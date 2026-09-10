// The picker's honesty rides on one pure function: mergeVersions joins
// the multiverse's two indexes — every version that ever shipped, and
// the ones with an x86_64-linux store path — and labels each with what
// trynix can do about it. A version dropped from the list is a version
// the reader is never told about, so the states are pinned here against
// the shard shapes the site actually serves.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  State,
  bootable,
  mergeVersions,
  multiverseUrl,
} from "../../site/js/multiverse.js";

// A meta-shard entry: `d` digest, `ok` census verdict (1 alive, 0 gone,
// absent for a path nobody probed), sizes.
const built = (d, ok) => ({ d, ...(ok === undefined ? {} : { ok }), cs: 100 });

test("mergeVersions labels each version by which index holds it", () => {
  const indexed = { 2.1: 999, "2.0": 998, 1.9: 997, 1.8: 996 };
  const meta = {
    2.1: built("aaaa", 1), // in both, census alive
    "2.0": built("bbbb", undefined), // in both, never probed
    1.9: built("cccc", 0), // in both, census found it gone
    // 1.8 is only in the versions index: no build for this system
  };

  const rows = mergeVersions("pkg", indexed, meta);
  const byVersion = Object.fromEntries(rows.map((r) => [r.version, r]));

  assert.equal(byVersion["2.1"].state, State.LIVE);
  assert.equal(byVersion["2.0"].state, State.UNPROBED);
  assert.equal(byVersion["1.9"].state, State.GONE);
  assert.equal(byVersion["1.8"].state, State.UNBUILT);
});

test("mergeVersions keeps every version, newest first", () => {
  const rows = mergeVersions(
    "pkg",
    { "1.0": 1, "10.0": 2, "2.0": 3 },
    { "2.0": built("bbbb", 1) },
  );
  assert.deepEqual(
    rows.map((r) => r.version),
    ["10.0", "2.0", "1.0"],
  );
  // None dropped: the count the picker shows matches the index's.
  assert.equal(rows.length, 3);
});

test("bootable is exactly the two states with a fetchable path", () => {
  const rows = mergeVersions(
    "pkg",
    { 4: 1, 3: 2, 2: 3, 1: 4 },
    { 4: built("a", 1), 3: built("b", undefined), 2: built("c", 0) },
  );
  const state = (v) => rows.find((r) => r.version === v);

  assert.equal(bootable(state("4")), true); // live
  assert.equal(bootable(state("3")), true); // unprobed — worth attempting
  assert.equal(bootable(state("2")), false); // gone
  assert.equal(bootable(state("1")), false); // no build
});

test("an unbuilt version carries no digest to boot", () => {
  const [row] = mergeVersions("pkg", { "1.0": 1 }, undefined);
  assert.equal(row.state, State.UNBUILT);
  assert.equal(row.digest, null);
  assert.equal(row.storePath, null);
});

test("a built version resolves to its store path", () => {
  const [row] = mergeVersions("hello", { 2.12: 1 }, { 2.12: built("d", 1) });
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
