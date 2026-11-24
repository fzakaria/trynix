#!/usr/bin/env python3
"""Stall a store path's download partway and check what the guest sees.

On the unkernel engine the guest's store is served lazily
(site/js/lazy.js): a path downloads from the cache the first time the
guest reads a file in it, and the guest's read waits for that download.
The 9p mount has no request timeout, so a download that stops sending
bytes without failing would hold the read, and the program behind it,
forever. The page gives such a download up once it has gone a while
without a byte and fetches it again, a few times, and then fails the
read with an I/O error (site/js/net.js). The node tests check that
logic against a stand-in fetch; this checks it in a real browser, with
a real guest waiting on the read, since a stalled body is aborted by
the browser's fetch, not by anything the node tests run.

The test boots hello lazily, so the shell starts once hello's own path
is in and glibc, which hello's loader opens, is still on its way. A
script installed before the page's own wraps the page's fetch: it reads
glibc's narinfo for its NAR's URL, and passes on the first bytes of
that NAR and then nothing more, until the page aborts the request. Then
it types `hello` at the shell. The cases:

    stall-once    only the first download of glibc stalls. The page
                  gives it up, fetches it again, and hello prints its
                  greeting, after the stall's window and not before.
                  While it waits, the strip under the terminal says the
                  download is being tried again, and the Debug log says
                  why.

    stall-always  every download of glibc stalls. Once the page has
                  tried as often as it does, hello fails with an I/O
                  error, the strip says the download failed, and the
                  Debug log says so. Then the stall is lifted, and
                  hello typed again downloads glibc afresh and greets.

    nix run .#stall-test -- --site <a built site directory>
    nix run .#stall-test -- --site <site> --case stall-once --with firefox

A boot needs the network: the closure comes from cache.nixos.org.
"""

import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
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
link = load("linktest", "link-test.py")

# The package booted, the store path whose download stalls (a basename
# without its digest, as a regular expression), and what hello prints.
PACKAGE = "hello"
STALLED_NAME = r"glibc-\d"
COMMAND = "hello\n"
GREETING = "Hello, world!"

# What the guest's shell says when the kernel cannot read hello's
# loader, which is in glibc: ash, with musl's words for EIO.
IO_ERROR = "hello: I/O error"

# The link: hello on unkernel, its closure downloaded on first use, no
# guest network (nothing here needs it), booted without a click.
LINK = [
    ("pkg", PACKAGE),
    ("engine", "unkernel"),
    ("fetch", "lazy"),
    ("net", "off"),
    ("boot", "1"),
]

# How many bytes of the stalled NAR are passed on before it stops: some,
# so the page has seen the download move before it goes quiet.
STALL_AFTER_BYTES = 64 * 1024

# The page's window for a download without a byte, and how many times it
# fetches a path (site/js/net.js, IDLE_TIMEOUT_MS and ATTEMPTS).
IDLE_SECONDS = 30
ATTEMPTS = 4

# How long after the window a retried download may take to arrive and
# be written, and how long the boot may take.
SLACK_SECONDS = 90
BOOT_LIMIT_SECONDS = 300

# How often the strip under the terminal is read while the test waits.
POLL_SECONDS = 0.5


class Stall:
    """What the preload does with the stalled path's NAR: stall the
    first download only, every download, or none."""

    ONCE = "once"
    ALWAYS = "always"
    OFF = "off"


# Installed in every document before the page's own scripts (the
# drivers' preload). It wraps the page's fetch: a narinfo whose store
# path matches STALLED_NAME names the NAR to stall, and a download of
# that NAR is answered, while window.stallTest.mode says so, with a body
# that passes on STALL_AFTER_BYTES and then waits until the request's
# signal aborts, which errors the body as a browser's does.
# window.stallTest counts the NAR's downloads and the stalled ones, and
# keeps the page's clock at the first stall.
PRELOAD = (
    """() => {
  const target = new RegExp(`^/nix/store/[0-9a-z]{32}-${STALLED_NAME}`);
  const state = {
    mode: MODE,
    nar: null,
    path: null,
    downloads: 0,
    stalled: 0,
    stalledAt: null,
  };
  window.stallTest = state;
  const pageFetch = window.fetch.bind(window);

  // The target's narinfo names its NAR, relative to the narinfo.
  async function readNarinfo(url, response) {
    const text = await response.clone().text();
    const storePath = text.match(/^StorePath: (\\S+)$/m)?.[1] ?? "";
    const narUrl = text.match(/^URL: (\\S+)$/m)?.[1];
    if (narUrl !== undefined && target.test(storePath)) {
      state.nar = new URL(narUrl, url).href;
      state.path = storePath;
    }
  }

  // The response with a body that stops after STALL_AFTER_BYTES and
  // errors when `signal` aborts.
  function stall(response, signal) {
    const reader = response.body.getReader();
    let passed = 0;
    let body;
    const stream = new ReadableStream({
      start(controller) {
        body = controller;
      },
      async pull(controller) {
        if (passed >= STALL_AFTER_BYTES) {
          return new Promise(() => {});
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const part = value.subarray(0, STALL_AFTER_BYTES - passed);
        passed += part.byteLength;
        controller.enqueue(part);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    signal?.addEventListener("abort", () => {
      body.error(signal.reason);
      reader.cancel(signal.reason).catch(() => {});
    });
    return new Response(stream, {
      status: response.status,
      headers: response.headers,
    });
  }

  window.fetch = async (resource, options) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    const response = await pageFetch(resource, options);
    if (url.endsWith(".narinfo") && response.ok) {
      await readNarinfo(url, response);
    }
    if (state.nar === null || url !== state.nar) {
      return response;
    }
    state.downloads += 1;
    const stalls =
      state.mode === "always" || (state.mode === "once" && state.stalled === 0);
    if (!stalls) {
      return response;
    }
    state.stalled += 1;
    state.stalledAt ??= performance.now();
    return stall(response, options?.signal);
  };
}"""
    .replace("STALLED_NAME", json.dumps(STALLED_NAME))
    .replace("STALL_AFTER_BYTES", str(STALL_AFTER_BYTES))
)

# The strip under the terminal (site/js/activity.js): what it says, and
# whether it shows.
STRIP = (
    "(() => { const s = document.getElementById('console-activity');"
    " return s.dataset.visible === 'true' ? s.innerText.replace(/\\s+/g, ' ').trim() : ''; })()"
)
STATE = "window.stallTest"
NOW = "performance.now()"
DEBUG_LOG = "document.getElementById('debug-log').textContent"

# What the strip says while a download is tried again, and once one has
# failed for good; what the Debug log says on a retry for want of bytes,
# and once the page has given up on the path.
STRIP_RETRYING = f"attempt 2 of {ATTEMPTS}"
STRIP_FAILED = "could not download glibc"
LOG_STALLED = f"no bytes for {IDLE_SECONDS} s"
LOG_GAVE_UP = "not fetched"


def boot(browser, base, mode):
    """Boot hello with the preload stalling as `mode` says, and wait for
    the shell."""
    browser.preload(PRELOAD.replace("MODE", json.dumps(mode)))
    browser.navigate(f"{base}/?{urllib.parse.urlencode(LINK)}")
    _, seconds = gui.wait_for(
        browser,
        f"(window.trynix?.transcript?.() ?? '').includes({json.dumps(cpu.SHELL_MARKER)})",
        BOOT_LIMIT_SECONDS,
        "a shell",
    )
    print(f"  shell after {seconds:.1f} s")


def wait_watching_strip(browser, expression, limit, label):
    """Poll `expression` until it is truthy, reading the strip on each
    look; returns its value and every distinct line the strip showed.
    Fails the run at `limit` seconds."""
    seen = []
    started = time.monotonic()
    while time.monotonic() - started < limit:
        strip = browser.evaluate(STRIP)
        if strip and strip not in seen:
            seen.append(strip)
            print(f"  strip: {strip}")
        value = browser.evaluate(expression)
        if value:
            return value, seen
        time.sleep(POLL_SECONDS)
    log_tail = browser.evaluate(f"{DEBUG_LOG}.slice(-3000)")
    transcript_tail = browser.transcript()[-1500:]
    raise SystemExit(
        f"FAIL {label}: nothing after {limit} s\n"
        f"the Debug log:\n{log_tail}\nthe guest's console:\n{transcript_tail}"
    )


def greeted_after(browser, count):
    """An expression true once the transcript holds `count` greetings."""
    return (
        f"(window.trynix.transcript().split({json.dumps(GREETING)}).length - 1)"
        f" >= {count}"
    )


def stall_once(browser, base, checks):
    """Only the first download of glibc stalls (the module docstring's
    stall-once)."""
    print("hello, glibc's first download stalled")
    boot(browser, base, Stall.ONCE)
    browser.type(COMMAND)
    _, strips = wait_watching_strip(
        browser,
        greeted_after(browser, 1),
        IDLE_SECONDS + SLACK_SECONDS,
        "hello's greeting",
    )
    greeted_at = browser.evaluate(NOW)
    state = browser.evaluate(STATE)
    print(f"  {state['path']}: {state['downloads']} downloads, {state['stalled']} stalled")

    checks.equal("glibc's downloads", state["downloads"], 2)
    checks.equal("glibc's stalled downloads", state["stalled"], 1)
    waited = (greeted_at - state["stalledAt"]) / 1000
    checks.true(
        f"hello waited out the stall ({waited:.1f} s after it began)",
        waited >= IDLE_SECONDS,
    )
    checks.true(
        "the strip said the download was tried again",
        any(STRIP_RETRYING in strip for strip in strips),
    )
    checks.true(
        "the Debug log says the download went quiet",
        LOG_STALLED in browser.evaluate(DEBUG_LOG),
    )


def stall_always(browser, base, checks):
    """Every download of glibc stalls until the test lifts the stall
    (the module docstring's stall-always)."""
    print("hello, every download of glibc stalled")
    boot(browser, base, Stall.ALWAYS)
    browser.type(COMMAND)
    _, strips = wait_watching_strip(
        browser,
        f"window.trynix.transcript().includes({json.dumps(IO_ERROR)})",
        ATTEMPTS * IDLE_SECONDS + SLACK_SECONDS,
        "hello's I/O error",
    )
    state = browser.evaluate(STATE)
    print(f"  {state['path']}: {state['downloads']} downloads, {state['stalled']} stalled")

    checks.equal("glibc's downloads", state["downloads"], ATTEMPTS)
    checks.equal("hello's greetings", browser.evaluate(greeted_after(browser, 1)), False)
    # The strip's last line lingers after the failure, so a look after
    # the error is in still finds it.
    strips.append(browser.evaluate(STRIP))
    checks.true(
        "the strip said the download failed",
        any(STRIP_FAILED in strip for strip in strips),
    )
    checks.true(
        "the Debug log says the page gave up on glibc",
        LOG_GAVE_UP in browser.evaluate(DEBUG_LOG),
    )

    # The stall lifted, the next read downloads glibc again.
    print("the stall lifted, hello typed again")
    browser.evaluate(f"{STATE}.mode = {json.dumps(Stall.OFF)}")
    browser.type(COMMAND)
    wait_watching_strip(
        browser,
        greeted_after(browser, 1),
        SLACK_SECONDS,
        "hello's greeting after the stall lifted",
    )
    checks.equal(
        "glibc's downloads", browser.evaluate(STATE)["downloads"], ATTEMPTS + 1
    )


CASES = {"stall-once": stall_once, "stall-always": stall_always}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="test this address instead of serving a directory")
    parser.add_argument(
        "--with",
        dest="kind",
        choices=gui.BROWSERS,
        default=gui.CHROMIUM,
        help="the browser to run the page in (default chromium)",
    )
    parser.add_argument(
        "--browser",
        help="the browser's binary (default: --with's name on PATH, or $TRYNIX_BROWSER for chromium)",
    )
    parser.add_argument("--case", action="append", choices=list(CASES))
    args = parser.parse_args()
    if (args.site is None) == (args.url is None):
        parser.error("pass one of --site or --url")

    binary = args.browser or (
        os.environ.get("TRYNIX_BROWSER", gui.CHROMIUM)
        if args.kind == gui.CHROMIUM
        else args.kind
    )

    # One case at a time, each in a fresh profile, so no download is
    # answered from an earlier case's Cache API.
    checks = link.Checks()
    base, shutdown = (args.url.rstrip("/"), None) if args.site is None else cpu.serve(args.site)
    workdir = tempfile.mkdtemp()
    try:
        for name in args.case or list(CASES):
            checks.case = name
            print(f"== {name}", flush=True)
            browser = gui.DRIVERS[args.kind](
                binary, os.path.join(workdir, name), cpu.Gpu.OFF
            )
            try:
                CASES[name](browser, base, checks)
            finally:
                browser.close()
    finally:
        if shutdown is not None:
            shutdown()
        shutil.rmtree(workdir, ignore_errors=True)

        # The failed checks, listed here so that a wait that ran out
        # still shows the checks that failed before it.
        for line in checks.failed:
            print(f"FAILED {line}", flush=True)

    if checks.failed:
        sys.exit(f"{len(checks.failed)} checks failed")
    print("every stalled download was given up, and the guest's read ended")


if __name__ == "__main__":
    main()
