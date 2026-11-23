// Tests reading a binary cache's NAR listings (site/js/listing.js): the
// `<digest>.ls` file a cache publishes beside each narinfo, which names
// every file of a store path with its type, size and executable bit.
// The page answers the guest's lookups from one until the path's NAR is
// needed. These tests hand the functions listings shaped as
// cache.nixos.org serves them, and a stand-in for the download.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  listingAttr,
  listingEntries,
  listingFetcher,
  nodeAt,
  parseListing,
  programsOfListing,
} from "../../site/js/listing.js";

// hello's listing, trimmed: a program, a data file, a directory and a
// relative symlink, as the cache writes them (narOffset is ignored).
const HELLO = {
  version: 1,
  root: {
    type: "directory",
    entries: {
      bin: {
        type: "directory",
        entries: {
          hello: {
            type: "regular",
            size: 64472,
            executable: true,
            narOffset: 400,
          },
          hi: { type: "symlink", target: "hello" },
          "README.txt": { type: "regular", size: 12, narOffset: 99 },
        },
      },
      share: { type: "directory", entries: {} },
    },
  },
};

// How the share writes a symlink's target: relative ones made absolute
// against the link's own directory under /share (store.js,
// absoluteTarget). The tests pass the same rule in.
const targetOf = (path, target) =>
  target.startsWith("/")
    ? target
    : `/share${path.slice(0, path.lastIndexOf("/"))}/${target}`;

// Checks that a listing is read from the cache's JSON, and that what is
// not one is refused rather than half-read.
test("a listing is parsed, and what is not one is refused", () => {
  const root = parseListing(JSON.stringify(HELLO));
  assert.equal(root.type, "directory");
  assert.throws(() => parseListing("{}"), /not a NAR listing/);
  assert.throws(
    () => parseListing('{"root":{"type":"fifo"}}'),
    /not a NAR listing/,
  );
});

// Checks walking a listing by the path inside the store path: the root
// itself, a nested file, a name that is not there (ENOENT) and a name
// under a file (ENOTDIR), with the errno names the 9p server answers.
test("a name inside a listing is found, or is ENOENT or ENOTDIR", () => {
  const root = parseListing(JSON.stringify(HELLO));
  assert.equal(nodeAt(root, "").type, "directory");
  assert.equal(nodeAt(root, "bin/hello").size, 64472);
  assert.throws(
    () => nodeAt(root, "lib/libc.so.6"),
    (err) => err.code === "ENOENT",
  );
  assert.throws(
    () => nodeAt(root, "bin/missing"),
    (err) => err.code === "ENOENT",
  );
  assert.throws(
    () => nodeAt(root, "bin/hello/x"),
    (err) => err.code === "ENOTDIR",
  );
});

// Checks the attributes the guest is given: those the share's own files
// have once the NAR is written (share.js and store.js write files 0644
// and programs 0755; the MemoryFs makes directories 0755, symlinks 0777,
// and gives a directory 4096 bytes and a symlink its target's length).
test("a listed name has the attributes the written file will have", () => {
  const root = parseListing(JSON.stringify(HELLO));
  const at = (rest) =>
    listingAttr(nodeAt(root, rest), `/nix/store/abc-hello/${rest}`, targetOf);
  assert.deepEqual(at("bin/hello"), { type: "file", mode: 0o755, size: 64472 });
  assert.deepEqual(at("bin/README.txt"), {
    type: "file",
    mode: 0o644,
    size: 12,
  });
  assert.deepEqual(at("share"), { type: "dir", mode: 0o755, size: 4096 });
  const target = "/share/nix/store/abc-hello/bin/hello";
  assert.deepEqual(at("bin/hi"), {
    type: "symlink",
    mode: 0o777,
    size: new TextEncoder().encode(target).length,
  });
});

// Checks a directory's entries, typed as the 9p server names types.
test("a listed directory's entries carry their types", () => {
  const root = parseListing(JSON.stringify(HELLO));
  assert.deepEqual(listingEntries(nodeAt(root, "bin")), [
    { name: "hello", type: "file" },
    { name: "hi", type: "symlink" },
    { name: "README.txt", type: "file" },
  ]);
});

// Checks the programs a listing offers: what a PATH lookup would run
// under bin/, executables and symlinks, as store.js's programsOf picks
// them from a written NAR.
test("a listing's programs are its executables and links in bin", () => {
  const root = parseListing(JSON.stringify(HELLO));
  assert.deepEqual(programsOfListing(root), ["hello", "hi"]);
  assert.deepEqual(programsOfListing({ type: "regular", size: 1 }), []);
});

// Checks the fetcher: one download per path however often it is asked,
// a bound on how many run at once, a failure that resolves to null (no
// listing) rather than rejecting, since every caller then falls back to
// the NAR, and a count of the bytes the downloads came to.
test("listings are fetched once each, a few at a time, null on failure", async () => {
  const started = [];
  const finish = new Map();
  const fetcher = listingFetcher({
    concurrency: 2,
    fetchOne: (info) => {
      started.push(info.storePath);
      return new Promise((resolve, reject) =>
        finish.set(info.storePath, { resolve, reject }),
      );
    },
  });
  const info = (name) => ({ storePath: `/nix/store/${name}` });

  const a = fetcher.of(info("a"));
  const again = fetcher.of(info("a"));
  fetcher.of(info("b"));
  const c = fetcher.of(info("c"));
  assert.equal(a, again);
  assert.deepEqual(started, ["/nix/store/a", "/nix/store/b"]);

  finish.get("/nix/store/a").resolve({ root: HELLO.root, bytes: 120 });
  assert.deepEqual(await a, HELLO.root);
  assert.equal(fetcher.bytes(), 120);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["/nix/store/a", "/nix/store/b", "/nix/store/c"]);

  finish.get("/nix/store/c").reject(new Error("decode failed"));
  assert.equal(await c, null);
  finish.get("/nix/store/b").resolve(null);
  assert.equal(await fetcher.of(info("b")), null);
  assert.equal(fetcher.count(), 1);
});
