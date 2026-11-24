#!/usr/bin/env python3
"""Open a shared link on a first visit and check that the address keeps it.

trynix.dev is served by GitHub Pages, which cannot send COOP/COEP
headers, so the page loads a service worker that adds them
(coi-serviceworker.js). On a reader's first visit the worker is not
installed yet, and the shim reloads the page once it is. The reload
opens whatever the address says at that moment. The page writes the
address from its selection, and a shared link's selection fills in only
as the page finds each package in the index, so for that moment the
address was the link with its packages and boot=1 cut out. A reload
that landed then opened an empty page saying "nothing selected yet".
Every other browser test here serves the real headers, under which
the shim never reloads, so no test saw the lost link.

This serves the site with the headers GitHub Pages sends, which have
no COOP/COEP and keep files for ten minutes, and opens the page's own
Try link in a fresh profile. Where the shim's reload lands is a race:
before the fix, Firefox's reload opened the stripped address in 3 of 8
runs here, as it did for the reader, and Chromium's in none. The
address the reloaded page writes is no race, and before the fix it had
lost the link on every run in both browsers. Every fetch to another
origin is held, the index's until the test answers it and a cache's
for good, so the page stays in that moment for as long as the test
needs and no guest boots. Then it checks that:

  1. after the shim's reload, the address still carries the link's
     packages, its boot=1 and its settings, and the address the reload
     opened did too;
  2. a setting changed in that moment (the memory) goes into the
     address without taking the packages or boot=1 out;
  3. once the index answers, the address describes the selection the
     page restored, keeps the changed setting, and drops boot=1, since
     the boot has started.

    nix run .#link-test -- --site <a built site directory>
    nix run .#link-test -- --site <site> --with firefox
    nix run .#link-test -- --url https://trynix.dev

Against --site this needs no network: the test answers for the index
and holds every other fetch to another origin.
"""

import argparse
import functools
import http.server
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, filename):
    """Import a sibling tool by file name; they have hyphens."""
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    assert spec is not None and spec.loader is not None, filename
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cpu = load("cputest", "cpu-test.py")
gui = load("guitest", "gui-test.py")

# The link under test: the one the page's Try button writes for
# firefox (site/js/share.js), which is the link a reader saw lose its
# packages. The engine it names is the default, which the page leaves
# out of the address by design (app.js, linkEngine), so the engine is
# not among the parameters checked.
PACKAGE = "firefox"
MEMORY_MIB = "2048"
COMMAND = "firefox &"
LINK = [
    ("pkg", PACKAGE),
    ("engine", "unkernel"),
    ("mem", MEMORY_MIB),
    ("run", COMMAND),
    ("boot", "1"),
]

# The memory chosen under Settings while the index is held.
CHOSEN_MEMORY_MIB = "1024"

# What the test's index says about PACKAGE once it answers: one version
# with an aarch64-linux build (the unkernel guest's system), in the two
# shards the page reads (site/js/multiverse.js). The digest is made up;
# the boot that follows asks a cache for it and is held there.
INDEX_ORIGIN = "https://nixmultiverse.com"
VERSION = "130.0"
DIGEST = "0" * 32
INDEX_SHARDS = {
    "versions": {"attrs": {PACKAGE: {VERSION: 0}}},
    "meta-aarch64-linux": {
        "attrs": {PACKAGE: {VERSION: {"d": DIGEST, "n": f"{PACKAGE}-{VERSION}"}}}
    },
}

# The session-storage key the preload keeps each load's address under.
LOADS_KEY = "link-test-loads"

# Installed in every document before the page's own scripts (the
# drivers' preload). It records the address each load opened with, in
# the tab's session storage, so the record outlives the shim's reload.
# And it holds every fetch to another origin: the index's until the
# test calls window.linkTest.answer(shards), with shards keyed by the
# index's directory, and anything else for good.
PRELOAD = (
    """() => {
  if (location.protocol.startsWith("http")) {
    const loads = JSON.parse(sessionStorage.getItem(LOADS_KEY) ?? "[]");
    loads.push(location.search);
    sessionStorage.setItem(LOADS_KEY, JSON.stringify(loads));
  }

  let answer;
  const answered = new Promise((resolve) => {
    answer = resolve;
  });
  window.linkTest = { answer: (shards) => answer(shards) };

  const pageFetch = window.fetch.bind(window);
  window.fetch = (resource, options) => {
    const url = new URL(
      resource instanceof Request ? resource.url : String(resource),
      location.href,
    );
    if (url.origin === location.origin) {
      return pageFetch(resource, options);
    }
    if (url.origin !== INDEX_ORIGIN) {
      return new Promise(() => {});
    }
    const directory = url.pathname.split("/")[1];
    return answered.then(
      (shards) => new Response(JSON.stringify(shards[directory] ?? { attrs: {} })),
    );
  };
}"""
    .replace("LOADS_KEY", json.dumps(LOADS_KEY))
    .replace("INDEX_ORIGIN", json.dumps(INDEX_ORIGIN))
)

# How long the shim and the page's modules get to reach a rendered,
# cross-origin isolated page, and the index's answer to reach the
# address.
SETTLE_LIMIT_SECONDS = 60

# The page after the shim's reload: isolated, and its status line drawn,
# which render() does once it has written the address.
SETTLED = (
    "globalThis.crossOriginIsolated === true"
    " && (document.getElementById('status')?.textContent ?? '') !== ''"
)
ADDRESS = "location.search"


# How long GitHub Pages lets a browser keep a file. The modules a
# reload asks for again come out of the browser's cache under it, which
# decides where the shim's reload lands.
PAGES_CACHE_CONTROL = "max-age=600"


class PagesHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the site with GitHub Pages' headers as far as the first
    visit goes: no COOP/COEP, so only the shim's service worker can make
    the page cross-origin isolated, and Pages' cache lifetime."""

    def end_headers(self):
        self.send_header("Cache-Control", PAGES_CACHE_CONTROL)
        super().end_headers()

    def log_message(self, *args):
        pass


class PagesServer(http.server.ThreadingHTTPServer):
    """A server that takes a client hanging up as routine: the shim's
    reload drops the first load's requests in flight on every run, and
    closing the browser drops the rest."""

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def serve(directory):
    """Serve `directory` without isolation headers on a free port;
    returns (url_base, shutdown)."""
    port = cpu.free_port()
    httpd = PagesServer(
        ("127.0.0.1", port), functools.partial(PagesHandler, directory=directory)
    )
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", httpd.shutdown


class Checks:
    """Every check run, so one failure does not hide the rest."""

    def __init__(self):
        self.failed = []

    def equal(self, label, got, want):
        ok = got == want
        print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got!r}")
        if not ok:
            self.failed.append(f"{label}: got {got!r}, want {want!r}")

    def true(self, label, got):
        self.equal(label, bool(got), True)


def params(search):
    """A query string as {name: [values]}, the way the page reads it."""
    return urllib.parse.parse_qs((search or "").lstrip("?"), keep_blank_values=True)


def check_link(checks, label, search, memory):
    """The address `search` still carries the link: its package, boot=1,
    the memory `memory` and the command."""
    got = params(search)
    checks.equal(f"{label}: pkg", got.get("pkg"), [PACKAGE])
    checks.equal(f"{label}: boot", got.get("boot"), ["1"])
    checks.equal(f"{label}: mem", got.get("mem"), [memory])
    checks.equal(f"{label}: run", got.get("run"), [COMMAND])


def run(browser, base, checks):
    """The three checks the module docstring lists, in one tab."""
    browser.preload(PRELOAD)
    browser.navigate(f"{base}/?{urllib.parse.urlencode(LINK)}")

    # 1. The first visit: the shim installs its worker and reloads, and
    # the reloaded page writes the address while the index is held.
    print("a first visit to a shared link, the index held")
    gui.wait_for(browser, SETTLED, SETTLE_LIMIT_SECONDS, "an isolated page")
    loads = json.loads(browser.evaluate(f"sessionStorage.getItem({json.dumps(LOADS_KEY)})"))
    # Once as a rule; a worker still installing when the first reload
    # lands makes the shim reload a second time.
    checks.true(f"the shim reloaded the page ({len(loads)} loads)", len(loads) > 1)
    check_link(checks, "the address the reload opened", loads[-1], MEMORY_MIB)
    check_link(checks, "the address", browser.evaluate(ADDRESS), MEMORY_MIB)

    # 2. A setting changed while the link is still being restored.
    print("the memory changed under Settings, the index still held")
    browser.evaluate(
        "document.querySelector("
        f"'#memory-sizes input[value=\"{CHOSEN_MEMORY_MIB}\"]').click()"
    )
    check_link(checks, "the address", browser.evaluate(ADDRESS), CHOSEN_MEMORY_MIB)

    # 3. The index answers: the page selects the version, the address
    # names it, and the boot the link asked for starts.
    print("the index answers")
    browser.evaluate(f"window.linkTest.answer({json.dumps(INDEX_SHARDS)})")
    restored = f"{PACKAGE}@{VERSION}"
    search, _ = gui.wait_for(
        browser,
        f"new URLSearchParams(location.search).get('pkg') === {json.dumps(restored)}"
        " && location.search",
        SETTLE_LIMIT_SECONDS,
        "an address naming the restored version",
    )
    got = params(search)
    checks.equal("the address: pkg", got.get("pkg"), [restored])
    checks.equal("the address: boot", got.get("boot"), None)
    checks.equal("the address: mem", got.get("mem"), [CHOSEN_MEMORY_MIB])
    checks.equal("the address: run", got.get("run"), [COMMAND])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="test this address instead of serving a directory")
    parser.add_argument(
        "--with",
        dest="kind",
        choices=gui.BROWSERS,
        default=gui.CHROMIUM,
        help="the browser to open the link in (default chromium)",
    )
    parser.add_argument(
        "--browser",
        help="the browser's binary (default: --with's name on PATH, or $TRYNIX_BROWSER for chromium)",
    )
    args = parser.parse_args()
    if (args.site is None) == (args.url is None):
        parser.error("pass one of --site or --url")

    binary = args.browser or (
        os.environ.get("TRYNIX_BROWSER", gui.CHROMIUM)
        if args.kind == gui.CHROMIUM
        else args.kind
    )

    base, shutdown = (args.url.rstrip("/"), None) if args.site is None else serve(args.site)
    workdir = tempfile.mkdtemp()
    browser = gui.DRIVERS[args.kind](binary, os.path.join(workdir, "profile"), cpu.Gpu.OFF)
    checks = Checks()
    try:
        run(browser, base, checks)
    finally:
        browser.close()
        if shutdown is not None:
            shutdown()
        shutil.rmtree(workdir, ignore_errors=True)

        # The failed checks, listed here so that a wait that ran out and
        # ended the run early still shows the checks that failed before
        # the wait, which say why the wait never ended.
        for line in checks.failed:
            print(f"FAILED {line}", flush=True)

    if checks.failed:
        sys.exit(f"{len(checks.failed)} checks failed: the address lost the link")
    print("the address kept the link until the page restored it")


if __name__ == "__main__":
    main()
