// Resolving package attributes against the nixpkgs-multiverse index,
// fetched straight from the deployed site (CORS is open on it). Two
// files answer everything trynix needs, both sharded by the first two
// characters of the attribute:
//
//   versions/<shard>.json  every version an attribute ever shipped
//   meta/<shard>.json      the x86_64-linux store-path digest per
//                          version, plus sizes and the census verdict
//
// The meta shard is fetched whole rather than per attribute because its
// reference lists are indices into a shard-level intern table.

import { MULTIVERSE_URL } from "./config.js";

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

// Every version of one attribute that has an x86_64-linux store path,
// newest first, as { version, digest, name, storePath, alive, fileSize,
// closureSize, closureCount }.
//
// `alive` has three states, matching the index: true (the census
// fetched it), false (the census found it gone), and null (nobody ever
// looked) — a boot of an unprobed path is worth attempting, a boot of a
// known-dead one is not.
export async function versionsOf(attr) {
  const meta = await fetchShard("meta", attr);
  const entries = meta.attrs?.[attr];
  if (entries === undefined) {
    return [];
  }

  return Object.entries(entries)
    .map(([version, entry]) => ({
      attr,
      version,
      digest: entry.d,
      name: entry.n ?? `${attr}-${version}`,
      storePath: `/nix/store/${entry.d}-${entry.n ?? `${attr}-${version}`}`,
      alive: entry.ok === undefined ? null : entry.ok === 1,
      fileSize: entry.fs ?? 0,
      closureSize: entry.cs ?? 0,
      closureCount: entry.cn ?? 0,
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
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
