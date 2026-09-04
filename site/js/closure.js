// Fetching and parsing narinfos from the binary cache, and walking a
// runtime closure from them. The whole walk is browser fetches against
// cache.nixos.org — no server anywhere.

import { CACHE_URL, DIGEST_LENGTH, FETCH_CONCURRENCY } from "./config.js";

// A narinfo is "Key: value" lines. References holds the store basenames
// of the direct runtime dependencies; a path may reference itself.
export function parseNarinfo(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const sep = line.indexOf(": ");
    if (sep === -1) {
      continue;
    }
    fields[line.slice(0, sep)] = line.slice(sep + 2);
  }

  return {
    storePath: fields.StorePath,
    url: fields.URL,
    compression: fields.Compression,
    fileSize: Number(fields.FileSize ?? 0),
    narSize: Number(fields.NarSize ?? 0),
    references: (fields.References ?? "").split(" ").filter(Boolean),
  };
}

// The digest is the leading 32 characters of a store basename.
export const digestOf = (basename) => basename.slice(0, DIGEST_LENGTH);

async function fetchNarinfo(digest) {
  const res = await fetch(`${CACHE_URL}/${digest}.narinfo`);
  if (!res.ok) {
    throw new Error(`${digest}.narinfo: HTTP ${res.status}`);
  }
  return parseNarinfo(await res.text());
}

// Breadth-first walk from one root digest to the full runtime closure,
// FETCH_CONCURRENCY narinfos in flight at a time. Returns a Map of
// digest -> parsed narinfo in discovery order; onProgress hears the
// count as it grows.
export async function walkClosure(rootDigest, onProgress = () => {}) {
  const closure = new Map();
  const enqueued = new Set([rootDigest]);
  let frontier = [rootDigest];

  while (frontier.length > 0) {
    const next = [];

    for (let i = 0; i < frontier.length; i += FETCH_CONCURRENCY) {
      const batch = frontier.slice(i, i + FETCH_CONCURRENCY);
      const infos = await Promise.all(batch.map(fetchNarinfo));

      // Record the batch, then queue every reference the walk has not
      // seen; the enqueued set is what keeps a diamond dependency from
      // being fetched twice.
      for (const [j, info] of infos.entries()) {
        closure.set(batch[j], info);
        onProgress(closure.size);

        for (const ref of info.references) {
          const digest = digestOf(ref);
          if (enqueued.has(digest)) {
            continue;
          }
          enqueued.add(digest);
          next.push(digest);
        }
      }
    }

    frontier = next;
  }

  return closure;
}
