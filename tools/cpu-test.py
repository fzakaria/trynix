#!/usr/bin/env python3
"""Boot the CPU probe in a real browser and check the emulator's arithmetic.

The engine is a JIT, and a JIT can be wrong about an instruction rather
than slow at it. One was: its POPCNT returned a stale register instead of
a count, for as long as the guest ran a CPU model old enough that nothing
emitted the instruction. Every check in the tree passed throughout —
`nix flake check` never starts the engine, and boot-test only asks
whether a shell appears, which it did.

So this one runs something. The probe (nix/probe.nix) is a static binary
that executes the instructions a Haswell guest reaches and compares each
against a plain-C implementation of the same operation; the test boots
it, types its name at the guest's shell, and reads back the verdict.

    nix run .#cpu-test -- --site <a built site directory>
    nix run .#cpu-test -- --url https://trynix.dev/

The probe is served from the site's own binary cache
(site/examples/cache, written by tools/make-example-cache.sh), and its
closure is one static path, so against a local --site this needs no
network at all.
"""

import argparse
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import websocket

# What init prints once the store is mounted and the shell is live.
SHELL_MARKER = "trynix: welcome to the multiverse"

# What the probe prints when every instruction agreed. It also prints a
# line per disagreement, which is the diagnosis, so the whole tail of the
# transcript is worth showing on a failure.
PROBE_OK = "cputest: ok"

# The probe's exit status is echoed rather than trusted to the marker
# alone: a guest that dies on SIGILL prints no verdict at all.
STATUS_PREFIX = "cputest-status="

# Where make-example-cache.sh records what it published. Read rather than
# hardcoded, so a store path that moved is a clear failure here instead
# of a 404 inside the page.
MANIFEST = os.path.join("examples", "cache.json")
CACHE_PATH = "/examples/cache"

BOOT_LIMIT_SECONDS = 180
PROBE_LIMIT_SECONDS = 300
POLL_SECONDS = 0.25


def free_port():
    """A port nothing is listening on, so concurrent runs never collide."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves the site with the headers SharedArrayBuffer needs."""

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def serve(directory):
    """Serve `directory` on a free port; returns (url_base, shutdown)."""
    port = free_port()
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", port), functools.partial(Handler, directory=directory)
    )
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", httpd.shutdown


class Browser:
    """One headless browser, driven over the DevTools protocol.

    Its own debugging port and its own process group, for the reasons
    boot-test.py gives: a shared port attaches to a dying previous
    browser, and killing the parent alone leaves renderers running a
    guest.
    """

    def __init__(self, binary, profile):
        self.profile = profile
        self.port = free_port()
        self.stderr = tempfile.NamedTemporaryFile(prefix="chromium-", suffix=".log")
        self.process = subprocess.Popen(
            [
                binary,
                "--headless=new",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                f"--remote-debugging-port={self.port}",
                "--no-first-run",
                "--no-default-browser-check",
                f"--user-data-dir={profile}",
                "--disable-gpu",
                "--enable-features=SharedArrayBuffer",
                "--remote-allow-origins=*",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=self.stderr,
            start_new_session=True,
        )
        self.socket = websocket.create_connection(
            self._page_socket(), max_size=None, timeout=60
        )
        self.message_id = 0
        self.send("Runtime.enable")
        self.send("Page.enable")

    def _page_socket(self):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SystemExit(
                    f"the browser exited with status {self.process.returncode}:\n"
                    f"{self._stderr_tail()}"
                )
            try:
                targets = json.load(
                    urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json", timeout=2)
                )
                pages = [t for t in targets if t["type"] == "page"]
                if pages:
                    return pages[0]["webSocketDebuggerUrl"]
            except Exception:
                pass
            time.sleep(0.25)
        raise SystemExit(
            f"the browser never opened a debugging port:\n{self._stderr_tail()}"
        )

    def _stderr_tail(self):
        self.stderr.flush()
        with open(self.stderr.name, errors="replace") as f:
            return "".join(f.readlines()[-20:])

    def send(self, method, **params):
        self.message_id += 1
        self.socket.send(
            json.dumps({"id": self.message_id, "method": method, "params": params})
        )
        while True:
            message = json.loads(self.socket.recv())
            if message.get("id") == self.message_id:
                return message

    def evaluate(self, expression):
        reply = self.send(
            "Runtime.evaluate", expression=expression, returnByValue=True, timeout=30000
        )
        return reply.get("result", {}).get("result", {}).get("value")

    def transcript(self):
        return (
            self.evaluate(
                "(window.trynix && window.trynix.transcript "
                "&& window.trynix.transcript()) || ''"
            )
            or ""
        )

    def page_text(self):
        """What the page itself says, where fetch and signature failures
        are reported — they never reach the guest's console."""
        return self.evaluate("document.body.innerText") or "(nothing)"

    def close(self):
        try:
            self.socket.close()
        except Exception:
            pass
        for signal_number in (15, 9):
            try:
                os.killpg(os.getpgid(self.process.pid), signal_number)
            except Exception:
                pass
            time.sleep(0.5)
        shutil.rmtree(self.profile, ignore_errors=True)


def await_marker(browser, marker, limit):
    """Poll the guest's transcript until `marker` shows up."""
    started = time.monotonic()
    while time.monotonic() - started < limit:
        if marker in browser.transcript():
            return time.monotonic() - started
        time.sleep(POLL_SECONDS)
    return None


def read_manifest(site):
    """What the site's own cache holds, from the manifest beside it."""
    path = os.path.join(site, MANIFEST)
    if not os.path.exists(path):
        sys.exit(
            f"{path} is missing: run `nix run .#make-example-cache -- "
            f"--secret-key <file>` to publish the probe and write it"
        )
    with open(path) as f:
        manifest = json.load(f)
    probe = manifest["paths"]["probe"]

    # A probe rebuilt but not republished would fail inside the page as a
    # missing narinfo, several layers away from the cause. Say it here.
    digest = os.path.basename(probe).split("-", 1)[0]
    narinfo = os.path.join(site, "examples", "cache", f"{digest}.narinfo")
    if not os.path.exists(narinfo):
        sys.exit(
            f"the cache does not hold {probe}\n"
            f"re-run `nix run .#make-example-cache -- --secret-key <file>`"
        )
    return probe, manifest["publicKey"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="test this address instead of serving a directory")
    parser.add_argument(
        "--browser",
        default=os.environ.get("TRYNIX_BROWSER", "chromium"),
        help="the headless browser to drive",
    )
    args = parser.parse_args()

    if not args.url and not args.site:
        sys.exit("pass --site <directory> or --url <address>")

    # Against a served address the manifest comes from the tree, since
    # there is no local site directory to read it out of.
    manifest_root = args.site if args.site else "site"
    probe, public_key = read_manifest(manifest_root)

    shutdown = None
    if args.url:
        base = args.url.rstrip("/")
    else:
        base, shutdown = serve(args.site)

    # The cache is named by a path relative to whatever origin serves the
    # page, so one link works against a local directory and the deployed
    # site alike.
    query = urllib.parse.urlencode(
        {"path": probe, "cache": f"{CACHE_PATH} {public_key}", "boot": "1"}
    )
    url = f"{base}/?{query}"
    print(f"booting {url}", flush=True)

    workdir = tempfile.mkdtemp()
    browser = Browser(args.browser, os.path.join(workdir, "profile"))
    failed = True
    try:
        browser.send("Page.navigate", url=url)

        taken = await_marker(browser, SHELL_MARKER, BOOT_LIMIT_SECONDS)
        if taken is None:
            print(browser.transcript())
            print("=== the page said ===")
            print(browser.page_text())
            sys.exit(f"no shell within {BOOT_LIMIT_SECONDS}s")
        print(f"shell in {taken:.1f}s", flush=True)

        # Type the probe's name the way a keystroke arrives, and echo its
        # status so a guest that dies on SIGILL is a failure rather than
        # a wait for a verdict that never comes.
        mark = len(browser.transcript())
        browser.evaluate(
            "window.trynix.master.ldisc.writeFromLower("
            f'{json.dumps("cputest; echo " + STATUS_PREFIX + "$?" + chr(10))})'
        )

        taken = await_marker(browser, STATUS_PREFIX + "0", PROBE_LIMIT_SECONDS)
        said = browser.transcript()[mark:]
        if taken is None or PROBE_OK not in said:
            print("=== the guest said ===")
            print(said)
            sys.exit("the emulator does not compute what the hardware would")

        print(f"every instruction agreed, in {taken:.1f}s", flush=True)
        failed = False
    finally:
        browser.close()
        if shutdown:
            shutdown()
        shutil.rmtree(workdir, ignore_errors=True)

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
