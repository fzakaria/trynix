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
// and before that each path's NAR listing (listing.js), which answers a
// stat, a directory listing or a symlink without the NAR. Reading a
// regular file's bytes is what downloads the path. A path the cache has
// no listing for is downloaded whole the first time the guest looks in
// it.
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
//   for the dynamic loader (elf.js) are fetched next, ahead of the
//   background fetches: they are what the loader opens next. They wait
//   for room like a background fetch, since a RUNPATH can name dozens
//   of paths and the loader finds many of its libraries in the first
//   few; once the loader looks in one, the guest is waiting on it and
//   it starts at once.
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
import { listingAttr, listingEntries, nodeAt, rootType } from "./listing.js";
import { log } from "./log.js";
import { absoluteTarget } from "./store.js";

// How urgently a path is wanted.
export const Priority = Object.freeze({
  // The guest is waiting on it: start now, whatever else is in flight.
  DEMAND: "demand",
  // The guest's dynamic loader will open it next: start when there is
  // room, ahead of every PREFETCH.
  NEXT: "next",
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

// The type a store path is listed with in the store before its NAR is
// in, when it has no listing to say. Nearly every store path is a
// directory, and a directory entry's type is only a hint: the guest
// looks the name up before it acts on what the name is.
const UNFETCHED_TYPE = "dir";

// The modification time nix gives every file in a store, one second
// past the epoch, in milliseconds; the share stamps its files with it
// (share.js).
const STORE_TIME_MS = 1000;

const STORE_PREFIX = "/nix/store/";

const basenameOf = (info) => info.storePath.slice(STORE_PREFIX.length);

// The closure's paths and their downloads.
//
// fetch(info) resolves to a path's parsed NAR (store.js, fetchNar), and
// write(basename, entries) puts it into the guest's share; either may
// be async. `concurrency` bounds the background fetches: a lookup the
// guest waits on starts at once, and the others (NEXT, then PREFETCH)
// only start while fewer than `concurrency` downloads of any kind are
// running.
// listing(info), when given, resolves to a path's NAR listing's root,
// or to null when there is none to be had (listing.js).
export function lazyStore({ fetch, write, concurrency, listing }) {
  // basename -> { info, written, promise, settle, queued, listing }.
  // `promise` is the download every lookup of the path waits on, from
  // the moment the path is asked for until the download ends; null
  // otherwise. `queued` is the queue the path waits in for room, or
  // null. `listing` is undefined until the listing is asked for, then a
  // promise, then its root or null.
  const paths = new Map();

  // Paths the guest has touched, whose references are on their way.
  const touched = new Set();

  // Fetches waiting for room, oldest first in each: what the loader
  // opens next (NEXT), which goes first, and the background (PREFETCH).
  const next = [];
  const background = [];
  let running = 0;

  // Download, check and write one path, and settle the promise its
  // lookups wait on. A failure leaves the path unwritten and forgets
  // the download, so the next lookup starts another.
  function start(path) {
    path.queued = null;
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

  // Start waiting fetches while there is room, NEXT first.
  function pump() {
    while (running < concurrency) {
      const path = next.shift() ?? background.shift();
      if (path === undefined) {
        return;
      }
      start(path);
    }
  }

  // Put a path that is waiting for room in `queue`, out of the one it
  // was in.
  function requeue(path, queue) {
    path.queued.splice(path.queued.indexOf(path), 1);
    path.queued = queue;
    queue.push(path);
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
    path.queued = priority === Priority.NEXT ? next : background;
    path.queued.push(path);
    pump();
  }

  // A lookup of a path that is still waiting for room: take it out of
  // its queue and start it now.
  function promote(path) {
    path.queued.splice(path.queued.indexOf(path), 1);
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
          queued: null,
          listing: undefined,
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
      if (path.queued === null) {
        return path.promise;
      }

      // A path still waiting for room moves up: to now for a lookup
      // the guest waits on, ahead of the background for one the loader
      // opens next.
      if (priority === Priority.DEMAND) {
        promote(path);
      } else if (priority === Priority.NEXT && path.queued === background) {
        requeue(path, next);
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

    // The path's listing: resolves to its root, or to null when the
    // path has none (no listing function, or none to be had), asked for
    // once however many lookups want it.
    list(basename) {
      const path = paths.get(basename);
      if (path === undefined || listing === undefined) {
        return Promise.resolve(null);
      }
      if (path.listing === undefined) {
        path.listing = Promise.resolve(listing(path.info)).then(
          (root) => {
            path.listing = root ?? null;
            return path.listing;
          },
          () => {
            path.listing = null;
            return null;
          },
        );
      }
      return Promise.resolve(path.listing);
    },

    // The path's listing if it has arrived: its root, null when there is
    // none, undefined while it has not been asked for or is on its way.
    // A store with no listing function has none for any path.
    listed(basename) {
      if (listing === undefined) {
        return null;
      }
      const known = paths.get(basename)?.listing;
      return known instanceof Promise ? undefined : known;
    },

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

// The file system the guest is served: `fs`, unkernel's MemoryFs
// holding what has been written, with `store` deciding when a path in
// the store may be answered and from what. `storeDir` is the store's
// path inside the MemoryFs, and `shareDir` where the guest mounts the
// MemoryFs, which a symlink's target is written against (store.js,
// absoluteTarget).
//
// The calls are unkernel's Fs (its dist _chunks/index.d.mts): a handler
// may return a promise, and an error with an errno name as its `code`
// answers the guest with that errno. Only what the guest reads is here;
// the mount is read-only, so every change is refused before it gets
// this far.
//
// A file of the closure is described the same way whether the answer
// comes from its listing or from the MemoryFs: type, mode, size and
// nix's one-second times, and nothing else. The MemoryFs's own inode
// numbers and versions would change under the guest the moment a path
// arrived; without them the 9p server derives both from the path and
// the times, the same before and after.
export function lazyFs(fs, store, { storeDir, shareDir }) {
  const prefix = `${storeDir}/`;

  // Files already read for what their loading opens, by path.
  const inspected = new Set();

  // The closure path `path` is or is inside, as { basename, rest }, rest
  // being the part inside it ("" for the path itself); null for a path
  // outside the store, or a name the closure does not hold.
  function closurePathOf(path) {
    if (!path.startsWith(prefix)) {
      return null;
    }
    const inside = path.slice(prefix.length);
    const slash = inside.indexOf("/");
    const basename = slash === -1 ? inside : inside.slice(0, slash);
    if (!store.knows(basename)) {
      return null;
    }
    return { basename, rest: slash === -1 ? "" : inside.slice(slash + 1) };
  }

  // How the share writes a symlink's target at `path`.
  const targetOf = (path, target) =>
    absoluteTarget(`${shareDir}${path}`, target);

  // Run `call` once the closure path `basename` has been written: at
  // once for a path already there, so a warm lookup costs no more than
  // the MemoryFs does, and after its download otherwise. Touching it is
  // what fetches its references (lazyStore.touch).
  function whole(path, basename, call) {
    const arrived = store.touch(basename);
    if (store.ready(basename)) {
      return call();
    }
    return arrived.then(call, (err) => {
      throw errno(EIO, `${path}: ${err.message}`);
    });
  }

  // Answer a lookup at `path`, inside the closure path `at`: from the
  // MemoryFs once the path is written, from its listing until then, and
  // for a path with no listing, from the MemoryFs once the path is
  // downloaded. fromListing(root) and fromShare() give the answer.
  function answer(path, at, fromListing, fromShare) {
    if (store.ready(at.basename)) {
      return fromShare();
    }
    const listed = store.listed(at.basename);
    if (listed === null) {
      return whole(path, at.basename, fromShare);
    }
    if (listed !== undefined) {
      return fromListing(listed);
    }
    return store.list(at.basename).then((root) => {
      if (store.ready(at.basename)) {
        return fromShare();
      }
      if (root === null) {
        return whole(path, at.basename, fromShare);
      }
      return fromListing(root);
    });
  }

  // Start what the dynamic loader will open for a file of the closure
  // path `basename` the guest has just opened (elf.js), once per file.
  // These are needed within milliseconds, so they go ahead of the
  // background fetches; the one the loader looks in first starts at
  // once when it does, if it has not already.
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
        store.ensure(needed, Priority.NEXT).catch(() => {});
      }
    }
  }

  // Open a written file of the closure path `basename`, describing it as
  // every file of the closure is described.
  function openWritten(path, basename, flags) {
    const file = fs.open(path, flags);
    expectLoads(path, basename, file);
    return {
      read: (offset, length) => file.read(offset, length),
      getattr: () => storeAttr(file.getattr?.() ?? fs.getattr(path)),
    };
  }

  return {
    getattr(path) {
      const at = closurePathOf(path);
      if (at === null) {
        return fs.getattr(path);
      }
      return answer(
        path,
        at,
        (root) => storeAttr(listingAttr(nodeAt(root, at.rest), path, targetOf)),
        () => storeAttr(fs.getattr(path)),
      );
    },

    // The store itself lists every path of the closure, fetched or not,
    // typed by its listing where it has one. Listing it fetches nothing.
    readdir(path) {
      if (path === storeDir) {
        const written = fs.readdir(path).map(entryOf);
        const names = new Set(written.map((entry) => entry.name));
        const unfetched = store
          .pending()
          .filter((basename) => !names.has(basename))
          .map((name) => {
            const listed = store.listed(name);
            return {
              name,
              type: listed ? rootType(listed) : UNFETCHED_TYPE,
            };
          });
        return [...written, ...unfetched];
      }
      const at = closurePathOf(path);
      if (at === null) {
        return fs.readdir(path);
      }
      return answer(
        path,
        at,
        (root) => listingEntries(nodeAt(root, at.rest)),
        () => fs.readdir(path).map(entryOf),
      );
    },

    // Reading a file is what needs its bytes: a listed regular file
    // downloads its path, and anything else the listing names is not a
    // file to open.
    open(path, flags) {
      const at = closurePathOf(path);
      if (at === null) {
        return fs.open(path, flags);
      }
      const opened = () => openWritten(path, at.basename, flags);
      return answer(
        path,
        at,
        (root) => {
          if (nodeAt(root, at.rest).type !== "regular") {
            throw errno("EISDIR", `${path}: not a regular file`);
          }
          return whole(path, at.basename, opened);
        },
        () => whole(path, at.basename, opened),
      );
    },

    readlink(path) {
      const at = closurePathOf(path);
      if (at === null) {
        return fs.readlink(path);
      }
      return answer(
        path,
        at,
        (root) => {
          const node = nodeAt(root, at.rest);
          if (node.type !== "symlink") {
            throw errno("EINVAL", `${path}: not a symlink`);
          }
          return targetOf(path, node.target);
        },
        () => fs.readlink(path),
      );
    },

    statfs: () => fs.statfs(),
  };
}

// A closure file's attributes as the guest is told them: type, mode and
// size, with nix's times (see lazyFs). `attr` may be a promise.
function storeAttr(attr) {
  if (attr instanceof Promise) {
    return attr.then(storeAttr);
  }
  return {
    type: attr.type,
    mode: attr.mode,
    size: attr.size,
    atimeMs: STORE_TIME_MS,
    mtimeMs: STORE_TIME_MS,
    ctimeMs: STORE_TIME_MS,
  };
}

// A directory entry without the MemoryFs's inode number (see lazyFs).
const entryOf = ({ name, type }) => ({ name, type });
