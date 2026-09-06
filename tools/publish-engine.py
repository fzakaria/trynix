#!/usr/bin/env python3
"""Publish the engine and the snapshot as a release, and repin them.

The four artifacts (docs/engine.md) go up under a fresh, dated release
tag, and nix/engine-pins.json is rewritten to name that tag and the
hash of every file in it, plus the hashes of the guest image the
snapshot was taken from.

A tag is never reused. A release is what the pins of a commit resolve
against, so an asset replaced in place would break every commit that
pinned the old bytes; a new tag per publish keeps `nix build` working
on any commit in the history. Dated to the minute in UTC, because two
publishes in one day have already happened.

Usage:

    nix run .#publish-engine -- --dir <directory> --guest <guest image>

The directory holds out.js, qemu-system-x86_64.wasm,
qemu-system-x86_64.worker.js and vm.state; the guest image is the
`nix build .#guest` output the snapshot was taken against, whose
hashes the pins record.
"""

import argparse
import datetime
import json
import os
import subprocess
import sys

REPO = "fzakaria/trynix"
PINS_IN_TREE = os.path.join("nix", "engine-pins.json")

ENGINE_FILES = (
    "out.js",
    "qemu-system-x86_64.wasm",
    "qemu-system-x86_64.worker.js",
    "vm.state",
)
GUEST_FILES = ("bzImage", "initramfs.cpio.gz", "machine.json")

TAG_PREFIX = "engine-"
TAG_TIME_FORMAT = "%Y%m%d-%H%M"


def pins_path():
    """The pins file of the checkout the caller is standing in.

    Not a path relative to this script: run as a flake app the script is
    a lone file in the nix store, and the file that has to be rewritten
    is the one in the working tree that will carry the commit.
    """
    root = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
    )
    if root.returncode != 0:
        sys.exit("run this from a trynix checkout: git found no repository here")
    path = os.path.join(root.stdout.strip(), PINS_IN_TREE)
    if not os.path.isfile(path):
        sys.exit(f"no {PINS_IN_TREE} in {root.stdout.strip()}: is this a trynix checkout?")
    return path


def sri(path):
    """The SRI sha256 nix uses in the pins."""
    return subprocess.run(
        ["nix", "hash", "file", "--sri", path],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="directory holding the four artifacts")
    parser.add_argument("--guest", required=True, help="the guest image the snapshot was taken from")
    parser.add_argument(
        "--tag",
        default=TAG_PREFIX + datetime.datetime.now(datetime.timezone.utc).strftime(TAG_TIME_FORMAT),
        help="release tag to create (default: engine-<UTC date>-<UTC time>)",
    )
    parser.add_argument("--notes", default="", help="release notes")
    args = parser.parse_args()

    pins_file = pins_path()

    paths = [os.path.join(args.dir, name) for name in ENGINE_FILES]
    missing = [path for path in paths if not os.path.isfile(path)]
    if missing:
        sys.exit(f"missing: {', '.join(missing)}")

    # Hash everything before touching the network, so a failure here
    # leaves no half-made release behind.
    files = {name: sri(path) for name, path in zip(ENGINE_FILES, paths)}
    guest = os.path.realpath(args.guest)
    guest_hashes = {name: sri(os.path.join(guest, name)) for name in GUEST_FILES}

    with open(pins_file) as f:
        pins = json.load(f)

    subprocess.run(
        [
            "gh", "release", "create", args.tag,
            "--repo", REPO,
            "--title", args.tag,
            "--notes", args.notes or f"qemu-wasm engine and snapshot, taken against guest {os.path.basename(guest)}",
            *paths,
        ],
        check=True,
    )

    pins["tag"] = args.tag
    pins["files"] = files
    pins["guest"] = guest_hashes
    with open(pins_file, "w") as f:
        json.dump(pins, f, indent=2)
        f.write("\n")

    print(f"published {args.tag} and rewrote {os.path.relpath(pins_file)}", flush=True)


if __name__ == "__main__":
    main()
