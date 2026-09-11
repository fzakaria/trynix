// Resolving package attributes against the nixpkgs-multiverse index,
// fetched straight from the deployed site (CORS is open on it). Three
// files answer everything trynix needs, the first two sharded by the
// first two characters of the attribute and the third by the first two
// of the digest:
//
//   versions/<shard>.json        every version an attribute ever shipped
//   meta-<system>/<shard>.json   the store-path digest per version, plus
//                                sizes and the census verdict
//   identify/<shard>.json        digest -> the (attribute, version) it is
//
// The two indexes do not agree on how many versions there are, and the
// difference is the point. The multiverse records 310,860 (attribute,
// version) pairs across nixpkgs history and holds an x86_64-linux store
// path for 274,729 of them. The other 36,131 were never built for this
// system, being unfree, broken, or taken out of Hydra's jobset. They
// appear in the versions file and not in the meta file, and nothing
// here can boot them. `mergeVersions` joins the two so the picker can
// say so, rather than quietly showing a shorter list than the count
// beside the attribute promised.
//
// The meta shard is fetched whole rather than per attribute because its
// reference lists are indices into a shard-level intern table.

import { MULTIVERSE_SITE_SYSTEM, MULTIVERSE_URL, SYSTEM } from "./config.js";

// The multiverse shard function, ported from its site/js/data.js. Note
// it does NOT pad: a one-character attribute lands in a one-character
// shard. (grail's own shard function pads to two — the two indexes are
// not interchangeable.)
export const shardOf = (attr) =>
  [...attr.slice(0, 2).toLowerCase()]
    .map((c) => (/[a-z0-9]/.test(c) ? c : "_"))
    .join("") || "_";

const shardCache = new Map();

function fetchShard(dir, attr) {
  const key = `${dir}/${shardOf(attr)}`;
  if (!shardCache.has(key)) {
    shardCache.set(
      key,
      fetch(`${MULTIVERSE_URL}/${key}.json`).then((res) => {
        // A missing shard means no attribute starts with those
        // characters, which is the same answer as a shard that loads
        // and does not hold it.
        if (!res.ok) {
          return { attrs: {} };
        }
        return res.json();
      }),
    );
  }
  return shardCache.get(key);
}

let namesPromise;

// The autocomplete corpus: attribute -> how many versions it ever had.
export function attrNames() {
  namesPromise ??= fetch(`${MULTIVERSE_URL}/names.json`)
    .then((res) => res.json())
    .then((json) => json.attrs);
  return namesPromise;
}

// Whether trynix can attempt this version at all, which is the one
// question the index answers on its own: a version with an
// x86_64-linux store path is offered, a version without one cannot be.
// Everything the resolvers pick goes through this predicate, a range
// and a `?pkg=` in a link included.
//
// The meta shard also carries the census verdict `ok`, the multiverse's
// last fetch of that path, and nothing here reads it. Over the whole
// x86_64-linux index on 2026-09-10 the verdict was present for all
// 274,729 entries and called 11 of them gone, and all 11 are
// downloadable. The census of 2026-09-06 listed 30 digests across the
// three published systems whose narinfo answered and whose NAR did not,
// and cache.nixos.org served the narinfo and the NAR for all 30 when
// they were re-checked. Its NAR check folds "the request ran out of
// retries" into "the bytes are gone" (tools/census.py, `check`), so a
// verdict of gone can be a fact about one HEAD request on one Sunday.
// The page asks the cache itself the moment a version is picked
// (substituters.js, `holdsPath`), which is the answer worth having
// either way.
export const bootable = (v) => v.storePath !== null;

// One meta-shard entry as a version record.
function built(attr, version, entry) {
  const name = entry.n ?? `${attr}-${version}`;
  return {
    attr,
    version,
    digest: entry.d,
    name,
    storePath: `/nix/store/${entry.d}-${name}`,
    fileSize: entry.fs ?? 0,
    closureSize: entry.cs ?? 0,
    closureCount: entry.cn ?? 0,
  };
}

// One version that shipped without an x86_64-linux store path. There is
// no digest to carry, so a boot is not on offer. The row exists to say
// that the version was real and this is not the place to run it.
const unbuilt = (attr, version) => ({
  attr,
  version,
  digest: null,
  name: `${attr}-${version}`,
  storePath: null,
  fileSize: 0,
  closureSize: 0,
  closureCount: 0,
});

// Every version of one attribute that has an x86_64-linux store path,
// newest first, as { version, digest, name, storePath, fileSize,
// closureSize, closureCount }.
export async function versionsOf(attr) {
  const meta = await fetchShard(`meta-${SYSTEM}`, attr);
  const entries = meta.attrs?.[attr];
  if (entries === undefined) {
    return [];
  }

  return Object.entries(entries)
    .map(([version, entry]) => built(attr, version, entry))
    .sort((a, b) => compareVersions(b.version, a.version));
}

// The two indexes joined: every version nixpkgs ever shipped of this
// attribute, newest first, the ones Hydra built for this system
// carrying a store path and the rest carrying none. Pure, so the join
// is testable without the network.
//
// `indexed` is the versions shard's map of version -> revision offset;
// `entries` is the meta shard's map of version -> entry. Either may be
// undefined, since an attribute in neither file is not in the index at
// all.
export function mergeVersions(attr, indexed, entries) {
  const versions = new Set([
    ...Object.keys(indexed ?? {}),
    ...Object.keys(entries ?? {}),
  ]);

  return [...versions]
    .map((version) =>
      entries?.[version] === undefined
        ? unbuilt(attr, version)
        : built(attr, version, entries[version]),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

// The picker's list: every version, bootable or not. Both shards are
// fetched at once, since the answer needs both and one of them is
// already on its way for any attribute the reader has looked at.
export async function versionRowsOf(attr) {
  const [meta, all] = await Promise.all([
    fetchShard(`meta-${SYSTEM}`, attr),
    fetchShard("versions", attr),
  ]);
  return mergeVersions(attr, all.attrs?.[attr], meta.attrs?.[attr]);
}

// Version ordering good enough to sort a picker: numeric runs compare
// as numbers, everything else lexically, and a release sorts above its
// own prereleases (1.2 over 1.2-rc1) because the shorter run wins when
// every shared component is equal.
export function compareVersions(a, b) {
  const split = (v) => v.split(/[.\-_+]/).filter(Boolean);
  const pa = split(a);
  const pb = split(b);

  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isInteger(nx) && Number.isInteger(ny)) {
      if (nx !== ny) {
        return nx - ny;
      }
      continue;
    }
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// Attributes whose name contains the query, best matches first: exact,
// then prefix, then substring, each alphabetically within its class.
export async function searchAttrs(query, limit) {
  const names = await attrNames();
  const q = query.toLowerCase();

  const rank = (name) => {
    if (name === q) {
      return 0;
    }
    return name.startsWith(q) ? 1 : 2;
  };

  return Object.keys(names)
    .filter((name) => name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, limit)
    .map((name) => ({ attr: name, versionCount: names[name] }));
}

// What store path a digest is, when the index knows: { attr, version },
// or null. The multiverse publishes `identify/<xx>.json` keyed by the
// digest's first two characters, covering every system it indexes, so a
// pasted store path can be named rather than left as 32 opaque
// characters. The answer is the same whichever architecture the path is
// for, since a digest belongs to exactly one of them.
//
// A shard is a few tens of KB, so a paste costs one small fetch and
// nothing at all the second time.
const identifyCache = new Map();

export function identify(digest) {
  const shard = digest.slice(0, 2);
  if (!identifyCache.has(shard)) {
    identifyCache.set(
      shard,
      fetch(`${MULTIVERSE_URL}/identify/${shard}.json`)
        .then((res) => (res.ok ? res.json() : {}))
        // A path nobody can name is still a path this page can boot,
        // so a failed lookup answers "unknown" rather than throwing.
        .catch(() => ({})),
    );
  }
  return identifyCache.get(shard).then((entries) => {
    const hit = entries[digest];
    return hit === undefined ? null : { attr: hit[0], version: hit[1] };
  });
}

// The page on nixmultiverse.com for an attribute, or for one version of
// it: where the version came from, which revisions shipped it, what its
// closure looked like, and the `nix run` line that fetches the same
// store path outside the browser. That site's router reads the whole
// route out of the query string, so the link is spelled here rather
// than looked up.
//
// `sys` is left off when trynix's system is the one that site already
// shows, which makes every link the canonical URL it would write for
// itself.
export function multiverseUrl({ attr, version = null }) {
  const params = new URLSearchParams({ pkg: attr });
  if (version !== null) {
    params.set("ver", version);
  }
  if (SYSTEM !== MULTIVERSE_SITE_SYSTEM) {
    params.set("sys", SYSTEM);
  }
  return `${MULTIVERSE_URL}/?${params}`;
}
