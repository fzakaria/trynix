#!/usr/bin/env python3
"""Measure every published engine on one machine, and write the history
the site's benchmark page (site/bench/) draws.

Every commit that repinned nix/engine-pins.json names an engine release
that is never rewritten, so the speed of each one can be measured again
at any time, on any machine, from immutable inputs. That is what this
does: for each such commit it builds that commit's site (the engine,
snapshot and guest image nix verified by hash), puts those under today's
page, and runs the two existing instruments against it --
tools/emubench.py a few times, taking the median per row, and
tools/exec-bench.py once. One record per engine goes into the history
file, keyed by the release tag.

    nix run .#bench-history -- --site <site> --out history.json
    nix run .#bench-history -- --site <site> --out h.json --revs 805107b cd13238 --emubench-runs 3
    nix run .#bench-history -- --merge a.json b.json --out history.json

--site is the page every engine is driven through: build it from the
checkout the tool runs in (`nix build .#site`). --revs restricts the
commits; the default is every commit that touched the pins, oldest
first. A tag already in --out is skipped unless --redo. Records from
several runs (say, split across machines or run in parallel with
disjoint --revs) are joined with --merge.

Old engines and the guest's clock: before patch 0003 the guest's clock
ran 3.3x slow (docs/performance.md), and emubench's mips figures are
measured against that clock. Each record therefore carries the ratio of
the guest's account of the run to the host's, and a `mips_host` per row
corrected by it. The page draws `mips_host`.

Read the numbers as one machine's: the history is only comparable within
a run on one host, which the record names.
"""

import argparse
import datetime
import json
import os
import platform
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

PINS_PATH = "nix/engine-pins.json"
# the probe served to every engine: one instrument across the history,
# built for the baseline ISA so the engines whose guest CPU was qemu64
# can run it (nix/emubench.nix)
PROBE_ATTRIBUTE = "emubench-baseline"
PROBE_CACHE_DIR = "benchcache"
PROBE_KEY_NAME = "trynix-bench-1"
ENGINE_DIRS = ("qemu", "guest")
DEFAULT_EMUBENCH_RUNS = 3
# an engine before the entropy fix stalls a first run for minutes; the
# probe's own default limit is sized for CI
PROBE_LIMIT_SECONDS = 1800
# a build of an old commit can take a kernel compile; a bench, opencode
BUILD_LIMIT_SECONDS = 3600
BENCH_LIMIT_SECONDS = 7200
DESCRIPTION = (
    "One record per published trynix engine, measured on one machine by "
    "tools/bench-history.py: the per-instruction-class probe (emubench, "
    "median of repeated runs, mips on the host's clock) and the real-package "
    "suite (exec-bench, cold and warm wall seconds). See site/bench/."
)


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", repo, *args], check=True, capture_output=True, text=True
    ).stdout


def pin_commits(repo):
    """Every commit that touched the pins, oldest first."""
    out = git(repo, "log", "--format=%H", "--", PINS_PATH)
    return list(reversed(out.split()))


def describe_commit(repo, rev):
    commit, date, subject = git(repo, "log", "-1", "--format=%H%x00%cI%x00%s", rev).rstrip("\n").split("\0")
    pins = json.loads(git(repo, "show", f"{commit}:{PINS_PATH}"))
    return {"commit": commit, "date": date, "subject": subject, "tag": pins["tag"]}


def build_site_at(repo, commit):
    """That commit's deployable tree, engine and guest verified by nix."""
    result = subprocess.run(
        [
            "nix", "build", "--accept-flake-config", "--no-link", "--print-out-paths",
            f"git+file://{repo}?rev={commit}#site",
        ],
        capture_output=True, text=True, timeout=BUILD_LIMIT_SECONDS,
    )
    if result.returncode != 0:
        raise RuntimeError("nix build failed:\n" + result.stderr[-2000:])
    return result.stdout.strip()


def build_probe(repo):
    """The baseline-ISA probe, from the checkout the tool runs in."""
    result = subprocess.run(
        [
            "nix", "build", "--accept-flake-config", "--no-link", "--print-out-paths",
            f"git+file://{repo}#{PROBE_ATTRIBUTE}",
        ],
        capture_output=True, text=True, timeout=BUILD_LIMIT_SECONDS,
    )
    if result.returncode != 0:
        raise RuntimeError("nix build of the probe failed:\n" + result.stderr[-2000:])
    return result.stdout.strip()


class ProbeCache:
    """A signed binary cache holding the probe, written into a site copy
    so the page fetches it same-origin: the trick tools/cpu-test.py's
    example cache uses, with a key made here since the published cache's
    key is not on this machine."""

    def __init__(self, probe, workdir):
        self.probe = probe
        self.key = os.path.join(workdir, "secret-key")
        with open(self.key, "w") as f:
            subprocess.run(
                ["nix", "key", "generate-secret", "--key-name", PROBE_KEY_NAME], stdout=f, check=True
            )
        with open(self.key) as f:
            self.public_key = subprocess.run(
                ["nix", "key", "convert-secret-to-public"], stdin=f, capture_output=True, text=True, check=True
            ).stdout.strip()

    def write_into(self, site):
        """Copy the probe's closure into <site>/benchcache; returns the
        `cache` argument emubench.py takes."""
        target = os.path.join(site, PROBE_CACHE_DIR)
        subprocess.run(
            [
                "nix", "copy", "--to",
                f"file://{target}?secret-key={self.key}&compression=none",
                self.probe,
            ],
            check=True, capture_output=True,
        )
        return f"/{PROBE_CACHE_DIR} {self.public_key}"


def overlay(site, old_site, probe_cache):
    """Today's page with the old commit's engine, snapshot and guest
    image under it, in a scratch copy, the asset manifest recomputed to
    describe the bytes actually served, and the probe's cache beside it.
    Returns (site copy, scratch root, emubench's --cache argument)."""
    scratch = tempfile.mkdtemp(prefix="bench-history-")
    copy = os.path.join(scratch, "site")
    shutil.copytree(site, copy, symlinks=True)
    subprocess.run(["chmod", "-R", "u+w", copy], check=True)
    for name in ENGINE_DIRS:
        shutil.rmtree(os.path.join(copy, name))
        shutil.copytree(os.path.join(old_site, name), os.path.join(copy, name))
    subprocess.run(["chmod", "-R", "u+w", copy], check=True)
    subprocess.run(
        [sys.executable, os.path.join(HERE, "asset-versions.py"), copy, *ENGINE_DIRS],
        check=True, stdout=subprocess.DEVNULL,
    )
    cache = probe_cache.write_into(copy) if probe_cache else None
    return copy, scratch, cache


def run_tool(name, arguments, log):
    """Run a sibling tool, streaming its output to `log`; return the
    tail of what it said if it failed, else None."""
    with open(log, "a") as f:
        f.write(f"\n== {name} {' '.join(arguments)}\n")
        f.flush()
        result = subprocess.run(
            [sys.executable, os.path.join(HERE, name), *arguments],
            stdout=f, stderr=subprocess.STDOUT, timeout=BENCH_LIMIT_SECONDS,
        )
    if result.returncode == 0:
        return None
    with open(log) as f:
        return f.read()[-1500:]


def clock_ratio(run):
    """The guest's clock over the host's, as emubench measured it row by
    row; failing that, the guest's account of the whole probe over the
    host's, which also counts the probe's untimed setup."""
    if run.get("clock_ratio") is not None:
        return run["clock_ratio"]
    return run["guest_seconds"] / run["host_seconds"]


def median_rows(runs):
    """Per test, the median over the runs that printed it, of the guest's
    figures and of the host-clock mips."""
    names = []
    for run in runs:
        for name in run["rows"]:
            if name not in names:
                names.append(name)
    rows = {}
    for name in names:
        # a row the guest timed at zero nanoseconds is a clock too coarse
        # for that test, not a measurement
        present = [run for run in runs if run["rows"].get(name, {}).get("ns", 0) > 0]
        if not present:
            continue
        rows[name] = {
            "mips": statistics.median(run["rows"][name]["mips"] for run in present),
            "ns_per_iter": statistics.median(run["rows"][name]["ns_per_iter"] for run in present),
            "mips_host": statistics.median(
                run["rows"][name]["mips"] * clock_ratio(run) for run in present
            ),
            "runs": len(present),
        }
    return rows


def merge_record(existing, fresh):
    """A fresh measurement over an existing record of the same tag: the
    fields measured this time replace the old ones, and exec-bench
    entries replace by package name, so one package can be measured
    again without losing the rest."""
    if existing is None:
        return fresh
    merged = {**existing, **{k: v for k, v in fresh.items() if k != "exec"}}
    if "exec" in fresh:
        results = {r["name"]: r for r in existing.get("exec", {}).get("results", [])}
        for result in fresh["exec"].get("results", []):
            results[result["name"]] = result
        merged["exec"] = {**fresh["exec"], "results": list(results.values())}
    return merged


def merge_histories(histories):
    """One record per tag, the last one given winning, in tag order --
    the tags are dated, so that is chronological."""
    by_tag = {}
    for history in histories:
        for record in history.get("records", []):
            by_tag[record["tag"]] = record
    return {
        "description": DESCRIPTION,
        "records": [by_tag[tag] for tag in sorted(by_tag)],
    }


def runner(browser):
    """What the numbers were measured on."""
    cpu = None
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
    except OSError:
        pass
    memory_gib = None
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    memory_gib = round(int(line.split()[1]) / (1 << 20))
                    break
    except OSError:
        pass
    try:
        version = subprocess.run([browser, "--version"], capture_output=True, text=True).stdout.strip()
    except OSError:
        version = browser
    return {
        "host": socket.gethostname(),
        "cpu": cpu,
        "cores": os.cpu_count(),
        "memory_gib": memory_gib,
        "kernel": platform.release(),
        "browser": version,
    }


def measure_emubench(site, probe, cache, count, browser, workdir, log):
    runs = []
    errors = []
    for index in range(count):
        out = os.path.join(workdir, f"emubench-{index}.json")
        failure = run_tool(
            "emubench.py",
            [
                "--site", site, "--probe", probe, "--cache", cache, "--json", out,
                "--browser", browser, "--limit", str(PROBE_LIMIT_SECONDS),
            ],
            log,
        )
        if failure is not None or not os.path.exists(out):
            errors.append(failure or "no output")
            continue
        with open(out) as f:
            runs.append(json.load(f))
    if not runs:
        return {"error": errors[-1] if errors else "no runs"}
    return {
        "runs": len(runs),
        "failed_runs": len(errors),
        "clock_ratio": round(statistics.median(clock_ratio(run) for run in runs), 3),
        "host_seconds": round(statistics.median(run["host_seconds"] for run in runs), 1),
        "rows": median_rows(runs),
    }


def measure_exec(site, only, browser, workdir, log):
    out = os.path.join(workdir, "exec-bench.json")
    # The history is of qemu engine releases, so the guest runs on qemu
    # whatever the page's default engine is.
    arguments = ["--site", site, "--json", out, "--browser", browser, "--guest-engine", "qemu"]
    for name in only or []:
        arguments += ["--only", name]
    # exec-bench exits nonzero when any entry failed but still writes
    # what it measured; the entries carry their own errors
    failure = run_tool("exec-bench.py", arguments, log)
    if not os.path.exists(out):
        return {"error": failure or "no output"}
    with open(out) as f:
        return {"results": json.load(f)["results"]}


def load_history(path):
    if not path or not os.path.exists(path):
        return {"records": []}
    with open(path) as f:
        return json.load(f)


def save_history(path, history):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(merge_histories([history]), f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site", help="today's built site, the page every engine is driven through")
    parser.add_argument("--out", required=True, help="the history file to write or extend")
    parser.add_argument("--repo", help="the checkout whose pin history to walk (default: the one around the working directory)")
    parser.add_argument("--revs", nargs="*", help="only these commits (default: every commit that touched the pins)")
    parser.add_argument("--redo", action="store_true", help="measure a tag again even if --out has it")
    parser.add_argument(
        "--probe",
        help=f"a built {PROBE_ATTRIBUTE} to serve every engine (default: build it from --repo)",
    )
    parser.add_argument("--emubench-runs", type=int, default=DEFAULT_EMUBENCH_RUNS)
    parser.add_argument("--skip-emubench", action="store_true")
    parser.add_argument("--skip-exec", action="store_true")
    parser.add_argument(
        "--reason",
        help="with both --skip flags: why these releases carry no numbers, recorded on each",
    )
    parser.add_argument("--only", action="append", help="exec-bench entries to run (repeatable)")
    parser.add_argument("--merge", nargs="*", help="join these history files into --out and stop")
    parser.add_argument("--log", help="where the tools' own output goes (default: <out>.log)")
    parser.add_argument(
        "--browser",
        default=os.environ.get("TRYNIX_BROWSER", "chromium"),
        help="the headless browser to drive",
    )
    args = parser.parse_args()

    if args.merge is not None:
        histories = [load_history(args.out)] + [load_history(path) for path in args.merge]
        save_history(args.out, merge_histories(histories))
        print(f"{args.out}: {len(merge_histories(histories)['records'])} records")
        return

    if not args.site:
        sys.exit("pass --site <a built site directory>")
    repo = args.repo or git(os.getcwd(), "rev-parse", "--show-toplevel").strip()
    log = args.log or args.out + ".log"
    history = load_history(args.out)
    done = {record["tag"] for record in history["records"]}
    machine = runner(args.browser)
    print(f"measuring on {machine['host']} ({machine['cpu']}), {machine['browser']}", flush=True)
    probe = None
    probe_cache = None
    keydir = tempfile.mkdtemp(prefix="bench-history-key-")
    if not args.skip_emubench:
        probe = args.probe or build_probe(repo)
        probe_cache = ProbeCache(probe, keydir)
        print(f"probe {probe}", flush=True)

    revs = args.revs or pin_commits(repo)
    for rev in revs:
        info = describe_commit(repo, rev)
        label = f"{info['tag']} ({info['commit'][:7]} {info['subject']})"
        if info["tag"] in done and not args.redo:
            print(f"skip {label}: already measured", flush=True)
            continue

        print(f"== {label}", flush=True)
        record = {
            **info,
            "runner": machine,
            "probe": probe,
            "measured": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        }
        if args.reason:
            record["unmeasured"] = args.reason
        try:
            old_site = build_site_at(repo, info["commit"])
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            record["error"] = f"build: {error}"
            print(f"   build failed; recorded", flush=True)
            history["records"].append(record)
            save_history(args.out, history)
            continue

        site, scratch, cache = overlay(args.site, old_site, probe_cache)
        workdir = tempfile.mkdtemp(prefix="bench-history-runs-")
        try:
            if not args.skip_emubench:
                record["emubench"] = measure_emubench(site, probe, cache, args.emubench_runs, args.browser, workdir, log)
                summary = record["emubench"].get("rows", {}).get("alu", {}).get("mips_host")
                print(f"   emubench: alu {summary} mips (host clock), clock ratio {record['emubench'].get('clock_ratio')}", flush=True)
            if not args.skip_exec:
                record["exec"] = measure_exec(site, args.only, args.browser, workdir, log)
                for result in record["exec"].get("results", []):
                    cold = result.get("cold", {}).get("wall_seconds")
                    warm = result.get("warm", {}).get("wall_seconds")
                    print(f"   exec: {result['name']:9s} cold {cold} warm {warm}", flush=True)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
            shutil.rmtree(scratch, ignore_errors=True)

        existing = next((r for r in history["records"] if r["tag"] == info["tag"]), None)
        history["records"] = [r for r in history["records"] if r["tag"] != info["tag"]]
        history["records"].append(merge_record(existing, record))
        done.add(info["tag"])
        save_history(args.out, history)


if __name__ == "__main__":
    main()
