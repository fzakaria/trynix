// Sibling outputs: where a package's programs actually live.
//
// nixpkgs splits many packages across outputs, and the multiverse index
// publishes the default one. `jq`'s default output holds a library and
// a man page; jq itself is in the `bin` output, a different store path
// with a different digest that nothing in the default output's closure
// references. Selecting "jq" and booting a shell where jq is missing is
// the visible result.
//
// The multiverse publishes the digests sharded by the first two
// characters of the path being asked about, one directory per system,
// and serves them with open CORS — the same deployment, and the same
// treatment, as the index shards site/js/multiverse.js reads.

import { MULTIVERSE_URL, SYSTEM } from "./config.js";
import { indexFile } from "./multiverse.js";

const SHARD_LENGTH = 2;
const SHARD_DIR = `${MULTIVERSE_URL}/outs-${SYSTEM}`;

const shards = new Map();

// A missing shard means no path in it has siblings worth carrying,
// which is the same answer as an empty one. A shard that could not be
// read rejects instead: answering "no siblings" for it booted a split
// package without its programs.
function shard(digest) {
  const key = digest.slice(0, SHARD_LENGTH);
  return indexFile(shards, key, `${SHARD_DIR}/${key}.json`, { missing: {} });
}

// The `bin` output's digest for a store path, or null: null both when
// the package has no siblings and when it is not split at all. Rejects
// when the index could not be read.
export async function binOutputOf(digest) {
  const entries = await shard(digest);
  const siblings = entries[digest];
  if (
    siblings === undefined ||
    siblings.bin === undefined ||
    siblings.bin === digest
  ) {
    return null;
  }
  return siblings.bin;
}
