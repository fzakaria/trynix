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

test("multiverseUrl points at the package page, system left implicit", () => {
  // x86_64-linux is the system the index's own pages default to, so a
  // link naming it would not be the canonical URL that site writes.
  assert.equal(
    multiverseUrl({ attr: "ripgrep" }),
    "https://nixmultiverse.com/?pkg=ripgrep",
  );
  assert.equal(
    multiverseUrl({ attr: "ripgrep", version: "14.1.0" }),
    "https://nixmultiverse.com/?pkg=ripgrep&ver=14.1.0",
  );
});
