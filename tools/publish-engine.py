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

    python3 tools/publish-engine.py --dir <directory holding the four files>

The directory holds out.js, qemu-system-x86_64.wasm,
qemu-system-x86_64.worker.js and vm.state. The guest image the pins
record is `nix build .#guest` of the current tree, so run this from the
commit whose guest the snapshot was taken against.
"""

import argparse
import datetime
import json
import os
import subprocess
import sys

REPO = "fzakaria/trynix"
PINS = os.path.join(os.path.dirname(__file__), "..", "nix", "engine-pins.json")

ENGINE_FILES = (
    "out.js",
    "qemu-system-x86_64.wasm",
    "qemu-system-x86_64.worker.js",
    "vm.state",
)
GUEST_FILES = ("bzImage", "initramfs.cpio.gz")

TAG_PREFIX = "engine-"
TAG_TIME_FORMAT = "%Y%m%d-%H%M"


def sri(path):
    """The SRI sha256 nix uses in the pins."""
    return subprocess.run(
        ["nix", "hash", "file", "--sri", path],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def guest_image():
    """Build the guest of the current tree and return its store path."""
    return subprocess.run(
        ["nix", "build", ".#guest", "--no-link", "--print-out-paths"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="directory holding the four artifacts")
    parser.add_argument(
        "--tag",
        default=TAG_PREFIX + datetime.datetime.now(datetime.timezone.utc).strftime(TAG_TIME_FORMAT),
        help="release tag to create (default: engine-<UTC date>-<UTC time>)",
    )
    parser.add_argument("--notes", default="", help="release notes")
    args = parser.parse_args()

    paths = [os.path.join(args.dir, name) for name in ENGINE_FILES]
    missing = [path for path in paths if not os.path.isfile(path)]
    if missing:
        sys.exit(f"missing: {', '.join(missing)}")

    # Hash everything before touching the network, so a failure here
    # leaves no half-made release behind.
    files = {name: sri(path) for name, path in zip(ENGINE_FILES, paths)}
    guest = guest_image()
    guest_hashes = {name: sri(os.path.join(guest, name)) for name in GUEST_FILES}

    with open(PINS) as f:
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
    with open(PINS, "w") as f:
        json.dump(pins, f, indent=2)
        f.write("\n")

    print(f"published {args.tag} and rewrote {os.path.relpath(PINS)}", flush=True)


if __name__ == "__main__":
    main()
