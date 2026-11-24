// Tests fetching a URL into bytes (site/js/net.js) when the network
// stops partway: a download that goes quiet is given up and tried
// again, and one that is slow but keeps sending bytes is left to
// finish however long it takes. fetch is a stand-in whose body sends
// the chunks the test gives it, each after a delay, and errors when
// the request's signal aborts, as a browser's body does.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchWithProgress } from "../../site/js/net.js";

// No Cache API under node: every fetch goes to the network.
globalThis.caches = { open: () => Promise.resolve(null) };

// How long the tests let a download go quiet before it counts as
// stalled, and the delay between chunks of a slow download that keeps
// moving: longer in all than the limit, shorter each time.
const IDLE_MS = 100;
const SLOW_CHUNK_MS = 30;

// A test that would hang without the fix fails at this limit instead.
const TEST_LIMIT_MS = 5000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fetch whose nth call answers with attempts[n], { chunks, stalls }:
// each chunk, { after, bytes }, is sent `after` ms after the one
// before, and the body ends after the last unless `stalls` is set.
// Returns a record whose `count` is the number of calls so far.
function fakeFetch(attempts) {
  const calls = { count: 0 };
  globalThis.fetch = async (url, { signal } = {}) => {
    const { chunks, stalls } = attempts[calls.count];
    calls.count += 1;
    const body = new ReadableStream({
      async start(controller) {
        signal?.addEventListener("abort", () =>
          controller.error(signal.reason),
        );
        for (const { after, bytes } of chunks) {
          await delay(after);
          if (signal?.aborted) {
            return;
          }
          controller.enqueue(new Uint8Array(bytes));
        }
        if (!stalls) {
          controller.close();
        }
      },
    });
    return new Response(body);
  };
  return calls;
}

// Checks that a download that stops sending bytes partway is given up
// once it has been quiet for the limit, and fetched again; the bytes
// the stalled attempt reported are taken back from the progress count.
test(
  "a download that stalls is given up and fetched again",
  { timeout: TEST_LIMIT_MS },
  async () => {
    const calls = fakeFetch([
      { chunks: [{ after: 0, bytes: [1, 2] }], stalls: true },
      { chunks: [{ after: 0, bytes: [1, 2, 3, 4] }], stalls: false },
    ]);
    let counted = 0;

    const bytes = await fetchWithProgress("https://cache.example/nar", {
      idleMs: IDLE_MS,
      onBytes: (n) => {
        counted += n;
      },
    });

    assert.deepEqual([...bytes], [1, 2, 3, 4]);
    assert.equal(calls.count, 2);
    assert.equal(counted, 4);
  },
);

// Checks that a download slower in all than the limit, which never goes
// quiet for as long as the limit, is not cut off.
test(
  "a slow download that keeps sending bytes finishes",
  { timeout: TEST_LIMIT_MS },
  async () => {
    const chunks = [1, 2, 3, 4, 5, 6, 7, 8].map((byte) => ({
      after: SLOW_CHUNK_MS,
      bytes: [byte],
    }));
    const calls = fakeFetch([{ chunks, stalls: false }]);

    const bytes = await fetchWithProgress("https://cache.example/slow", {
      idleMs: IDLE_MS,
    });

    assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(calls.count, 1);
  },
);
