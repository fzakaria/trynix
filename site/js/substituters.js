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
// Extra caches are part of the page's state and ride in its link
// (url.js), tried in the order listed after the default. Nothing is
// kept in the browser: a link is the way to share a cachix store path,
// and the key that vouches for it has to travel with it.

import { CACHE_URL, GL_CACHE } from "./config.js";
import { parseNarinfo } from "./closure.js";
import { cachedResponse, storeInCache } from "./cache.js";

// How the page words a path that every configured cache answered for and
// none holds, in the walk's error and on the selection.
export const NOT_FOUND = "not found in any configured cache";

// What vouches for a substituter's narinfos.
export const Trust = Object.freeze({
  // A signature by the substituter's key.
  KEY: "key",
  // Being served from the page's own origin. Whoever can change a file
  // there can change the page's JavaScript, which is what checks
  // signatures, so a key would vouch for nothing the origin does not
  // already. The files are committed to the repository like the page's
  // own source (site/gl/), and each NAR is still checked against its
  // narinfo's NarHash on arrival (store.js).
  SITE: "site",
});

// The site's own binary cache, which serves the GL driver the page
// adds for GL programs (gldriver.js) and nothing cache.nixos.org has.
// An absolute URL, since it is joined to NAR paths and kept as a key
// in the Cache API.
export const SITE_CACHE_URL = globalThis.location
  ? new URL(GL_CACHE, globalThis.location.href).href
  : GL_CACHE;

// Nix's own key for cache.nixos.org, so the default path verifies
// without the reader configuring anything, then the site's cache. The
// order is the lookup order: a path cache.nixos.org holds never costs a
// request to the site.
export const DEFAULT_SUBSTITUTERS = [
  {
    url: CACHE_URL,
    key: "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=",
    trust: Trust.KEY,
  },
  { url: SITE_CACHE_URL, key: null, trust: Trust.SITE },
];

// The extra caches in effect, as the page last set them.
let extra = [];

export function readSubstituters() {
  return [...DEFAULT_SUBSTITUTERS, ...extra];
}

export function setExtraSubstituters(list) {
  extra = list;
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
      return { url: url.replace(/\/$/, ""), key, trust: Trust.KEY };
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
  const served = substituters.find((s) => s.url === info.substituter);
  if (served?.trust === Trust.SITE) {
    return true;
  }
  if (info.sigs.length === 0) {
    return false;
  }
  if (crypto.subtle === undefined) {
    return null;
  }

  for (const sig of info.sigs) {
    const [name, signature] = sig.split(":");
    const match = substituters.find((s) => s.key?.startsWith(`${name}:`));
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
  throw new Error(`${digest}: ${NOT_FOUND}`);
}

// Whether some configured cache holds this path. True, false when every
// cache answered that it does not, and null when not one of them could
// be asked at all, which means offline or a cache that sends no CORS
// headers. Three states, because "the cache does not have it" and "the
// cache could not be reached" are different claims and only the first
// one says a boot cannot work.
//
// This is what the page asks the moment a package is picked. A pasted
// store path has no index entry to consult, and for a version that came
// out of the index the census verdict records the last fetch anyone
// made against the path, which may be a week old. The narinfo this
// fetches lands in the Cache API on the way past, so the closure walk
// that follows a boot finds it already there and the check costs one
// round trip in total.
export async function holdsPath(digest, substituters) {
  let asked = false;

  for (const substituter of substituters) {
    let text;
    try {
      text = await fetchNarinfoText(`${substituter.url}/${digest}.narinfo`);
    } catch {
      // This one could not be asked; another one still might hold it.
      continue;
    }
    asked = true;
    if (text !== null) {
      return true;
    }
  }

  return asked ? false : null;
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
