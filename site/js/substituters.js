// The binary caches trynix fetches from, and the signatures it checks.
//
// A cache is usable from a browser only if it allows cross-origin
// reads — cache.nixos.org sends `access-control-allow-origin: *` on
// narinfos and NARs alike. A cache that does not is unreachable from a
// page however correct its contents, and no amount of configuration
// here changes that; working around it would mean a proxy in the
// middle, which costs the no-server-anywhere property the whole
// project is built on.
//
// Extra caches are kept per reader in localStorage, tried in the order
// listed after the default.

import { CACHE_URL } from "./config.js";
import { parseNarinfo } from "./closure.js";
import { cachedResponse, storeInCache } from "./cache.js";

const STORAGE_KEY = "trynix:substituters";

// Nix's own key for cache.nixos.org, so the default path verifies
// without the reader configuring anything.
export const DEFAULT_SUBSTITUTERS = [
  {
    url: CACHE_URL,
    key: "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=",
  },
];

export function readSubstituters() {
  let extra = [];
  try {
    extra = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    // unreadable or absent storage: the defaults still work
  }
  return [...DEFAULT_SUBSTITUTERS, ...extra];
}

export function writeSubstituters(extra) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(extra));
  } catch {
    // a reader in a private window keeps their list for this page only
  }
}

// "https://host cache-name-1:base64key" per line, blanks ignored.
export function parseSubstituters(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [url, key] = line.split(/\s+/);
      if (url === undefined || key === undefined) {
        throw new Error(`each line needs a URL and a public key: "${line}"`);
      }
      return { url: url.replace(/\/$/, ""), key };
    });
}

const decodeBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// What a cache signs: the store path, its NAR hash and size, and its
// references, joined the way nix's own fingerprint does.
function fingerprint(info) {
  const refs = info.references.map((r) => `/nix/store/${r}`).join(",");
  return `1;${info.storePath};${info.narHash};${info.narSize};${refs}`;
}

// True when some configured key signed this narinfo, false when none
// did, and null when the browser cannot check Ed25519 at all (older
// Safari and Chrome before 137) — a third state, because "unverifiable
// here" is not the same claim as "forged".
export async function verify(info, substituters) {
  if (info.sigs.length === 0) {
    return false;
  }
  if (crypto.subtle === undefined) {
    return null;
  }

  for (const sig of info.sigs) {
    const [name, signature] = sig.split(":");
    const match = substituters.find((s) => s.key.startsWith(`${name}:`));
    if (match === undefined) {
      continue;
    }

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        decodeBase64(match.key.slice(name.length + 1)),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        decodeBase64(signature),
        new TextEncoder().encode(fingerprint(info)),
      );
      if (ok) {
        return true;
      }
    } catch {
      // No Ed25519 in this browser: report the third state rather than
      // calling a signature we never examined invalid.
      return null;
    }
  }

  return false;
}

// The first substituter holding this digest, with the narinfo it
// served. The NAR that follows must come from the same one, since a
// narinfo's URL is relative to the cache that served it.
//
// Narinfos are kept in the persistent cache like the NARs: a store
// path's narinfo describes immutable bytes, so a cached one is never
// stale, and a closure walk that has been done before then costs no
// network at all. (A path a cache has since dropped would still walk;
// the NAR fetch is where that surfaces.) A cache that cannot be
// reached is skipped rather than fatal: the next one in the list may
// hold the path, and the reasons are reported together only if none
// does.
export async function fetchNarinfo(digest, substituters) {
  const failures = [];
  for (const substituter of substituters) {
    const url = `${substituter.url}/${digest}.narinfo`;
    let text;
    try {
      text = await fetchNarinfoText(url);
    } catch (err) {
      // A cross-origin refusal lands here with no status to inspect.
      failures.push(`${substituter.url}: ${err.message} (no CORS headers?)`);
      continue;
    }
    if (text === null) {
      continue;
    }
    const info = parseNarinfo(text);
    return { info: { ...info, substituter: substituter.url }, substituter };
  }

  if (failures.length > 0) {
    throw new Error(`${digest}: ${failures.join("; ")}`);
  }
  throw new Error(`${digest}: no configured cache holds it`);
}

// The narinfo text, or null when the cache answers that it has no
// such path. Throws when the cache cannot be asked at all.
async function fetchNarinfoText(url) {
  const hit = await cachedResponse(url);
  if (hit !== null) {
    return hit.text();
  }

  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  const text = await res.text();
  await storeInCache(url, new TextEncoder().encode(text));
  return text;
}
