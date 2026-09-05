// Fetching and parsing narinfos from the binary cache, and walking a
// runtime closure from them. The whole walk is browser fetches against
// cache.nixos.org — no server anywhere.

import { DIGEST_LENGTH, FETCH_CONCURRENCY } from "./config.js";

// A narinfo is "Key: value" lines. References holds the store basenames
// of the direct runtime dependencies; a path may reference itself.
export function parseNarinfo(text) {
  const fields = {};
  // A path signed by several keys carries a Sig line each, so they are
  // collected rather than overwritten.
  const sigs = [];

  for (const line of text.split("\n")) {
    const sep = line.indexOf(": ");
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);
    if (key === "Sig") {
      sigs.push(value);
      continue;
    }
    fields[key] = value;
  }

  return {
    storePath: fields.StorePath,
    url: fields.URL,
    compression: fields.Compression,
    fileSize: Number(fields.FileSize ?? 0),
    fileHash: fields.FileHash,
    narSize: Number(fields.NarSize ?? 0),
    narHash: fields.NarHash,
    sigs,
    references: (fields.References ?? "").split(" ").filter(Boolean),
  };
}

// The digest is the leading 32 characters of a store basename.
export const digestOf = (basename) => basename.slice(0, DIGEST_LENGTH);

// Resolved lazily to avoid a cycle: substituters.js parses narinfos
// with the function above.
async function fetchFrom(digest) {
  const { fetchNarinfo, readSubstituters } = await import("./substituters.js");
  const { info } = await fetchNarinfo(digest, readSubstituters());
  return info;
}

// Breadth-first walk from one root digest to the full runtime closure,
// FETCH_CONCURRENCY narinfos in flight at a time. Returns a Map of
// digest -> parsed narinfo in discovery order; onProgress hears the
// count as it grows.
//
// `known` is a closure already walked. Paths in it are neither fetched
// nor returned, so walking several roots that share a glibc costs one
// fetch of it rather than one per root.
export async function walkClosure(
  rootDigest,
  onProgress = () => {},
  known = new Map(),
) {
  const closure = new Map();
  if (known.has(rootDigest)) {
    return closure;
  }
  const enqueued = new Set([rootDigest, ...known.keys()]);
  let frontier = [rootDigest];

  while (frontier.length > 0) {
    const next = [];

    for (let i = 0; i < frontier.length; i += FETCH_CONCURRENCY) {
      const batch = frontier.slice(i, i + FETCH_CONCURRENCY);
      const infos = await Promise.all(batch.map(fetchFrom));

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
