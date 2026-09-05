#!/usr/bin/env python3
"""Write assets.json: a content hash for every file the page fetches by
a stable name.

The site's own modules are already cache-safe — the build renames the
directory to js.<hash> — but the engine, the guest image and the
snapshot are downloaded from a release under fixed names and kept in
the browser's Cache API, which keys on the URL. A new snapshot at the
same URL would never be fetched again.

So each of those names gets a version, and the page appends it as a
query string. A changed file is a changed URL and a guaranteed miss; an
unchanged one keeps its entry and stays cached.
"""

import argparse
import hashlib
import json
import os
import sys

# Enough of a sha256 to make a collision irrelevant here.
VERSION_LENGTH = 12


def versions(root, directory):
    """Map each file under `directory` to a hash, keyed site-relative."""
    found = {}
    base = os.path.join(root, directory)
    if not os.path.isdir(base):
        return found

    for name in sorted(os.listdir(base)):
        path = os.path.join(base, name)
        if not os.path.isfile(path):
            continue

        digest = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(chunk)
        found[f"{directory}/{name}"] = digest.hexdigest()[:VERSION_LENGTH]

    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", help="the site directory")
    parser.add_argument("directories", nargs="+", help="directories under it to version")
    args = parser.parse_args()

    files = {}
    for directory in args.directories:
        files.update(versions(args.root, directory))

    out = os.path.join(args.root, "assets.json")
    with open(out, "w") as f:
        json.dump({"files": files}, f, indent=1, sort_keys=True)
    print(f"wrote {out} ({len(files)} files)", file=sys.stderr)


if __name__ == "__main__":
    main()
