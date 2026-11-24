// The picker's honesty rides on one pure function. mergeVersions joins
// the multiverse's two indexes, one listing every version that ever
// shipped and the other the versions Hydra built for x86_64-linux, and
// marks which of the two a version came from. A version dropped from
// the list is a version the reader is never told about, so the join is
// pinned here against the shard shapes the site actually serves.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attrNames,
  bootable,
  compareVersions,
  identify,
  mergeVersions,
  multiverseUrl,
  versionsOf,
} from "../../site/js/multiverse.js";
import { matches, parseSpecs } from "../../site/js/ranges.js";
import { jsonResponse, statusResponse, stubFetch } from "./stub-fetch.mjs";

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
// "21.0.5+11", so ?pkg=openjdk booted Java 8. A letter after a release
// is newer than the release, as in Nix, so OpenSSL's 1.1.1t is newer
// than 1.1.1. One rule differs from Nix's: a release is newer than its
// own prereleases (rc, beta and the other words nixpkgs uses for them).
test("versions compare as Nix compares them", () => {
  const newer = (a, b) => assert.ok(compareVersions(a, b) > 0, `${a} > ${b}`);
  newer("21.0.5+11", "8u265-ga");
  newer("2.12.3", "2.10");
  newer("1.2.3", "1.2");
  newer("2.3.1", "2.3a");
  newer("1.0", "1.0pre1");
  newer("0.43.0", "0.9.1");
  newer("1.1.1t", "1.1.1");
  newer("1.1.1t", "1.1.1s");
  newer("9.6p1", "9.6");
  newer("1.2-unstable-2025-01-19", "1.2");
  newer("1.2", "1.2-rc1");
  newer("1.2", "1.2beta3");
  newer("1.0.0", "1.0.0-alpha.1");
  newer("3.0.0", "3.0.0-preview.26");
  newer("3.5", "3.5-DEV1903");
  newer("0.7.0", "0.7.0_rc4");
  newer("1.2-rc1", "1.2-beta3");
  assert.equal(compareVersions("3.10.6", "3.10.6"), 0);
});

// Checks that a range compares with the same order, by matching
// OpenSSL's lettered releases against ">1.1.1": every one of them is a
// release after 1.1.1, and 1.1.1 itself is not after itself.
test("a range accepts the lettered releases after a version", () => {
  const [spec] = parseSpecs("openssl_1_1@>1.1.1");
  assert.equal(matches(spec, "1.1.1t"), true);
  assert.equal(matches(spec, "1.1.1a"), true);
  assert.equal(matches(spec, "1.1.1"), false);
  assert.equal(matches(spec, "1.1.0l"), false);
});

// A meta shard holding one built version of `attr`, as a response.
const metaShard = (attr) =>
  jsonResponse({ attrs: { [attr]: { "1.0": entry("d") } } });

// Each test below asks for an attribute in a shard of its own: the
// page's shard cache lives as long as the module, so a shard another
// test loaded would answer without a fetch.

// Checks that a shard whose fetch failed is not kept: the first lookup
// fails with the fetch's error, and the second fetches again and gets
// the version. A cached failure would fail every later lookup in that
// shard for the life of the page.
test("a shard that failed to load is fetched again", async (t) => {
  const stub = stubFetch(t, [
    new TypeError("Failed to fetch"),
    metaShard("qa"),
  ]);

  await assert.rejects(versionsOf("qa"), /Failed to fetch/);
  const rows = await versionsOf("qa");
  assert.equal(rows[0].version, "1.0");
  assert.equal(stub.calls, 2);
});

// Checks that a server error is a failed lookup rather than an empty
// shard, which would tell the reader the package is not in the index,
// and that it is not kept either.
test("a shard the server could not serve is an error", async (t) => {
  const stub = stubFetch(t, [statusResponse(503), metaShard("qb")]);

  await assert.rejects(versionsOf("qb"), /503/);
  const rows = await versionsOf("qb");
  assert.equal(rows[0].version, "1.0");
  assert.equal(stub.calls, 2);
});

// Checks that a missing shard is an empty one: no attribute starts with
// those characters, and asking again would get the same answer.
test("a missing shard holds no attributes", async (t) => {
  const stub = stubFetch(t, [statusResponse(404)]);

  assert.deepEqual(await versionsOf("qc"), []);
  assert.deepEqual(await versionsOf("qc"), []);
  assert.equal(stub.calls, 1);
});

// Checks that the attribute names behind search and the range box's
// completions are not kept after a failure: a failed fetch and a server
// error each fail the one lookup, naming names.json, and the next
// lookup fetches again and gets the names. A kept failure left search
// dead for the life of the page. Both failures are in one test because
// the names, once loaded, are kept for the module's life.
test("the attribute names are fetched again after a failure", async (t) => {
  const stub = stubFetch(t, [
    new TypeError("Failed to fetch"),
    statusResponse(503),
    jsonResponse({ attrs: { hello: 12 } }),
  ]);

  await assert.rejects(attrNames(), /Failed to fetch/);
  await assert.rejects(attrNames(), /names\.json: HTTP 503/);
  assert.deepEqual(await attrNames(), { hello: 12 });
  assert.equal(stub.calls, 3);
});

// A digest in an identify shard of its own (see the shard tests above),
// and the attribute and version the shard names it as.
const IDENTIFIED = "ia000000000000000000000000000000";

// Checks that a pasted path's name is not lost to a failed lookup: the
// first lookup fails, naming the shard, and the second fetches again
// and names the path. A failure kept as an empty shard left every path
// in that shard unnamed for the life of the page.
test("a path's name is looked up again after a failure", async (t) => {
  const stub = stubFetch(t, [
    new TypeError("Failed to fetch"),
    jsonResponse({ [IDENTIFIED]: ["hello", "2.12"] }),
  ]);

  await assert.rejects(identify(IDENTIFIED), /identify\/ia\.json: Failed/);
  assert.deepEqual(await identify(IDENTIFIED), {
    attr: "hello",
    version: "2.12",
  });
  assert.equal(stub.calls, 2);
});

// Checks that a server error names no path either, and is not kept.
test("a path's name is looked up again after a server error", async (t) => {
  const digest = "ib000000000000000000000000000000";
  const stub = stubFetch(t, [
    statusResponse(503),
    jsonResponse({ [digest]: ["jq", "1.7"] }),
  ]);

  await assert.rejects(identify(digest), /identify\/ib\.json: HTTP 503/);
  assert.deepEqual(await identify(digest), { attr: "jq", version: "1.7" });
  assert.equal(stub.calls, 2);
});

// Checks that a missing identify shard is an answer, kept: no indexed
// path starts with those characters, so the path has no name.
test("a path in a missing identify shard has no name", async (t) => {
  const digest = "ic000000000000000000000000000000";
  const stub = stubFetch(t, [statusResponse(404)]);

  assert.equal(await identify(digest), null);
  assert.equal(await identify(digest), null);
  assert.equal(stub.calls, 1);
});
