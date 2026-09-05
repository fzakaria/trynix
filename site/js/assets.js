// Versioned URLs for the large files the page fetches by a stable name:
// the qemu engine, the guest image, the snapshot.
//
// Those are kept in the Cache API, which keys on the URL, so a new
// snapshot published under the old name would never be fetched again.
// assets.json (tools/asset-versions.py) carries a content hash for each
// one and the hash rides as a query string — a changed file is a
// changed URL and a guaranteed miss.
//
// The manifest itself is fetched past the HTTP cache every time. It is
// a few hundred bytes, and it is the one file that must never be stale.

const MANIFEST_URL = "assets.json";

let manifestPromise;

export function manifest() {
  manifestPromise ??= fetch(MANIFEST_URL, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : { files: {} }))
    .catch(() => ({ files: {} }));
  return manifestPromise;
}

// The URL to fetch `path` (site-relative) from. Without a manifest
// entry the path is returned unchanged: a local tree with no versions
// still works, it just caches by name.
export async function asset(path) {
  const { files } = await manifest();
  const version = files?.[path];
  return version === undefined ? path : `${path}?v=${version}`;
}

// Several at once, as a name -> URL map, so a caller can hand the
// whole set to something that resolves names later (emscripten's
// locateFile, for one).
export async function assets(paths) {
  const entries = await Promise.all(
    paths.map(async (path) => [path, await asset(path)]),
  );
  return new Map(entries);
}
