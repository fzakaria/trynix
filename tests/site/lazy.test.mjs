// Tests fetching a closure's store paths on demand (site/js/lazy.js):
// the store that downloads a path once however many lookups wait on it,
// retries a path whose download failed, and fetches a touched path's
// references ahead of the guest; and the file system the guest is
// served, which holds a lookup inside a path until the path is in.
//
// The downloads are stand-ins the tests settle by hand, so each test
// says exactly what is in flight when it looks.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  lazyFs,
  lazyStore,
  PREFETCH_LIMIT_BYTES,
  Priority,
  References,
} from "../../site/js/lazy.js";
import { logLines } from "../../site/js/log.js";
import { elf } from "./elf-builder.mjs";

const STORE = "/nix/store";

// A narinfo as closure.js parses one, for a basename and its
// references.
function info(basename, references = [], fileSize = 100) {
  return { storePath: `${STORE}/${basename}`, references, fileSize };
}

// A promise with its settle functions, for downloads the test finishes.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let every settled promise's callbacks run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A store over downloads the test controls: `started` lists the
// basenames whose download began, in order, and finish(basename) or
// fail(basename) ends the oldest download of that basename. `written`
// lists what reached the share.
function controlled({ concurrency = 4 } = {}) {
  const started = [];
  const written = [];
  const inFlight = new Map();

  const store = lazyStore({
    concurrency,
    fetch(narinfo) {
      const basename = narinfo.storePath.slice(STORE.length + 1);
      started.push(basename);
      const download = deferred();
      inFlight.set(basename, [...(inFlight.get(basename) ?? []), download]);
      return download.promise;
    },
    write(basename, entries) {
      written.push({ basename, entries });
    },
  });

  const take = (basename) => {
    const [first, ...rest] = inFlight.get(basename) ?? [];
    assert.ok(first, `no download of ${basename} is in flight`);
    inFlight.set(basename, rest);
    return first;
  };

  return {
    store,
    started,
    written,
    finish: async (basename) => {
      take(basename).resolve([{ path: "", type: "directory" }]);
      await settle();
    },
    fail: async (basename) => {
      take(basename).reject(new Error("HTTP 503"));
      await settle();
    },
  };
}

// Checks that several lookups of one path share one download, and that
// all of them are answered once it is written.
test("concurrent lookups of one path share one download", async () => {
  const { store, started, written, finish } = controlled();
  store.add([info("a-gtk")]);

  const first = store.ensure("a-gtk", Priority.DEMAND);
  const second = store.ensure("a-gtk", Priority.DEMAND);
  const third = store.touch("a-gtk");
  assert.deepEqual(started, ["a-gtk"]);
  assert.equal(store.ready("a-gtk"), false);

  await finish("a-gtk");
  await Promise.all([first, second, third]);
  assert.equal(store.ready("a-gtk"), true);
  assert.deepEqual(
    written.map((w) => w.basename),
    ["a-gtk"],
  );

  // A path already written answers at once and fetches nothing.
  await store.ensure("a-gtk", Priority.DEMAND);
  assert.deepEqual(started, ["a-gtk"]);
});

// Checks that a download that fails rejects every lookup waiting on it,
// leaves the path unwritten, says which path and why in the page's log,
// and that the next lookup tries again.
test("a failed download rejects its lookups and is retried on the next", async () => {
  const { store, started, fail, finish } = controlled();
  store.add([info("b-gcc")]);

  const waiting = [
    store.ensure("b-gcc", Priority.DEMAND),
    store.ensure("b-gcc", Priority.DEMAND),
  ];
  await fail("b-gcc");
  for (const lookup of waiting) {
    await assert.rejects(lookup, /HTTP 503/);
  }
  assert.equal(store.ready("b-gcc"), false);
  assert.match(logLines(), /\/nix\/store\/b-gcc.*HTTP 503/);

  const again = store.ensure("b-gcc", Priority.DEMAND);
  assert.deepEqual(started, ["b-gcc", "b-gcc"]);
  await finish("b-gcc");
  await again;
  assert.equal(store.ready("b-gcc"), true);
});

// Checks that a lookup which asks again the moment it hears of a
// failure starts a fresh download, rather than being handed the failed
// one a second time.
test("asking again on hearing of a failure starts a fresh download", async () => {
  const { store, started, fail } = controlled();
  store.add([info("w-pixman")]);

  store.ensure("w-pixman", Priority.DEMAND).catch(() => {
    store.ensure("w-pixman", Priority.DEMAND).catch(() => {});
  });
  await fail("w-pixman");
  assert.deepEqual(started, ["w-pixman", "w-pixman"]);
});

// Checks that touching a path fetches its direct references in the
// background, and only those: a reference's own references wait until
// the guest touches the reference. A path's reference to itself is
// nothing more to fetch.
test("a touched path's references are fetched, one level deep", async () => {
  const { store, started, finish } = controlled();
  store.add([
    info("c-sol", ["c-sol", "d-guile", "e-gtk"]),
    info("d-guile", ["f-gcc"]),
    info("e-gtk"),
    info("f-gcc"),
  ]);

  const sol = store.touch("c-sol");
  assert.deepEqual(started, ["c-sol", "d-guile", "e-gtk"]);
  await finish("c-sol");
  await sol;
  await finish("d-guile");
  await finish("e-gtk");
  assert.deepEqual(started, ["c-sol", "d-guile", "e-gtk"]);

  // The guest opens guile: now guile's references come.
  await store.touch("d-guile");
  assert.deepEqual(started, ["c-sol", "d-guile", "e-gtk", "f-gcc"]);
});

// Checks that a touched path's large references are left for the guest
// to ask for, since a large reference is as often a compiler a library
// was built with as something it opens; a selected package's are all
// fetched, since the reader is about to run it.
test("a touched path's large references wait, unless it was selected", async () => {
  const { store, started } = controlled();
  const large = PREFETCH_LIMIT_BYTES + 1;
  store.add([
    info("p-guile", ["q-gcc", "r-gmp"]),
    info("q-gcc", [], large),
    info("r-gmp"),
    info("s-sol", ["t-gtk"]),
    info("t-gtk", [], large),
  ]);

  store.touch("p-guile");
  assert.deepEqual(started, ["p-guile", "r-gmp"]);

  store.touch("s-sol", References.ALL);
  assert.deepEqual(started, ["p-guile", "r-gmp", "s-sol", "t-gtk"]);
});

// Checks the order of a touched path's references: largest first, so
// the downloads that take longest are not the last to start. firefox's
// wrapper references firefox itself, 98 MiB, among smaller paths, and
// its window waited on it more than on anything else.
test("a touched path's references start largest first", () => {
  const { store, started } = controlled({ concurrency: 2 });
  store.add([
    info("x-firefox", ["y-small", "z-large", "0-middle"]),
    info("y-small", [], 10),
    info("z-large", [], 1000),
    info("0-middle", [], 100),
  ]);

  store.touch("x-firefox", References.ALL);
  assert.deepEqual(started, ["x-firefox", "z-large"]);
});

// Checks the bound: background fetches wait for room, and a lookup
// the guest is waiting on starts at once, ahead of them, even when the
// bound is reached. A lookup of a path still queued for the background
// takes it out of the queue rather than fetching it twice.
test("a lookup starts at once; background fetches wait for room", async () => {
  const { store, started, finish } = controlled({ concurrency: 1 });
  store.add([
    info("g-app", ["h-lib", "i-lib", "j-lib"]),
    info("h-lib"),
    info("i-lib"),
    info("j-lib"),
  ]);

  const app = store.touch("g-app");
  assert.deepEqual(started, ["g-app"]);

  const lib = store.ensure("j-lib", Priority.DEMAND);
  assert.deepEqual(started, ["g-app", "j-lib"]);

  await finish("g-app");
  await app;
  await finish("j-lib");
  await lib;
  assert.deepEqual(started, ["g-app", "j-lib", "h-lib"]);
  await finish("h-lib");
  assert.deepEqual(started, ["g-app", "j-lib", "h-lib", "i-lib"]);
});

// Checks the counts the page's progress row shows: the closure's size,
// and what has been written so far, in paths and compressed bytes.
test("the store counts what it has written against the closure", async () => {
  const { store, finish } = controlled();
  store.add([info("k-one", [], 300), info("l-two", [], 700)]);
  assert.deepEqual(store.stats(), {
    paths: 2,
    bytes: 1000,
    writtenPaths: 0,
    writtenBytes: 0,
  });

  const one = store.ensure("k-one", Priority.DEMAND);
  await finish("k-one");
  await one;
  assert.deepEqual(store.stats(), {
    paths: 2,
    bytes: 1000,
    writtenPaths: 1,
    writtenBytes: 300,
  });
  assert.deepEqual(store.pending(), ["l-two"]);
});

// The part of unkernel's MemoryFs the lazy file system calls, over a
// Map of paths, which the store's write fills.
function fakeShare() {
  const nodes = new Map([
    ["/", { type: "dir" }],
    ["/nix", { type: "dir" }],
    [STORE, { type: "dir" }],
  ]);
  const enoent = (path) =>
    Object.assign(new Error(`${path}: ENOENT`), { code: "ENOENT" });
  const node = (path) => {
    const found = nodes.get(path);
    if (found === undefined) {
      throw enoent(path);
    }
    return found;
  };

  return {
    nodes,
    getattr: (path) => ({
      type: node(path).type,
      size: node(path).data?.length,
    }),
    readdir(path) {
      node(path);
      const prefix = path === "/" ? "/" : `${path}/`;
      return [...nodes.keys()]
        .filter((p) => p.startsWith(prefix) && p !== path)
        .map((p) => p.slice(prefix.length))
        .filter((name) => !name.includes("/"))
        .map((name) => ({ name, type: nodes.get(prefix + name).type }));
    },
    open: (path) => ({
      read: (offset, length) =>
        node(path).data.subarray(offset, offset + length),
    }),
    readlink: (path) => node(path).target,
    statfs: () => ({ bsize: 4096 }),
  };
}

// A lazy file system over a fake share, with downloads the test
// controls; finishing a download writes `files` (path -> node) for it.
function servedLazily(infos, files) {
  const share = fakeShare();
  const downloads = new Map();
  const started = [];
  const store = lazyStore({
    concurrency: 4,
    fetch(narinfo) {
      const basename = narinfo.storePath.slice(STORE.length + 1);
      started.push(basename);
      const download = deferred();
      downloads.set(basename, download);
      return download.promise;
    },
    write(basename) {
      for (const [path, node] of Object.entries(files[basename] ?? {})) {
        share.nodes.set(path, node);
      }
    },
  });
  store.add(infos);
  return {
    fs: lazyFs(share, store, STORE),
    started,
    finish: async (basename) => {
      downloads.get(basename).resolve([]);
      await settle();
    },
    fail: async (basename) => {
      downloads.get(basename).reject(new Error("HTTP 404"));
      await settle();
    },
  };
}

const LIBC = "m-glibc-2.42";
const LIBC_FILES = {
  [`${STORE}/${LIBC}`]: { type: "dir" },
  [`${STORE}/${LIBC}/lib`]: { type: "dir" },
  [`${STORE}/${LIBC}/lib/libc.so.6`]: {
    type: "file",
    data: new Uint8Array([7]),
  },
};

// Checks that every path of the closure is listed in the store before
// any of it is fetched, and that listing the store fetches nothing.
test("the store lists the whole closure before anything is fetched", async () => {
  const { fs, started } = servedLazily([info(LIBC), info("n-hello")], {});
  const names = (await fs.readdir(STORE)).map((entry) => entry.name).sort();
  assert.deepEqual(names, [LIBC, "n-hello"]);
  assert.deepEqual(started, []);
});

// Checks that a lookup of a path, and of a file inside one, waits for
// the path's download and is then answered from the share.
test("a lookup inside a path waits for its download", async () => {
  const { fs, started, finish } = servedLazily([info(LIBC)], {
    [LIBC]: LIBC_FILES,
  });

  const lookup = fs.getattr(`${STORE}/${LIBC}/lib/libc.so.6`);
  const opened = fs.open(`${STORE}/${LIBC}/lib/libc.so.6`, { read: true });
  assert.deepEqual(started, [LIBC]);

  await finish(LIBC);
  assert.deepEqual(await lookup, { type: "file", size: 1 });
  assert.deepEqual((await opened).read(0, 1), new Uint8Array([7]));

  // Written, the path is answered without waiting for anything.
  assert.deepEqual(fs.getattr(`${STORE}/${LIBC}`), {
    type: "dir",
    size: undefined,
  });
});

// Checks that a path whose download fails answers the guest EIO, and
// that the next lookup downloads it again.
test("a failed download answers EIO, and the next lookup retries", async () => {
  const { fs, started, fail, finish } = servedLazily([info(LIBC)], {
    [LIBC]: LIBC_FILES,
  });

  // The guest's request is waiting on the answer before the download
  // fails, as the 9p server's is.
  const answered = assert.rejects(
    fs.getattr(`${STORE}/${LIBC}/lib`),
    (err) => err.code === "EIO",
  );
  await fail(LIBC);
  await answered;

  const again = fs.getattr(`${STORE}/${LIBC}/lib`);
  assert.deepEqual(started, [LIBC, LIBC]);
  await finish(LIBC);
  assert.deepEqual(await again, { type: "dir", size: undefined });
});

// Checks that what is not a path of the closure goes straight to the
// share: the share's own files, and a store name nothing listed.
test("paths outside the closure go straight to the share", async () => {
  const { fs, started } = servedLazily([info(LIBC)], {});
  assert.deepEqual(fs.getattr("/nix"), { type: "dir", size: undefined });
  assert.throws(
    () => fs.getattr(`${STORE}/o-elsewhere`),
    (err) => err.code === "ENOENT",
  );
  assert.deepEqual(started, []);
});

// Checks that opening a program starts the store paths its loader will
// open, all at once and ahead of the guest asking: its interpreter and
// its RUNPATH, including one too large to fetch as a mere reference.
// The program's own path is not fetched again.
test("opening a program fetches what its loader will open", async () => {
  const program = "u-sol";
  const binary = elf({
    interp: `${STORE}/${LIBC}/lib/ld-linux-aarch64.so.1`,
    searchPath: `${STORE}/v-gtk/lib:${STORE}/${program}/lib`,
  });
  const { fs, started, finish } = servedLazily(
    [info(program), info(LIBC), info("v-gtk", [], PREFETCH_LIMIT_BYTES + 1)],
    {
      [program]: {
        [`${STORE}/${program}`]: { type: "dir" },
        [`${STORE}/${program}/bin`]: { type: "dir" },
        [`${STORE}/${program}/bin/sol`]: { type: "file", data: binary },
      },
    },
  );

  const opened = fs.open(`${STORE}/${program}/bin/sol`, { read: true });
  await finish(program);
  await opened;
  assert.deepEqual(started, [program, LIBC, "v-gtk"]);
});
