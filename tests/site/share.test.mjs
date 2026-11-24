// Tests the store share over unkernel's in-memory file system. The
// share's code is written against the handful of emscripten FS calls
// the qemu engine offers, so the unkernel engine wraps its MemoryFs in
// the same calls; these tests drive the share through that wrapper
// against a stand-in MemoryFs that records what it was told.
import { test } from "node:test";
import assert from "node:assert/strict";

import { memoryFsCalls, storeShare } from "../../site/js/share.js";
import { Precedence } from "../../site/js/store.js";

// The part of unkernel's MemoryFs the wrapper uses, over a Map.
function fakeMemoryFs() {
  const nodes = new Map([["/", { type: "dir" }]]);
  return {
    nodes,
    mkdirp(path) {
      nodes.set(path, { type: "dir" });
    },
    writeFile(path, content, opts = {}) {
      nodes.set(path, { type: "file", content, mode: opts.mode });
    },
    setattr(path, attr) {
      Object.assign(nodes.get(path), attr);
    },
    writeLink(path, target) {
      nodes.set(path, { type: "link", target });
    },
    rm(path) {
      nodes.delete(path);
    },
    stat(path) {
      return nodes.get(path);
    },
  };
}

const HELLO = "abc-hello-2.12.3";
const ENTRIES = [
  { path: "", type: "directory" },
  { path: "bin", type: "directory" },
  {
    path: "bin/hello",
    type: "regular",
    executable: true,
    data: new Uint8Array([1]),
  },
  { path: "share", type: "directory" },
  {
    path: "share/README",
    type: "regular",
    executable: false,
    data: new Uint8Array([2]),
  },
  { path: "bin/hi", type: "symlink", target: "hello" },
];

// Checks that a parsed NAR lands under the store directory with its
// modes and links. The MemoryFs is mounted at /share, so its own paths
// carry no /share, while a link's target is what the guest reads and
// does.
test("a NAR is written under the share's store directory", () => {
  const fs = fakeMemoryFs();
  const share = storeShare(memoryFsCalls(fs));
  share.write(HELLO, ENTRIES);

  const root = `/nix/store/${HELLO}`;
  assert.equal(fs.nodes.get(`${root}/bin/hello`).mode, 0o755);
  assert.equal(fs.nodes.get(`${root}/share/README`).mode, 0o644);
  assert.deepEqual(fs.nodes.get(`${root}/bin/hi`), {
    type: "link",
    target: `/share${root}/bin/hello`,
  });
  assert.deepEqual(share.programsOf(HELLO), ["hello", "hi"]);
});

// Checks that a store file carries the modification time nix gives
// every file in a store, one second past the epoch. Guile, for one,
// compares a .scm source with its compiled .go by mtime; files stamped
// with the moment they were written make the source look newer, and
// guile then ignores every compiled file and interprets the source.
test("store files carry nix's one-second modification time", () => {
  const fs = fakeMemoryFs();
  const share = storeShare(memoryFsCalls(fs));
  share.write(HELLO, ENTRIES);

  const root = `/nix/store/${HELLO}`;
  assert.equal(fs.nodes.get(`${root}/bin/hello`).mtimeMs, 1000);
  assert.equal(fs.nodes.get(`${root}/share/README`).mtimeMs, 1000);
});

// Checks the farm: a root's programs are linked by the guest's store
// path, a second package keeps or replaces a name as the caller says.
test("programs are linked into the farm, and precedence decides a collision", () => {
  const fs = fakeMemoryFs();
  const share = storeShare(memoryFsCalls(fs));
  const other = "xyz-hello-2.10";
  share.write(HELLO, ENTRIES);
  share.write(other, ENTRIES);

  // The dependency comes first in the batch and still loses the name
  // to the root.
  share.linkAll([other, HELLO], [HELLO], Precedence.KEEP);
  assert.equal(
    fs.nodes.get("/bin/hello").target,
    `/nix/store/${HELLO}/bin/hello`,
  );

  share.link(other, Precedence.KEEP);
  assert.equal(
    fs.nodes.get("/bin/hello").target,
    `/nix/store/${HELLO}/bin/hello`,
  );

  share.link(other, Precedence.REPLACE);
  assert.equal(
    fs.nodes.get("/bin/hello").target,
    `/nix/store/${other}/bin/hello`,
  );
});

// Checks programs offered from a listing before the path is written: they
// are linked like a written path's, the path does not count as written,
// and writing it later changes neither.
test("a listed path's programs are linked before it is written", () => {
  const fs = fakeMemoryFs();
  const share = storeShare(memoryFsCalls(fs));
  share.offer(HELLO, ["hello", "hi"]);

  assert.deepEqual(share.written(), []);
  assert.deepEqual(share.known(), [HELLO]);
  share.link(HELLO, Precedence.KEEP);
  assert.equal(fs.nodes.get("/bin/hi").target, `/nix/store/${HELLO}/bin/hi`);

  share.write(HELLO, ENTRIES);
  assert.deepEqual(share.written(), [HELLO]);
  assert.deepEqual(share.programsOf(HELLO), ["hello", "hi"]);
});

// A package whose NAR holds one program, `first`, though its listing
// may have offered more.
const FIRST = "aaa-first-1.0";
const FIRST_ENTRIES = [
  { path: "", type: "directory" },
  { path: "bin", type: "directory" },
  {
    path: "bin/first",
    type: "regular",
    executable: true,
    data: new Uint8Array([3]),
  },
];

// Checks that a path's NAR, once in, takes back the farm links its
// listing made for programs the NAR does not have, and that another
// package's program of the same name takes the link. Two packages are
// offered from listings, the first wrongly listing `hello`, and linked
// as a boot links them, the first winning the name; then both NARs
// arrive in turn, and the farm's `hello` is read after each. A link
// left to the first named a file that was never there, so `hello` on
// PATH failed after both NARs were in.
test("a NAR takes back the programs its listing offered wrongly", () => {
  const fs = fakeMemoryFs();
  const share = storeShare(memoryFsCalls(fs));
  share.offer(FIRST, ["first", "hello"]);
  share.offer(HELLO, ["hello", "hi"]);
  share.linkAll([FIRST, HELLO], [FIRST, HELLO], Precedence.KEEP);
  assert.equal(
    fs.nodes.get("/bin/hello").target,
    `/nix/store/${FIRST}/bin/hello`,
  );

  // The first NAR has no hello: the second package's takes the link.
  share.write(FIRST, FIRST_ENTRIES);
  assert.deepEqual(share.programsOf(FIRST), ["first"]);
  assert.equal(
    fs.nodes.get("/bin/hello").target,
    `/nix/store/${HELLO}/bin/hello`,
  );
  assert.equal(
    fs.nodes.get("/bin/first").target,
    `/nix/store/${FIRST}/bin/first`,
  );

  // The second NAR backs the link it now has.
  share.write(HELLO, ENTRIES);
  share.link(HELLO, Precedence.KEEP);
  assert.equal(
    fs.nodes.get("/bin/hello").target,
    `/nix/store/${HELLO}/bin/hello`,
  );
});

// Checks that a wrongly listed program no other package has leaves the
// farm when the NAR arrives, so the name is not found rather than found
// and broken.
test("a program no NAR has leaves the farm", () => {
  const fs = fakeMemoryFs();
  const share = storeShare(memoryFsCalls(fs));
  share.offer(FIRST, ["first", "ghost"]);
  share.link(FIRST, Precedence.KEEP);
  assert.equal(
    fs.nodes.get("/bin/ghost").target,
    `/nix/store/${FIRST}/bin/ghost`,
  );

  share.write(FIRST, FIRST_ENTRIES);
  assert.equal(fs.nodes.get("/bin/ghost"), undefined);
  assert.equal(
    fs.nodes.get("/bin/first").target,
    `/nix/store/${FIRST}/bin/first`,
  );
});

// Checks which package takes a link a NAR gave back when several have
// the program: a selected package before a dependency, as a boot's
// batch links the roots first. A dependency offering `hello` comes
// ahead of a second selected package in the share's order, and the
// selected one takes the name. A link the NAR still backs, or that
// names another package, stays as it is.
test("a selected package takes a given-back link before a dependency", () => {
  const fs = fakeMemoryFs();
  const share = storeShare(memoryFsCalls(fs));
  const dependency = "ddd-hello-2.10";
  share.offer(FIRST, ["first", "hello"]);
  share.offer(dependency, ["hello"]);
  share.offer(HELLO, ["hello", "hi"]);
  share.linkAll([FIRST, dependency, HELLO], [FIRST, HELLO], Precedence.KEEP);

  share.write(FIRST, FIRST_ENTRIES);
  assert.equal(
    fs.nodes.get("/bin/hello").target,
    `/nix/store/${HELLO}/bin/hello`,
  );
  assert.equal(fs.nodes.get("/bin/hi").target, `/nix/store/${HELLO}/bin/hi`);
});

// Checks the programs a set of paths offers, as files the guest can
// read: by each path's own bin directory rather than through the farm,
// whose links may name another package.
test("a path's programs are named as its own files", () => {
  const fs = fakeMemoryFs();
  const share = storeShare(memoryFsCalls(fs));
  share.write(HELLO, ENTRIES);
  share.offer("xyz-figlet-2.2.5", ["figlet"]);
  assert.deepEqual(share.programFiles([HELLO]), [
    `/nix/store/${HELLO}/bin/hello`,
    `/nix/store/${HELLO}/bin/hi`,
  ]);
  assert.deepEqual(share.programFiles(["nothing-here"]), []);
});
