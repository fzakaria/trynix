// A persistent cache for the bytes that never change: the qemu engine,
// the guest image, the snapshot, and every NAR (a store path is
// immutable by construction — its digest is the hash of its contents,
// so a cached NAR can never be stale).
//
// The Cache API is used rather than OPFS because these are all plain
// GETs and the entries are whole HTTP responses. Cross-origin NARs are
// storable because cache.nixos.org sends CORS headers, which keeps the
// responses non-opaque.
//
// Reads and writes are deliberately separate calls. Handing `put` a
// `response.clone()` while streaming the original tees one body into
// two branches, and a rejected write — hitting the storage quota is the
// ordinary way that happens — errors the branch still being read, which
// surfaces as a bare "TypeError: Failed to fetch" partway through a
// download. So callers buffer the bytes themselves and store them
// afterwards, when nothing depends on the stream any more.
//
// Every call degrades to no caching at all: a private window, blocked
// site data, or a full quota costs a download, never an error.

const CACHE_NAME = "trynix-v1";

let cachePromise;
function openCache() {
  cachePromise ??= caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

// The cached response for a URL, or null.
export async function cachedResponse(url) {
  const cache = await openCache();
  if (cache === null) {
    return null;
  }
  try {
    return (await cache.match(url)) ?? null;
  } catch {
    return null;
  }
}

// Keep bytes for next time. Failure is silent and harmless.
export async function storeInCache(url, bytes) {
  const cache = await openCache();
  if (cache === null) {
    return;
  }
  try {
    await cache.put(url, new Response(bytes));
  } catch {
    // out of quota, or storage denied: the next visit re-downloads
  }
}

// Forget a URL: for a cached body that turned out to be short or
// corrupt, so the next fetch goes to the network.
export async function evictFromCache(url) {
  const cache = await openCache();
  if (cache === null) {
    return;
  }
  try {
    await cache.delete(url);
  } catch {
    // nothing to forget, or storage denied
  }
}
