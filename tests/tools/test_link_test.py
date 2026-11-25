"""Tests for tools/link-test.py's browser: the driver it opens takes
every argument gui-test.py's drivers ask for, so a driver that gains one
cannot leave link-test failing only in CI, which is the one place it
runs. cpu-test.py's Browser is replaced by a recorder, so nothing here
starts a browser or reaches the network."""

import importlib.util
import os
import sys
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "..", "tools", "link-test.py")

# What the driver is started with; the recorder runs neither.
BINARY = "chromium"
PROFILE = "profile"


def unreached(*args, **kwargs):
    raise AssertionError("the recorded browser opened a socket")


def load_tool():
    """link-test.py as a module. The tools it loads import websocket,
    which the test environment does not have and which the recorder
    never connects with, so a placeholder module stands in."""
    placeholder = types.ModuleType("websocket")
    placeholder.create_connection = unreached
    sys.modules.setdefault("websocket", placeholder)
    spec = importlib.util.spec_from_file_location("link_test", TOOL)
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    return tool


class OpenBrowserTest(unittest.TestCase):
    """The browser link-test opens for Chromium."""

    def test_chromium_has_no_gpu_and_no_webgpu_adapter(self):
        """Opens the Chromium driver with cpu-test.py's Browser recorded,
        and checks that the driver was built and started Chromium with
        neither a GPU nor a WebGPU adapter, which the links under test
        do not need."""
        tool = load_tool()
        cpu = tool.gui.cpu

        with mock.patch.object(cpu, "Browser") as browser:
            driver = tool.open_browser(tool.gui.CHROMIUM, BINARY, PROFILE)

        browser.assert_called_once()
        self.assertEqual(browser.call_args.kwargs["gpu"].value, cpu.Gpu.OFF.value)
        self.assertEqual(
            browser.call_args.kwargs["webgpu"].value, cpu.WebGpu.OFF.value
        )
        self.assertEqual(driver.adapter, tool.gui.Adapter.ABSENT)


if __name__ == "__main__":
    unittest.main()
