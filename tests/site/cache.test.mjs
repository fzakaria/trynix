// Tests the persistent cache (site/js/cache.js) against a stand-in for
// the Cache API that records what it is handed. Its own file, because
// cache.js opens the Cache API once for the life of the module.
import { test } from "node:test";
import assert from "node:assert/strict";

const stored = new Map();
globalThis.caches = {
  open: async () => ({
    match: async (url) => stored.get(url),
    put: async (url, response) => stored.set(url, response),
  }),
};

const { cachedResponse, storeInCache } = await import("../../site/js/cache.js");

// Checks that bytes are kept with their length as the Content-Length,
// so a later read can allocate one buffer for them before the first
// chunk (net.js), and that they read back the same.
test("stored bytes carry their length", async () => {
  const url = "https://example.org/stored";
  await storeInCache(url, new Uint8Array([1, 2, 3]));
  const response = await cachedResponse(url);
  assert.equal(response.headers.get("Content-Length"), "3");
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [1, 2, 3],
  );
});
