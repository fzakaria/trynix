// Tests symlink target resolution, which decides whether a package can
// find its own libraries in the guest. A relative NAR target has to
// become an absolute path before it reaches emscripten's filesystem:
// FS.readlink returns an absolute path but stat keeps the relative
// target's length, and the guest's 9p client trusts the length.
import { test } from "node:test";
import assert from "node:assert/strict";

import { absoluteTarget } from "../../site/js/store.js";

const LIB = "/share/nix/store/abc-zlib-1.3.2/lib";

test("a sibling target resolves against the link's own directory", () => {
  assert.equal(
    absoluteTarget(`${LIB}/libz.so.1`, "libz.so.1.3.2"),
    `${LIB}/libz.so.1.3.2`,
  );
});

test("a target that walks up resolves the .. segments", () => {
  assert.equal(
    absoluteTarget(`${LIB}/pkgconfig/z.pc`, "../libz.so"),
    `${LIB}/libz.so`,
  );
  assert.equal(absoluteTarget(`${LIB}/a/b/c`, "./d"), `${LIB}/a/b/d`);
});

test("an absolute target is left alone: it names a store path", () => {
  const target = "/nix/store/xyz-hello-2.12.2/bin/hello";
  assert.equal(absoluteTarget(`${LIB}/hello`, target), target);
});

// Tests which entries of a NAR count as programs: the files under bin/
// that a PATH lookup would run. They become the symlinks in the
// guest's /share/bin, so a data file or a nested directory must not
// be offered as a command.
import { programsOf } from "../../site/js/store.js";

test("executables and symlinks directly under bin/ are programs", () => {
  const entries = [
    { path: "", type: "directory" },
    { path: "bin", type: "directory" },
    {
      path: "bin/rg",
      type: "regular",
      executable: true,
      data: new Uint8Array(),
    },
    { path: "bin/python", type: "symlink", target: "python3.10" },
    {
      path: "bin/README",
      type: "regular",
      executable: false,
      data: new Uint8Array(),
    },
    { path: "bin/sub", type: "directory" },
    {
      path: "bin/sub/tool",
      type: "regular",
      executable: true,
      data: new Uint8Array(),
    },
    {
      path: "lib/libz.so",
      type: "regular",
      executable: true,
      data: new Uint8Array(),
    },
  ];
  assert.deepEqual(programsOf(entries), ["rg", "python"]);
});

test("a package without a bin directory has no programs", () => {
  assert.deepEqual(programsOf([{ path: "", type: "directory" }]), []);
});
