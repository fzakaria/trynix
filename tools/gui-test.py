#!/usr/bin/env python3
"""Run GUI programs from nixpkgs in the unkernel guest and check that
their windows reach the page.

A GUI program crosses more pieces than anything else the page runs:
the relay the page writes into the guest, the vsock link, wland's
compositor on the page, kwshm for a program's pixels and, for GL,
Mesa's virgl driver, the guest's virtio-gpu device and the wasm GL
renderer, and for Vulkan, unkernel's kwvk driver and its renderer on
the page's WebGPU. boot-test only asks whether a shell appears, which
it does with every one of those broken. This boots a link, starts the
program at the shell the way a reader would, and waits for the
compositor to take a frame from it.

    nix run .#gui-test -- --site <a built site directory>
    nix run .#gui-test -- --site <site> --case foot --screenshots /tmp/gui
    nix run .#gui-test -- --site <site> --with firefox
    nix run .#gui-test -- --site <site> --fetch all
    nix run .#gui-test -- --site <site> --viewport phone
    nix run .#gui-test -- --site <site> --case vulkan --webgpu off

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
    vulkan vulkan-tools alone, with guest Vulkan on (vk=1, which only
           this case and llm set): `vulkaninfo --summary` typed at the
           page's shell, then `vkcube --wsi wayland`. With a WebGPU
           adapter, vulkaninfo must name kwvk's device and vkcube's
           window must draw through kwvk: frames presented by the
           renderer and taken by the compositor, in the LunarG cube's
           colours. Without one, vulkaninfo must fail with
           VK_ERROR_INCOMPATIBLE_DRIVER and the guest go on answering.
    llm    llama.cpp's Vulkan build with vk=1 and a 1 MB model the link
           names by URL and hash (file=), as the page's LLM Try link
           names its own: llama-completion typed at the shell
           continues a prompt. It must exit 0 and print words past
           the prompt. With a WebGPU adapter the renderer must have
           run llama.cpp's compute work with no errors; without one,
           llama.cpp runs on the guest's CPU and must still answer.

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

--webgpu is Chromium's WebGPU: SwiftShader's, which gives the page an
adapter on any host, or none, which is what Chromium on Linux gives
without flags. Every case runs with it; only the vulkan and llm cases
turn guest Vulkan on, so the others run as a reader's link does by
default. Firefox has its own WebGPU, and those two cases take either
outcome there.

A boot needs the network: the closures come from cache.nixos.org, the
llm case's model from Hugging Face, and the driver from the site's own
cache (gl/), which a site with no published driver lacks; the gl case
fails there.
"""

import argparse
import base64
import collections
import enum
import importlib.util
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import zlib

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


class Adapter(enum.Enum):
    """What a driver's browser says about a WebGPU adapter: it gives
    the page one, it gives none, or the browser decides for itself and
    the vulkan case takes either."""

    PRESENT = "present"
    ABSENT = "absent"
    UNKNOWN = "unknown"


class Chromium:
    """Chromium over the DevTools protocol: cpu-test.py's Browser, with
    the operations the cases use."""

    def __init__(self, binary, profile, gpu, webgpu):
        self.browser = cpu.Browser(binary, profile, gpu=gpu, webgpu=webgpu)
        self.adapter = Adapter.PRESENT if webgpu is cpu.WebGpu.SOFTWARE else Adapter.ABSENT

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

    def __init__(self, binary, profile, gpu, webgpu):
        del gpu, webgpu  # Firefox picks its WebGL and WebGPU backends itself.
        self.adapter = Adapter.UNKNOWN
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


# The vulkan case: vulkan-tools alone, booted with vk=1. vulkaninfo is
# typed at the page's shell, which sourced the manifest that names kwvk
# to the Vulkan loader (site/js/gui.js, sessionEnv), so it runs as a
# reader's would; its output and status go to files the case reads
# through the page's exec.
VULKAN_PACKAGES = ["vulkan-tools"]
VULKANINFO_OUT = "/tmp/vulkaninfo.out"
VULKANINFO_STATUS = "/tmp/vulkaninfo.status"
VULKANINFO_COMMAND = (
    f"vulkaninfo --summary > {VULKANINFO_OUT} 2>&1; echo $? > {VULKANINFO_STATUS}\n"
)
VULKANINFO_LIMIT_SECONDS = 60

# What vulkaninfo prints for kwvk's device, and how it fails when the
# browser gives the renderer no WebGPU adapter: kwvk's driver answers
# the loader VK_ERROR_INCOMPATIBLE_DRIVER and no other driver is there.
KWVK_DEVICE = "kwvk (WebGPU)"
INCOMPATIBLE_DRIVER = "ERROR_INCOMPATIBLE_DRIVER"

# The renderer's state once it is loaded on a WebGPU device
# (vm.vk.status.state in unkernel's SDK). Without an adapter it is
# "failed", with the reason in vm.vk.status.error.
VK_READY = "ready"

# vkcube on Wayland, left running. nixpkgs' vkcube (vulkan-tools 1.4.304
# on) loads libwayland-client with dlopen, and its RUNPATH names only the
# Vulkan loader, so the library is found only when the process already
# holds it. On NixOS Mesa's Vulkan driver links it and the dlopen finds
# that copy; kwvk's driver opens Wayland with dlopen as well, so in the
# guest vkcube says "Cannot load wayland dynamic library" and exits.
# The command names the store's libwayland directories for it, joined
# by colons: the store holds more than one libwayland once the GL
# driver's and the X server's closures are in it, and any of them
# serves.
VKCUBE_COMMAND = (
    "LD_LIBRARY_PATH=$(ls -d /nix/store/*-wayland-[0-9]*/lib | tr '\\n' :)"
    " vkcube --wsi wayland &\n"
)
VKCUBE_TITLE = "vkcube"

# How many frames the renderer must have presented, and the compositor
# taken, before the window's picture is judged, and how long they may
# take.
VKCUBE_FRAMES = 30
FRAMES_LIMIT_SECONDS = 60

# The judgement of vkcube's picture, after unkernel's own check: many
# colours, and the LunarG logo's teal rather than the olive a swap of
# red and blue makes of it. A pixel is teal when its green and blue
# both exceed its red by TINT_MARGIN, olive when its red and green both
# exceed its blue by as much. Measured on a right frame, 2026-11-24: 7.6%
# teal, no olive, 2981 colours over a 500x500 window.
TINT_MARGIN = 30
MIN_TEAL_FRACTION = 0.01
MIN_COLOURS = 256

# The llm case: the Vulkan build of llama.cpp the page's LLM Try link
# boots, at the same version, with a model the link names by URL and
# hash (file=) as that link names its own. The model is stories260K, a
# 1.2 MB llama from the tinyllamas set, on Hugging Face at a commit,
# whose CDN sends CORS headers; its store path is the one
# `nix store prefetch-file` printed for it.
LLM_PACKAGES = ["llama-cpp-vulkan@1.0.0"]
LLM_MODEL_URL = (
    "https://huggingface.co/ggml-org/models-moved/resolve/"
    "499bc8821c6b12b4e53c5bffcb21ec206f212d81/tinyllamas/stories260K.gguf"
)
LLM_MODEL_HASH = "sha256-Jwy6G9UQn0LQM1D2BAYCRWBGTbFzwOOH2R8EJtO9JW0="
LLM_MODEL_PATH = "/nix/store/mxkcjc93z0kyzrnh7hcky8bsd725yjrj-stories260K.gguf"

# llama-completion continues the prompt for LLM_TOKENS tokens with every
# layer on the GPU, printing the prompt and then the continuation. Its
# log goes to a file of its own, so the output file holds the text
# alone.
LLM_PROMPT = "Once upon a time"
LLM_TOKENS = 24
LLM_OUT = "/tmp/llm.out"
LLM_STATUS = "/tmp/llm.status"
LLM_COMMAND = (
    f"llama-completion -m {LLM_MODEL_PATH} -ngl 99 -n {LLM_TOKENS} -no-cnv"
    f" -p '{LLM_PROMPT}' > {LLM_OUT} 2> /tmp/llm.err; echo $? > {LLM_STATUS}\n"
)
LLM_LIMIT_SECONDS = 180


CASES = ["foot", "gl", "x11", "feedback", "glx", "oldgl", "slowx", "vulkan", "llm"]

# --gpu's choices, and the browser's WebGL for each.
GPU_SOFTWARE = "software"
GPU_HARDWARE = "hardware"
GPUS = {GPU_SOFTWARE: cpu.Gpu.SOFTWARE, GPU_HARDWARE: cpu.Gpu.HARDWARE}

# --webgpu's choices, and Chromium's WebGPU for each. Firefox has its
# own and takes none.
WEBGPU_SOFTWARE = "software"
WEBGPU_OFF = "off"
WEBGPUS = {WEBGPU_SOFTWARE: cpu.WebGpu.SOFTWARE, WEBGPU_OFF: cpu.WebGpu.OFF}


# When the closure downloads, by the name a link carries
# (site/js/downloads.js).
FETCH_MODES = ["lazy", "all"]


class Vulkan(enum.Enum):
    """Guest Vulkan's switch, as a link writes it (site/js/vulkan.js,
    the link's `vk`): off, the page's default, which a link leaves out,
    or on."""

    OFF = "0"
    ON = "1"


def page_url(base, packages, fetch, run=None, vulkan=Vulkan.OFF, files=()):
    """The link that boots `packages` on unkernel without a click,
    naming when the closure downloads if `fetch` is not None, the
    command the page types at the shell if `run` is not None, guest
    Vulkan when `vulkan` turns it on, and each of `files`, a URL and a
    hash with a space between, as a file= (site/js/files.js)."""
    query = [("pkg", name) for name in packages]
    query += [("file", file) for file in files]
    query += [("engine", ENGINE)]
    if fetch is not None:
        query += [("fetch", fetch)]
    if run is not None:
        query += [("run", run)]
    if vulkan is Vulkan.ON:
        query += [("vk", vulkan.value)]
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


def boot(
    browser, base, packages, fetch, viewport, run=None, vulkan=Vulkan.OFF, files=()
):
    """Boot `packages` and `files` in a browser window of `viewport`'s
    size, with guest Vulkan as `vulkan` says, and wait for the shell;
    returns the seconds taken. The page records the NARs it fetches
    (FETCH_RECORDER)."""
    browser.set_viewport(VIEWPORTS[viewport])
    browser.preload(FETCH_RECORDER)
    browser.navigate(page_url(base, packages, fetch, run, vulkan, files))
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


# PNG's signature, and the colour types a browser's screenshot comes
# in, by the bytes each pixel takes: RGB and RGBA, 8 bits a channel.
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_CHANNELS = {2: 3, 6: 4}
PNG_DEPTH = 8

# PNG's row filters (the PNG specification, section 9).
PNG_FILTER_NONE = 0
PNG_FILTER_SUB = 1
PNG_FILTER_UP = 2
PNG_FILTER_AVERAGE = 3
PNG_FILTER_PAETH = 4


def paeth(left, up, corner):
    """PNG's Paeth predictor: whichever neighbour is nearest to
    left + up - corner."""
    guess = left + up - corner
    to_left, to_up, to_corner = abs(guess - left), abs(guess - up), abs(guess - corner)
    if to_left <= to_up and to_left <= to_corner:
        return left
    if to_up <= to_corner:
        return up
    return corner


def png_pixels(data):
    """The pixels of a browser screenshot's PNG, as (channels, rows):
    each row a bytes of RGB or RGBA. Only what screenshots use: 8 bits a
    channel, not interlaced."""
    if data[: len(PNG_SIGNATURE)] != PNG_SIGNATURE:
        raise SystemExit("FAIL the screenshot is not a PNG")

    # The header and the image data, from the chunks.
    pos = len(PNG_SIGNATURE)
    compressed = []
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
        if kind == b"IDAT":
            compressed.append(body)
    if depth != PNG_DEPTH or colour not in PNG_CHANNELS or interlace != 0:
        raise SystemExit(f"FAIL the screenshot's PNG is of a kind not read here: {depth}, {colour}")

    # Each row starts with its filter, which says how to predict each
    # byte from the one to its left, the one above, or both.
    channels = PNG_CHANNELS[colour]
    stride = width * channels
    raw = zlib.decompress(b"".join(compressed))
    rows = []
    above = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        row = bytearray(raw[start + 1 : start + 1 + stride])
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            corner = above[x - channels] if x >= channels else 0
            if kind == PNG_FILTER_SUB:
                row[x] = (row[x] + left) & 0xFF
            elif kind == PNG_FILTER_UP:
                row[x] = (row[x] + above[x]) & 0xFF
            elif kind == PNG_FILTER_AVERAGE:
                row[x] = (row[x] + (left + above[x]) // 2) & 0xFF
            elif kind == PNG_FILTER_PAETH:
                row[x] = (row[x] + paeth(left, above[x], corner)) & 0xFF
        rows.append(bytes(row))
        above = row
    return channels, rows


def tints(png):
    """What vkcube's picture holds: the fraction of its pixels that are
    teal, the fraction that are olive (see TINT_MARGIN), and how many
    colours it has."""
    channels, rows = png_pixels(png)
    teal = olive = total = 0
    colours = set()
    for row in rows:
        for x in range(0, len(row), channels):
            red, green, blue = row[x], row[x + 1], row[x + 2]
            total += 1
            colours.add((red, green, blue))
            if green - red >= TINT_MARGIN and blue - red >= TINT_MARGIN:
                teal += 1
            if red - blue >= TINT_MARGIN and green - blue >= TINT_MARGIN:
                olive += 1
    return teal / total, olive / total, len(colours)


def window_clip(browser):
    """The newest window's content, as a screenshot's clip in the
    document's coordinates."""
    return browser.evaluate(
        "(() => { const c = [...document.querySelectorAll('#desktop canvas')].at(-1);"
        " c.scrollIntoView({ block: 'nearest' });"
        " const r = c.getBoundingClientRect();"
        " return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()"
    )


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


def read_when_written(browser, path, limit, label):
    """The contents of `path` in the guest once it holds something, read
    through the page's exec; fails the run after `limit` seconds."""
    started = time.monotonic()
    while time.monotonic() - started < limit:
        contents = guest_shell(browser, f"cat {path} 2>/dev/null")["stdout"]
        if contents.strip():
            return contents
        time.sleep(POLL_SECONDS * 5)
    raise SystemExit(f"FAIL {label}: nothing in {path} after {limit} s")


def vk_value(browser, name):
    """The SDK's guest Vulkan renderer's `name` (vm.vk: status or
    stats), as plain values, or None when the SDK took no Vulkan, as it
    does in a browser without navigator.gpu."""
    return browser.evaluate(
        f"(() => {{ const vk = window.trynix.kernel.vk;"
        f" return vk ? JSON.parse(JSON.stringify(vk.{name})) : null; }})()"
    )


def run_vulkan(browser, base, screenshots, fetch, viewport):
    """vulkan: boot vulkan-tools and run vulkaninfo at the page's shell.
    With a WebGPU adapter, vulkaninfo must name kwvk's device, and
    vkcube's window must draw through kwvk: frames the renderer
    presented, the compositor took, and a picture of the right colours.
    Without one, vulkaninfo must fail with VK_ERROR_INCOMPATIBLE_DRIVER
    and the page must go on running the guest."""
    print("vulkan")
    seconds = boot(browser, base, VULKAN_PACKAGES, fetch, viewport, vulkan=Vulkan.ON)
    print(f"  shell after {seconds:.1f} s")

    # vulkaninfo, typed at the page's shell. Its status is written
    # last, so a status means its output is all there.
    started = time.monotonic()
    browser.type(VULKANINFO_COMMAND)
    status = int(
        read_when_written(browser, VULKANINFO_STATUS, VULKANINFO_LIMIT_SECONDS, "vulkaninfo")
    )
    seconds = time.monotonic() - started
    output = guest_shell(browser, f"cat {VULKANINFO_OUT}")["stdout"]

    # Whether the renderer got an adapter, against what the browser was
    # launched to give it.
    renderer = vk_value(browser, "status")
    has_adapter = renderer is not None and renderer["state"] == VK_READY
    why = "no navigator.gpu" if renderer is None else renderer["error"]
    if browser.adapter is Adapter.PRESENT and not has_adapter:
        raise SystemExit(f"FAIL the browser was to give WebGPU an adapter and gave none: {why}")
    if browser.adapter is Adapter.ABSENT and has_adapter:
        raise SystemExit(f"FAIL the browser was to give WebGPU no adapter and gave {renderer['adapter']}")

    # No adapter: vulkaninfo fails as it does with no driver, and the
    # guest still answers the page.
    if not has_adapter:
        print(f"  no WebGPU adapter ({why}); vulkaninfo exited {status} after {seconds:.2f} s")
        if status == 0 or INCOMPATIBLE_DRIVER not in output:
            raise SystemExit(f"FAIL vulkaninfo did not fail with {INCOMPATIBLE_DRIVER}:\n{output}")
        if guest_shell(browser, "true")["exitCode"] != 0:
            raise SystemExit("FAIL the guest stopped answering after vulkaninfo")
        print(f"  vulkaninfo failed with {INCOMPATIBLE_DRIVER}; the guest still answers")
        return

    print(
        f"  renderer on {renderer['adapter']}, loaded in {renderer['loadMs']:.0f} ms;"
        f" vulkaninfo exited {status} after {seconds:.2f} s"
    )
    if status != 0 or KWVK_DEVICE not in output:
        raise SystemExit(f"FAIL vulkaninfo did not name {KWVK_DEVICE}:\n{output}")

    # vkcube's window: its first frame, then frames until the renderer
    # has presented VKCUBE_FRAMES of them.
    browser.type(VKCUBE_COMMAND)
    seconds = first_frame(browser)
    print(f"  first frame {seconds:.2f} s after the command")
    _, seconds = wait_for(
        browser,
        f"(window.trynix.kernel.vk.stats.renderer?.presents ?? 0) >= {VKCUBE_FRAMES}"
        f" && window.trynix.desktopStats.commits >= {VKCUBE_FRAMES}",
        FRAMES_LIMIT_SECONDS,
        f"{VKCUBE_FRAMES} vkcube frames",
    )
    stats = vk_value(browser, "stats")
    print(
        f"  {VKCUBE_FRAMES} frames {seconds:.2f} s later; renderer: {stats['renderer']['presents']}"
        f" presents, {stats['renderer']['errors']} errors"
    )
    titles = browser.evaluate("window.trynix.desktop.windows().map((w) => w.title)")
    if VKCUBE_TITLE not in titles:
        raise SystemExit(f"FAIL no window titled {VKCUBE_TITLE!r}: {titles}")
    if stats["renderer"]["errors"] != 0:
        raise SystemExit("FAIL the renderer reported errors for vkcube")

    # The picture: the window's content as the page shows it.
    teal, olive, colours = tints(browser.screenshot(window_clip(browser)))
    screenshot(browser, screenshots, "vkcube", viewport)
    print(f"  picture: {teal:.1%} teal, {olive:.1%} olive, {colours} colours")
    if teal < MIN_TEAL_FRACTION or olive >= teal or colours < MIN_COLOURS:
        raise SystemExit("FAIL vkcube's picture is not the LunarG cube's")


def run_llm(browser, base, screenshots, fetch, viewport):
    """llm: boot llama.cpp's Vulkan build with a model the link names
    by URL and hash, and have llama-completion continue a prompt at the
    page's shell. It must exit 0 and print words past the prompt. With
    a WebGPU adapter the renderer must have run its compute work with
    no errors; without one llama.cpp falls back to the guest's CPU and
    must answer all the same."""
    del screenshots  # the case draws no window
    print("llm")
    seconds = boot(
        browser,
        base,
        LLM_PACKAGES,
        fetch,
        viewport,
        vulkan=Vulkan.ON,
        files=[f"{LLM_MODEL_URL} {LLM_MODEL_HASH}"],
    )
    print(f"  shell after {seconds:.1f} s")

    # llama-completion, typed at the page's shell. Its status is
    # written last, so a status means its output is all there.
    started = time.monotonic()
    browser.type(LLM_COMMAND)
    status = int(read_when_written(browser, LLM_STATUS, LLM_LIMIT_SECONDS, "llama-completion"))
    seconds = time.monotonic() - started
    output = guest_shell(browser, f"cat {LLM_OUT}")["stdout"]
    continuation = output.split(LLM_PROMPT, 1)[-1].strip()
    print(f"  llama-completion exited {status} after {seconds:.2f} s: {output.strip()[:80]!r}")
    if status != 0 or LLM_PROMPT not in output or not continuation:
        log = guest_shell(browser, "tail -n 20 /tmp/llm.err")["stdout"]
        raise SystemExit(f"FAIL llama-completion did not continue the prompt:\n{output}\n{log}")

    # Where the work ran, against what the browser was launched to give.
    renderer = vk_value(browser, "status")
    has_adapter = renderer is not None and renderer["state"] == VK_READY
    why = "no navigator.gpu" if renderer is None else renderer["error"]
    if browser.adapter is Adapter.PRESENT and not has_adapter:
        raise SystemExit(f"FAIL the browser was to give WebGPU an adapter and gave none: {why}")
    if browser.adapter is Adapter.ABSENT and has_adapter:
        raise SystemExit(f"FAIL the browser was to give WebGPU no adapter and gave {renderer['adapter']}")
    if not has_adapter:
        print(f"  no WebGPU adapter ({why}); llama.cpp answered on the guest's CPU")
        return

    stats = vk_value(browser, "stats")["renderer"]
    print(
        f"  renderer on {renderer['adapter']}: {stats['dispatches']} dispatches,"
        f" {stats['pipelines']} pipelines, {stats['errors']} errors"
    )
    if stats["dispatches"] == 0:
        raise SystemExit("FAIL llama.cpp answered without running anything on kwvk")
    if stats["errors"] != 0:
        raise SystemExit("FAIL the renderer reported errors for llama.cpp")


RUNNERS = {
    "foot": run_foot,
    "gl": run_gl,
    "x11": run_x11,
    "feedback": run_feedback,
    "glx": run_glx,
    "oldgl": run_oldgl,
    "slowx": run_slowx,
    "vulkan": run_vulkan,
    "llm": run_llm,
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
    parser.add_argument(
        "--webgpu",
        choices=list(WEBGPUS),
        default=WEBGPU_SOFTWARE,
        help="Chromium's WebGPU: SwiftShader's (the default, any host) or none, as Chromium on Linux has",
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
                binary, os.path.join(workdir, case), GPUS[args.gpu], WEBGPUS[args.webgpu]
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
