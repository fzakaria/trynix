// The translation cache in the browser: the Cache API, one entry per
// region, keyed by a URL that names the store path, the file and the
// offset the region starts at. The Cache API is asynchronous and the
// worker translates synchronously, so the page loads every entry for
// the closure's store paths before the process starts and hands them
// over, and stores what the worker translates as it reports it.
//
// Keys look like
//   https://translations.trynix.invalid/v1/nix/store/<path>/bin/x@8f790#1
// where the fragment is the translator's version; the host is a name
// nothing serves, so a miss can never turn into a network fetch.

const CACHE_NAME = "trynix-translations-v1";
const KEY_ORIGIN = "https://translations.trynix.invalid/v1";
const HEADER_OFFSETS = "x-trynix-blocks";
const HEADER_UNSUPPORTED = "x-trynix-unsupported";

const toUrl = (key) => `${KEY_ORIGIN}${key.replace("#", "%23")}`;
const fromUrl = (url) => decodeURIComponent(url.slice(KEY_ORIGIN.length));

export async function openTranslationCache() {
  if (typeof caches === "undefined") {
    return null;
  }
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

// Every cached region whose file lies under one of the store paths.
export async function loadTranslations(cache, storePaths) {
  const out = [];
  if (cache === null) {
    return out;
  }
  const prefixes = storePaths.map((p) => `${KEY_ORIGIN}${p}`);
  const requests = await cache.keys();
  const wanted = requests.filter((r) => prefixes.some((p) => r.url.startsWith(p)));
  await Promise.all(
    wanted.map(async (request) => {
      const response = await cache.match(request);
      if (!response) {
        return;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const offsets = JSON.parse(response.headers.get(HEADER_OFFSETS) ?? "[]");
      const unsupported = JSON.parse(response.headers.get(HEADER_UNSUPPORTED) ?? "[]");
      out.push({ key: fromUrl(request.url), bytes, offsets, unsupported });
    }),
  );
  return out;
}

export async function storeTranslation(cache, { key, bytes, offsets, unsupported }) {
  if (cache === null) {
    return;
  }
  const headers = new Headers({
    "content-type": "application/wasm",
    [HEADER_OFFSETS]: JSON.stringify(offsets),
    [HEADER_UNSUPPORTED]: JSON.stringify(unsupported),
  });
  await cache.put(toUrl(key), new Response(bytes, { headers }));
}

export async function clearTranslations() {
  if (typeof caches !== "undefined") {
    await caches.delete(CACHE_NAME);
  }
}
