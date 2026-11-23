// Fetching a closure's store paths when the guest first needs them.
//
// A runtime closure is everything a package could reach, and a program
// reaches much less of it than that. aisleriot's closure is 180 paths
// and 298 MiB compressed, and solitaire never opens gcc (82 MiB, which
// guile references as its compiler) or python3 (54 MiB, through
// libcanberra and gstreamer). So on the unkernel engine the page can
// list every path of the closure in the guest's store from the narinfos
// alone, start the shell once the selected packages are in, and fetch
// any other path the first time the guest looks inside it.
//
// Two pieces. lazyStore knows the closure and fetches a path once
// however many lookups wait on it. lazyFs is the file system the guest
// is served: unkernel's MemoryFs, which holds what has been written,
// with each lookup under the store held until its path is in.
//
// unkernel's 9p server keeps answering other requests while one
// handler waits, so a lookup that waits for a download stalls the one
// guest process that made it and nothing else. The server runs at most
// sixteen requests per mount at once, though: sixteen processes stuck
// on downloads would hold up the rest of the mount until one is in.
//
// A program's first run makes its lookups one after another: the
// dynamic linker opens a library, reads which ones that library needs,
// and opens those next. Each first touch would be a round trip to the
// cache. Two things start paths before the guest asks for them:
//
//   When the guest opens a file, the store paths its ELF headers name
//   for the dynamic loader (elf.js) are fetched at once: they are what
//   the loader opens next.
//
//   When the guest first touches a path, the paths its narinfo
//   references are fetched in the background, which covers what no ELF
//   header names: icon themes, schemas, fonts. Only one level, or the
//   whole closure would download the moment anything was touched; and
//   only the small ones, because the large references of a library are
//   as often what it was built with as what it opens. guile's include
//   gcc (82 MiB), and solitaire's first frame waited behind it. A
//   selected package's references are all fetched, since the reader is
//   about to run it.

import { loaderStorePaths } from "./elf.js";
import { log } from "./log.js";

// How urgently a path is wanted.
export const Priority = Object.freeze({
  // The guest is waiting on it: start now, whatever else is in flight.
  DEMAND: "demand",
  // The guest will probably want it soon: start when there is room.
  PREFETCH: "prefetch",
});

// Which of a touched path's references are fetched in the background.
export const References = Object.freeze({
  // Every one: a selected package's, which the reader is about to run.
  ALL: "all",
  // Those no larger than PREFETCH_LIMIT_BYTES.
  SMALL: "small",
});

// The largest reference, in compressed bytes, fetched in the background
// for a touched path that was not selected. Libraries a program loads
// are fetched through its ELF headers whatever their size; what is
// left is mostly data, and a theme or a schema is far smaller than
// this, while the compilers and runtimes nobody opens are far larger.
export const PREFETCH_LIMIT_BYTES = 2 * 1024 * 1024;

// The errno a lookup gets when its path could not be fetched: an I/O
// error, which is what the path is, and which the guest does not cache
// as an answer, so the next lookup asks again.
const EIO = "EIO";

// The type a store path is listed with before its NAR is in. Nearly
// every store path is a directory, and a listing's type is only a hint:
// the guest looks the name up, which waits for the NAR, before it acts
// on what the name is.
const UNFETCHED_TYPE = "dir";

const STORE_PREFIX = "/nix/store/";

const basenameOf = (info) => info.storePath.slice(STORE_PREFIX.length);

// The closure's paths and their downloads.
//
// fetch(info) resolves to a path's parsed NAR (store.js, fetchNar), and
// write(basename, entries) puts it into the guest's share; either may
// be async. `concurrency` bounds the background fetches: a lookup the
// guest waits on starts at once, and background fetches only start
// while fewer than `concurrency` downloads of either kind are running.
export function lazyStore({ fetch, write, concurrency }) {
  // basename -> { info, written, promise, settle, queued }. `promise`
  // is the download every lookup of the path waits on, from the moment
  // the path is asked for until the download ends; null otherwise.
  const paths = new Map();

  // Paths the guest has touched, whose references are on their way.
  const touched = new Set();

  // Background fetches waiting for room, oldest first.
  const queue = [];
  let running = 0;

  // Download, check and write one path, and settle the promise its
  // lookups wait on. A failure leaves the path unwritten and forgets
  // the download, so the next lookup starts another.
  function start(path) {
    path.queued = false;
    running += 1;
    const basename = basenameOf(path.info);

    // The download starts before this returns, so what is in flight is
    // known the moment a lookup has been made; a fetch that throws
    // rather than rejecting fails the same way.
    let download;
    try {
      download = Promise.resolve(fetch(path.info));
    } catch (err) {
      download = Promise.reject(err);
    }

    // The download is over before its lookups hear the outcome, so one
    // that asks again on hearing of a failure starts a fresh download.
    const settle = path.settle;
    const over = () => {
      path.promise = null;
      running -= 1;
      pump();
    };

    download
      .then((entries) => write(basename, entries))
      .then(
        () => {
          path.written = true;
          over();
          settle.resolve();
        },
        (err) => {
          log(
            `${path.info.storePath}: not fetched (${err.message}); the next lookup tries again`,
          );
          over();
          settle.reject(err);
        },
      );
  }

  // Start background fetches while there is room.
  function pump() {
    while (running < concurrency && queue.length > 0) {
      start(queue.shift());
    }
  }

  // Give a path a download its lookups can wait on, queued or started.
  function request(path, priority) {
    path.promise = new Promise((resolve, reject) => {
      path.settle = { resolve, reject };
    });
    // A background fetch may fail with nobody waiting on it. That is
    // logged, not an unhandled rejection; a lookup that does wait still
    // sees the failure.
    path.promise.catch(() => {});

    if (priority === Priority.DEMAND) {
      start(path);
      return;
    }
    path.queued = true;
    queue.push(path);
    pump();
  }

  // A lookup of a path that is still waiting for room in the
  // background: take it out of the queue and start it now.
  function promote(path) {
    queue.splice(queue.indexOf(path), 1);
    start(path);
  }

  const store = {
    // Add paths of the closure, as narinfos; paths already known are
    // left as they are.
    add(infos) {
      for (const info of infos) {
        const basename = basenameOf(info);
        if (paths.has(basename)) {
          continue;
        }
        paths.set(basename, {
          info,
          written: false,
          promise: null,
          settle: null,
          queued: false,
        });
      }
    },

    // Resolves once the path is written, fetching it if it is not on
    // its way; rejects if its download fails. A name the closure does
    // not hold has nothing to wait for.
    ensure(basename, priority) {
      const path = paths.get(basename);
      if (path === undefined || path.written) {
        return Promise.resolve();
      }
      if (path.promise === null) {
        request(path, priority);
        return path.promise;
      }
      if (priority === Priority.DEMAND && path.queued) {
        promote(path);
      }
      return path.promise;
    },

    // The guest looked at the path: fetch it now, and, the first time,
    // its references in the background, all of them or the small ones.
    // The largest go first: they take longest, and a download started
    // last is the one a program ends up waiting for.
    touch(basename, references = References.SMALL) {
      const arrived = store.ensure(basename, Priority.DEMAND);
      if (touched.has(basename) || !paths.has(basename)) {
        return arrived;
      }
      touched.add(basename);

      const wanted = paths
        .get(basename)
        .info.references.filter((reference) => reference !== basename)
        .map((reference) => paths.get(reference))
        .filter((path) => path !== undefined)
        .filter(
          (path) =>
            references === References.ALL ||
            path.info.fileSize <= PREFETCH_LIMIT_BYTES,
        )
        .sort((a, b) => b.info.fileSize - a.info.fileSize);
      for (const path of wanted) {
        store.ensure(basenameOf(path.info), Priority.PREFETCH).catch(() => {});
      }
      return arrived;
    },

    knows: (basename) => paths.has(basename),
    ready: (basename) => paths.get(basename)?.written === true,

    // The closure's paths not written yet, by basename.
    pending: () =>
      [...paths.entries()]
        .filter(([, path]) => !path.written)
        .map(([basename]) => basename),

    // The closure against what has been written, in paths and in
    // compressed bytes (the narinfo's FileSize, which is what a
    // download costs).
    stats() {
      let bytes = 0;
      let writtenPaths = 0;
      let writtenBytes = 0;
      for (const path of paths.values()) {
        bytes += path.info.fileSize;
        if (path.written) {
          writtenPaths += 1;
          writtenBytes += path.info.fileSize;
        }
      }
      return { paths: paths.size, bytes, writtenPaths, writtenBytes };
    },
  };
  return store;
}

// An error the 9p server answers the guest with as that errno.
function errno(code, message) {
  return Object.assign(new Error(message), { code });
}

// The file system the guest is served: `fs`, unkernel's MemoryFs holding
// what has been written, with `store` deciding when a path under
// `storeDir` may be answered. `storeDir` is the store's path inside the
// MemoryFs.
//
// The calls are unkernel's Fs (its dist _chunks/index.d.mts): a handler
// may return a promise, and an error with an errno name as its `code`
// answers the guest with that errno. Only what the guest reads is here;
// the mount is read-only, so every change is refused before it gets
// this far.
export function lazyFs(fs, store, storeDir) {
  const prefix = `${storeDir}/`;

  // Files already read for what their loading opens, by path.
  const inspected = new Set();

  // The closure path `path` is or is inside, by basename; null for a
  // path outside the store, or a name the closure does not hold.
  function closurePathOf(path) {
    if (!path.startsWith(prefix)) {
      return null;
    }
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const basename = slash === -1 ? rest : rest.slice(0, slash);
    return store.knows(basename) ? basename : null;
  }

  // Run `call` once the closure path `path` is in has been written: at
  // once for a path already there, so a warm lookup costs no more than
  // the MemoryFs does, and after the download otherwise.
  function after(path, call) {
    const basename = closurePathOf(path);
    if (basename === null) {
      return call();
    }
    const arrived = store.touch(basename);
    if (store.ready(basename)) {
      return call();
    }
    return arrived.then(call, (err) => {
      throw errno(EIO, `${path}: ${err.message}`);
    });
  }

  // Start what the dynamic loader will open for a file of the closure
  // path `basename` the guest has just opened (elf.js), once per file.
  // These are needed within milliseconds, so they start at once.
  function expectLoads(path, basename, file) {
    if (inspected.has(path)) {
      return;
    }
    inspected.add(path);
    const bytes = file.read(0, fs.getattr(path).size ?? 0);
    if (!(bytes instanceof Uint8Array)) {
      return;
    }
    for (const needed of loaderStorePaths(bytes)) {
      if (needed !== basename) {
        store.ensure(needed, Priority.DEMAND).catch(() => {});
      }
    }
  }

  return {
    getattr: (path) => after(path, () => fs.getattr(path)),

    // The store itself lists every path of the closure, fetched or not.
    // Listing it fetches nothing; looking any of the names up does.
    readdir(path) {
      if (path !== storeDir) {
        return after(path, () => fs.readdir(path));
      }
      const listed = fs.readdir(path);
      const names = new Set(listed.map((entry) => entry.name));
      const unfetched = store
        .pending()
        .filter((basename) => !names.has(basename))
        .map((name) => ({ name, type: UNFETCHED_TYPE }));
      return [...listed, ...unfetched];
    },

    open: (path, flags) =>
      after(path, () => {
        const file = fs.open(path, flags);
        const basename = closurePathOf(path);
        if (basename !== null) {
          expectLoads(path, basename, file);
        }
        return file;
      }),
    readlink: (path) => after(path, () => fs.readlink(path)),
    statfs: () => fs.statfs(),
  };
}
