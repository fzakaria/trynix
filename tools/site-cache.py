#!/usr/bin/env python3
"""Add the guest's Vulkan driver to the site's binary cache, at build
time.

nix/site.nix runs this inside the site's build, with kwvk (nix/kwvk.nix)
as an input. The driver is a store path the guest fetches through the
lazy store the first time a program loads Vulkan (site/js/lazy.js,
capability), as it fetches the GL driver, so the site serves it the
way it serves the GL driver: a narinfo, a NAR listing beside it and
the xz-compressed NAR, in site/gl/cache/, and the path named in
site/gl/drivers.json. The GL driver's files are committed, since an
x86_64 runner cannot build an aarch64 Mesa (tools/make-gl-cache.py);
zig builds kwvk from any system, so its files are written here instead,
from the build, and never drift from nix/kwvk.nix and its patches.

The narinfo is not signed: the page trusts its own origin
(site/js/substituters.js, Trust.SITE) and checks each NAR against the
narinfo's NarHash.

    site-cache.py <cache dir> <drivers.json> <references graph> <store path>

The references graph is the file exportReferencesGraph writes for the
store path. The driver's closure has to be the path alone: the site
serves nothing else for it, and its one reference is itself, the
manifest naming the library by its store path.
"""

import json
import lzma
import os
import shutil
import subprocess
import sys
import tempfile

# How a narinfo names the store and its hashes.
STORE_DIR = "/nix/store"
HASH_PREFIX = "sha256:"

# Where the files go in the cache, as cache.nixos.org lays them out.
NAR_DIR = "nar"
NAR_SUFFIX = ".nar.xz"
NARINFO_SUFFIX = ".narinfo"
LISTING_SUFFIX = ".ls"
LISTING_VERSION = 1

DIGEST_LENGTH = 32

# What drivers.json says of the entry this adds.
VULKAN_COMMENT = (
    " vulkan: the guest's Vulkan driver, kwvk with trynix's patches, which "
    "nix/site.nix builds and tools/site-cache.py adds to the cache and to "
    "this file in the copy the site serves."
)


def run(*args):
    """A command's standard output, as bytes."""
    return subprocess.run(args, check=True, capture_output=True).stdout


def closure(graph):
    """The store paths in an exportReferencesGraph file, which holds per
    path its name, its deriver, a count and that many references."""
    lines = open(graph).read().split("\n")
    paths = {}
    at = 0
    while at < len(lines) and lines[at]:
        path, count = lines[at], int(lines[at + 2])
        paths[path] = lines[at + 3 : at + 3 + count]
        at += 3 + count
    return paths


def nix_hash(path):
    """A file's sha256 in nix's base 32, as a narinfo writes it."""
    return run("nix-hash", "--type", "sha256", "--base32", "--flat", path).decode().strip()


def write_path(cache, store_path, references):
    """The NAR, the listing and the narinfo of `store_path` in `cache`."""
    basename = os.path.basename(store_path)
    digest = basename[:DIGEST_LENGTH]
    os.makedirs(os.path.join(cache, NAR_DIR), exist_ok=True)
    work = tempfile.mkdtemp()
    nar_file = os.path.join(work, "path.nar")
    xz_file = os.path.join(work, "path.nar.xz")

    # The NAR, and its hash before compression and after.
    nar = run("nix-store", "--dump", store_path)
    with open(nar_file, "wb") as f:
        f.write(nar)
    nar_hash = nix_hash(nar_file)
    compressed = lzma.compress(nar, preset=lzma.PRESET_DEFAULT)
    with open(xz_file, "wb") as f:
        f.write(compressed)
    file_hash = nix_hash(xz_file)
    url = f"{NAR_DIR}/{file_hash}{NAR_SUFFIX}"
    shutil.move(xz_file, os.path.join(cache, url))

    # The listing, nix's own, as write-nar-listing writes it.
    root = json.loads(
        run("nix", "--extra-experimental-features", "nix-command", "nar", "ls", "--json", "--recursive", nar_file, "/")
    )
    shutil.rmtree(work)
    with open(os.path.join(cache, f"{digest}{LISTING_SUFFIX}"), "w") as f:
        json.dump({"version": LISTING_VERSION, "root": root}, f)

    # The narinfo.
    narinfo = [
        f"StorePath: {store_path}",
        f"URL: {url}",
        "Compression: xz",
        f"FileHash: {HASH_PREFIX}{file_hash}",
        f"FileSize: {len(compressed)}",
        f"NarHash: {HASH_PREFIX}{nar_hash}",
        f"NarSize: {len(nar)}",
        "References: " + " ".join(sorted(os.path.basename(ref) for ref in references)),
        "",
    ]
    with open(os.path.join(cache, f"{digest}{NARINFO_SUFFIX}"), "w") as f:
        f.write("\n".join(narinfo))


def main():
    cache, manifest_path, graph, store_path = sys.argv[1:5]

    # The driver alone, or the site would serve a path whose closure it
    # does not hold.
    paths = closure(graph)
    others = sorted(set(paths) - {store_path})
    if others:
        sys.exit(f"{store_path} refers to {others}, which the site does not serve")
    write_path(cache, store_path, paths[store_path])

    # The manifest: the path among those the site serves, and named as
    # the Vulkan driver.
    with open(manifest_path) as f:
        manifest = json.load(f)
    manifest["comment"] += VULKAN_COMMENT
    manifest["paths"] = sorted(set(manifest["paths"]) | {store_path})
    manifest["vulkan"] = {"storePath": store_path}
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
