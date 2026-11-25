#!/usr/bin/env python3
"""Write the unkernel guest's GL driver into the site's binary cache.

The driver is Mesa with the virgl driver alone (nix/mesa-virgl.nix),
built for aarch64-linux. No public cache holds it, so the site serves
it from site/gl/cache/, a directory committed to the repository and
served by Pages with the page (docs/gui.md). The pages workflow builds
the site on an x86_64 runner and only copies the directory; this tool
is where the driver is built, by hand.

Only the paths cache.nixos.org does not hold are kept: Mesa itself.
The page asks cache.nixos.org first, so the rest of Mesa's closure
comes from there. Each kept path has its NAR listing beside its
narinfo, as cache.nixos.org's do: every guest is linked to the
driver, and the dynamic loader of any program that links libglvnd
looks for its libraries in /run/opengl-driver/lib first, which the
page answers from the listing (site/js/lazy.js) rather than by
downloading the driver.

The narinfos are not signed. The site serves them from the page's own
origin, which the page trusts as it trusts its own JavaScript
(site/js/substituters.js, Trust.SITE), so no key is needed and none is
kept.

site/gl/drivers.json records what the driver asks of the process it is
loaded into, which the page compares with a program's closure
(site/js/gldriver.js): the newest GLIBC_ symbol version any library in
Mesa's closure needs, and the oldest gcc whose libstdc++ has every
GLIBCXX_ version they need.

Usage:

    nix run .#make-gl-cache                  # build, write, report sizes
    nix run .#make-gl-cache -- --mesa <path> # an already built driver

Every NAR written here goes into the repository's history for good
when it is committed, so the tool refuses a file over GitHub's warning
size and says what it wrote.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

UPSTREAM = "https://cache.nixos.org"
MESA_ATTR = "packages.aarch64-linux.mesa-virgl"
CACHE_IN_TREE = os.path.join("site", "gl", "cache")
DRIVERS_IN_TREE = os.path.join("site", "gl", "drivers.json")

DIGEST_LENGTH = 32

# GitHub warns about a file over this and refuses one over twice it.
FILE_LIMIT_BYTES = 50 * 1000 * 1000

# What nix writes at the root of a file:// cache. The page never reads
# it; nix does, for anyone who points a real nix at the cache.
CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 50\n"

# Store path names left out of the floors: glibc's and gcc's runtime
# files are what is measured against, not something that needs them.
GLIBC_NAME = re.compile(r"^glibc-(\d+\.\d+)")
GCC_LIB_NAME = re.compile(r"^gcc-(\d+(?:\.\d+)*)-lib$")

# A version a library needs from glibc, as readelf -V prints it in the
# version needs section.
GLIBC_NEED = re.compile(r"Name: GLIBC_(\d+(?:\.\d+)+)")
GLIBCXX_NEED = re.compile(r"Name: GLIBCXX_(\d+(?:\.\d+)+)")

# The first gcc release whose libstdc++ has each GLIBCXX_ version, from
# libstdc++'s ABI history (the manual's "ABI Policy and Guidelines"),
# back as far as a nixpkgs program in the index can reach. A program's
# closure names its gcc runtime by gcc version, so the floor is kept
# as one.
GLIBCXX_GCC = {
    "3.4.25": "8.1",
    "3.4.26": "9.1",
    "3.4.28": "10.1",
    "3.4.29": "11.1",
    "3.4.30": "12.1",
    "3.4.31": "13.1",
    "3.4.32": "13.2",
    "3.4.33": "14.1",
    "3.4.34": "15.1",
}

ELF_MAGIC = b"\x7fELF"

DRIVERS_COMMENT = (
    "The GL drivers site/gl/cache serves, written by tools/make-gl-cache.py: "
    "paths, every store path the cache serves, which the page asks of the "
    "site and of no other cache; and each Mesa store path with the newest "
    "GLIBC_ symbol version anything in its closure asks for, and the oldest "
    "gcc whose libstdc++ has every GLIBCXX_ version it asks for, which "
    "site/js/gldriver.js compares with a program's."
)


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def repository_root():
    """The checkout the caller is standing in: run as a flake app this
    script is a lone file in the store, and the directory to write is
    the one in the working tree that will carry the commit."""
    root = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
    )
    if root.returncode != 0:
        sys.exit("run this from a trynix checkout: git found no repository here")
    return root.stdout.strip()


def build_mesa(root):
    """Build the driver from the committed tree. A git+file reference
    with the commit, never a path: nix sees what git has, and a path
    reference would copy the whole working tree into the store."""
    rev = run("git", "-C", root, "rev-parse", "HEAD").strip()
    flake = f"git+file://{root}?rev={rev}"
    print(f"building {MESA_ATTR} at {rev[:12]}", flush=True)
    return run("nix", "build", "--no-link", "--print-out-paths", f"{flake}#{MESA_ATTR}").strip()


def name_of(path):
    return os.path.basename(path)[DIGEST_LENGTH + 1 :]


def as_numbers(version):
    return tuple(int(part) for part in version.split("."))


def elf_files(path):
    """Every ELF file under a store path's lib/, links left out."""
    for directory, _, files in os.walk(os.path.join(path, "lib")):
        for name in files:
            file = os.path.join(directory, name)
            if os.path.islink(file):
                continue
            with open(file, "rb") as f:
                if f.read(len(ELF_MAGIC)) == ELF_MAGIC:
                    yield file


def newest_need(closure, pattern, skip):
    """The newest version matching `pattern` that anything under the
    closure's lib/ directories needs, the paths named by `skip` left
    out. Whichever of these libraries the program has not loaded
    already is loaded from Mesa's closure, so each one counts."""
    newest = None
    for path in closure:
        if skip.match(name_of(path)):
            continue
        for file in elf_files(path):
            needs = run("readelf", "--version-info", "--wide", file)
            for version in pattern.findall(needs):
                if newest is None or as_numbers(version) > as_numbers(newest):
                    newest = version
    return newest


def floors(closure):
    """The driver's glibc floor and gcc floor (see the manifest). glibc's
    own files are what is measured against and are skipped; so are gcc's
    runtime's, for libstdc++."""
    glibc = newest_need(closure, GLIBC_NEED, GLIBC_NAME)
    glibcxx = newest_need(closure, GLIBCXX_NEED, GCC_LIB_NAME)
    if glibcxx is None:
        return glibc, None
    if glibcxx not in GLIBCXX_GCC:
        sys.exit(f"GLIBCXX_{glibcxx} is not in GLIBCXX_GCC: add the gcc that introduced it")
    return glibc, GLIBCXX_GCC[glibcxx]


def upstream_has(path):
    digest = os.path.basename(path)[:DIGEST_LENGTH]
    request = urllib.request.Request(f"{UPSTREAM}/{digest}.narinfo", method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=30):
            return True
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return False
        raise


def write_cache(mesa, closure, cache):
    """nix copy the closure into a scratch cache, with listings, keep
    what upstream lacks, and check the sizes before anything reaches the
    tree. Returns the kept files, relative to the cache, with their
    sizes, and the store paths they serve."""
    scratch = tempfile.mkdtemp(prefix="trynix-gl-")
    run(
        "nix",
        "copy",
        "--to",
        f"file://{scratch}?compression=xz&write-nar-listing=true",
        mesa,
    )

    kept = {}
    served = []
    for path in closure:
        if upstream_has(path):
            continue
        served.append(path)
        digest = os.path.basename(path)[:DIGEST_LENGTH]
        narinfo = f"{digest}.narinfo"
        listing = f"{digest}.ls"
        with open(os.path.join(scratch, narinfo)) as f:
            url = next(line.split(": ", 1)[1].strip() for line in f if line.startswith("URL: "))
        for relative in (narinfo, listing, url):
            kept[relative] = os.path.getsize(os.path.join(scratch, relative))

    too_big = {name: size for name, size in kept.items() if size > FILE_LIMIT_BYTES}
    if too_big:
        sys.exit(f"over {FILE_LIMIT_BYTES} bytes, not written: {too_big} (in {scratch})")

    # The directory holds this driver and nothing older: a NAR left
    # behind would be served, and committed, for nothing.
    shutil.rmtree(cache, ignore_errors=True)
    os.makedirs(os.path.join(cache, "nar"))
    with open(os.path.join(cache, "nix-cache-info"), "w") as f:
        f.write(CACHE_INFO)
    for relative in kept:
        shutil.copy(os.path.join(scratch, relative), os.path.join(cache, relative))
    shutil.rmtree(scratch)
    return kept, sorted(served)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesa", help="an already built mesa-virgl store path")
    args = parser.parse_args()

    root = repository_root()
    mesa = args.mesa or build_mesa(root)
    closure = run("nix", "path-info", "--recursive", mesa).split()

    kept, served = write_cache(mesa, closure, os.path.join(root, CACHE_IN_TREE))
    glibc, gcc = floors(closure)
    driver = {"storePath": mesa, "glibc": glibc, "gcc": gcc}
    manifest = {"comment": DRIVERS_COMMENT, "paths": served, "drivers": [driver]}
    with open(os.path.join(root, DRIVERS_IN_TREE), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"{len(served)} of {len(closure)} paths are not on {UPSTREAM}; wrote {CACHE_IN_TREE}:")
    for relative, size in sorted(kept.items()):
        print(f"  {size:>12}  {relative}")
    print(f"  {sum(kept.values()):>12}  in all")
    print(json.dumps(driver, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
