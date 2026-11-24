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

// Spin the thread for `ms`, as a page busy with something else does:
// no timer and no chunk is handled meanwhile.
function holdThread(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Held.
  }
}

// How long the thread is held up in the next test, from when, and when
// the chunk that arrives meanwhile is due: after the download's window
// is up, before the thread is free, so the guard's timer and the chunk
// are both waiting when it is.
const HOLD_START_MS = 10;
const HOLD_MS = 300;
const LATE_CHUNK_MS = 120;

// Checks that a page held up longer than the window, as a phone's tab
// in the background or a page in a guest inside another guest is, does
// not give up a download whose bytes arrived while it was held: the
// guard's timer fires late, before the chunk waiting behind it is read,
// and the quiet it measures is the page's, not the network's.
test(
  "a page held up past the window does not call its download stalled",
  { timeout: TEST_LIMIT_MS },
  async () => {
    const calls = fakeFetch([
      {
        chunks: [
          { after: 0, bytes: [1] },
          { after: LATE_CHUNK_MS, bytes: [2] },
        ],
        stalls: false,
      },
    ]);
    setTimeout(() => holdThread(HOLD_MS), HOLD_START_MS);

    const bytes = await fetchWithProgress("https://cache.example/held", {
      idleMs: IDLE_MS,
    });

    assert.deepEqual([...bytes], [1, 2]);
    assert.equal(calls.count, 1);
  },
);

// The delay between attempts the tests ask for, so a test of every
// attempt failing does not wait out the page's own backoff.
const BACKOFF_MS = 1;

// Checks that a download that stalls on every attempt is given up after
// the last one, with the stall as the reason, and that each failed
// attempt is reported as it fails, numbered against the attempts there
// are: what the page's strip says while the guest waits.
test(
  "a download that stalls every time fails, and each attempt is reported",
  { timeout: TEST_LIMIT_MS },
  async () => {
    const stalled = { chunks: [{ after: 0, bytes: [1] }], stalls: true };
    const calls = fakeFetch([stalled, stalled, stalled, stalled]);
    const failures = [];

    await assert.rejects(
      fetchWithProgress("https://cache.example/stalled", {
        idleMs: IDLE_MS,
        backoffMs: BACKOFF_MS,
        onAttemptFailed: (failure) => failures.push(failure),
      }),
      /no bytes for/,
    );

    assert.equal(failures.length, calls.count);
    assert.deepEqual(
      failures.map(({ attempt }) => attempt),
      Array.from({ length: calls.count }, (_, i) => i + 1),
    );
    for (const { attempts, reason } of failures) {
      assert.equal(attempts, calls.count);
      assert.match(reason, /^no bytes for /);
    }
  },
);
