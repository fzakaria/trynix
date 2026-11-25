"""Tests for tools/gui-test.py's Chromium driver: the browser window it
sets up lays the page out at the same width while a screenshot captures
beyond the viewport as it did when the screenshot's clip was measured,
and the switches it starts Chromium with give WebGPU an adapter without
losing SharedArrayBuffer. Also the PNG reader the vulkan case judges
vkcube's picture with. A fake DevTools browser records what the driver
sends; nothing here starts a browser or reaches the network."""

import importlib.util
import os
import struct
import sys
import types
import unittest
import urllib.parse
import zlib
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "..", "tools", "gui-test.py")

# What the driver is started with; the recording browser runs neither.
BINARY = "chromium"
PROFILE = "profile"

# The call that hides the page's scrollbars, as the driver sends it.
HIDE_SCROLLBARS = ("Emulation.setScrollbarsHidden", {"hidden": True})


def unreached(*args, **kwargs):
    raise AssertionError("the fake browser opened a socket")


def load_tool():
    """gui-test.py as a module. It and cpu-test.py import websocket,
    which the test environment does not have and which the fake browser
    never connects with, so a placeholder module stands in."""
    placeholder = types.ModuleType("websocket")
    placeholder.create_connection = unreached
    sys.modules.setdefault("websocket", placeholder)
    spec = importlib.util.spec_from_file_location("gui_test", TOOL)
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    return tool


class RecordingBrowser:
    """cpu-test.py's Browser as the Chromium driver uses it: every
    DevTools call is kept, by method and parameters, and answered with
    nothing."""

    def __init__(self, binary, profile, gpu, webgpu):
        self.calls = []

    def send(self, method, **params):
        self.calls.append((method, params))
        return {"result": {}}


class ChromiumViewportTest(unittest.TestCase):
    """The browser window the Chromium driver sets for each --viewport."""

    def test_scrollbars_are_hidden_for_every_viewport(self):
        """Sets each viewport on a driver over the recording browser and
        checks that the driver hid the scrollbars. A screenshot that
        captures beyond the viewport grows it to the page's height, the
        page's scrollbar goes, and the console, centred, moved 7.5 px
        right of the clip measured with the scrollbar there: the picture
        lost the console's right 7.5 px, and a window against the
        frame's right edge looked cut off."""
        tool = load_tool()
        tool.cpu.Browser = RecordingBrowser

        for name, viewport in tool.VIEWPORTS.items():
            with self.subTest(viewport=name):
                driver = tool.Chromium(
                    BINARY, PROFILE, tool.cpu.Gpu.SOFTWARE, tool.cpu.WebGpu.SOFTWARE
                )
                driver.set_viewport(viewport)
                self.assertIn(HIDE_SCROLLBARS, driver.browser.calls)


class LaunchStopped(Exception):
    """Raised by the recording Popen to end a launch once its command
    line is kept."""


# The Chromium features each WebGPU choice must enable: SharedArrayBuffer
# always, and the features unkernel's tests name for SwiftShader's WebGPU.
EXPECTED_FEATURES = {
    "OFF": {"SharedArrayBuffer"},
    "SOFTWARE": {"SharedArrayBuffer", "Vulkan", "WebGPU"},
}

# The switch that picks SwiftShader for WebGPU's adapter.
SWIFTSHADER_ADAPTER = "--use-webgpu-adapter=swiftshader"


class WebGpuSwitchesTest(unittest.TestCase):
    """The command line cpu-test.py's Browser starts Chromium with, for
    each WebGPU choice."""

    def test_features_go_in_one_switch(self):
        """Starts the Browser with each WebGpu over a Popen that keeps
        its command line and stops the launch. Checks that exactly one
        --enable-features names every feature the choice needs, since a
        second such switch could drop SharedArrayBuffer, which the
        page's worker mode needs, or WebGPU's features. Checks too that
        only the software choice asks for SwiftShader's adapter."""
        tool = load_tool()
        for name, features in EXPECTED_FEATURES.items():
            with self.subTest(webgpu=name):
                launched = []

                def popen(command, **kwargs):
                    launched.append(command)
                    raise LaunchStopped()

                with mock.patch.object(tool.cpu.subprocess, "Popen", side_effect=popen):
                    with self.assertRaises(LaunchStopped):
                        tool.cpu.Browser(
                            BINARY,
                            PROFILE,
                            gpu=tool.cpu.Gpu.SOFTWARE,
                            webgpu=tool.cpu.WebGpu[name],
                        )
                switches = [
                    arg for arg in launched[0] if arg.startswith("--enable-features=")
                ]
                self.assertEqual(len(switches), 1, switches)
                named = set(switches[0].split("=", 1)[1].split(","))
                self.assertEqual(named, features)
                self.assertEqual(
                    SWIFTSHADER_ADAPTER in launched[0], name == "SOFTWARE"
                )


# A picture for the PNG reader: five rows of four RGB pixels, teal,
# olive, greys and others, each row stored with another of PNG's five
# filters, so the reader must undo every one of them.
TEAL = (10, 80, 90)
OLIVE = (90, 80, 10)
GREY = (51, 51, 51)
PICTURE = [
    [TEAL, TEAL, GREY, OLIVE],
    [GREY, TEAL, TEAL, GREY],
    [(200, 10, 30), TEAL, GREY, (0, 0, 0)],
    [TEAL, (255, 255, 255), OLIVE, GREY],
    [GREY, GREY, TEAL, TEAL],
]
CHANNELS = 3


def paeth(left, up, corner):
    """PNG's Paeth predictor, written out again from the specification
    rather than taken from the tool under test."""
    guess = left + up - corner
    to_left, to_up, to_corner = abs(guess - left), abs(guess - up), abs(guess - corner)
    if to_left <= to_up and to_left <= to_corner:
        return left
    if to_up <= to_corner:
        return up
    return corner


def encode_png(picture):
    """`picture` as an RGB PNG whose row y uses filter y % 5."""
    width, height = len(picture[0]), len(picture)
    rows = [bytes(v for pixel in row for v in pixel) for row in picture]
    stream = bytearray()
    above = bytes(width * CHANNELS)
    for y, row in enumerate(rows):
        kind = y % 5
        stream.append(kind)
        for x, value in enumerate(row):
            left = row[x - CHANNELS] if x >= CHANNELS else 0
            corner = above[x - CHANNELS] if x >= CHANNELS else 0
            predicted = [0, left, above[x], (left + above[x]) // 2, paeth(left, above[x], corner)][kind]
            stream.append((value - predicted) & 0xFF)
        above = row

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(stream)))
        + chunk(b"IEND", b"")
    )


class PngReaderTest(unittest.TestCase):
    """The PNG reader and the tint count the vulkan case judges with."""

    def test_every_filter_is_undone(self):
        """Encodes PICTURE with each of PNG's five filters on one of its
        rows, reads it back, and checks that every pixel is the one
        encoded."""
        tool = load_tool()
        channels, rows = tool.png_pixels(encode_png(PICTURE))
        self.assertEqual(channels, CHANNELS)
        decoded = [
            [tuple(row[x : x + CHANNELS]) for x in range(0, len(row), CHANNELS)]
            for row in rows
        ]
        self.assertEqual(decoded, PICTURE)

    def test_tints_count_teal_olive_and_colours(self):
        """Counts PICTURE's tints and checks them against the pixels
        placed: teal and olive by TINT_MARGIN, and every distinct
        colour."""
        tool = load_tool()
        pixels = [pixel for row in PICTURE for pixel in row]
        teal, olive, colours = tool.tints(encode_png(PICTURE))
        self.assertEqual(teal, pixels.count(TEAL) / len(pixels))
        self.assertEqual(olive, pixels.count(OLIVE) / len(pixels))
        self.assertEqual(colours, len(set(pixels)))


# Two files as a link names them: a URL, a space, and an SRI hash.
FILES = [
    "https://example.org/a/model.gguf sha256-Jwy6G9UQn0LQM1D2BAYCRWBGTbFzwOOH2R8EJtO9JW0=",
    "https://example.org/b/data.csv sha256-SS1epJYFbxpqZZIkEDL6t2TDIVljF5MLT6Dh6Lw7dHA=",
]


class PageUrlTest(unittest.TestCase):
    """The link a case boots, as the page reads it back."""

    def test_each_file_is_one_file_parameter(self):
        """Builds a link with FILES and one with none, parses each query
        as the page does, and checks that every file is one file=
        holding its URL and hash, in order, and that the link without
        files names none."""
        tool = load_tool()
        url = tool.page_url("http://site", ["hello"], None, files=FILES)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertEqual(query["file"], FILES)
        self.assertEqual(query["pkg"], ["hello"])

        bare = tool.page_url("http://site", ["hello"], None)
        bare_query = urllib.parse.parse_qs(urllib.parse.urlsplit(bare).query)
        self.assertNotIn("file", bare_query)


if __name__ == "__main__":
    unittest.main()
