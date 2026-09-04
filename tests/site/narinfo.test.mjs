// Tests the narinfo parser in site/js/closure.js against a fixture that
// mirrors what cache.nixos.org serves: every field the walk reads comes
// back typed, references split into basenames, and the digest helper
// takes the leading 32 characters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseNarinfo, digestOf } from "../../site/js/closure.js";

const fixture = new URL("../fixtures/hello.narinfo", import.meta.url);

test("parseNarinfo reads the fields the walk needs", async () => {
  const info = parseNarinfo(await readFile(fixture, "utf8"));

  assert.equal(
    info.storePath,
    "/nix/store/18bbdvag5v2f3d4y37pdbkzvh7s71cw4-hello-2.12.2",
  );
  assert.equal(
    info.url,
    "nar/0fixture0fixture0fixture0fixture0fixture0fixture0000.nar.xz",
  );
  assert.equal(info.compression, "xz");
  assert.equal(info.fileSize, 50560);
  assert.equal(info.narSize, 226504);
  assert.deepEqual(info.references, [
    "18bbdvag5v2f3d4y37pdbkzvh7s71cw4-hello-2.12.2",
    "wx1vk75bpdr65g6xwxbj4rw0pk04v5j3-glibc-2.27",
  ]);
});

test("parseNarinfo treats a missing References line as no references", () => {
  const info = parseNarinfo("StorePath: /nix/store/x\nNarSize: 7\n");
  assert.deepEqual(info.references, []);
  assert.equal(info.narSize, 7);
  assert.equal(info.fileSize, 0);
});

test("digestOf takes the digest half of a store basename", () => {
  assert.equal(
    digestOf("wx1vk75bpdr65g6xwxbj4rw0pk04v5j3-glibc-2.27"),
    "wx1vk75bpdr65g6xwxbj4rw0pk04v5j3",
  );
});
