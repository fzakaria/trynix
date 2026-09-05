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
export async function fetchNarinfo(digest, substituters) {
  for (const substituter of substituters) {
    let res;
    try {
      res = await fetch(`${substituter.url}/${digest}.narinfo`);
    } catch (err) {
      // A cross-origin refusal lands here with no status to inspect.
      throw new Error(
        `${substituter.url} refused a browser read (no CORS headers?): ${err.message}`,
      );
    }
    if (res.ok) {
      const info = parseNarinfo(await res.text());
      return { info: { ...info, substituter: substituter.url }, substituter };
    }
  }

  throw new Error(`${digest}: no configured cache holds it`);
}
