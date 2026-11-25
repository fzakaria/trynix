// Tests the narinfo parser in site/js/closure.js against a fixture that
// mirrors what cache.nixos.org serves: every field the walk reads comes
// back typed, references split into basenames, and the digest helper
// takes the leading 32 characters. And what part of a walked closure
// one program reaches, from a closure built by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseNarinfo, digestOf, reachable } from "../../site/js/closure.js";

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

test("parseNarinfo collects every signature, not the last one", () => {
  const info = parseNarinfo(
    [
      "StorePath: /nix/store/x",
      "Sig: cache.nixos.org-1:aaa",
      "Sig: other-1:bbb",
      "",
    ].join("\n"),
  );
  assert.deepEqual(info.sigs, ["cache.nixos.org-1:aaa", "other-1:bbb"]);
});

test("digestOf takes the digest half of a store basename", () => {
  assert.equal(
    digestOf("wx1vk75bpdr65g6xwxbj4rw0pk04v5j3-glibc-2.27"),
    "wx1vk75bpdr65g6xwxbj4rw0pk04v5j3",
  );
});

// A digest per name, from a hash of the name, so two packages in one
// closure do not share one.
const ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
const DIGEST_LENGTH = 32;
function digestFor(name) {
  let hash = 0;
  let digest = "";
  for (let i = 0; i < DIGEST_LENGTH; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i % name.length) + i) >>> 0;
    digest += ALPHABET[hash % ALPHABET.length];
  }
  return digest;
}
const basenameFor = (name) => `${digestFor(name)}-${name}`;

// A closure as the walk returns it, from { name: [references] }.
function closureOf(graph) {
  return new Map(
    Object.entries(graph).map(([name, refs]) => [
      digestFor(name),
      {
        storePath: `/nix/store/${basenameFor(name)}`,
        references: refs.map(basenameFor),
      },
    ]),
  );
}

// Checks that reachability follows references from the given roots
// only, which is how the page asks what one selected program's own
// closure holds (activity.js, opensWindows): of an X11 program and a
// Wayland program selected together, the X11 program's closure holds
// no libwayland, and the Wayland program's holds GTK and libX11.
test("reachable follows references from the roots alone", () => {
  const closure = closureOf({
    "xeyes-1.3.1": ["libx11-1.8.14", "glibc-2.44"],
    "galculator-2.1.4": ["gtk+3-3.24.52", "glibc-2.44"],
    "gtk+3-3.24.52": ["libx11-1.8.14", "wayland-1.26.0", "glibc-2.44"],
    "libx11-1.8.14": ["libxcb-1.17.0", "glibc-2.44"],
    "libxcb-1.17.0": ["glibc-2.44"],
    "wayland-1.26.0": ["glibc-2.44"],
    "glibc-2.44": [],
  });
  const names = (digests) =>
    [...reachable(closure, digests).values()].map((info) =>
      info.storePath.slice("/nix/store/".length + DIGEST_LENGTH + 1),
    );
  assert.deepEqual(names([digestFor("xeyes-1.3.1")]).sort(), [
    "glibc-2.44",
    "libx11-1.8.14",
    "libxcb-1.17.0",
    "xeyes-1.3.1",
  ]);
  assert.ok(names([digestFor("galculator-2.1.4")]).includes("wayland-1.26.0"));
});
