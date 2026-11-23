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

The cases:

    foot   a terminal that draws into shared memory. Also types into
           its window and checks that the keys reached the program.
    gl     es2gears from mesa-demos, rendered by Mesa's virgl driver
           through the page's WebGL2 (SwiftShader here, so the frame
           rate it prints is a floor, not a measurement of a GPU).

A boot needs the network: the closures come from cache.nixos.org, and
the gl case's is 400 MB.
"""

import argparse
import base64
import importlib.util
import json
import os
import re
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

# The gl case: es2gears, and Mesa for the driver. es2gears prints its
# frame rate every five seconds, as "<n> frames in 5.0 seconds = <fps>
# FPS"; two such lines are waited for, since the first includes the
# renderer's load.
GL_PACKAGES = ["mesa-demos", "mesa"]
GL_COMMAND = "es2gears_wayland &\n"
FPS_LINE = re.compile(r"frames in [\d.]+ seconds = ([\d.]+) FPS")
FPS_LINES = 2
FPS_LIMIT_SECONDS = 60


CASES = ["foot", "gl"]

# --gpu's choices, and the browser's WebGL for each.
GPU_SOFTWARE = "software"
GPU_HARDWARE = "hardware"
GPUS = {GPU_SOFTWARE: cpu.Gpu.SOFTWARE, GPU_HARDWARE: cpu.Gpu.HARDWARE}


def page_url(base, packages):
    """The link that boots `packages` on unkernel without a click."""
    query = [("pkg", name) for name in packages]
    query += [("engine", ENGINE), ("boot", "1")]
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


def boot(browser, base, packages):
    """Boot `packages` and wait for the shell; returns the seconds taken."""
    browser.send(
        "Emulation.setDeviceMetricsOverride",
        width=VIEWPORT_WIDTH,
        height=VIEWPORT_HEIGHT,
        deviceScaleFactor=1,
        mobile=False,
    )
    browser.send("Page.navigate", url=page_url(base, packages))
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
        " width: r.width, height: r.height, scale: 1 }; })()"
    )
    reply = browser.send(
        "Page.captureScreenshot", format="png", clip=clip, captureBeyondViewport=True
    )
    path = os.path.join(directory, f"{name}.png")
    with open(path, "wb") as f:
        f.write(base64.b64decode(reply["result"]["data"]))
    print(f"  screenshot: {path}")


def type_into_window(browser, text):
    """Click near the top of the newest window's content, which is on
    screen however tall the window is, then type `text` as key events."""
    point = browser.evaluate(
        "(() => { const c = [...document.querySelectorAll('#desktop canvas')].at(-1);"
        " const r = c.getBoundingClientRect();"
        f" return {{ x: r.x + r.width / 2, y: r.y + {CLICK_DEPTH} }}; }})()"
    )
    for kind in ("mousePressed", "mouseReleased"):
        browser.send(
            "Input.dispatchMouseEvent",
            type=kind,
            x=point["x"],
            y=point["y"],
            button="left",
            clickCount=1,
        )
    for char in text:
        code = KEY_CODES[char]
        key = "Enter" if code == "Enter" else char
        browser.send(
            "Input.dispatchKeyEvent", type="keyDown", key=key, code=code, text=char
        )
        browser.send("Input.dispatchKeyEvent", type="keyUp", key=key, code=code)


def guest_has(browser, path):
    """Whether `path` exists in the guest, through the page's exec."""
    reply = browser.send(
        "Runtime.evaluate",
        expression="window.trynix.kernel.exec('/bin/test', ['-e', "
        + json.dumps(path)
        + "]).then((r) => r.exitCode === 0)",
        returnByValue=True,
        awaitPromise=True,
    )
    return reply.get("result", {}).get("result", {}).get("value") is True


def run_foot(browser, base, screenshots):
    """foot: boot it, start it, wait for its window, type into it."""
    print("foot")
    seconds = boot(browser, base, FOOT_PACKAGES)
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


def run_gl(browser, base, screenshots):
    """gl: boot es2gears with Mesa, wait for its window and its frame
    rate, and check that the frames came through the GL renderer."""
    print("gl")
    seconds = boot(browser, base, GL_PACKAGES)
    print(f"  shell after {seconds:.1f} s")

    mark = len(browser.transcript())
    browser.type(GL_COMMAND)
    seconds = first_frame(browser)
    print(f"  first frame {seconds:.2f} s after the command")

    started = time.monotonic()
    rates = []
    while time.monotonic() - started < FPS_LIMIT_SECONDS:
        rates = [
            float(rate) for rate in FPS_LINE.findall(browser.transcript()[mark:])
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
    parser.add_argument("--browser", default=os.environ.get("TRYNIX_BROWSER", "chromium"))
    parser.add_argument("--case", action="append", choices=CASES)
    parser.add_argument("--screenshots", help="a directory to save the windows in")
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

    base, shutdown = (args.url, None) if args.site is None else cpu.serve(args.site)
    workdir = tempfile.mkdtemp()
    try:
        for case in args.case or CASES:
            browser = cpu.Browser(
                args.browser, os.path.join(workdir, case), gpu=GPUS[args.gpu]
            )
            try:
                RUNNERS[case](browser, base, args.screenshots)
            finally:
                browser.close()
    finally:
        if shutdown is not None:
            shutdown()
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
