"""Tests for the pure parts of tools/bench-history.py: taking the median
of repeated emubench runs, reading the guest clock's ratio to the host's,
and merging history files by engine tag."""

import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "..", "tools", "bench-history.py")


def load():
    spec = importlib.util.spec_from_file_location("bench_history", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(mips, ns_per_iter=10.0, host_seconds=2.0, guest_seconds=2.0):
    """One emubench --json file's worth, with a single row."""
    return {
        "host_seconds": host_seconds,
        "guest_seconds": guest_seconds,
        "rows": {"alu": {"iters": 1, "ns": 1, "ns_per_iter": ns_per_iter, "mips": mips}},
    }


class MedianRows(unittest.TestCase):
    """Three runs of a row collapse to the middle value, per field, and
    the count of runs the median came from is kept."""

    def test_odd_count_picks_the_middle(self):
        tool = load()
        rows = tool.median_rows([run(100.0), run(300.0), run(200.0)])
        self.assertEqual(rows["alu"]["mips"], 200.0)
        self.assertEqual(rows["alu"]["runs"], 3)

    def test_even_count_averages_the_middle_pair(self):
        tool = load()
        rows = tool.median_rows([run(100.0), run(300.0)])
        self.assertEqual(rows["alu"]["mips"], 200.0)

    def test_a_row_missing_from_one_run_uses_the_others(self):
        tool = load()
        partial = {"host_seconds": 1.0, "guest_seconds": 1.0, "rows": {}}
        rows = tool.median_rows([run(100.0), partial, run(300.0)])
        self.assertEqual(rows["alu"]["mips"], 200.0)
        self.assertEqual(rows["alu"]["runs"], 2)


class ZeroDurationRows(unittest.TestCase):
    """A row the guest timed at zero nanoseconds came from a clock too
    coarse for that test; it is dropped rather than reported as zero."""

    def test_dropped_when_every_run_read_zero(self):
        tool = load()
        zero = {"host_seconds": 1.0, "guest_seconds": 1.0, "rows": {"alu": {"iters": 1, "ns": 0, "ns_per_iter": 0.0, "mips": 0.0}}}
        self.assertEqual(tool.median_rows([zero, zero]), {})

    def test_kept_from_the_runs_that_timed_it(self):
        tool = load()
        zero = {"host_seconds": 1.0, "guest_seconds": 1.0, "rows": {"alu": {"iters": 1, "ns": 0, "ns_per_iter": 0.0, "mips": 0.0}}}
        rows = tool.median_rows([zero, run(100.0)])
        self.assertEqual(rows["alu"]["mips"], 100.0)
        self.assertEqual(rows["alu"]["runs"], 1)


class ClockRatio(unittest.TestCase):
    """A guest whose clock runs slow reports fewer nanoseconds than the
    host saw pass; the ratio is guest over host, so a correct clock is
    1.0 and the old 3.3x-slow clock reads as about 0.3."""

    def test_correct_clock(self):
        tool = load()
        self.assertAlmostEqual(tool.clock_ratio(run(1.0, host_seconds=4.0, guest_seconds=4.0)), 1.0)

    def test_the_row_by_row_ratio_wins_when_present(self):
        tool = load()
        measured = {**run(1.0, host_seconds=4.0, guest_seconds=2.0), "clock_ratio": 0.9}
        self.assertAlmostEqual(tool.clock_ratio(measured), 0.9)

    def test_slow_clock(self):
        tool = load()
        self.assertAlmostEqual(tool.clock_ratio(run(1.0, host_seconds=3.3, guest_seconds=1.0)), 0.303, places=3)

    def test_host_mips_corrects_by_the_ratio(self):
        tool = load()
        rows = tool.median_rows([run(330.0, host_seconds=3.3, guest_seconds=1.0)])
        self.assertAlmostEqual(rows["alu"]["mips_host"], 100.0, places=1)


class Merge(unittest.TestCase):
    """Records are keyed by engine tag; a later file's record replaces an
    earlier one's, and the result is ordered by the tag's date."""

    def test_replaces_by_tag_and_sorts(self):
        tool = load()
        older = {"records": [{"tag": "engine-20260905-0511", "n": 1}, {"tag": "engine-20260909-1605", "n": 1}]}
        newer = {"records": [{"tag": "engine-20260905-0511", "n": 2}, {"tag": "engine-20260906-2123", "n": 2}]}
        merged = tool.merge_histories([older, newer])
        self.assertEqual(
            [(r["tag"], r["n"]) for r in merged["records"]],
            [("engine-20260905-0511", 2), ("engine-20260906-2123", 2), ("engine-20260909-1605", 1)],
        )


class MergeRecord(unittest.TestCase):
    """Measuring one package again keeps the record's other entries and
    its emubench rows; a fresh emubench replaces the old one."""

    def test_one_package_replaces_only_itself(self):
        tool = load()
        existing = {
            "tag": "engine-20260907-0100",
            "emubench": {"rows": {"alu": {"mips": 1.0}}},
            "exec": {"results": [{"name": "hello", "cold": {"wall_seconds": 1.0}}, {"name": "opencode", "cold": {"wall_seconds": 300.0}}]},
        }
        fresh = {"tag": "engine-20260907-0100", "measured": "later", "exec": {"results": [{"name": "opencode", "cold": {"wall_seconds": 250.0}}]}}
        merged = tool.merge_record(existing, fresh)
        self.assertEqual(merged["emubench"]["rows"]["alu"]["mips"], 1.0)
        self.assertEqual(merged["measured"], "later")
        self.assertEqual({r["name"]: r["cold"]["wall_seconds"] for r in merged["exec"]["results"]}, {"hello": 1.0, "opencode": 250.0})

    def test_no_existing_record(self):
        tool = load()
        fresh = {"tag": "engine-20260909-1605"}
        self.assertIs(tool.merge_record(None, fresh), fresh)


class Chronology(unittest.TestCase):
    """Tests the order records are kept in once two engines share the
    history. Tags only sort chronologically within one engine, so the
    order comes from each record's date; the records here are built by
    hand with tags that would sort the wrong way."""

    def test_records_sort_by_date_across_engines(self):
        history = load()
        qemu = {"tag": "engine-20260913-2056", "date": "2026-09-13T13:56:42-07:00"}
        first = {"tag": "unkernel-0.10.0", "date": "2026-11-20T18:00:00+00:00", "engine": "unkernel"}
        second = {"tag": "unkernel-0.9.0", "date": "2026-11-21T02:00:00+09:00", "engine": "unkernel"}
        merged = history.merge_histories([{"records": [first, qemu, second]}])
        self.assertEqual(
            [record["tag"] for record in merged["records"]],
            ["engine-20260913-2056", "unkernel-0.9.0", "unkernel-0.10.0"],
        )

    def test_a_record_without_a_date_keeps_its_tag_order(self):
        history = load()
        dated = {"tag": "engine-b", "date": "2026-09-13T13:56:42-07:00"}
        undated = {"tag": "engine-a"}
        merged = history.merge_histories([{"records": [dated, undated]}])
        self.assertEqual([record["tag"] for record in merged["records"]], ["engine-a", "engine-b"])


class UnkernelRecord(unittest.TestCase):
    """Tests the record an unkernel measurement becomes: named after the
    unkernel version the site carries, marked with its engine, and
    holding the qemu engine's numbers from the same run beside its own.
    Built from made-up measurements, with no browser."""

    def test_names_the_version_and_keeps_the_baseline(self):
        history = load()
        record = history.unkernel_record(
            version="0.2.0-261119-040e142",
            machine={"host": "leviathan"},
            measured="2026-11-20T20:00:00+00:00",
            unkernel={"results": [{"name": "hello"}]},
            baseline_tag="engine-20260913-2056",
            baseline={"results": [{"name": "hello"}]},
        )
        self.assertEqual(record["tag"], "unkernel-0.2.0-261119-040e142")
        self.assertEqual(record["engine"], "unkernel")
        self.assertEqual(record["date"], "2026-11-20T20:00:00+00:00")
        self.assertEqual(record["exec"], {"results": [{"name": "hello"}]})
        self.assertEqual(record["baseline"]["tag"], "engine-20260913-2056")
        self.assertEqual(record["baseline"]["exec"], {"results": [{"name": "hello"}]})


class MemoryPolicy(unittest.TestCase):
    """Tests reading a run's NUMA memory policy from /proc/self/numa_maps,
    which a record keeps beside the CPUs it was pinned to. numactl
    --membind sets a policy, not a cpuset, so Mems_allowed in
    /proc/self/status does not show it. Fed made-up numa_maps text."""

    LINE = "618c01320000 {} file=/nix/store/abc-coreutils/bin/coreutils mapped=22 N1=20 N5=2 kernelpagesize_kB=4\n"

    def test_bound_to_one_node(self):
        history = load()
        self.assertEqual(history.memory_policy(self.LINE.format("bind:5")), "bind:5")

    def test_interleaved(self):
        history = load()
        self.assertEqual(history.memory_policy(self.LINE.format("interleave:1,5")), "interleave:1,5")

    def test_default(self):
        """A run with the kernel's default policy is not bound, and the
        record says nothing."""
        history = load()
        self.assertIsNone(history.memory_policy(self.LINE.format("default")))

    def test_empty(self):
        history = load()
        self.assertIsNone(history.memory_policy(""))


if __name__ == "__main__":
    unittest.main()
