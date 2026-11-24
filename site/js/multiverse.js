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

// The status a file the index does not have answers with, as opposed
// to one the index failed to serve.
const HTTP_NOT_FOUND = 404;

// One JSON file from the index, fetched once per `key` and kept in
// `cache` for the life of the page. A 404 answers `missing` when the
// caller says what a missing file means; with no `missing`, a 404 fails
// like any other error. A file that could not be read rejects with an
// Error naming the file's URL, and is dropped from the cache, so the
// next lookup fetches the file again. Kept, the failure would fail
// every later lookup for the life of the page, or answer every one of
// them wrongly.
//
// Shared by the index's readers here and in outputs.js, which reads
// the same site.
export function indexFile(cache, key, url, { missing } = {}) {
  if (cache.has(key)) {
    return cache.get(key);
  }

  const file = fetch(url)
    .then((res) => {
      if (res.status === HTTP_NOT_FOUND && missing !== undefined) {
        return missing;
      }
      // Any other failure says nothing about what the index holds.
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    })
    .catch((err) => {
      throw new Error(`${url}: ${err.message}`);
    });
  cache.set(key, file);

  // Dropped once it fails, unless a newer fetch already took its place.
  file.catch(() => {
    if (cache.get(key) === file) {
      cache.delete(key);
    }
  });
  return file;
}

const shardCache = new Map();

// A missing shard means no attribute starts with those characters,
// which is the same answer as a shard that loads and does not hold it.
function fetchShard(dir, attr) {
  const key = `${dir}/${shardOf(attr)}`;
  return indexFile(shardCache, key, `${MULTIVERSE_URL}/${key}.json`, {
    missing: { attrs: {} },
  });
}

// The autocomplete corpus: attribute -> how many versions it ever had.
// The index always has the file, so a missing one is a failure too.
const NAMES = "names.json";
const namesCache = new Map();

export function attrNames() {
  return indexFile(namesCache, NAMES, `${MULTIVERSE_URL}/${NAMES}`).then(
    (json) => json.attrs,
  );
}

// Whether trynix can attempt this version at all, which is the one
// question the index answers on its own: a version with an
// x86_64-linux store path is offered, a version without one cannot be.
// Everything the resolvers pick goes through this predicate, a range
// and a `?pkg=` in a link included.
//
// The meta shard also carries the census verdict `ok`, the multiverse's
// last fetch of that path, and nothing here reads it. The verdict is up
// to a week old and the boot needs that narinfo regardless, so the page
// asks the cache itself the moment a version is picked
// (substituters.js, `holdsPath`) and gets a live answer, which covers
// the paths cache.nixos.org drops next week as well as the ones it has
// dropped already. That second set is close to empty: every one of the
// 274,729 x86_64-linux entries carried a verdict on 2026-09-10, and the
// census of 2026-09-06 found all 607,535 indexed narinfos still served
// across the three published systems.
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

// Version ordering for the picker and for a link's newest version, as
// Nix's compareVersions orders nixpkgs' version strings, with one
// change: a release sorts above its own prereleases (1.2 over 1.2-rc1,
// 1.2beta3 and Python's 1.2a1), where Nix puts the prerelease first.
//
// Two versions compare part by part, each part by its kind first and
// its spelling only within a kind (partKey), which keeps the order
// total. Comparing a prerelease word with a release's letter by
// spelling put 3.15.0a1 above 3.15.0, 3.15.0 above 3.15.0rc1 and
// 3.15.0rc1 above 3.15.0a1, so a sort's answer hung on the order it
// was handed the versions in.
export function compareVersions(a, b) {
  const ka = versionKeys(a);
  const kb = versionKeys(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
    const order = compareKeys(ka[i] ?? MISSING, kb[i] ?? MISSING);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

// The parts of a version as Nix splits them (libstore/names.cc,
// nextComponent): runs of digits and runs of anything else, with "."
// and "-" between parts. "8u265-ga" is 8, u, 265, ga.
const VERSION_PART = /\d+|[^.\-\d]+/g;

// Python's alpha and beta letters: an "a" or "b" glued between a
// release and a number, with nothing glued after the number, as in
// 3.15.0a1 and 6.0.0b3. Every such version in the multiverse whose
// release also shipped came before that release (57 alphas, 66
// betas). The same letter ending a version is a release after it
// (OpenSSL's 1.1.1a), and after a separator it starts a commit hash
// (0.0.6-a31eadd7), so neither of those matches.
const ALPHA_BETA = /(?<=\d)[ab](?=\d+(?:[.\-]|$))/g;

// A milestone, as Java and Scala projects write one: an "M" after a
// separator and before a number, as in 2.1.0-M7 and 9.0.0.M10. Every
// version of that shape in the multiverse is a milestone, and the five
// whose release also shipped came before that release.
const MILESTONE = /(?<=[.\-])[Mm](?=\d+(?:[.\-]|$))/g;

// The single letters that are a prerelease where they stand.
const PRERELEASE_LETTERS = [ALPHA_BETA, MILESTONE];

// Each part of a version as the key it sorts by. A prerelease letter
// sorts as its lowercase self among the prerelease words, where "m"
// comes after "dev" and before "rc".
function versionKeys(version) {
  const letters = new Set(
    PRERELEASE_LETTERS.flatMap((pattern) =>
      [...version.matchAll(pattern)].map((match) => match.index),
    ),
  );
  return [...version.matchAll(VERSION_PART)].map((match) =>
    letters.has(match.index)
      ? { kind: PartKind.PRERELEASE, value: match[0].toLowerCase() }
      : partKey(match[0]),
  );
}

const isNumber = (part) => /^\d+$/.test(part);

// What a version part is, oldest kind first. Two parts of different
// kinds compare by kind alone. These are Nix's rules (componentsLT):
// "pre" is older than anything, a missing part is older than a number
// and than letters, and letters are older than a number, so 2.3a is
// older than 2.3.1. The one change from Nix is PRERELEASE, below a
// missing part, so 1.2 is newer than 1.2-rc1 while 1.1.1t stays newer
// than 1.1.1.
const PartKind = Object.freeze({
  PRE: 0,
  PRERELEASE: 1,
  MISSING: 2,
  WORD: 3,
  NUMBER: 4,
});

// The key past the end of the shorter of two versions.
const MISSING = { kind: PartKind.MISSING, value: "" };

// The part Nix counts older than any other.
const PRE = "pre";

// The words nixpkgs versions use for a build that comes before the
// release it names: "1.0.0-rc.1", "1.2beta3", "3.0.0-preview.26",
// "3.5-DEV1903", "1.7.0-prerelease-1". Each one counts as older than
// the release itself. The list is every word that, in the multiverse's
// versions, follows a release that also shipped and nearly always
// shipped before that release. Single letters stay off the list:
// OpenSSL's 1.1.1t and OpenSSH's 9.6p1 come after 1.1.1 and 9.6, and
// "a", "b" and "M" are a prerelease only where Python writes an alpha
// or beta and Java a milestone (PRERELEASE_LETTERS).
const PRERELEASE_WORDS = new Set([
  PRE,
  "rc",
  "alpha",
  "beta",
  "dev",
  "preview",
  "prerelease",
  "nightly",
]);

// A part as { kind, value }. A number's value is the number. A
// prerelease word's is the word without case or punctuation, so "DEV"
// and "_rc" count as "dev" and "rc", and 1.0_rc4 sorts above 1.0beta3.
// Any other letters keep their spelling.
function partKey(part) {
  if (isNumber(part)) {
    return { kind: PartKind.NUMBER, value: Number(part) };
  }

  const word = part.toLowerCase().replace(/[^a-z]/g, "");
  if (word === PRE) {
    return { kind: PartKind.PRE, value: word };
  }
  if (PRERELEASE_WORDS.has(word)) {
    return { kind: PartKind.PRERELEASE, value: word };
  }
  return { kind: PartKind.WORD, value: part };
}

// Two part keys compared, kind first and then value, as -1, 0 or 1.
function compareKeys(a, b) {
  if (a.kind !== b.kind) {
    return Math.sign(a.kind - b.kind);
  }
  if (a.value < b.value) {
    return -1;
  }
  if (a.value > b.value) {
    return 1;
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
// nothing at all the second time. A missing shard means no indexed path
// starts with those characters, so the path has no name. A shard that
// could not be read rejects, and the next paste in it asks again.
const identifyCache = new Map();

export function identify(digest) {
  const shard = digest.slice(0, 2);
  const url = `${MULTIVERSE_URL}/identify/${shard}.json`;
  return indexFile(identifyCache, shard, url, { missing: {} }).then(
    (entries) => {
      const hit = entries[digest];
      return hit === undefined ? null : { attr: hit[0], version: hit[1] };
    },
  );
}

// The page on nixmultiverse.com for an attribute, or for one version of
// it: where the version came from, which revisions shipped it, what its
// closure looked like, and the `nix run` line that fetches the same
// store path outside the browser. That site's router reads the whole
// route out of the query string, so the link is spelled here rather
// than looked up.
//
// `sys` is left off when the system is the one that site already
// shows, which makes every link the canonical URL it would write for
// itself. `system` is the guest's (config.js), and a parameter so the
// tests can name one.
export function multiverseUrl({ attr, version = null, system = SYSTEM }) {
  const params = new URLSearchParams({ pkg: attr });
  if (version !== null) {
    params.set("ver", version);
  }
  if (system !== MULTIVERSE_SITE_SYSTEM) {
    params.set("sys", system);
  }
  return `${MULTIVERSE_URL}/?${params}`;
}
