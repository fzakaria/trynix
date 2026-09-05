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
