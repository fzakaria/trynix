"""Tests for the parsers tools/exec-bench.py relies on: busybox `time`
output in both spacings, and the split completion marker that must not
match the terminal's echo of the command itself."""

import importlib.util
import json
import os
import re
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


class PageTimer(unittest.TestCase):
    """Tests the script that times a command inside the page, where the
    clock is not a host poll a quarter of a second wide. The script is
    text handed to the browser, so the tests read the text: the line to
    type has to arrive intact, and the pattern the page waits on has to
    match exactly what completion() matches on the host."""

    def test_types_the_line_as_given(self):
        bench = load()
        line = "time sh -c 'echo \"hi\"'; printf done\n"
        script = bench.page_timer(line, "EXEC_BENCH_0")
        self.assertIn(json.dumps(line), script)

    def test_waits_for_the_same_closing_line_as_the_host(self):
        bench = load()
        marker = "EXEC_BENCH_1"
        pattern = re.compile(bench.closing_pattern(marker))
        self.assertIn(json.dumps(bench.closing_pattern(marker)), bench.page_timer("x\n", marker))

        echoed = "printf '\\n%s%s:%s\\n' 'EXEC_BENCH_' '1' $?\r\n"
        printed = "\nEXEC_BENCH_1:0\r\n"
        self.assertIsNone(pattern.search(echoed))
        self.assertIsNotNone(pattern.search(echoed + printed))
        self.assertEqual(bench.completion(echoed + printed, marker), 0)


class PageQuery(unittest.TestCase):
    """Tests the link an entry is booted with: the entry's spec, the
    engine named outright so a record never depends on the page's
    default, and boot=1. Called directly with suite-shaped entries."""

    def test_package(self):
        bench = load()
        entry = {"name": "hello", "spec": "pkg=hello", "command": "hello"}
        self.assertEqual(
            bench.page_query(entry, "unkernel"),
            {"pkg": "hello", "engine": "unkernel", "boot": "1"},
        )

    def test_engine_is_always_named(self):
        bench = load()
        entry = {"name": "x", "spec": "path=/nix/store/abc-x-1", "command": "x"}
        self.assertEqual(
            bench.page_query(entry, "qemu"),
            {"path": "/nix/store/abc-x-1", "engine": "qemu", "boot": "1"},
        )

    def test_suite_runs_on_either_engine(self):
        """Every entry is found by name in the index, so each engine
        resolves the build for its own system; a store path would pin
        the suite to one of them."""
        bench = load()
        for entry in bench.SUITE:
            self.assertTrue(entry["spec"].startswith("pkg="), entry["name"])


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
