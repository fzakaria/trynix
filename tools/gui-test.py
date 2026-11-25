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
    nix run .#gui-test -- --site <site> --viewport phone

The cases:

    foot   a terminal that draws into shared memory. Also types into
           its window and checks that the keys reached the program,
           then presses the page's terminal, behind the window, and
           checks that keys typed next reach the page's shell and no
           window.
    gl     es2gears from mesa-demos, selected alone, rendered through
           the site's GL driver, which every guest is linked to and
           which arrives when es2gears first looks for it
           (site/js/gldriver.js), by Mesa's virgl driver through the
           page's WebGL2 (SwiftShader by default, so the frame rate it
           prints is a floor, not a measurement of a GPU).
    x11    xterm, which speaks only X11, selected alone: the X server
           every guest is linked to arrives when xterm first connects,
           and the GL driver does not. Waits for its window, then types
           into it and checks that the keys reached xterm's shell, and
           that the X server put none of its programs on PATH.
    feedback
           tools/gl-feedback.py, run in the guest with python3 through
           the site's GL driver: ten draws into textures, the second
           into a texture still bound to a sampler of its program, the
           fifth and sixth with a texture of another type than its
           sampler on a unit, which WebGL refuses (patches/mesa/). The
           last three sample what GL defines next to those: a level
           below the one the draw renders into, and an integer sampler
           with an incomplete texture or none on its unit. Checks that
           each draw read back its colour and that the renderer
           reported no context error.
    glx    extremetuxracer, selected alone: an SFML 2 game that speaks
           X11 alone and makes its GL context with GLX, with no X
           server or driver selected. Waits for its window and checks
           that its frames came through the page's GL renderer by GPU
           resource, which GLX reaches by DRI3 on Xwayland with glamor.
    oldgl  mesa-demos 8.5.0 (glibc 2.35), older than the site's GL
           driver. Checks that /run/opengl-driver is the site's driver
           and not the Mesa in the program's closure, that none of that
           Mesa is downloaded, and that eglinfo and es2gears_wayland
           exit with an error rather than a signal.
    slowx  xterm alone, with the X server's and Xwayland's NARs held
           back 35 s from when the guest first asks for them. Checks
           that xterm waits for its server and opens its window after
           the hold.

--fetch says when the closure downloads (site/js/downloads.js): `lazy`
fetches store paths as the program opens them, `all` before the shell
starts. Without it the link leaves the choice to the page, whose
default is lazy.

--viewport is the browser window's size: a desktop's, where a window
floats over the terminal, or a phone's, where a window is wider than
the console and opens maximized (site/js/frame.js), so the way back to
the terminal is the console bar's windows button. Chromium also
emulates a touch screen for the phone, which gives the page its touch
layout; Firefox only takes the size.

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
import collections
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

# The foot case's second half: a line typed into the page's terminal
# after a press on it, which the page's shell runs. foot runs a shell
# too, so the file alone does not say which one ran the line; the keys
# wland sent to any window are counted while the line is typed, and
# must stay at none.
TERMINAL_TYPED_FILE = "/tmp/terminal-typed"
TERMINAL_TYPED = f"touch {TERMINAL_TYPED_FILE}\r"

# Counts the key presses wland sends to any window from now on, in
# window.trynixKeysToWindows: every key a window takes goes through the
# compositor's key call (wland's lib/input.ts), which this wraps.
COUNT_WINDOW_KEYS = """(() => {
  const engine = window.trynix.desktop.engine;
  const key = engine.key.bind(engine);
  window.trynixKeysToWindows = 0;
  engine.key = (conn, time, code, pressed) => {
    if (pressed) {
      window.trynixKeysToWindows++;
    }
    return key(conn, time, code, pressed);
  };
  return true;
})()"""

# Whether wland holds any window focused, which its window bindings
# (Alt+F9 and the rest) act on.
ANY_WINDOW_FOCUSED = "window.trynix.desktop.windows().some((w) => w.focused)"

# A point on the page's terminal that no window covers, or null: a grid
# over the console's body, from the bottom right, where windows are
# least likely, each point asked what is on top there.
TERMINAL_POINT_STEP = 16
FREE_TERMINAL_POINT = f"""(() => {{
  const body = document.getElementById('console-body');
  const terminal = document.getElementById('terminal');
  body.scrollIntoView({{ block: 'nearest' }});
  const r = body.getBoundingClientRect();
  const step = {TERMINAL_POINT_STEP};
  for (let y = Math.min(r.bottom, innerHeight) - step; y > Math.max(r.top, 0); y -= step) {{
    for (let x = Math.min(r.right, innerWidth) - step; x > Math.max(r.left, 0); x -= step) {{
      const hit = document.elementFromPoint(x, y);
      if (hit && terminal.contains(hit)) {{
        return {{ x, y }};
      }}
    }}
  }}
  return null;
}})()"""

# The middle of the console bar's windows button, which hides every
# window and gives the terminal the keyboard (site/js/frame.js).
WINDOWS_BUTTON_POINT = """(() => {
  const button = document.getElementById('console-windows');
  button.scrollIntoView({ block: 'nearest' });
  const r = button.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()"""

# How far into a window's content the click that focuses it lands.
CLICK_DEPTH = 20

# The browser window's size for --viewport. A desktop's makes the
# console as tall as a reader would see it, with a program's window
# floating over the terminal; a phone's is narrower than foot's window.
# `mobile` asks Chromium for a phone's touch screen as well.
Viewport = collections.namedtuple("Viewport", ["width", "height", "mobile"])
VIEWPORT_DESKTOP = "desktop"
VIEWPORT_PHONE = "phone"
VIEWPORTS = {
    VIEWPORT_DESKTOP: Viewport(width=1280, height=1000, mobile=False),
    VIEWPORT_PHONE: Viewport(width=390, height=844, mobile=True),
}

# The touch points Chromium's emulated touch screen offers.
TOUCH_POINTS = 5

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

    def set_viewport(self, viewport):
        self.browser.send(
            "Emulation.setDeviceMetricsOverride",
            width=viewport.width,
            height=viewport.height,
            deviceScaleFactor=1,
            mobile=viewport.mobile,
        )

        # The page is laid out without a scrollbar. A screenshot that
        # captures beyond the viewport grows the viewport to the page's
        # height, which drops a scrollbar the page had, and the centred
        # console then sat 7.5 px right of the clip measured before.
        self.browser.send("Emulation.setScrollbarsHidden", hidden=True)

        if viewport.mobile:
            self.browser.send(
                "Emulation.setTouchEmulationEnabled",
                enabled=True,
                maxTouchPoints=TOUCH_POINTS,
            )

    def navigate(self, url):
        self.browser.send("Page.navigate", url=url)

    def preload(self, function):
        """Run `function`, the source of a JavaScript function, in every
        document this tab opens from now on, before the page's own
        scripts."""
        self.browser.send(
            "Page.addScriptToEvaluateOnNewDocument", source=f"({function})();"
        )

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

    def set_viewport(self, viewport):
        self.send(
            "browsingContext.setViewport",
            context=self.context,
            viewport={"width": viewport.width, "height": viewport.height},
        )

    def navigate(self, url):
        self.send("browsingContext.navigate", context=self.context, url=url, wait="none")

    def preload(self, function):
        """Run `function`, the source of a JavaScript function, in every
        document this tab opens from now on, before the page's own
        scripts."""
        self.send(
            "script.addPreloadScript",
            functionDeclaration=function,
            contexts=[self.context],
        )

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

# What the page's log says when the guest first looks inside the X
# server or the GL driver, which is when their closures join its store
# (site/js/app.js, serveCapabilities).
SERVER_USED = re.compile(r"capability: (/nix/store/\S+-xwayland-satellite-\S+)")
DRIVER_USED = re.compile(r"capability: (/nix/store/\S+-mesa-virgl-\S+)")

# A function the page runs before its own scripts (preload) that
# records the store paths whose NARs the page fetches, in
# window.trynixFetched as { path, bytes } with the narinfo's FileSize,
# from the narinfos it fetched before them. A NAR whose store path
# matches window.trynixHold's pattern, when one is set, is held back
# its `ms` the first time it is asked for: a download that sends
# nothing for 30 s is abandoned and asked for again (site/js/net.js),
# and the second attempt goes through.
FETCH_RECORDER = """() => {
  const fetched = [];
  const narOf = new Map();
  const held = new Set();
  const original = window.fetch.bind(window);
  window.trynixFetched = fetched;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href).href;
    const nar = narOf.get(url);
    if (nar !== undefined) {
      fetched.push(nar);
      const hold = window.trynixHold;
      if (hold && new RegExp(hold.pattern).test(nar.path) && !held.has(url)) {
        held.add(url);
        await new Promise((resolve) => setTimeout(resolve, hold.ms));
      }
    }
    const res = await original(input, init);
    if (url.endsWith(".narinfo") && res.ok) {
      const text = await res.clone().text();
      const path = /^StorePath: (.*)$/m.exec(text);
      const narUrl = /^URL: (.*)$/m.exec(text);
      const size = /^FileSize: (\\d+)$/m.exec(text);
      if (path && narUrl) {
        narOf.set(new URL(narUrl[1], url).href, {
          path: path[1],
          bytes: size ? Number(size[1]) : 0,
        });
      }
    }
    return res;
  };
}"""

# The store paths whose NARs the page has fetched so far, with sizes.
FETCHED = "JSON.parse(JSON.stringify(window.trynixFetched ?? []))"

# The gl case: es2gears alone; the guest's first look for the driver
# brings it in, and the page says so in its log. es2gears prints its
# frame rate every five seconds, as "<n> frames in 5.0 seconds = <fps>
# FPS"; two such lines are waited for, since the first includes the
# renderer's load.
GL_PACKAGES = ["mesa-demos"]
# The gl case's link types the command itself (run=, site/js/url.js),
# as the page's Try link does; the foot case types its own.
GL_COMMAND = "LIBDECOR_PLUGIN_DIR= es2gears_wayland &"
FPS_LINE = re.compile(r"frames in [\d.]+ seconds = ([\d.]+) FPS")
FPS_LINES = 2
FPS_LIMIT_SECONDS = 60


# The x11 case: xterm alone; xterm's first connection brings in the X
# server, which the page says in its log, and the link types the
# command. A line typed into the window writes a file, as in the foot
# case.
X11_PACKAGES = ["xterm"]
X11_COMMAND = "xterm &"
X11_TYPED_FILE = "/tmp/xterm-typed"
X11_TYPED = f"touch {X11_TYPED_FILE}\r"

# The title wland reports for xterm's window, which the satellite takes
# from the X11 window's name.
X11_TITLE = "xterm"

# Programs of the X server's closure that must stay off PATH: the X
# server itself, and, where the selection's own closure lacks them,
# what libdbus's autolaunch would start a bus with. xterm's closure
# holds neither dbus nor systemd; extremetuxracer's holds both, through
# pipewire, and offers their programs as any selection does.
SERVER_PROGRAMS = ["Xwayland", "xwayland-satellite"]
BUS_PROGRAMS = ["dbus-launch", "systemctl"]


# The feedback case: the guest program, where the case writes it, and
# the python3 that runs it. mesa-demos is selected for its closure's
# libglvnd, which the program loads GL through; the driver's link in the
# guest is logged once it is made, at the boot.
FEEDBACK_PACKAGES = ["python3", "mesa-demos"]
FEEDBACK_SCRIPT = os.path.join(HERE, "gl-feedback.py")
FEEDBACK_IN_GUEST = "/tmp/gl-feedback.py"
GUEST_PYTHON = "/share/bin/python3"
DRIVER_LINKED = "/run/opengl-driver is"
FEEDBACK_PASSED = "FEEDBACK-TEST PASS"
VIRGL_RENDERER = "renderer: virgl"

# What the renderer logs when a GL error puts a guest context in error
# (vrend_check_no_error), and how long its log has to catch up after
# the program's last read.
CONTEXT_ERROR = "context error reported"
LOG_SETTLE_SECONDS = 2


# The glx case: extremetuxracer alone. It draws through SFML 2, which
# speaks X11 alone and makes its GL context with GLX, and its closure
# holds libwayland through pipewire. Without an X server SFML aborts;
# with a server and no GLX in the driver it gets no context and
# SIGSEGVs. The link types the command; the window's title is the
# game's name and version.
GLX_PACKAGES = ["extremetuxracer"]
GLX_COMMAND = "etr &"
GLX_TITLE = re.compile(r"^Extreme Tux Racer ")
# How long the game's menu is watched for frames through the renderer.
GLX_DRAW_SECONDS = 10
# The page's GL renderer's counters, or null before it loads.
GL_STATS = (
    "window.trynix.kernel.gl?.stats"
    " ? JSON.parse(JSON.stringify(window.trynix.kernel.gl.stats)) : null"
)
# Succeeds when the game runs with the guest's render node open, which
# a GLX context on the virgl driver keeps.
GLX_HOLDS_RENDER_NODE = (
    "pid=$(pidof etr) && ls -l /proc/$pid/fd | grep -q /dev/dri/renderD128"
)

# The oldgl case: mesa-demos 8.5.0, from nixpkgs of early 2023, whose
# glibc 2.35 is older than the site's driver's floor of 2.38, and whose
# closure carries Mesa 22.3.7's drivers, the output with its EGL vendor
# file (25 MB). The page used to take that output for a Mesa the reader
# selected, fetch it with the selection and link it as the driver.
# osmesa, which mesa-demos references itself, is fetched with it as any
# selected package's references are. Each command runs in an
# environment from the shells' manifest and with a limit, and its exit
# status is checked: 1 is the program's own failure, and anything from
# 128 up is a signal.
OLDGL_PACKAGES = ["mesa-demos@8.5.0"]
OLDGL_COMMANDS = [
    "timeout 120 eglinfo",
    "LIBDECOR_PLUGIN_DIR= timeout 120 es2gears_wayland",
]
OLDGL_OWN_MESA = re.compile(r"-mesa-22\.3\.7-drivers$")
SHELL_ENVIRONMENT = ". /share/manifest"
COMMAND_NOT_FOUND = 127
SIGNAL_STATUS = 128
DRIVER_LINK = "/run/opengl-driver"
SITE_DRIVER = re.compile(r"-mesa-virgl-")

# The slowx case: xterm alone, with the NARs of the X server and of
# Xwayland held back from when the page first asks for them. xterm is
# looked at every HOLD_CHECK_SECONDS while it waits.
HOLD_PATTERN = r"-xwayland-satellite-\d|-xwayland-\d"
HOLD_MS = 35000
HOLD_CHECK_SECONDS = 10
XTERM_RUNNING = "pidof xterm > /dev/null"


CASES = ["foot", "gl", "x11", "feedback", "glx", "oldgl", "slowx"]

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


def boot(browser, base, packages, fetch, viewport, run=None):
    """Boot `packages` in a browser window of `viewport`'s size and wait
    for the shell; returns the seconds taken. The page records the NARs
    it fetches (FETCH_RECORDER)."""
    browser.set_viewport(VIEWPORTS[viewport])
    browser.preload(FETCH_RECORDER)
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


def screenshot(browser, directory, name, viewport):
    """Save the console, the terminal and the windows over it, as a PNG
    in `directory`, named for the case's step and the viewport."""
    if directory is None:
        return
    browser.evaluate("document.getElementById('console').scrollIntoView()")
    clip = browser.evaluate(
        "(() => { const r = document.getElementById('console')"
        ".getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY,"
        " width: r.width, height: r.height }; })()"
    )
    path = os.path.join(directory, f"{name}-{viewport}.png")
    with open(path, "wb") as f:
        f.write(browser.screenshot(clip))
    print(f"  screenshot: {path}")


def type_into_window(browser, text):
    """Click near the top of the newest window's content, which is on
    screen however tall the window is, then type `text` as key events."""
    # Scrolled into view first: Firefox refuses a click outside the
    # viewport, and the console can be taller than the viewport.
    point = browser.evaluate(
        "(() => { const c = [...document.querySelectorAll('#desktop canvas')].at(-1);"
        " c.scrollIntoView({ block: 'start' });"
        " const r = c.getBoundingClientRect();"
        f" return {{ x: r.x + r.width / 2, y: r.y + {CLICK_DEPTH} }}; }})()"
    )
    browser.click(point["x"], point["y"])
    for char in text:
        browser.press(char)


def type_into_terminal(browser, text):
    """Press the page's terminal where no window covers it, or the
    console bar's windows button when windows cover all of it, then type
    `text` as key events. Returns how the terminal was reached."""
    point = browser.evaluate(FREE_TERMINAL_POINT)
    reached = "a press on the terminal beside the window"
    if point is None:
        point = browser.evaluate(WINDOWS_BUTTON_POINT)
        reached = "the windows button, the window covering the terminal"
    browser.click(point["x"], point["y"])
    for char in text:
        browser.press(char)
    return reached


def guest_shell(browser, command, stdin=None):
    """Run `command` with the guest's /bin/sh through the page's exec,
    with `stdin` as its input; returns stdout, stderr and exitCode."""
    options = "" if stdin is None else ", { input: " + json.dumps(stdin) + " }"
    reply = browser.evaluate_async(
        "window.trynix.kernel.exec('/bin/sh', ['-c', "
        + json.dumps(command)
        + "]"
        + options
        + ").then((r) => JSON.stringify(r))"
    )
    return json.loads(reply)


def guest_has(browser, path):
    """Whether `path` exists in the guest, through the page's exec."""
    found = browser.evaluate_async(
        "window.trynix.kernel.exec('/bin/test', ['-e', "
        + json.dumps(path)
        + "]).then((r) => r.exitCode === 0)"
    )
    return found is True


def run_foot(browser, base, screenshots, fetch, viewport):
    """foot: boot it, start it, wait for its window, type into it, then
    type into the page's terminal behind it."""
    print("foot")
    seconds = boot(browser, base, FOOT_PACKAGES, fetch, viewport)
    print(f"  shell after {seconds:.1f} s")

    browser.type(FOOT_COMMAND)
    seconds = first_frame(browser)
    print(f"  first frame {seconds:.2f} s after the command")

    # Give the terminal its first prompt before the picture is taken
    # and before keys go to it.
    time.sleep(2)
    screenshot(browser, screenshots, "foot", viewport)

    type_into_window(browser, FOOT_TYPED)
    if not wait_for_file(browser, FOOT_TYPED_FILE):
        screenshot(browser, screenshots, "foot-typed", viewport)
        raise SystemExit("FAIL keys typed into foot's window never reached it")
    print(f"  keys reached foot: {FOOT_TYPED_FILE} written")
    screenshot(browser, screenshots, "foot-typed", viewport)

    browser.evaluate(COUNT_WINDOW_KEYS)
    reached = type_into_terminal(browser, TERMINAL_TYPED)
    print(f"  terminal reached by {reached}")
    ran = wait_for_file(browser, TERMINAL_TYPED_FILE)
    screenshot(browser, screenshots, "terminal-typed", viewport)
    if not ran:
        raise SystemExit("FAIL keys typed into the terminal never reached a shell")
    if TERMINAL_TYPED_FILE not in browser.transcript():
        raise SystemExit("FAIL the terminal's shell never echoed the line typed into it")
    window_keys = browser.evaluate("window.trynixKeysToWindows")
    if window_keys != 0:
        raise SystemExit(f"FAIL {window_keys} keys typed into the terminal went to a window")
    if browser.evaluate(ANY_WINDOW_FOCUSED):
        raise SystemExit("FAIL a window kept the keyboard while the terminal had it")
    print(f"  keys reached the terminal's shell and no window: {TERMINAL_TYPED_FILE} written")


def wait_for_file(browser, path):
    """Whether `path` appears in the guest within TYPED_LIMIT_SECONDS."""
    started = time.monotonic()
    while time.monotonic() - started < TYPED_LIMIT_SECONDS:
        if guest_has(browser, path):
            return True
        time.sleep(POLL_SECONDS * 5)
    return False


def run_gl(browser, base, screenshots, fetch, viewport):
    """gl: boot es2gears with Mesa, wait for its window and its frame
    rate, and check that the frames came through the GL renderer."""
    print("gl")
    seconds = boot(browser, base, GL_PACKAGES, fetch, viewport, run=GL_COMMAND)
    print(f"  shell after {seconds:.1f} s; the link types {GL_COMMAND!r}")

    seconds = first_frame(browser)
    print(f"  first frame {seconds:.2f} s after the shell")
    used = DRIVER_USED.search(debug_log(browser))
    if used is None:
        raise SystemExit("FAIL es2gears drew without the site's GL driver arriving")
    print(f"  driver arrived on first use: {used.group(1)}")

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
    screenshot(browser, screenshots, "es2gears", viewport)


def run_x11(browser, base, screenshots, fetch, viewport):
    """x11: boot xterm alone, let the link start it, wait for its window,
    and type into it."""
    print("x11")
    seconds = boot(browser, base, X11_PACKAGES, fetch, viewport, run=X11_COMMAND)
    print(f"  shell after {seconds:.1f} s; the link types {X11_COMMAND!r}")

    seconds = first_frame(browser)
    print(f"  first frame {seconds:.2f} s after the shell")
    titles = browser.evaluate(
        "window.trynix.desktop.windows().map((w) => w.title)"
    )
    if X11_TITLE not in titles:
        raise SystemExit(f"FAIL no window titled {X11_TITLE!r}: {titles}")
    check_x11_server(browser, SERVER_PROGRAMS + BUS_PROGRAMS)
    fetched = browser.evaluate(FETCHED)
    drivers = [nar["path"] for nar in fetched if SITE_DRIVER.search(nar["path"])]
    if drivers:
        raise SystemExit(f"FAIL xterm downloaded the GL driver: {drivers}")
    print(
        f"  {len(fetched)} NARs, {sum(nar['bytes'] for nar in fetched) / 1e6:.1f} MB"
        " fetched by the first window, none of the GL driver"
    )

    # Give xterm's shell its first prompt before the picture is taken
    # and before keys go to it.
    time.sleep(2)
    screenshot(browser, screenshots, "xterm", viewport)
    type_into_window(browser, X11_TYPED)
    if not wait_for_file(browser, X11_TYPED_FILE):
        screenshot(browser, screenshots, "xterm-typed", viewport)
        raise SystemExit("FAIL keys typed into xterm's window never reached it")
    print(f"  keys reached xterm: {X11_TYPED_FILE} written")
    screenshot(browser, screenshots, "xterm-typed", viewport)


def debug_log(browser):
    """The page's log, as the Debug section shows it."""
    return browser.evaluate("document.getElementById('debug-log').textContent")


def check_x11_server(browser, programs):
    """Fail unless the X server arrived on the guest's first use of it
    and left none of `programs`, from its closure, on PATH."""
    used = SERVER_USED.search(debug_log(browser))
    if used is None:
        raise SystemExit("FAIL the X server never arrived")
    print(f"  X server arrived on first use: {used.group(1)}")
    on_path = [name for name in programs if guest_has(browser, f"/share/bin/{name}")]
    if on_path:
        raise SystemExit(f"FAIL the X server's programs are on PATH: {on_path}")
    print(f"  none of {', '.join(programs)} on PATH")


def run_feedback(browser, base, screenshots, fetch, viewport):
    """feedback: boot python3 with the site's GL driver, run
    tools/gl-feedback.py in the guest and check what each draw read back
    and the renderer's log."""
    del screenshots  # The program draws off screen.
    print("feedback")
    seconds = boot(browser, base, FEEDBACK_PACKAGES, fetch, viewport)
    print(f"  shell after {seconds:.1f} s")
    wait_for(
        browser,
        "document.getElementById('debug-log').textContent.includes("
        + json.dumps(DRIVER_LINKED)
        + ")",
        BOOT_LIMIT_SECONDS,
        "GL driver link",
    )

    # The program goes in as the input of a cat, then runs.
    with open(FEEDBACK_SCRIPT) as f:
        written = guest_shell(browser, f"cat > {FEEDBACK_IN_GUEST}", f.read())
    if written["exitCode"] != 0:
        raise SystemExit(f"FAIL writing {FEEDBACK_IN_GUEST}: {written['stderr']}")
    result = guest_shell(browser, f"{GUEST_PYTHON} {FEEDBACK_IN_GUEST}")
    for line in (result["stdout"] + result["stderr"]).splitlines():
        print(f"  {line}")

    # The renderer logs a context error as it runs the command buffer,
    # which the program's reads waited for; the log reaches the page
    # a moment later.
    time.sleep(LOG_SETTLE_SECONDS)
    log = browser.evaluate("document.getElementById('debug-log').textContent")
    errors = [line.strip() for line in log.splitlines() if CONTEXT_ERROR in line]
    for line in errors:
        print(f"  renderer: {line}")

    if VIRGL_RENDERER not in result["stdout"]:
        raise SystemExit("FAIL the program did not draw through virgl")
    if errors:
        raise SystemExit("FAIL the renderer put the program's context in error")
    if result["exitCode"] != 0 or FEEDBACK_PASSED not in result["stdout"]:
        raise SystemExit("FAIL a draw read back the wrong colour")
    print("  every draw read back its colour; no context error")


def run_glx(browser, base, screenshots, fetch, viewport):
    """glx: boot extremetuxracer alone, let the link start it, wait for
    its window, and check that its frames came through the GL renderer
    by GPU resource, which GLX reaches only by DRI3 on a glamor
    Xwayland."""
    print("glx")
    seconds = boot(browser, base, GLX_PACKAGES, fetch, viewport, run=GLX_COMMAND)
    print(f"  shell after {seconds:.1f} s; the link types {GLX_COMMAND!r}")

    # A window is waited for by its title rather than by the first
    # frame alone, so that a game that died is told apart from one
    # still loading: SFML's abort and SIGSEGV are in the transcript.
    started = time.monotonic()
    titles = []
    while time.monotonic() - started < FRAME_LIMIT_SECONDS:
        titles = browser.evaluate(
            "window.trynix.desktop?.windows().map((w) => w.title) ?? []"
        )
        if any(GLX_TITLE.search(title) for title in titles):
            break
        time.sleep(POLL_SECONDS * 5)
    else:
        print(browser.transcript()[-2000:])
        raise SystemExit(f"FAIL no window titled {GLX_TITLE.pattern!r}: {titles}")
    print(f"  window {titles} {time.monotonic() - started:.1f} s after the shell")
    check_x11_server(browser, SERVER_PROGRAMS)
    used = DRIVER_USED.search(debug_log(browser))
    if used is None:
        raise SystemExit("FAIL the game drew without the site's GL driver arriving")
    print(f"  driver arrived on first use: {used.group(1)}")

    # Frames by GPU resource keep coming while the game draws its menu.
    # Xwayland's glamor submits work to the renderer too, so the game's
    # own use of the GPU is read from the guest: a GLX context rendering
    # through virgl holds the render node open.
    first = browser.evaluate(GL_STATS)
    time.sleep(GLX_DRAW_SECONDS)
    stats = browser.evaluate(GL_STATS)
    if first is None or stats is None:
        raise SystemExit("FAIL the page's GL renderer never loaded")
    submits = stats["renderer"]["submits"] - first["renderer"]["submits"]
    images = stats["gpu"]["images"] - first["gpu"]["images"]
    print(
        f"  in {GLX_DRAW_SECONDS} s: virgl submits {submits},"
        f" frames taken by GPU resource {images}"
    )
    screenshot(browser, screenshots, "extremetuxracer", viewport)
    if submits == 0 or images == 0:
        raise SystemExit("FAIL extremetuxracer did not draw through the page's renderer")
    holds = guest_shell(browser, GLX_HOLDS_RENDER_NODE)
    if holds["exitCode"] != 0:
        print(browser.transcript()[-2000:])
        raise SystemExit(
            "FAIL extremetuxracer is not running with the render node open:"
            f" {holds['stdout']}{holds['stderr']}"
        )
    print("  extremetuxracer holds the render node")


def run_oldgl(browser, base, screenshots, fetch, viewport):
    """oldgl: boot mesa-demos 8.5.0, older than the site's driver, and
    check that the guest links the site's driver rather than the Mesa in
    the program's closure, downloads none of that Mesa, and that each
    GL program fails with an exit status rather than a signal."""
    del screenshots  # The programs open no window.
    print("oldgl")
    seconds = boot(browser, base, OLDGL_PACKAGES, fetch, viewport)
    print(f"  shell after {seconds:.1f} s")

    link = guest_shell(browser, f"readlink {DRIVER_LINK}")["stdout"].strip()
    if not SITE_DRIVER.search(link):
        raise SystemExit(f"FAIL {DRIVER_LINK} is {link!r}, not the site's driver")
    print(f"  {DRIVER_LINK} is {link}")

    for command in OLDGL_COMMANDS:
        result = guest_shell(browser, f"{SHELL_ENVIRONMENT}; {command} 2>&1")
        status = result["exitCode"]
        last = result["stdout"].strip().splitlines()[-1:] or [""]
        print(f"  {command}: exit {status}, {last[0]!r}")
        if status in (0, COMMAND_NOT_FOUND) or status >= SIGNAL_STATUS:
            raise SystemExit(f"FAIL {command} exited {status}, not with its own error")

    own = [
        nar["path"]
        for nar in browser.evaluate(FETCHED)
        if OLDGL_OWN_MESA.search(nar["path"])
    ]
    if own:
        raise SystemExit(f"FAIL the program's own Mesa was downloaded: {own}")
    print("  none of the program's own Mesa downloaded")


def run_slowx(browser, base, screenshots, fetch, viewport):
    """slowx: boot xterm alone with the X server's NARs held back, start
    xterm, and check that it waits through the hold for its window."""
    del screenshots  # The window is the x11 case's.
    print("slowx")
    browser.preload(
        f"() => {{ window.trynixHold = {{ pattern: {json.dumps(HOLD_PATTERN)}, ms: {HOLD_MS} }}; }}"
    )
    seconds = boot(browser, base, X11_PACKAGES, fetch, viewport)
    print(f"  shell after {seconds:.1f} s; X server held back {HOLD_MS / 1000:g} s")

    browser.type(f"{X11_COMMAND}\n")
    started = time.monotonic()
    checked = 0
    while browser.evaluate("window.trynix?.desktopStats?.firstCommitAt == null"):
        waited = time.monotonic() - started
        if waited > HOLD_MS / 1000 + FRAME_LIMIT_SECONDS:
            raise SystemExit(f"FAIL no window {waited:.0f} s after the command")
        if waited >= (checked + 1) * HOLD_CHECK_SECONDS:
            checked += 1
            if guest_shell(browser, XTERM_RUNNING)["exitCode"] != 0:
                print(browser.transcript()[-2000:])
                raise SystemExit(f"FAIL xterm gave up waiting after {waited:.0f} s")
            print(f"  xterm still waiting at {waited:.0f} s")
        time.sleep(POLL_SECONDS)
    waited = time.monotonic() - started
    print(f"  window {waited:.1f} s after the command")
    if waited < HOLD_MS / 1000:
        raise SystemExit("FAIL the window came before the hold ended")


RUNNERS = {
    "foot": run_foot,
    "gl": run_gl,
    "x11": run_x11,
    "feedback": run_feedback,
    "glx": run_glx,
    "oldgl": run_oldgl,
    "slowx": run_slowx,
}


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
    parser.add_argument("--screenshots", help="a directory to save the console in")
    parser.add_argument(
        "--viewport",
        choices=list(VIEWPORTS),
        default=VIEWPORT_DESKTOP,
        help="the browser window's size: a desktop's (the default) or a phone's",
    )
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
                RUNNERS[case](
                    browser, base, args.screenshots, args.fetch, args.viewport
                )
            finally:
                browser.close()
    finally:
        if shutdown is not None:
            shutdown()
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
