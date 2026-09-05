// Sibling outputs: where a package's programs actually live.
//
// nixpkgs splits many packages across outputs, and the multiverse index
// publishes the default one. `jq`'s default output holds a library and
// a man page; jq itself is in the `bin` output, a different store path
// with a different digest that nothing in the default output's closure
// references. Selecting "jq" and booting a shell where jq is missing is
// the visible result.
//
// The digests are in a multiverse release artifact the browser cannot
// read (GitHub release downloads send no CORS header), so the site
// build fetches it and shards it by the first two characters of the
// digest — see nix/outputs.nix.

const SHARD_LENGTH = 2;
const SHARD_DIR = "outs";

const shards = new Map();

function shard(digest) {
  const key = digest.slice(0, SHARD_LENGTH);
  if (!shards.has(key)) {
    shards.set(
      key,
      fetch(`${SHARD_DIR}/${key}.json`)
        // A missing shard means no path in it has siblings worth
        // carrying, which is the same answer as an empty one.
        .then((res) => (res.ok ? res.json() : {}))
        .catch(() => ({})),
    );
  }
  return shards.get(key);
}

// The `bin` output's digest for a store path, or null: null both when
// the package has no siblings and when it is not split at all.
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
