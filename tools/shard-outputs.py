#!/usr/bin/env python3
"""Shard nixpkgs-multiverse's sibling-output map for the browser.

nixpkgs splits many packages so their programs live in a separate
output: `jq`'s default output holds a library and a man page, and jq
itself is in the `bin` output, at a different store path with a
different digest. The multiverse index publishes the default output, so
without this the page boots a shell where jq is not found.

The digests are in the multiverse's `outs-<system>.json` release
artifact, which the browser cannot read — GitHub release downloads send
no CORS header. But the site is built by nix, which can fetch it at
build time, so it is sharded here and served same-origin.

Input:  {"<out digest>": {"bin": "<digest>", "dev": "<digest>", ...}}
Output: outs/<first two characters>.json, the same shape restricted to
        the digests that fall in that shard.
"""

import argparse
import collections
import json
import os
import sys

# Two characters gives 1024-ish shards over nix base32, which keeps
# each one small enough that a lookup costs a few KB.
SHARD_LENGTH = 2

# Outputs worth carrying. The rest (dev, man, doc, debug) are large in
# aggregate and nothing here would run a program from them.
KEPT_OUTPUTS = ("bin", "out", "lib")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="outs-<system>.json")
    parser.add_argument("out", help="directory to write shards into")
    args = parser.parse_args()

    with open(args.source) as f:
        outs = json.load(f)

    shards = collections.defaultdict(dict)
    kept = 0
    for digest, siblings in outs.items():
        wanted = {
            name: sibling for name, sibling in siblings.items() if name in KEPT_OUTPUTS
        }
        # A path whose only sibling is itself teaches the page nothing.
        if not wanted or set(wanted.values()) == {digest}:
            continue
        shards[digest[:SHARD_LENGTH]][digest] = wanted
        kept += 1

    os.makedirs(args.out, exist_ok=True)
    for shard, entries in shards.items():
        with open(os.path.join(args.out, f"{shard}.json"), "w") as f:
            json.dump(entries, f, separators=(",", ":"), sort_keys=True)

    print(f"{kept} paths over {len(shards)} shards", file=sys.stderr)


if __name__ == "__main__":
    main()
