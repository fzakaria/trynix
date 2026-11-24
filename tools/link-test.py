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
Try link in a fresh profile, once per case. Every fetch to another
origin is held, the index's until the test answers it and a cache's
for good, so the page stays in each moment for as long as the test
needs and no guest boots. The server can also hold the shim's worker
script, which holds the reload, or refuse it, which stops the reload
for good. The cases:

    reload-first  the shim reloads while the index is held, which is
                  the order the reader saw. The address keeps the
                  link's packages, boot=1 and settings after the reload,
                  and a setting changed meanwhile (the memory) goes in
                  without taking the packages or boot=1 out. Once the
                  index answers, the address names the restored version
                  and drops boot=1, since the boot has started.

                  Where the reload lands is a race: before the address
                  was kept, Firefox's reload opened the stripped address
                  in 3 of 8 runs here and Chromium's in none. The
                  address the reloaded page writes is no race, and that
                  address lost the link on every run in both browsers.

    index-first   the index answers while the worker script is held, so
                  the restore finishes on a page the shim is about to
                  reload. The page does not start the boot, says why,
                  and keeps boot=1 in the address. Once the worker is
                  served, the reload opens boot=1 and the reloaded,
                  isolated page starts the boot.

    no-worker     the worker script is refused, so the page is never
                  isolated, on the qemu engine, which cannot run
                  without isolation. The page waits as above, and
                  pressing Boot ends in the page's own error saying the
                  page is not cross-origin isolated, not in a hang.

    index-fails   the index fetches fail after the shim's reload. The
                  status line says what failed, the address keeps the
                  link and boot=1 and no boot starts, and a reload of
                  that address restores the link and boots.

    engine-switch the guest choice under Settings moves the page to the
                  qemu engine while the index is held. The qemu page
                  opens with the link's package and settings, and once
                  the index answers, it selects the package. Before
                  the address was kept, the switch wrote the link of an
                  empty selection, and the qemu page opened with the
                  settings and no package.

    nix run .#link-test -- --site <a built site directory>
    nix run .#link-test -- --site <site> --with firefox --case index-first
    nix run .#link-test -- --url https://trynix.dev

--url runs reload-first, index-fails and engine-switch alone, since the
other cases need a server whose worker script the test controls.

Against --site this needs no network: the test answers for the index
and holds every other fetch to another origin.
"""

import argparse
import collections
import enum
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

# The no-worker case's link: the same package on the qemu engine, whose
# threads need isolation, so a boot without it fails at once.
QEMU = "qemu"
QEMU_LINK = [("pkg", PACKAGE), ("engine", QEMU), ("boot", "1")]

# The engine-switch case's link: the package and settings that ride
# along to the other engine, the network among them, and no boot=1, so
# neither page boots.
NETWORK_OFF = "off"
SWITCH_LINK = [
    ("pkg", PACKAGE),
    ("mem", MEMORY_MIB),
    ("net", NETWORK_OFF),
    ("run", COMMAND),
]

# What the test's index says about PACKAGE once it answers: one version
# with a build for either engine's system, in the two shards the page
# reads (site/js/multiverse.js). The digest is made up; the boot that
# follows asks a cache for it and is held there.
INDEX_ORIGIN = "https://nixmultiverse.com"
VERSION = "130.0"
RESTORED = f"{PACKAGE}@{VERSION}"
DIGEST = "0" * 32
BUILD = {"attrs": {PACKAGE: {VERSION: {"d": DIGEST, "n": f"{PACKAGE}-{VERSION}"}}}}
INDEX_SHARDS = {
    "versions": {"attrs": {PACKAGE: {VERSION: 0}}},
    "meta-aarch64-linux": BUILD,
    "meta-x86_64-linux": BUILD,
}

# The session-storage keys the preload keeps each load's address under,
# and the index's answer once the test has given one.
LOADS_KEY = "link-test-loads"
ANSWER_KEY = "link-test-answer"

# What a held index fetch fails with when the test fails it, as
# Chromium words a fetch that never reached the server.
FETCH_FAILED = "Failed to fetch"

# Installed in every document before the page's own scripts (the
# drivers' preload). It records the address each load opened with, in
# the tab's session storage, so the record outlives the shim's reload.
# And it holds every fetch to another origin: the index's until the
# test calls window.linkTest.answer(shards), with shards keyed by the
# index's directory, or window.linkTest.fail(), and anything else for
# good. An answer is kept in session storage too, so a load after a
# reload is answered at once.
PRELOAD = (
    """() => {
  const http = location.protocol.startsWith("http");
  if (http) {
    const loads = JSON.parse(sessionStorage.getItem(LOADS_KEY) ?? "[]");
    loads.push(location.search);
    sessionStorage.setItem(LOADS_KEY, JSON.stringify(loads));
  }

  let answer;
  const answered = new Promise((resolve) => {
    answer = resolve;
  });
  const kept = http ? sessionStorage.getItem(ANSWER_KEY) : null;
  if (kept !== null) {
    answer(JSON.parse(kept));
  }
  window.linkTest = {
    answer: (shards) => {
      sessionStorage.setItem(ANSWER_KEY, JSON.stringify(shards));
      answer(shards);
    },
    fail: () => answer(null),
  };

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
    return answered.then((shards) => {
      if (shards === null) {
        throw new TypeError(FETCH_FAILED);
      }
      return new Response(JSON.stringify(shards[directory] ?? { attrs: {} }));
    });
  };
}"""
    .replace("LOADS_KEY", json.dumps(LOADS_KEY))
    .replace("ANSWER_KEY", json.dumps(ANSWER_KEY))
    .replace("FETCH_FAILED", json.dumps(FETCH_FAILED))
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
ISOLATED = "globalThis.crossOriginIsolated === true"
LOADS = f"JSON.parse(sessionStorage.getItem({json.dumps(LOADS_KEY)}))"
STATUS = "document.getElementById('status').textContent"

# The address once the page has restored the link: it names the version.
RESTORED_ADDRESS = (
    f"new URLSearchParams(location.search).get('pkg') === {json.dumps(RESTORED)}"
    " && location.search"
)

# A boot has started once the page shows its progress section.
BOOT_STARTED = "document.getElementById('boot').hidden === false"

# What the status line says while a link's boot waits for the shim's
# reload (app.js), and what the boot says on a page that is not
# isolated, on the qemu engine.
WAITING_NOTE = "waits for the page to reload"
NOT_ISOLATED_ERROR = "not cross-origin isolated"

# What the status line says when the index could not be read (app.js).
UNREAD_NOTE = "could not be read"

# Pressing the Boot button.
PRESS_BOOT = "document.getElementById('boot-button').click()"

# Choosing the qemu engine under Settings, the chips that show the
# selection, and what the chip of the restored version says.
CHOOSE_QEMU = f"document.querySelector('#guest input[value=\"{QEMU}\"]').click()"
SELECTION = "document.getElementById('selection').textContent"
RESTORED_CHIP = f"{PACKAGE} {VERSION}"


# How long GitHub Pages lets a browser keep a file. The modules a
# reload asks for again come out of the browser's cache under it, which
# decides where the shim's reload lands.
PAGES_CACHE_CONTROL = "max-age=600"


# The header a browser sends with the fetch of a service worker's
# script, which is how the server tells the shim's registration apart
# from the page's own <script> tag for the same file.
WORKER_HEADER = "Service-Worker"
WORKER_SCRIPT = "script"
NOT_FOUND = 404


class Worker(enum.Enum):
    """What the server does with the shim's worker script: SERVE it,
    HOLD it until the test releases it, which holds the shim's reload,
    or REFUSE it, so the worker never installs and the page is never
    isolated."""

    SERVE = "serve"
    HOLD = "hold"
    REFUSE = "refuse"


class PagesHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the site with GitHub Pages' headers as far as the first
    visit goes: no COOP/COEP, so only the shim's service worker can make
    the page cross-origin isolated, and Pages' cache lifetime. The
    worker script is served as the server's `worker` says."""

    def do_GET(self):
        if self.headers.get(WORKER_HEADER) == WORKER_SCRIPT:
            if self.server.worker == Worker.REFUSE:
                self.send_error(NOT_FOUND)
                return
            if self.server.worker == Worker.HOLD:
                self.server.released.wait()
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", PAGES_CACHE_CONTROL)
        super().end_headers()

    def log_message(self, *args):
        pass


class PagesServer(http.server.ThreadingHTTPServer):
    """A server that takes a client hanging up as routine: the shim's
    reload drops the first load's requests in flight on every run, and
    closing the browser drops the rest. `worker` says what to do with
    the shim's worker script, and `released` lets a held one go."""

    def __init__(self, address, handler, worker):
        super().__init__(address, handler)
        self.worker = worker
        self.released = threading.Event()

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def serve(directory, worker):
    """Serve `directory` without isolation headers on a free port,
    treating the worker script as `worker` says; returns the server and
    its url_base."""
    port = cpu.free_port()
    httpd = PagesServer(
        ("127.0.0.1", port),
        functools.partial(PagesHandler, directory=directory),
        worker,
    )
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{port}"


class Checks:
    """Every check run, so one failure does not hide the rest. A failure
    is listed under `case`, the case running when it failed."""

    def __init__(self):
        self.failed = []
        self.case = None

    def equal(self, label, got, want):
        ok = got == want
        print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got!r}")
        if not ok:
            self.failed.append(f"{self.case}: {label}: got {got!r}, want {want!r}")

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


def answer_index(browser):
    """Answer the index's held fetches in the current page, and in every
    page this tab loads from now on."""
    browser.evaluate(f"window.linkTest.answer({json.dumps(INDEX_SHARDS)})")


def reload_first(browser, base, server, checks):
    """The shim reloads while the index is held (the module docstring's
    reload-first)."""
    del server  # the worker is served at once
    browser.navigate(f"{base}/?{urllib.parse.urlencode(LINK)}")

    # The first visit: the shim installs its worker and reloads, and the
    # reloaded page writes the address while the index is held.
    print("a first visit to a shared link, the index held")
    gui.wait_for(browser, SETTLED, SETTLE_LIMIT_SECONDS, "an isolated page")
    loads = browser.evaluate(LOADS)
    # Once as a rule; a worker still installing when the first reload
    # lands makes the shim reload a second time.
    checks.true(f"the shim reloaded the page ({len(loads)} loads)", len(loads) > 1)
    check_link(checks, "the address the reload opened", loads[-1], MEMORY_MIB)
    check_link(checks, "the address", browser.evaluate(ADDRESS), MEMORY_MIB)

    # A setting changed while the link is still being restored.
    print("the memory changed under Settings, the index still held")
    browser.evaluate(
        "document.querySelector("
        f"'#memory-sizes input[value=\"{CHOSEN_MEMORY_MIB}\"]').click()"
    )
    check_link(checks, "the address", browser.evaluate(ADDRESS), CHOSEN_MEMORY_MIB)

    # The index answers: the page selects the version, the address names
    # it, and the boot the link asked for starts.
    print("the index answers")
    answer_index(browser)
    search, _ = gui.wait_for(
        browser,
        RESTORED_ADDRESS,
        SETTLE_LIMIT_SECONDS,
        "an address naming the restored version",
    )
    got = params(search)
    checks.equal("the address: pkg", got.get("pkg"), [RESTORED])
    checks.equal("the address: boot", got.get("boot"), None)
    checks.equal("the address: mem", got.get("mem"), [CHOSEN_MEMORY_MIB])
    checks.equal("the address: run", got.get("run"), [COMMAND])
    checks.true("the boot started", browser.evaluate(BOOT_STARTED))


def check_waiting(browser, checks):
    """The page has restored the link on a page that is not isolated and
    is waiting with the link's boot: no boot, a status line that says so,
    and boot=1 still in the address."""
    search, _ = gui.wait_for(
        browser,
        RESTORED_ADDRESS,
        SETTLE_LIMIT_SECONDS,
        "an address naming the restored version",
    )
    checks.equal("the page is isolated", browser.evaluate(ISOLATED), False)
    checks.equal("the boot started", browser.evaluate(BOOT_STARTED), False)
    status = browser.evaluate(STATUS)
    checks.true(
        f"the status line says the boot waits: {status!r}", WAITING_NOTE in (status or "")
    )
    checks.equal("the address: boot", params(search).get("boot"), ["1"])


def index_first(browser, base, server, checks):
    """The index answers while the shim's worker script is held (the
    module docstring's index-first)."""
    browser.navigate(f"{base}/?{urllib.parse.urlencode(LINK)}")

    # The restore finishes on the first load, which the shim is about to
    # reload: its worker script is still held.
    print("a first visit to a shared link, the worker held, the index answered")
    gui.wait_for(browser, STATUS, SETTLE_LIMIT_SECONDS, "a rendered page")
    answer_index(browser)
    check_waiting(browser, checks)
    checks.equal("loads before the worker is served", len(browser.evaluate(LOADS)), 1)

    # The worker is served, the shim reloads, and the reloaded page is
    # isolated and boots.
    print("the worker served")
    server.released.set()
    gui.wait_for(
        browser,
        f"{ISOLATED} && {BOOT_STARTED}",
        SETTLE_LIMIT_SECONDS,
        "a boot on an isolated page",
    )
    loads = browser.evaluate(LOADS)
    checks.equal("the address the reload opened: boot", params(loads[-1]).get("boot"), ["1"])
    checks.true("the boot started", browser.evaluate(BOOT_STARTED))
    checks.equal("the address: boot", params(browser.evaluate(ADDRESS)).get("boot"), None)


def no_worker(browser, base, server, checks):
    """The shim's worker never installs, on the qemu engine (the module
    docstring's no-worker)."""
    del server  # the worker script is refused throughout
    browser.navigate(f"{base}/?{urllib.parse.urlencode(QEMU_LINK)}")

    print("a shared link on a page that is never isolated, on qemu")
    gui.wait_for(browser, STATUS, SETTLE_LIMIT_SECONDS, "a rendered page")
    answer_index(browser)
    check_waiting(browser, checks)

    # Boot, pressed, says what is missing rather than hanging.
    print("Boot pressed")
    browser.evaluate(PRESS_BOOT)
    status, _ = gui.wait_for(
        browser,
        f"{STATUS}.includes({json.dumps(NOT_ISOLATED_ERROR)}) && {STATUS}",
        SETTLE_LIMIT_SECONDS,
        "the page's error for a page that is not isolated",
    )
    print(f"  {status}")
    checks.equal("the shim never reloaded: loads", len(browser.evaluate(LOADS)), 1)


def index_fails(browser, base, server, checks):
    """The index fails while the link is restored (the module
    docstring's index-fails)."""
    del server  # the worker is served at once
    browser.navigate(f"{base}/?{urllib.parse.urlencode(LINK)}")

    # The reloaded, isolated page, its index fetches failing.
    print("a shared link whose index fetch fails")
    gui.wait_for(browser, SETTLED, SETTLE_LIMIT_SECONDS, "an isolated page")
    browser.evaluate("window.linkTest.fail()")
    status, _ = gui.wait_for(
        browser,
        f"{STATUS}.includes({json.dumps(UNREAD_NOTE)}) && {STATUS}",
        SETTLE_LIMIT_SECONDS,
        "a status line that says the index could not be read",
    )
    print(f"  {status}")
    checks.true("the status line names the failure", FETCH_FAILED in status)
    check_link(checks, "the address", browser.evaluate(ADDRESS), MEMORY_MIB)
    checks.equal("the boot started", browser.evaluate(BOOT_STARTED), False)

    # A reload of that address tries again, and this time the index
    # answers.
    print("reloaded, the index answering")
    answer_index(browser)
    browser.evaluate("location.reload()")
    search, _ = gui.wait_for(
        browser,
        f"{BOOT_STARTED} && {RESTORED_ADDRESS}",
        SETTLE_LIMIT_SECONDS,
        "a boot of the restored version",
    )
    checks.equal("the address: pkg", params(search).get("pkg"), [RESTORED])


def check_switched(checks, label, search):
    """The address `search` is the switch's link: the qemu engine, and
    the link's package and settings, with no boot=1."""
    got = params(search)
    checks.equal(f"{label}: engine", got.get("engine"), [QEMU])
    checks.equal(f"{label}: pkg", got.get("pkg"), [PACKAGE])
    checks.equal(f"{label}: mem", got.get("mem"), [MEMORY_MIB])
    checks.equal(f"{label}: net", got.get("net"), [NETWORK_OFF])
    checks.equal(f"{label}: run", got.get("run"), [COMMAND])
    checks.equal(f"{label}: boot", got.get("boot"), None)


def engine_switch(browser, base, server, checks):
    """The engine is switched while the index is held (the module
    docstring's engine-switch)."""
    del server  # the worker is served at once
    browser.navigate(f"{base}/?{urllib.parse.urlencode(SWITCH_LINK)}")

    # The first visit, through the shim's reload, with the index held.
    print("a first visit to a shared link, the index held")
    gui.wait_for(browser, SETTLED, SETTLE_LIMIT_SECONDS, "an isolated page")
    loads = len(browser.evaluate(LOADS))

    # The guest choice moves the page to qemu while the restore waits.
    # The qemu page is a load of its own, and the worker the first
    # visit installed isolates it.
    print("qemu chosen under Settings, the index still held")
    browser.evaluate(CHOOSE_QEMU)
    gui.wait_for(
        browser,
        f"{LOADS}.length > {loads} && {SETTLED}",
        SETTLE_LIMIT_SECONDS,
        "the qemu page",
    )
    check_switched(checks, "the address the switch opened", browser.evaluate(LOADS)[-1])
    check_switched(checks, "the address", browser.evaluate(ADDRESS))

    # The index answers, and the qemu page selects the link's package.
    print("the index answers")
    answer_index(browser)
    search, _ = gui.wait_for(
        browser,
        RESTORED_ADDRESS,
        SETTLE_LIMIT_SECONDS,
        "an address naming the restored version",
    )
    checks.equal("the address: engine", params(search).get("engine"), [QEMU])
    selection = browser.evaluate(SELECTION)
    checks.true(f"the selection: {selection!r}", RESTORED_CHIP in (selection or ""))
    checks.equal("the boot started", browser.evaluate(BOOT_STARTED), False)


# Each case, what the server does with the worker script for it, and
# the order --case runs them in when none is named.
Case = collections.namedtuple("Case", ["run", "worker"])
CASES = {
    "reload-first": Case(reload_first, Worker.SERVE),
    "index-first": Case(index_first, Worker.HOLD),
    "no-worker": Case(no_worker, Worker.REFUSE),
    "index-fails": Case(index_fails, Worker.SERVE),
    "engine-switch": Case(engine_switch, Worker.SERVE),
}
URL_CASES = ["reload-first", "index-fails", "engine-switch"]


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
    parser.add_argument("--case", action="append", choices=list(CASES))
    args = parser.parse_args()
    if (args.site is None) == (args.url is None):
        parser.error("pass one of --site or --url")

    cases = args.case or (list(CASES) if args.site is not None else URL_CASES)
    if args.site is None and set(cases) - set(URL_CASES):
        parser.error(f"--url runs {', '.join(URL_CASES)} alone")

    binary = args.browser or (
        os.environ.get("TRYNIX_BROWSER", gui.CHROMIUM)
        if args.kind == gui.CHROMIUM
        else args.kind
    )

    # One case at a time, each in a fresh profile against its own
    # server, since each is a first visit.
    checks = Checks()
    workdir = tempfile.mkdtemp()
    try:
        for name in cases:
            case = CASES[name]
            checks.case = name
            print(f"== {name}", flush=True)
            server, base = (
                (None, args.url.rstrip("/"))
                if args.site is None
                else serve(args.site, case.worker)
            )
            browser = gui.DRIVERS[args.kind](
                binary, os.path.join(workdir, name), cpu.Gpu.OFF
            )
            try:
                browser.preload(PRELOAD)
                case.run(browser, base, server, checks)
            finally:
                browser.close()
                if server is not None:
                    server.released.set()
                    server.shutdown()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

        # The failed checks, listed here so that a wait that ran out and
        # ended the run early still shows the checks that failed before
        # the wait, which say why the wait never ended.
        for line in checks.failed:
            print(f"FAILED {line}", flush=True)

    if checks.failed:
        sys.exit(f"{len(checks.failed)} checks failed")
    print("every case kept the link and booted where it could")


if __name__ == "__main__":
    main()
