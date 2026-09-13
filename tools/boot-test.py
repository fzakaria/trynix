#!/usr/bin/env python3
"""Boot the site in a real browser, repeatedly, and fail if it hangs.

Also fails a boot that reaches a shell and then litters the console
with the spare handshake newlines the page sent while the guest was
mounting: see PROMPT below.

Everything else in the tree checks that the pieces are the right bytes.
Nothing checked the one thing a reader actually does: open the page and
wait for a shell. Two separate bugs shipped through that gap, both of
them a guest that never reaches its prompt while the page waits out its
handshake timeout, and both invisible to `nix flake check`.

Cold boots only, one fresh browser profile each, because the failures
were races in the resume handshake and a warm profile hides them. The
run fails if any boot takes longer than --limit, which is set well
under the page's own timeout so a hang shows up as a failure rather
than a slow pass.

    nix run .#boot-test                     # the site this tree builds
    nix run .#boot-test -- --runs 20
    nix run .#boot-test -- --url https://trynix.dev/

A boot needs the network: the closure comes from cache.nixos.org.
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
import urllib.request

import websocket

# What init prints once it has mounted the share and is about to hand
# over the shell. This is the whole test: the page is only useful once
# this appears.
READY_MARKER = "welcome to the multiverse"

# The page gives the guest 180 s before it gives up, so a boot that is
# going to hang hangs for that long. Anything over this is a failure,
# not a slow machine: a healthy cold boot is a few seconds.
DEFAULT_LIMIT_SECONDS = 30
DEFAULT_RUNS = 10

# The package to boot. Small on purpose: this measures whether the guest
# comes up, not how fast a closure downloads.
DEFAULT_PACKAGE = "hello"

POLL_SECONDS = 0.15

# What the guest's shell prints when it wants a command.
#
# Reaching a shell is not enough: resuming offers init's handshake
# newline over and over until the guest says it has mounted, and only
# the first of them is read. The rest sit in the console's input queue
# and reach the shell as empty command lines, one bare prompt each.
# The slower the machine the more of them there are -- a phone that
# takes fifteen seconds to mount collects fifty -- and they scroll past
# the reader after the page has handed the console over. Count what the
# shell prints once it is up, and allow only the prompt it starts with
# and the one the page's redraw asks for.
PROMPT = "~ # "
MAX_PROMPTS = 3

# How long the guest is watched after it reaches its prompt: the spare
# newlines are already in its input queue by then, so whatever they are
# going to print has printed by the end of this.
DRAIN_SECONDS = 3

# The guest's clock, checked once per run from the host. A snapshot
# taken on a native qemu built without patches/0003 calibrates the
# guest's TSC against a real one and then runs on the browser's
# counter, and every guest second takes about three real ones: sleep
# 2 measured 6.7 s of wall time on such a snapshot and 2.1 s on a good
# one. Two releases shipped that way before anything checked. The
# limit leaves room for a slow runner's typing round trip and is still
# well under what the broken snapshot takes.
CLOCK_SLEEP_SECONDS = 2
CLOCK_LIMIT_SECONDS = 4.5
CLOCK_MARKER = "BOOT_TEST_CLOCK"


def free_port():
    """A port nothing is listening on, for the server or the debugger."""
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
    """One headless browser, driven over the DevTools protocol."""

    def __init__(self, binary, profile):
        self.profile = profile
        self.port = free_port()
        # start_new_session so the whole browser can be killed as a
        # process group: killing the parent alone leaves renderers
        # running a guest, which starves the next boot and makes the
        # measurement a lie.
        #
        # --no-sandbox: GitHub's ubuntu-latest (24.04) forbids unprivileged
        # user namespaces, and chromium's sandbox exits at launch without
        # them, before the debugging port ever opens. The page under test
        # is this repository's own. stderr is kept, so a launch that fails
        # says why instead of timing out in silence.
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
        self.socket = websocket.create_connection(self._page_socket(), max_size=None, timeout=60)
        self.message_id = 0
        self.send("Runtime.enable")
        self.send("Page.enable")

    def _page_socket(self):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SystemExit(
                    f"the browser exited with status {self.process.returncode}:\n{self._stderr_tail()}"
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
        raise SystemExit(f"the browser never opened a debugging port:\n{self._stderr_tail()}")

    def _stderr_tail(self):
        """The last of what chromium said, for a launch that went wrong."""
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
            "Runtime.evaluate", expression=expression, returnByValue=True, timeout=15000
        )
        return reply.get("result", {}).get("result", {}).get("value")

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


def read_transcript(browser):
    """Everything the guest has said so far, as the page has it."""
    return (
        browser.evaluate(
            "(window.trynix && window.trynix.transcript "
            "&& window.trynix.transcript()) || ''"
        )
        or ""
    )


def clock_seconds(browser):
    """Host wall time for a `sleep CLOCK_SLEEP_SECONDS` in the guest, or
    None if the guest never answered. The marker is typed in two pieces
    so the console's echo of the command line cannot match it."""
    mark = len(read_transcript(browser))
    started = time.monotonic()
    browser.evaluate(
        "window.trynix.type("
        + json.dumps(f"sleep {CLOCK_SLEEP_SECONDS}; echo {CLOCK_MARKER[:-1]}'{CLOCK_MARKER[-1]}'\n")
        + ")"
    )
    while time.monotonic() - started < CLOCK_LIMIT_SECONDS * 3:
        if CLOCK_MARKER + "\r" in read_transcript(browser)[mark:]:
            return time.monotonic() - started
        time.sleep(POLL_SECONDS)
    return None


def boot_once(binary, url, limit, workdir, index, check_clock):
    """Time one cold boot; returns (seconds, prompts, clock), or None if
    it hung. clock is the guest sleep's host wall time when asked for,
    else None."""
    browser = Browser(binary, os.path.join(workdir, f"profile-{index}"))
    try:
        started = time.monotonic()
        browser.send("Page.navigate", url=url)
        while time.monotonic() - started < limit:
            transcript = read_transcript(browser)
            if READY_MARKER in transcript:
                taken = time.monotonic() - started
                time.sleep(DRAIN_SECONDS)
                tail = read_transcript(browser).split(READY_MARKER, 1)[-1]
                clock = clock_seconds(browser) if check_clock else None
                return taken, tail.count(PROMPT), clock
            time.sleep(POLL_SECONDS)
        return None
    finally:
        browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="boot this URL instead of serving a directory")
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS)
    parser.add_argument("--limit", type=float, default=DEFAULT_LIMIT_SECONDS)
    parser.add_argument(
        "--browser",
        default=os.environ.get("TRYNIX_BROWSER", "chromium"),
        help="the headless browser to drive",
    )
    args = parser.parse_args()

    if not args.url and not args.site:
        sys.exit("pass --site <directory> or --url <address>")

    shutdown = None
    if args.url:
        url = args.url
    else:
        base, shutdown = serve(args.site)
        url = f"{base}/?pkg={args.package}&boot=1"

    print(f"booting {url}", flush=True)
    print(f"{args.runs} cold boots, each must reach a shell within {args.limit:g}s", flush=True)

    times = []
    stalls = 0
    noisy = 0
    slow_clock = None
    with tempfile.TemporaryDirectory() as workdir:
        try:
            for index in range(args.runs):
                # The clock is checked on the first boot that reaches a shell.
                result = boot_once(args.browser, url, args.limit, workdir, index, not times)
                if result is None:
                    stalls += 1
                    print(f"  boot {index + 1}: NO SHELL within {args.limit:g}s", flush=True)
                    continue

                taken, prompts, clock = result
                times.append(taken)
                if clock is not None:
                    print(
                        f"  guest sleep {CLOCK_SLEEP_SECONDS}: {clock:.1f}s of wall time",
                        flush=True,
                    )
                    if clock > CLOCK_LIMIT_SECONDS:
                        slow_clock = clock
                if prompts > MAX_PROMPTS:
                    noisy += 1
                    print(
                        f"  boot {index + 1}: {taken:.1f}s, "
                        f"{prompts} prompts (at most {MAX_PROMPTS} expected)",
                        flush=True,
                    )
                    continue
                print(f"  boot {index + 1}: {taken:.1f}s", flush=True)
        finally:
            if shutdown:
                shutdown()

    if times:
        times.sort()
        print(
            f"median {times[len(times) // 2]:.1f}s, "
            f"slowest {times[-1]:.1f}s, {stalls} of {args.runs} never reached a shell"
        )
    if stalls:
        sys.exit(f"{stalls} of {args.runs} boots never reached a shell")
    if noisy:
        sys.exit(f"{noisy} of {args.runs} boots left spare prompts on the console")
    if slow_clock is not None:
        sys.exit(
            f"the guest's clock runs slow: sleep {CLOCK_SLEEP_SECONDS} took "
            f"{slow_clock:.1f}s (limit {CLOCK_LIMIT_SECONDS:g}s). The snapshot was "
            "taken on a native qemu built without the current patches; rebuild it "
            "with tools/build-native-qemu.sh and retake the snapshot (docs/engine.md)"
        )
    print("every boot reached a shell")


if __name__ == "__main__":
    main()
