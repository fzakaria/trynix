#!/usr/bin/env python3
"""Run GUI programs from nixpkgs in the unkernel guest and check that
their windows reach the page.

A GUI program crosses more pieces than anything else the page runs:
the relay the page writes into the guest, the vsock link, wland's
compositor on the page, kwshm for a program's pixels and, for GL,
Mesa's virgl driver, the guest's virtio-gpu device and the wasm GL
renderer. boot-test only asks whether a shell appears, which it does
with every one of those broken. This boots a link, starts the program
at the shell the way a reader would, and waits for the compositor to
take a frame from it.

    nix run .#gui-test -- --site <a built site directory>
    nix run .#gui-test -- --site <site> --case foot --screenshots /tmp/gui
    nix run .#gui-test -- --site <site> --with firefox
    nix run .#gui-test -- --site <site> --fetch all

The cases:

    foot   a terminal that draws into shared memory. Also types into
           its window and checks that the keys reached the program.
    gl     es2gears from mesa-demos, selected alone, so the page adds
           the site's GL driver itself (site/js/gldriver.js), rendered
           by Mesa's virgl driver through the page's WebGL2
           (SwiftShader by default, so the frame rate it prints is a
           floor, not a measurement of a GPU).

--fetch says when the closure downloads (site/js/downloads.js): `lazy`
fetches store paths as the program opens them, `all` before the shell
starts. Without it the link leaves the choice to the page, whose
default is lazy.

The browser is Chromium, driven over the DevTools protocol as the other
tools here drive it, or with `--with firefox`, Firefox over WebDriver
BiDi, which is the protocol Firefox speaks now that it has dropped the
DevTools one. The cases are written against the few operations both
offer (Chromium and Firefox below).

A boot needs the network: the closures come from cache.nixos.org, and
the driver from the site's own cache (gl/), which a site with no
published driver lacks; the gl case fails there.
"""

import argparse
import base64
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse

import websocket

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, filename):
    """Import a sibling tool by file name; they have hyphens."""
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    assert spec is not None and spec.loader is not None, filename
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cpu = load("cputest", "cpu-test.py")

ENGINE = "unkernel"

# How long a boot may take, including the closure download, and how
# long a program then has to put a frame on the page. The gl case's
# closure is large, and its first frame waits for the renderer to load.
BOOT_LIMIT_SECONDS = 600
FRAME_LIMIT_SECONDS = 120
POLL_SECONDS = 0.1

# The foot case: the terminal, and a line typed into its window that
# writes a file the test then reads through the page's own exec.
FOOT_PACKAGES = ["foot"]
FOOT_COMMAND = "foot &\n"
FOOT_TYPED_FILE = "/tmp/foot-typed"
FOOT_TYPED = f"touch {FOOT_TYPED_FILE}\r"
TYPED_LIMIT_SECONDS = 30

# How far into a window's content the click that focuses it lands.
CLICK_DEPTH = 20

# The browser window's size: a desktop's, so the page's desktop element
# is as tall as a reader would see it and a program's window fits.
VIEWPORT_WIDTH = 1280
VIEWPORT_HEIGHT = 1000

# The physical key for each character typed, which is what wland reads
# (KeyboardEvent.code, mapped to an evdev key on a US layout). Only
# characters that need no Shift.
KEY_CODES = {
    **{c: f"Key{c.upper()}" for c in "abcdefghijklmnopqrstuvwxyz"},
    **{c: f"Digit{c}" for c in "0123456789"},
    " ": "Space",
    "/": "Slash",
    "-": "Minus",
    ".": "Period",
    "\r": "Enter",
}

# The browsers --with takes, and the binary each runs by default.
CHROMIUM = "chromium"
FIREFOX = "firefox"
BROWSERS = [CHROMIUM, FIREFOX]

# How long a browser has to open its debugging port.
LAUNCH_LIMIT_SECONDS = 60
LAUNCH_POLL_SECONDS = 0.25

# Firefox's preferences for a test profile: WebGL even where its
# blocklist would refuse the host's GPU (headless on a machine with
# no display), and no first-run pages or updates to get in the way.
FIREFOX_PREFS = {
    "webgl.force-enabled": True,
    "browser.shell.checkDefaultBrowser": False,
    "browser.startup.homepage_override.mstone": "ignore",
    "app.update.enabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
}

# The WebDriver code BiDi takes for the Enter key.
WEBDRIVER_ENTER = "\ue007"


class Chromium:
    """Chromium over the DevTools protocol: cpu-test.py's Browser, with
    the operations the cases use."""

    def __init__(self, binary, profile, gpu):
        self.browser = cpu.Browser(binary, profile, gpu=gpu)

    def set_viewport(self, width, height):
        self.browser.send(
            "Emulation.setDeviceMetricsOverride",
            width=width,
            height=height,
            deviceScaleFactor=1,
            mobile=False,
        )

    def navigate(self, url):
        self.browser.send("Page.navigate", url=url)

    def evaluate(self, expression):
        return self.browser.evaluate(expression)

    def evaluate_async(self, expression):
        reply = self.browser.send(
            "Runtime.evaluate",
            expression=expression,
            returnByValue=True,
            awaitPromise=True,
        )
        return reply.get("result", {}).get("result", {}).get("value")

    def screenshot(self, clip):
        reply = self.browser.send(
            "Page.captureScreenshot",
            format="png",
            clip={**clip, "scale": 1},
            captureBeyondViewport=True,
        )
        return base64.b64decode(reply["result"]["data"])

    def click(self, x, y):
        for kind in ("mousePressed", "mouseReleased"):
            self.browser.send(
                "Input.dispatchMouseEvent",
                type=kind,
                x=x,
                y=y,
                button="left",
                clickCount=1,
            )

    def press(self, char):
        code = KEY_CODES[char]
        key = "Enter" if code == "Enter" else char
        self.browser.send(
            "Input.dispatchKeyEvent", type="keyDown", key=key, code=code, text=char
        )
        self.browser.send("Input.dispatchKeyEvent", type="keyUp", key=key, code=code)

    def type(self, text):
        self.browser.type(text)

    def transcript(self):
        return self.browser.transcript()

    def close(self):
        self.browser.close()


class Firefox:
    """Firefox over WebDriver BiDi, headless, on a profile of its own.

    Results come back as BiDi's typed values, so every expression is
    wrapped in JSON.stringify and parsed here, which gives the same
    plain values the DevTools protocol's returnByValue does."""

    def __init__(self, binary, profile, gpu):
        del gpu  # Firefox picks its WebGL backend itself.
        os.makedirs(profile, exist_ok=True)
        with open(os.path.join(profile, "user.js"), "w") as f:
            for name, value in FIREFOX_PREFS.items():
                f.write(f"user_pref({json.dumps(name)}, {json.dumps(value)});\n")
        self.profile = profile
        port = cpu.free_port()
        self.stderr = tempfile.NamedTemporaryFile(prefix="firefox-", suffix=".log")
        self.process = subprocess.Popen(
            [
                binary,
                "--headless",
                f"--remote-debugging-port={port}",
                "--profile",
                profile,
                "--no-remote",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=self.stderr,
            start_new_session=True,
        )
        self.socket = self._connect(port)
        self.message_id = 0
        self.send("session.new", capabilities={})
        tree = self.send("browsingContext.getTree")
        self.context = tree["result"]["contexts"][0]["context"]

    def _connect(self, port):
        # Firefox refuses a handshake that carries an Origin header.
        deadline = time.monotonic() + LAUNCH_LIMIT_SECONDS
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SystemExit(f"firefox exited with status {self.process.returncode}")
            try:
                return websocket.create_connection(
                    f"ws://127.0.0.1:{port}/session",
                    timeout=60,
                    suppress_origin=True,
                    max_size=None,
                )
            except (OSError, websocket.WebSocketException):
                time.sleep(LAUNCH_POLL_SECONDS)
        raise SystemExit("firefox never opened its WebDriver BiDi port")

    def send(self, method, **params):
        self.message_id += 1
        self.socket.send(
            json.dumps({"id": self.message_id, "method": method, "params": params})
        )
        while True:
            message = json.loads(self.socket.recv())
            if message.get("id") != self.message_id:
                continue
            if message.get("type") == "error":
                raise SystemExit(f"{method}: {message.get('error')}: {message.get('message')}")
            return message

    def _value(self, expression, wait):
        reply = self.send(
            "script.evaluate",
            expression=expression,
            target={"context": self.context},
            awaitPromise=wait,
        )
        result = reply["result"]
        if result.get("type") == "exception":
            return None
        text = result["result"].get("value")
        return None if text is None else json.loads(text)

    def set_viewport(self, width, height):
        self.send(
            "browsingContext.setViewport",
            context=self.context,
            viewport={"width": width, "height": height},
        )

    def navigate(self, url):
        self.send("browsingContext.navigate", context=self.context, url=url, wait="none")

    def evaluate(self, expression):
        return self._value(f"JSON.stringify(({expression}) ?? null)", False)

    def evaluate_async(self, expression):
        return self._value(
            f"(async () => JSON.stringify((await ({expression})) ?? null))()", True
        )

    def screenshot(self, clip):
        reply = self.send(
            "browsingContext.captureScreenshot",
            context=self.context,
            origin="document",
            clip={"type": "box", **clip},
        )
        return base64.b64decode(reply["result"]["data"])

    def click(self, x, y):
        self.send(
            "input.performActions",
            context=self.context,
            actions=[
                {
                    "type": "pointer",
                    "id": "mouse",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [
                        {"type": "pointerMove", "x": round(x), "y": round(y)},
                        {"type": "pointerDown", "button": 0},
                        {"type": "pointerUp", "button": 0},
                    ],
                }
            ],
        )

    def press(self, char):
        value = WEBDRIVER_ENTER if KEY_CODES[char] == "Enter" else char
        self.send(
            "input.performActions",
            context=self.context,
            actions=[
                {
                    "type": "key",
                    "id": "keyboard",
                    "actions": [
                        {"type": "keyDown", "value": value},
                        {"type": "keyUp", "value": value},
                    ],
                }
            ],
        )

    def type(self, text):
        self.evaluate(f"window.trynix.type({json.dumps(text)})")

    def transcript(self):
        return (
            self.evaluate(
                "(window.trynix && window.trynix.transcript && window.trynix.transcript()) || ''"
            )
            or ""
        )

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


DRIVERS = {CHROMIUM: Chromium, FIREFOX: Firefox}

# The gl case: es2gears alone; the page adds the driver, and says so in
# its log. es2gears prints its frame rate every five seconds, as "<n>
# frames in 5.0 seconds = <fps> FPS"; two such lines are waited for,
# since the first includes the renderer's load.
GL_PACKAGES = ["mesa-demos"]
DRIVER_ADDED = re.compile(r"gl: added (/nix/store/\S+-mesa-virgl-\S+)")
# The gl case's link types the command itself (run=, site/js/url.js),
# as the page's Try link does; the foot case types its own.
GL_COMMAND = "es2gears_wayland &"
FPS_LINE = re.compile(r"frames in [\d.]+ seconds = ([\d.]+) FPS")
FPS_LINES = 2
FPS_LIMIT_SECONDS = 60


CASES = ["foot", "gl"]

# --gpu's choices, and the browser's WebGL for each.
GPU_SOFTWARE = "software"
GPU_HARDWARE = "hardware"
GPUS = {GPU_SOFTWARE: cpu.Gpu.SOFTWARE, GPU_HARDWARE: cpu.Gpu.HARDWARE}


# When the closure downloads, by the name a link carries
# (site/js/downloads.js).
FETCH_MODES = ["lazy", "all"]


def page_url(base, packages, fetch, run=None):
    """The link that boots `packages` on unkernel without a click,
    naming when the closure downloads if `fetch` is not None, and the
    command the page types at the shell if `run` is not None."""
    query = [("pkg", name) for name in packages]
    query += [("engine", ENGINE)]
    if fetch is not None:
        query += [("fetch", fetch)]
    if run is not None:
        query += [("run", run)]
    query += [("boot", "1")]
    return f"{base}/?{urllib.parse.urlencode(query)}"


def wait_for(browser, expression, limit, label):
    """Poll `expression` in the page until it is truthy; returns its
    value and the seconds taken. Fails the run on the limit."""
    started = time.monotonic()
    while time.monotonic() - started < limit:
        value = browser.evaluate(expression)
        if value:
            return value, time.monotonic() - started
        time.sleep(POLL_SECONDS)
    tail = browser.evaluate(
        "document.getElementById('debug-log').textContent.slice(-3000)"
    )
    raise SystemExit(f"FAIL {label}: nothing after {limit} s\n{tail}")


def boot(browser, base, packages, fetch, run=None):
    """Boot `packages` and wait for the shell; returns the seconds taken."""
    browser.set_viewport(VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
    browser.navigate(page_url(base, packages, fetch, run))
    _, seconds = wait_for(
        browser,
        f"(window.trynix?.transcript?.() ?? '').includes({json.dumps(cpu.SHELL_MARKER)})",
        BOOT_LIMIT_SECONDS,
        "boot",
    )
    return seconds


def first_frame(browser):
    """Wait for the compositor's first frame from a program; returns
    the seconds from now."""
    _, seconds = wait_for(
        browser,
        "window.trynix?.desktopStats?.firstCommitAt != null",
        FRAME_LIMIT_SECONDS,
        "first frame",
    )
    return seconds


def screenshot(browser, directory, name):
    """Save the desktop element as a PNG in `directory`."""
    if directory is None:
        return
    browser.evaluate("document.getElementById('desktop').scrollIntoView()")
    clip = browser.evaluate(
        "(() => { const r = document.getElementById('desktop')"
        ".getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY,"
        " width: r.width, height: r.height }; })()"
    )
    path = os.path.join(directory, f"{name}.png")
    with open(path, "wb") as f:
        f.write(browser.screenshot(clip))
    print(f"  screenshot: {path}")


def type_into_window(browser, text):
    """Click near the top of the newest window's content, which is on
    screen however tall the window is, then type `text` as key events."""
    # Scrolled into view first: Firefox refuses a click outside the
    # viewport, and the desktop sits under the terminal.
    point = browser.evaluate(
        "(() => { const c = [...document.querySelectorAll('#desktop canvas')].at(-1);"
        " c.scrollIntoView({ block: 'start' });"
        " const r = c.getBoundingClientRect();"
        f" return {{ x: r.x + r.width / 2, y: r.y + {CLICK_DEPTH} }}; }})()"
    )
    browser.click(point["x"], point["y"])
    for char in text:
        browser.press(char)


def guest_has(browser, path):
    """Whether `path` exists in the guest, through the page's exec."""
    found = browser.evaluate_async(
        "window.trynix.kernel.exec('/bin/test', ['-e', "
        + json.dumps(path)
        + "]).then((r) => r.exitCode === 0)"
    )
    return found is True


def run_foot(browser, base, screenshots, fetch):
    """foot: boot it, start it, wait for its window, type into it."""
    print("foot")
    seconds = boot(browser, base, FOOT_PACKAGES, fetch)
    print(f"  shell after {seconds:.1f} s")

    browser.type(FOOT_COMMAND)
    seconds = first_frame(browser)
    print(f"  first frame {seconds:.2f} s after the command")

    # Give the terminal its first prompt before the picture is taken
    # and before keys go to it.
    time.sleep(2)
    screenshot(browser, screenshots, "foot")

    type_into_window(browser, FOOT_TYPED)
    started = time.monotonic()
    while time.monotonic() - started < TYPED_LIMIT_SECONDS:
        if guest_has(browser, FOOT_TYPED_FILE):
            print(f"  keys reached foot: {FOOT_TYPED_FILE} written")
            screenshot(browser, screenshots, "foot-typed")
            return
        time.sleep(POLL_SECONDS * 5)
    screenshot(browser, screenshots, "foot-typed")
    raise SystemExit("FAIL keys typed into foot's window never reached it")


def run_gl(browser, base, screenshots, fetch):
    """gl: boot es2gears with Mesa, wait for its window and its frame
    rate, and check that the frames came through the GL renderer."""
    print("gl")
    seconds = boot(browser, base, GL_PACKAGES, fetch, run=GL_COMMAND)
    print(f"  shell after {seconds:.1f} s; the link types {GL_COMMAND!r}")
    added = DRIVER_ADDED.search(
        browser.evaluate("document.getElementById('debug-log').textContent")
    )
    if added is None:
        raise SystemExit("FAIL the page added no GL driver for es2gears")
    print(f"  driver added: {added.group(1)}")

    seconds = first_frame(browser)
    print(f"  first frame {seconds:.2f} s after the shell")

    started = time.monotonic()
    rates = []
    while time.monotonic() - started < FPS_LIMIT_SECONDS:
        rates = [
            float(rate) for rate in FPS_LINE.findall(browser.transcript())
        ]
        if len(rates) >= FPS_LINES:
            break
        time.sleep(POLL_SECONDS * 5)
    if len(rates) < FPS_LINES:
        raise SystemExit(f"FAIL es2gears printed no frame rate: {rates}")
    print(f"  frame rates: {rates} FPS")

    # The page's renderer loaded, the guest's Mesa submitted work to it
    # through virtio-gpu, and the compositor took the frames from the
    # renderer by GPU resource (images) rather than reading pixels back.
    # A Mesa that fell back to llvmpipe submits nothing.
    status = browser.evaluate("window.trynix.kernel.gl?.status")
    print(
        f"  page renderer, loaded in {status['loadMs'] / 1000:.2f} s:"
        f" {status['what']}; {status['webgl']}"
    )
    if status["state"] != "ready":
        raise SystemExit(f"FAIL the GL renderer is {status['state']}: {status['error']}")
    stats = browser.evaluate("JSON.parse(JSON.stringify(window.trynix.kernel.gl.stats))")
    submits = stats["renderer"]["submits"]
    images = stats["gpu"]["images"]
    print(f"  virgl submits {submits}, frames taken by GPU resource {images}")
    if submits == 0 or images == 0:
        raise SystemExit("FAIL es2gears did not draw through the page's renderer")
    screenshot(browser, screenshots, "es2gears")


RUNNERS = {"foot": run_foot, "gl": run_gl}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="test this address instead of serving a directory")
    parser.add_argument(
        "--with",
        dest="kind",
        choices=BROWSERS,
        default=CHROMIUM,
        help="the browser to run the page in (default chromium)",
    )
    parser.add_argument(
        "--browser",
        help="the browser's binary (default: --with's name on PATH, or $TRYNIX_BROWSER for chromium)",
    )
    parser.add_argument("--case", action="append", choices=CASES)
    parser.add_argument("--screenshots", help="a directory to save the windows in")
    parser.add_argument(
        "--fetch",
        choices=FETCH_MODES,
        help="when the closure downloads (default: the page's choice, lazy)",
    )
    parser.add_argument(
        "--gpu",
        choices=[GPU_SOFTWARE, GPU_HARDWARE],
        default=GPU_SOFTWARE,
        help="draw WebGL with SwiftShader (the default, any host) or the host's GPU",
    )
    args = parser.parse_args()
    if (args.site is None) == (args.url is None):
        parser.error("pass one of --site or --url")
    if args.screenshots is not None:
        os.makedirs(args.screenshots, exist_ok=True)

    binary = args.browser or (
        os.environ.get("TRYNIX_BROWSER", CHROMIUM) if args.kind == CHROMIUM else args.kind
    )

    base, shutdown = (args.url, None) if args.site is None else cpu.serve(args.site)
    workdir = tempfile.mkdtemp()
    try:
        for case in args.case or CASES:
            browser = DRIVERS[args.kind](
                binary, os.path.join(workdir, case), GPUS[args.gpu]
            )
            try:
                RUNNERS[case](browser, base, args.screenshots, args.fetch)
            finally:
                browser.close()
    finally:
        if shutdown is not None:
            shutdown()
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
