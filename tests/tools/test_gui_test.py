"""Tests for tools/gui-test.py's Chromium driver: the browser window it
sets up lays the page out at the same width while a screenshot captures
beyond the viewport as it did when the screenshot's clip was measured.
A fake DevTools browser records what the driver sends; nothing here
starts a browser or reaches the network."""

import importlib.util
import os
import sys
import types
import unittest

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

    def __init__(self, binary, profile, gpu):
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
                driver = tool.Chromium(BINARY, PROFILE, tool.cpu.Gpu.SOFTWARE)
                driver.set_viewport(viewport)
                self.assertIn(HIDE_SCROLLBARS, driver.browser.calls)


if __name__ == "__main__":
    unittest.main()
