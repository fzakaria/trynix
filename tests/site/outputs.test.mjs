// Tests that the lookup of a package's bin output (outputs.js) fails
// rather than answering "no bin output" when its shard could not be
// read, and fetches the shard again next time. An answer of "none" for
// a failed fetch booted a split package without its programs, and kept
// doing so for every path in that shard for the life of the page. The
// global fetch is stubbed, and each test uses a shard of its own, since
// the module keeps every shard it loads.
import { test } from "node:test";
import assert from "node:assert/strict";

import { binOutputOf } from "../../site/js/outputs.js";
import { jsonResponse, statusResponse, stubFetch } from "./stub-fetch.mjs";

// A default output and its bin output, in an outputs shard.
const siblings = (digest, bin) => jsonResponse({ [digest]: { bin } });

// Checks that a failed fetch fails the lookup, naming the shard, and
// that the next lookup fetches the shard again and finds the bin output.
test("a bin output is looked up again after a failed fetch", async (t) => {
  const digest = "oa000000000000000000000000000000";
  const bin = "ob000000000000000000000000000000";
  const stub = stubFetch(t, [
    new TypeError("Failed to fetch"),
    siblings(digest, bin),
  ]);

  await assert.rejects(binOutputOf(digest), /\/oa\.json: Failed to fetch/);
  assert.equal(await binOutputOf(digest), bin);
  assert.equal(stub.calls, 2);
});

// Checks that a server error fails the lookup too, and is not kept.
test("a bin output is looked up again after a server error", async (t) => {
  const digest = "oc000000000000000000000000000000";
  const bin = "od000000000000000000000000000000";
  const stub = stubFetch(t, [statusResponse(503), siblings(digest, bin)]);

  await assert.rejects(binOutputOf(digest), /\/oc\.json: HTTP 503/);
  assert.equal(await binOutputOf(digest), bin);
  assert.equal(stub.calls, 2);
});

// Checks that a missing shard means no bin output, and is kept: no path
// in it has siblings worth carrying.
test("a path in a missing outputs shard has no bin output", async (t) => {
  const digest = "oe000000000000000000000000000000";
  const stub = stubFetch(t, [statusResponse(404)]);

  assert.equal(await binOutputOf(digest), null);
  assert.equal(await binOutputOf(digest), null);
  assert.equal(stub.calls, 1);
});
