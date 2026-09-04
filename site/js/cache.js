// A persistent cache for the bytes that never change: the qemu engine,
// the guest image, and every NAR (a store path is immutable by
// construction — its digest is the hash of its contents, so a cached
// NAR can never be stale).
//
// The Cache API is used rather than OPFS because these are all plain
// GETs and the entries are whole HTTP responses. Cross-origin NARs are
// storable because cache.nixos.org sends CORS headers, which keeps the
// responses non-opaque.
//
// Every call degrades to a plain fetch: a private window, blocked site
// data, or an evicted entry costs a download, never an error.

const CACHE_NAME = "trynix-v1";

let cachePromise;
function openCache() {
  cachePromise ??= caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

// Returns { response, cached }. The caller streams the response as
// usual; `cached` says whether it came off disk, so the UI can tell the
// reader why a stage finished instantly.
export async function cachedFetch(url) {
  const cache = await openCache();

  if (cache !== null) {
    try {
      const hit = await cache.match(url);
      if (hit !== undefined) {
        return { response: hit, cached: true };
      }
    } catch {
      // an unreadable cache is a cache miss
    }
  }

  const response = await fetch(url);
  if (response.ok && cache !== null) {
    // The clone is drained by the cache while the caller streams the
    // original; a failed write costs nothing but a future download.
    cache.put(url, response.clone()).catch(() => {});
  }
  return { response, cached: false };
}
