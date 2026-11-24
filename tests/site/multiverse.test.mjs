// The picker's honesty rides on one pure function. mergeVersions joins
// the multiverse's two indexes, one listing every version that ever
// shipped and the other the versions Hydra built for x86_64-linux, and
// marks which of the two a version came from. A version dropped from
// the list is a version the reader is never told about, so the join is
// pinned here against the shard shapes the site actually serves.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bootable,
  compareVersions,
  mergeVersions,
  multiverseUrl,
} from "../../site/js/multiverse.js";

// A meta-shard entry: `d` digest, `cs` closure size. The entry also
// carries the census verdict `ok`, which nothing here reads, so it is
// left out.
const entry = (d) => ({ d, cs: 100 });

test("mergeVersions keeps the versions with no build for this system", () => {
  const indexed = { 2.1: 999, "2.0": 998, 1.9: 997 };
  const meta = { 2.1: entry("aaaa"), "2.0": entry("bbbb") };

  const rows = mergeVersions("pkg", indexed, meta);
  const byVersion = Object.fromEntries(rows.map((r) => [r.version, r]));

  // In both indexes: a store path, so a boot can be attempted.
  assert.equal(bootable(byVersion["2.1"]), true);
  assert.equal(bootable(byVersion["2.0"]), true);
  // Only in the versions index: nixpkgs shipped it, Hydra never built
  // it here, and there is nothing to fetch.
  assert.equal(bootable(byVersion["1.9"]), false);
});

test("mergeVersions keeps every version, newest first", () => {
  const rows = mergeVersions(
    "pkg",
    { "1.0": 1, "10.0": 2, "2.0": 3 },
    { "2.0": entry("bbbb") },
  );
  assert.deepEqual(
    rows.map((r) => r.version),
    ["10.0", "2.0", "1.0"],
  );
  // None dropped: the count the picker shows matches the index's.
  assert.equal(rows.length, 3);
});

test("a version with no build carries no digest to boot", () => {
  const [row] = mergeVersions("pkg", { "1.0": 1 }, undefined);
  assert.equal(bootable(row), false);
  assert.equal(row.digest, null);
  assert.equal(row.storePath, null);
});

test("a built version resolves to its store path", () => {
  const [row] = mergeVersions("hello", { 2.12: 1 }, { 2.12: entry("d") });
  assert.equal(row.storePath, "/nix/store/d-hello-2.12");
});

// Checks the link for each system, named rather than taken from the
// engine this node would pick: config.js picks unkernel, and with it
// aarch64-linux, wherever WebAssembly has JSPI, so a test that relied
// on the default passed or failed with the node it ran under.
test("multiverseUrl points at the package page, system left implicit", () => {
  // x86_64-linux is the system the index's own pages default to, so a
  // link naming it would not be the canonical URL that site writes.
  assert.equal(
    multiverseUrl({ attr: "ripgrep", system: "x86_64-linux" }),
    "https://nixmultiverse.com/?pkg=ripgrep",
  );
  assert.equal(
    multiverseUrl({
      attr: "ripgrep",
      version: "14.1.0",
      system: "x86_64-linux",
    }),
    "https://nixmultiverse.com/?pkg=ripgrep&ver=14.1.0",
  );
});

// Checks that any other system is named in the link, so the index shows
// the store paths built for the guest the page runs.
test("multiverseUrl names a system other than the index's default", () => {
  assert.equal(
    multiverseUrl({ attr: "ripgrep", system: "aarch64-linux" }),
    "https://nixmultiverse.com/?pkg=ripgrep&sys=aarch64-linux",
  );
});

// Checks that versions compare as Nix's compareVersions does, which is
// what nixpkgs' version strings are written for: a part that mixes
// digits and letters splits at each change, numbers compare as
// numbers, a letter part is older than a number, and "pre" is older
// than anything. openjdk's "8u265-ga" read as text came out newer than
// "21.0.5+11", so ?pkg=openjdk booted Java 8. One rule differs from
// Nix's: a release is newer than its own release candidates.
test("versions compare as Nix compares them", () => {
  const newer = (a, b) => assert.ok(compareVersions(a, b) > 0, `${a} > ${b}`);
  newer("21.0.5+11", "8u265-ga");
  newer("2.12.3", "2.10");
  newer("1.2.3", "1.2");
  newer("2.3.1", "2.3a");
  newer("1.0", "1.0pre1");
  newer("0.43.0", "0.9.1");
  newer("1.2", "1.2-rc1");
  assert.equal(compareVersions("3.10.6", "3.10.6"), 0);
});
