#!/usr/bin/env python3
"""Compose a trynix link for a flake attribute someone else published.

A store path alone is not a shareable environment. The browser needs a
cache that holds the path and a public key that vouches for it, and both
travel in the same link (docs/design.md, "The link"). This turns

    nix run .#share-link -- --attr .#hello \
        --cache https://mycache.cachix.org --key mycache-1:...

into

    https://trynix.dev/?path=/nix/store/...-hello&cache=https://mycache.cachix.org+mycache-1:...

which boots that exact build in a browser tab.

Publishing is somebody else's job. By default nothing is built and
nothing is pushed: the attribute is evaluated for the store path it
names, on the assumption that an earlier step in the same job built it
and a cache step pushed it. That keeps this usable with cachix, attic,
an S3 bucket, a directory of narinfos on a static host, or anything else
that speaks the binary cache protocol. `--build` builds first, for a
caller with nothing in front of it.

An attribute may be a package (`.#hello`) or an app
(`.#apps.x86_64-linux.hello`). An app is a set naming a program rather
than a derivation, so what lands in the link is the store path holding
that program, which is what the guest mounts.

An attribute whose output path is not a function of its inputs, such
as a content addressed derivation or a package built on a dynamic
derivation, evaluates to a placeholder instead of a path. Such an
attribute is built whatever `--build` says. It still produces an
ordinary store path, and realising it is the only way to learn which.

`--verify` asks the cache whether it really has each path and whether a
browser is allowed to read it. Both failures produce a link that dies at
boot, and the second one cannot be seen any other way: a cache can be
correct, public, and still unreadable from a page.
"""

import argparse
import enum
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse

SITE = "https://trynix.dev"

# A store path's digest is the part before the first dash of its
# basename, and the name a cache serves its narinfo under.
DIGEST_LENGTH = 32

STORE_PREFIX = "/nix/store/"

# "", "nix", "store", "<basename>" — a store path split on "/".
STORE_PATH_PARTS = 4

# The characters nix spells a hash with: the digits and the lowercase
# letters, less e, o, u and t.
NIX_BASE32 = "0123456789abcdfghijklmnpqrsvwxyz"

# A store path as a cache knows it: the store directory, a digest, a
# dash, and a name.
STORE_PATH = re.compile(
    rf"{re.escape(STORE_PREFIX)}[{NIX_BASE32}]{{{DIGEST_LENGTH}}}-[^/]+\Z"
)

# A sha256 hash in nix's base32, which is what a placeholder is made of.
PLACEHOLDER_LENGTH = 52

# What an evaluation gives back in place of an output path it cannot
# know yet. A content addressed derivation's output path is decided by
# what its build produced, and a dynamic derivation's by a derivation
# another build wrote (`builtins.outputOf`). A derivation that takes
# either as an input cannot know its own path until theirs are known.
# None of them has a path to evaluate to, but each still builds an
# ordinary store path.
PLACEHOLDER = re.compile(rf"/[{NIX_BASE32}]{{{PLACEHOLDER_LENGTH}}}(?:/|\Z)")

# What a browser needs on a response to be allowed to read it at all.
CORS_HEADER = "access-control-allow-origin"

HTTP_TIMEOUT_SECONDS = 30

# Caches behind Cloudflare answer 403 to urllib's default agent. Every
# request here names the tool instead.
USER_AGENT = "trynix-share-link"


def request(url, method="GET"):
    """A request the caches will answer, named for what is asking."""
    return urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})


def nix(*args):
    """Run nix and return its stdout, or exit with the message it gave.

    The caller's nix, deliberately: this script shells out rather than
    pinning a version, so the flake being built is evaluated by the
    same nix the caller would have used by hand.
    """
    result = subprocess.run(
        ["nix", *args],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.exit(f"nix {' '.join(args)} failed:\n{result.stderr.strip()}")
    return result.stdout.strip()


class Kind(enum.Enum):
    """What a flake attribute is, named by the `type` nix gives it."""

    PACKAGE = "derivation"
    APP = "app"


def kind_of(attr):
    """Whether a flake attribute is a package or an app.

    Every derivation carries `type = "derivation"` and every flake app
    carries `type = "app"`, so one evaluation separates them. An
    attribute with no `type` at all is neither, and nix's own error is
    the clearest thing to report.
    """
    if nix("eval", "--json", f"{attr}.type") == '"app"':
        return Kind.APP
    return Kind.PACKAGE


def app_program(attr):
    """The path of the program a flake app runs, without building it."""
    return nix("eval", "--raw", f"{attr}.program")


def is_store_path(path):
    """Whether a string is a store path, and not merely shaped like one.

    The gate on everything that reaches a link: the page turns a path
    into a digest and asks a cache for that narinfo, so a string that is
    not a store path is a boot that fails on its first request.
    """
    return STORE_PATH.match(path) is not None


def is_placeholder(path):
    """Whether an evaluation gave back a placeholder rather than a path."""
    return PLACEHOLDER.match(path) is not None


def containing_store_path(path):
    """The store path a file inside it belongs to.

    An app's program is `/nix/store/<basename>/bin/<name>`, and the guest
    mounts the store path, not the file. Everything after the basename is
    dropped rather than parsed: how deep the program sits is the app's
    business.
    """
    parts = path.split("/")
    if len(parts) < STORE_PATH_PARTS or not path.startswith(STORE_PREFIX):
        sys.exit(f"not a path inside the nix store: {path}")
    return "/".join(parts[:STORE_PATH_PARTS])


def evaluated_store_paths(attr, kind):
    """The store path an attribute names, building only if it has to.

    Evaluating is the default, because the caller's previous step built
    this and their cache step pushed it. Asking nix to build it again
    would at best be a no-op and at worst pull a closure onto a runner
    for no reason. An attribute nothing has built still evaluates fine,
    since the path is a function of the inputs, and `--verify` is what
    notices that no cache has it.

    An attribute that evaluates to a placeholder is the exception. There
    is no store path to read out of a placeholder, so the attribute is
    realised even here. When the caller's build step ran against the
    same store, nix hands back the paths that step made. Otherwise this
    substitutes or builds them.
    """
    # Ask nix for the path without building anything.
    if kind is Kind.APP:
        path = app_program(attr)
    else:
        path = nix("eval", "--raw", f"{attr}.outPath")

    # A placeholder names no store path, so realise the attribute instead.
    if is_placeholder(path):
        print(
            f"note: {attr} evaluates to {path}, a placeholder rather than a store "
            "path; realising it to find out which path it stands for",
            file=sys.stderr,
        )
        return built_store_paths(attr, kind)

    return [containing_store_path(path)]


def built_store_paths(attr, kind):
    """Build an attribute and return every output nix installed.

    `nix build` refuses an app, since a set naming a program is not a
    derivation. The program string carries that derivation in its string
    context, so the context names the drv to build.

    A multi-output package prints one path per output nix chose to
    install, and all of them belong in the link: dropping one would drop
    programs the reader was told they would get. Evaluation cannot see
    that, which is one reason the two modes can disagree.
    """
    # An app is built through the drv its program string depends on.
    target = attr
    if kind is Kind.APP:
        drv = nix(
            "eval",
            "--raw",
            f"{attr}.program",
            "--apply",
            "p: builtins.head (builtins.attrNames (builtins.getContext p))",
        )
        target = f"{drv}^out"

    # A build that printed nothing has nothing to link.
    paths = nix("build", target, "--no-link", "--print-out-paths").splitlines()
    if not paths:
        sys.exit(f"nix build {target} named no store paths")
    return paths


def store_paths(attr, build):
    """The store paths an attribute resolves to.

    Whichever route got here, what comes out has to be a store path.
    A placeholder that reached this far would be posted in a comment as
    though it were a path and boot for nobody (#10), and saying so is
    better than linking it.
    """
    # Ask what the attribute is once, for whichever route resolves it.
    kind = kind_of(attr)
    if build:
        paths = built_store_paths(attr, kind)
    else:
        paths = evaluated_store_paths(attr, kind)

    # Only a store path may reach the link.
    for path in paths:
        if not is_store_path(path):
            sys.exit(f"{attr} resolved to {path}, which is not a store path")
    return paths


def normalize_cache_url(cache):
    """The cache URL as the link should carry it.

    Only the trailing slash is taken off, because the page joins the URL
    to a digest with a slash of its own and a doubled one would ask for a
    path no cache serves. Nothing else is inferred: the caller names a
    cache and the key that signed the paths, and a provider is not
    something this needs to know about.
    """
    if not cache.startswith("http"):
        sys.exit(f"--cache wants a URL, got {cache!r}")
    return cache.rstrip("/")


def digest_of(path):
    """The cache's name for a store path: the digest of its basename."""
    return path[len(STORE_PREFIX) :][:DIGEST_LENGTH]


def readable(url):
    """Headers a browser would see for this URL, or None if unreachable.

    A ranged GET rather than a HEAD: a cache may answer the two with
    different headers, and only a GET is what a page does. One byte is
    enough to see the response headers.
    """
    request_ = request(url)
    request_.add_header("Range", "bytes=0-0")
    try:
        with urllib.request.urlopen(request_, timeout=HTTP_TIMEOUT_SECONDS) as response:
            return response.headers
    except urllib.error.HTTPError as err:
        return err.headers
    except urllib.error.URLError:
        return None


def head(url):
    """Status and headers for a URL, or None when it cannot be reached.

    HEAD is right for asking whether a path is in a cache at all, which
    is a question about the status line. Anything about headers a browser
    would see wants `readable` instead.
    """
    try:
        with urllib.request.urlopen(
            request(url, method="HEAD"), timeout=HTTP_TIMEOUT_SECONDS
        ) as response:
            return response.status, response.headers
    except urllib.error.HTTPError as err:
        return err.code, err.headers
    except urllib.error.URLError:
        return None


def fetch_narinfo(cache_url, digest):
    """A path's narinfo as parsed key/value pairs, or None if absent."""
    try:
        with urllib.request.urlopen(
            request(f"{cache_url}/{digest}.narinfo"), timeout=HTTP_TIMEOUT_SECONDS
        ) as response:
            text = response.read().decode()
    except urllib.error.URLError:
        return None

    fields = {}
    for line in text.splitlines():
        key, _, value = line.partition(": ")
        fields[key] = value
    return fields


def missing_from_cache(cache_url, paths):
    """The paths the cache does not serve a narinfo for."""
    missing = []
    for path in paths:
        answer = head(f"{cache_url}/{digest_of(path)}.narinfo")
        if answer is None or answer[0] != 200:
            missing.append(path)
    return missing


def cors_problem(cache_url, paths):
    """Why a browser could not read this cache, or None when it can.

    Being present is not enough: a page may only fetch what the cache
    lets it, and the narinfo and the NAR are separate routes that can
    disagree: a cache that answers narinfos with
    `access-control-allow-origin` and NARs without one walks the closure
    and then fails on the first download.
    """
    for path in paths:
        digest = digest_of(path)

        headers = readable(f"{cache_url}/{digest}.narinfo")
        if headers is None:
            continue
        if headers.get(CORS_HEADER) is None:
            return f"{cache_url} serves narinfos without {CORS_HEADER}"

        # The NAR URL is relative to the cache that served the narinfo,
        # and it is the route that has to allow the read as well.
        narinfo = fetch_narinfo(cache_url, digest)
        if narinfo is None or "URL" not in narinfo:
            continue
        headers = readable(f"{cache_url}/{narinfo['URL']}")
        if headers is None:
            continue
        if headers.get(CORS_HEADER) is None:
            return f"{cache_url} serves NARs without {CORS_HEADER}"

        # One path answers for the cache; the routes are the same for
        # every path it holds.
        return None

    return None


def link(site, paths, cache_url, keys, boot):
    """The trynix URL for these paths, fetched from this cache.

    Every parameter may repeat, and a cache is one value of "url key"
    with whitespace between, so a cache mid-key-rotation contributes
    one entry per key and the page picks whichever signed the narinfo.
    """
    params = [("path", path) for path in paths]
    params += [("cache", f"{cache_url} {key}") for key in keys]
    if boot:
        params.append(("boot", "1"))

    # `/` and `:` are legal in a query string and are most of what a
    # store path and a cache URL are made of; leaving them alone is the
    # difference between a link someone can read and a wall of %2F.
    return f"{site.rstrip('/')}/?{urlencode(params, safe='/:')}"


def main():
    parser = argparse.ArgumentParser(
        description="compose a trynix link for what a flake attribute builds"
    )
    parser.add_argument(
        "--attr",
        action="append",
        required=True,
        metavar="ATTR",
        help="a flake attribute to build, package or app; may repeat",
    )
    parser.add_argument(
        "--cache",
        required=True,
        help="the URL of a cache that allows cross-origin reads",
    )
    parser.add_argument(
        "--key",
        action="append",
        required=True,
        metavar="KEY",
        help="a public key the cache signs with, name:base64; may repeat",
    )
    parser.add_argument("--site", default=SITE, help=f"the site to link to ({SITE})")
    parser.add_argument(
        "--boot", action="store_true", help="link a boot that starts without a click"
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="build the attributes first, rather than only evaluating them",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="check the cache holds the paths and a browser may read them",
    )
    parser.add_argument(
        "--json", action="store_true", help="print the link and what went into it"
    )
    args = parser.parse_args()

    # Resolve first: an attribute that does not exist should say so
    # before anything is asked of the network.
    paths = []
    by_attr = {}
    for attr in args.attr:
        resolved = store_paths(attr, args.build)
        by_attr[attr] = resolved
        paths += resolved

    cache_url = normalize_cache_url(args.cache)
    keys = args.key

    # Verification reports rather than fails: a caller who has not
    # pushed yet still wants the link, and the action decides what a
    # missing path means for a comment.
    missing = []
    cors = None
    if args.verify:
        missing = missing_from_cache(cache_url, paths)
        cors = cors_problem(cache_url, [p for p in paths if p not in missing])
        for path in missing:
            print(f"warning: {cache_url} does not have {path}", file=sys.stderr)
        if cors is not None:
            print(f"warning: {cors}; a browser cannot boot this", file=sys.stderr)

    url = link(args.site, paths, cache_url, keys, args.boot)

    if args.json:
        json.dump(
            {
                "url": url,
                "paths": paths,
                "attrs": by_attr,
                "cache": {"url": cache_url, "keys": keys},
                "missing": missing,
                "cors": cors,
            },
            sys.stdout,
            indent=1,
        )
        print()
        return

    print(url)


if __name__ == "__main__":
    main()
