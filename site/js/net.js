// Fetch helpers shared by the boot flow.

import { cachedResponse, evictFromCache, storeInCache } from "./cache.js";
import { CacheResult } from "./analytics.js";
import { log } from "./log.js";

// A fetch can simply fail: a connection reset, a CDN hiccup, a browser
// declining under pressure. All of them arrive as a bare TypeError
// with no status and no URL. Retrying a few times turns most of them
// into a slower success rather than a dead boot.
const ATTEMPTS = 4;
const BACKOFF_MS = 400;

// How long a download may go without a byte before it counts as stalled
// and is retried like any other failed attempt. The clock starts again
// with every chunk, so a slow download that keeps moving is never cut
// off however long it takes; gcc's 82 MiB on a slow line takes
// minutes. One that has stopped would otherwise never end: a lazily
// served share has no request timeout (unkernel.js), so a guest lookup
// waiting on the download would wait forever.
//
// The window weighs two costs. Too short, and a slow link's pauses, a
// phone's on a poor signal or a nested page's, start a download over
// from its first byte; too long, and the reader waits that long on a
// program whose file is not coming. Half a minute without a single
// byte is the choice. Time the page itself was held up, as a phone's
// tab in the background and a nested page are, does not count
// (stallGuard).
const IDLE_TIMEOUT_MS = 30000;

// A guard's timer that fires later than this share of the window after
// it was due says the page itself was held up meanwhile: a tab in the
// background, a phone that slept, a thread busy with something else.
// Bytes may have arrived in that time and still wait their turn to be
// read, so the guard looks again this share of the window later, once,
// before it calls the download stalled.
const LATE_SHARE = 0.1;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An abort of `controller` once `ms` pass without a call to moved().
// One timer, set again for the time left when it fires early, rather
// than one per chunk.
function stallGuard(controller, ms) {
  const late = ms * LATE_SHARE;
  let last = Date.now();
  let due = 0;
  let timer;
  // Whether the look about to happen was put off for a late timer. A
  // look is put off once at most, so a page held up all the time still
  // gives up on a download that has stopped.
  let putOff = false;

  const arm = (wait) => {
    due = Date.now() + wait;
    timer = setTimeout(check, wait);
  };
  const check = () => {
    const now = Date.now();

    // The timer fired well after it was due: the page was held up, and
    // what arrived meanwhile gets read before the quiet is measured.
    if (now - due > late && !putOff) {
      putOff = true;
      arm(late);
      return;
    }
    putOff = false;

    // Quiet for the whole window: the download has stopped.
    const quiet = now - last;
    if (quiet >= ms) {
      controller.abort(new Error(`no bytes for ${ms / 1000} s`));
      return;
    }
    arm(ms - quiet);
  };
  arm(ms);

  return {
    moved() {
      last = Date.now();
    },
    stop: () => clearTimeout(timer),
  };
}

// Read a response body into one buffer, reporting chunk sizes as they
// arrive.
async function drain(res, { onBytes, onTotal } = {}) {
  const length = res.headers.get("Content-Length");
  onTotal?.(length === null ? null : Number(length));

  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
    onBytes?.(value.byteLength);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Fetch a URL into bytes, through the persistent cache. A hit is read
// from storage (and still reports its size, so a progress row fills);
// a miss is fetched, returned, and stored once it is complete.
// onCacheRead reports the source and size of each completed byte read.
//
// A download that goes `options.idleMs` (IDLE_TIMEOUT_MS by default)
// without a byte is abandoned and retried.
//
// `verify(bytes)` resolves to null for good bytes and to a reason for
// bad ones. A body can arrive short without the fetch failing — a
// mobile connection that drops mid-download looks like a clean end —
// and a bad body must be neither used nor kept: a cached hit that
// fails is evicted and fetched again, a download that fails is retried
// like any other failed attempt, and only what passes is stored.
//
// The error of the last failed attempt is the `cause` of what this
// throws: a TypeError there means no response came at all, which is
// also how a browser refuses a host that sends no CORS headers.
export async function fetchWithProgress(url, options = {}) {
  const verify = options.verify ?? (async () => null);

  const hit = await cachedResponse(url);
  if (hit !== null) {
    const bytes = await drain(hit, options);
    const problem = await verify(bytes);
    if (problem === null) {
      options.onCacheRead?.(CacheResult.HIT, bytes.byteLength);
      return bytes;
    }
    log(`cached copy of ${url} is bad (${problem}); fetching again`);
    await evictFromCache(url);
    options.onBytes?.(-bytes.byteLength);
  }

  let downloaded = 0;
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const guard = stallGuard(controller, options.idleMs ?? IDLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      // A retry restarts the download, so the progress a failed
      // attempt reported has to be taken back or the bar overcounts.
      const onBytes = (n) => {
        guard.moved();
        downloaded += n;
        options.onBytes?.(n);
      };
      const bytes = await drain(res, { ...options, onBytes });
      guard.stop();

      const problem = await verify(bytes);
      if (problem !== null) {
        throw new Error(problem);
      }

      await storeInCache(url, bytes);
      options.onCacheRead?.(CacheResult.MISS, bytes.byteLength);
      return bytes;
    } catch (err) {
      guard.stop();
      options.onBytes?.(-downloaded);
      downloaded = 0;

      if (attempt >= ATTEMPTS) {
        log(`giving up on ${url} after ${attempt} attempts: ${err.message}`);
        throw new Error(`${url}: ${err.message}`, { cause: err });
      }
      log(`retrying ${url} (attempt ${attempt} failed: ${err.message})`);
      await delay(BACKOFF_MS * attempt);
    }
  }
}

// Download a URL into the browser's HTTP cache and throw the bytes
// away, reporting progress on the way.
//
// This is for the engine's wasm, which the page deliberately does not
// hold: emscripten fetches it by URL and hands the response to
// WebAssembly.instantiateStreaming, which compiles as the bytes arrive
// and lets the browser keep the compiled code across visits — neither
// of which happens for a buffer the page passes in. What the page can
// still do is get the download on its way with a progress bar, so
// that later fetch is answered from the HTTP cache.
export async function warmHttpCache(url, options = {}) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  await drain(res, options);
}

// Run tasks with a bounded number in flight, preserving result order.
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
