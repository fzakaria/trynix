"""Tests for tools/boot-test.py's browser launch: a browser that never
opens its debugging port is stopped before the tool gives up, rather
than left running headless after the tool exits. The browser is a shell
script that sleeps, which is what Firefox looks like to the tool, since
Firefox no longer speaks the DevTools protocol. Nothing here starts a
real browser or reaches the network."""

import importlib.util
import os
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "..", "tools", "boot-test.py")

# How long the test lets the launch wait for a debugging port.
SHORT_WAIT_SECONDS = 1

# A browser that starts, never opens a port and never exits on its own.
SILENT_BROWSER = "#!/bin/sh\nexec sleep 300\n"


def unreached(*args, **kwargs):
    raise AssertionError("a launch with no debugging port opened a socket")


def load_tool():
    """boot-test.py as a module. It imports websocket, which the test
    environment does not have and which a launch that never opens a
    port never connects with, so a placeholder module stands in."""
    placeholder = types.ModuleType("websocket")
    placeholder.create_connection = unreached
    sys.modules.setdefault("websocket", placeholder)
    spec = importlib.util.spec_from_file_location("boot_test", TOOL)
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    return tool


class SilentBrowserTest(unittest.TestCase):
    """A browser that never opens its debugging port."""

    def test_browser_is_stopped_when_the_launch_fails(self):
        """Launches the sleeping script as the browser with a short port
        wait, and checks that the launch fails and that the script's
        process has exited by then."""
        tool = load_tool()
        tool.PORT_WAIT_SECONDS = SHORT_WAIT_SECONDS

        with tempfile.TemporaryDirectory() as work:
            binary = os.path.join(work, "browser")
            with open(binary, "w") as script:
                script.write(SILENT_BROWSER)
            os.chmod(binary, 0o755)

            # Every process the launch starts, so the test can look at
            # it afterwards and stop it if the tool did not.
            launched = []
            real_popen = subprocess.Popen

            def popen(*args, **kwargs):
                process = real_popen(*args, **kwargs)
                launched.append(process)
                # Cleanups run last first: kill, then reap.
                self.addCleanup(process.wait)
                self.addCleanup(process.kill)
                return process

            with mock.patch.object(tool.subprocess, "Popen", side_effect=popen):
                with self.assertRaises(SystemExit):
                    tool.Browser(binary, os.path.join(work, "profile"))

            self.assertEqual(len(launched), 1)
            self.assertIsNotNone(launched[0].poll())


if __name__ == "__main__":
    unittest.main()
