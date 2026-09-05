// Fetch helpers shared by the boot flow.

import { cachedResponse, storeInCache } from "./cache.js";
import { log } from "./log.js";

// A fetch can simply fail: a connection reset, a CDN hiccup, a browser
// declining under pressure. All of them arrive as a bare TypeError
// with no status and no URL. Retrying a few times turns most of them
// into a slower success rather than a dead boot.
const ATTEMPTS = 4;
const BACKOFF_MS = 400;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
export async function fetchWithProgress(url, options = {}) {
  const hit = await cachedResponse(url);
  if (hit !== null) {
    return drain(hit, options);
  }

  let downloaded = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      // A retry restarts the download, so the progress a failed
      // attempt reported has to be taken back or the bar overcounts.
      const onBytes = (n) => {
        downloaded += n;
        options.onBytes?.(n);
      };
      const bytes = await drain(res, { ...options, onBytes });

      await storeInCache(url, bytes);
      return bytes;
    } catch (err) {
      options.onBytes?.(-downloaded);
      downloaded = 0;

      if (attempt >= ATTEMPTS) {
        log(`giving up on ${url} after ${attempt} attempts: ${err.message}`);
        throw new Error(`${url}: ${err.message}`);
      }
      log(`retrying ${url} (attempt ${attempt} failed: ${err.message})`);
      await delay(BACKOFF_MS * attempt);
    }
  }
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
