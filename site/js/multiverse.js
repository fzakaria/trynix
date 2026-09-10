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
// difference is the point: the multiverse records 310,860 (attribute,
// version) pairs across nixpkgs history and holds an x86_64-linux store
// path for 274,729 of them. The rest were never built for this system —
// unfree, broken, or taken out of Hydra's jobset — so they are in the
// versions file and not in the meta file, and nothing here can boot
// them. `mergeVersions` joins the two so the picker can say that rather
// than quietly showing a shorter list than the count beside the
// attribute promised.
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

// What the index can say about one version, and what trynix can do
// about it. Four states, and the difference between them is which file
// the version was found in and what the census recorded:
//
//   live      a store path, and the census fetched it — boot it
//   unprobed  a store path nobody has probed — worth attempting
//   gone      a store path the census found missing — the bytes are not
//             in the cache and no boot can bring them back
//   unbuilt   no store path for this system at all: the version shipped
//             in nixpkgs and Hydra never built it here, so there is
//             nothing to fetch
//
// `unprobed` is a real answer rather than a shrug: an entry carries a
// verdict only where something looked, and calling an unexamined path
// either alive or dead would be inventing one. It is offered, and the
// pre-flight probe (app.js) asks the cache the moment it is picked.
export const State = {
  LIVE: "live",
  UNPROBED: "unprobed",
  GONE: "gone",
  UNBUILT: "unbuilt",
};

// Whether trynix can attempt this version at all. Everything the
// resolvers pick — a range, a `?pkg=` in a link — goes through this,
// so nothing is ever selected that provably cannot be fetched.
export const bootable = (v) =>
  v.state === State.LIVE || v.state === State.UNPROBED;

// One meta-shard entry as a version record.
function record(attr, version, entry) {
  const name = entry.n ?? `${attr}-${version}`;
  return {
    attr,
    version,
    digest: entry.d,
    name,
    storePath: `/nix/store/${entry.d}-${name}`,
    // The index's census verdict, folded into one of four boot states.
    // Absent means nobody has probed this path, which is a real answer
    // and not the same as gone.
    state:
      entry.ok === undefined
        ? State.UNPROBED
        : entry.ok === 1
          ? State.LIVE
          : State.GONE,
    fileSize: entry.fs ?? 0,
    closureSize: entry.cs ?? 0,
    closureCount: entry.cn ?? 0,
  };
}

// One version that shipped without an x86_64-linux store path. There is
// no digest to carry, so a boot is not on offer — the row exists to say
// that the version was real and this is not the place to run it.
const unbuilt = (attr, version) => ({
  attr,
  version,
  digest: null,
  name: `${attr}-${version}`,
  storePath: null,
  state: State.UNBUILT,
  fileSize: 0,
  closureSize: 0,
  closureCount: 0,
});

// Every version of one attribute that has an x86_64-linux store path,
// newest first, as { version, digest, name, storePath, state,
// fileSize, closureSize, closureCount }.
export async function versionsOf(attr) {
  const meta = await fetchShard(`meta-${SYSTEM}`, attr);
  const entries = meta.attrs?.[attr];
  if (entries === undefined) {
    return [];
  }

  return Object.entries(entries)
    .map(([version, entry]) => record(attr, version, entry))
    .sort((a, b) => compareVersions(b.version, a.version));
}

// The two indexes joined: every version nixpkgs ever shipped of this
// attribute, newest first, each carrying whichever of the four states
// it earned. Pure, so the join is testable without the network.
//
// `indexed` is the versions shard's map of version -> revision offset;
// `built` is the meta shard's map of version -> entry. Either may be
// undefined — an attribute in neither file is simply not in the index.
export function mergeVersions(attr, indexed, built) {
  const versions = new Set([
    ...Object.keys(indexed ?? {}),
    ...Object.keys(built ?? {}),
  ]);

  return [...versions]
    .map((version) =>
      built?.[version] === undefined
        ? unbuilt(attr, version)
        : record(attr, version, built[version]),
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
// digest's first two characters and covering every system it indexes,
// so a pasted store path can be named rather than left as 32 opaque
// characters — and named the same way whichever architecture it is for,
// since a digest belongs to exactly one of them.
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
// it: where it came from, which revisions shipped it, what its closure
// looked like, and the `nix run` line that fetches the same store path
// outside the browser. Its router reads the whole route out of the
// query string, so the link is spelled here rather than looked up.
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
