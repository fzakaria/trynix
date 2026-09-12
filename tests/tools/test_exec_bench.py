"""Tests for the parsers tools/exec-bench.py relies on: busybox `time`
output in both spacings, and the split completion marker that must not
match the terminal's echo of the command itself."""

import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "..", "tools", "exec-bench.py")


def load():
    spec = importlib.util.spec_from_file_location("exec_bench", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ParseTime(unittest.TestCase):
    """busybox prints minutes and seconds with or without a space."""

    def test_spaced(self):
        bench = load()
        text = "real\t0m 12.34s\nuser\t1m 2.50s\nsys\t0m 0.07s\n"
        self.assertEqual(bench.parse_time(text), {"real": 12.34, "user": 62.5, "sys": 0.07})

    def test_compact(self):
        bench = load()
        self.assertEqual(bench.parse_time("real\t0m0.123s\n"), {"real": 0.123})

    def test_missing(self):
        bench = load()
        self.assertEqual(bench.parse_time("hello, world\n"), {})


class Completion(unittest.TestCase):
    """The marker is typed as two halves, so the echoed command line does
    not contain it; only the printed line after exit does."""

    def test_echo_does_not_complete(self):
        bench = load()
        typed = bench.wrap_command("hello", "EXEC_BENCH_0")
        self.assertNotIn("EXEC_BENCH_0:", typed)
        self.assertIsNone(bench.completion(typed + "\r\n", "EXEC_BENCH_0"))

    def test_status_line_completes(self):
        bench = load()
        transcript = "$ time sh -c 'hello'\r\nHello, world!\r\n\r\nEXEC_BENCH_0:0\r\n$ "
        self.assertEqual(bench.completion(transcript, "EXEC_BENCH_0"), 0)

    def test_nonzero_status(self):
        bench = load()
        self.assertEqual(bench.completion("\nEXEC_BENCH_1:127\n", "EXEC_BENCH_1"), 127)

    def test_quotes_survive(self):
        bench = load()
        typed = bench.wrap_command("python3 -c 'print(1)'", "EXEC_BENCH_0")
        self.assertIn("'python3 -c '\\''print(1)'\\'''", typed)


if __name__ == "__main__":
    unittest.main()


class StoreRoot(unittest.TestCase):
    """readlink's answer names a file inside a package; the package is
    the store path up to its first slash."""

    def test_binary_inside_a_package(self):
        bench = load()
        text = "$ readlink -f \"$(command -v hello)\"\r\n/nix/store/awmhh7ci4admi71gs6b73awh0lxgrqqn-hello-2.12.2/bin/hello\r\n"
        self.assertEqual(bench.store_root(text), "/nix/store/awmhh7ci4admi71gs6b73awh0lxgrqqn-hello-2.12.2")

    def test_nothing_resolved(self):
        bench = load()
        self.assertIsNone(bench.store_root("sh: hello: not found\r\n"))


class CommandError(unittest.TestCase):
    """Failed commands must not be recorded as successful benchmark samples."""

    def test_nonzero_exit_is_an_error(self):
        """Reject a completed command whose exit status reports failure."""
        bench = load()
        signal_exit = 4
        self.assertEqual(bench.command_error(signal_exit), "command exited with status 4")

    def test_timeout_is_an_error(self):
        """Keep a missing completion marker classified as a timeout."""
        bench = load()
        self.assertEqual(bench.command_error(None), "timed out")

    def test_success_has_no_error(self):
        """Allow a completed command with a zero exit status."""
        bench = load()
        self.assertIsNone(bench.command_error(0))
