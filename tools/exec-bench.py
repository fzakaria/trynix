#!/usr/bin/env python3
"""Run a few real packages in the browser guest, cold and warm, and
report what each cost: wall time, guest CPU, browser CPU and memory.

The emulator changes that make one workload faster can make another
slower -- more compilation, more memory, a longer boot -- and the
throughput probe (tools/emubench.py) cannot see that. This runs a small
suite of binaries of different sizes through a fresh guest each, the
way a visitor would meet them: the first execution pays for paging the
closure in over 9p and translating everything, the second is warm.

    nix run .#exec-bench -- --site <site> --json new.json
    nix run .#exec-bench -- --site <site> --engine <dir> --json new.json --baseline old.json

--engine overlays a locally built engine over the site's qemu/ files in
a scratch copy. --baseline prints the ratio of every number against an
earlier run. --only picks entries by name. The suite is the table below;
`path=` entries are fetched from the default cache, `pkg=` entries are
resolved by the page's index.

Numbers per entry and execution: wall seconds from keystroke to prompt;
the guest's own real/user/sys from busybox `time`; the browser process
group's CPU seconds and peak RSS over the same window. The RSS is a sum
over processes and double-counts shared pages: compare it between runs,
do not read it as a footprint.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
cpu = None
emu = None


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    assert spec is not None and spec.loader is not None, filename
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module



# name, how the page finds it, what to type. Sizes: hello is a few
# hundred KB, ripgrep and jujutsu are tens of MB of Rust, python is an
# interpreter start, opencode is a 190 MB Bun binary that JITs.
SUITE = [
    {"name": "hello", "spec": "pkg=hello", "command": "hello"},
    {"name": "ripgrep", "spec": "pkg=ripgrep", "command": "rg --version"},
    {"name": "jujutsu", "spec": "pkg=jujutsu", "command": "jj --version"},
    {"name": "python", "spec": "pkg=python3", "command": "python3 -c 'print(1)'"},
    {
        "name": "opencode",
        "spec": "path=/nix/store/6pw7n475sa1d4scq8sy1qkdn2bcy0glc-opencode-1.18.29",
        "command": "opencode --version",
    },
]

ITERATIONS = ["cold", "warm"]
COMMAND_LIMIT_SECONDS = 1800
POLL_SECONDS = 0.25
KIB = 1024
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")
SUCCESS_STATUS = 0
TRANSCRIPT_TAIL_LENGTH = 1500

# busybox time prints "real\t0m 0.12s" (or "0m0.123s" in other builds)
TIME_LINE = re.compile(r"^(real|user|sys)\s+(\d+)m\s*([\d.]+)s", re.MULTILINE)


def wrap_command(command, marker):
    """The command under `time`, then the marker printed as two halves so
    the terminal's echo of this line cannot complete the run."""
    prefix, suffix = marker.rsplit("_", 1)
    quoted = "'" + command.replace("'", "'\\''") + "'"
    return f"time sh -c {quoted}; printf '\\n%s%s:%s\\n' '{prefix}_' '{suffix}' $?"


def completion(transcript, marker):
    """The exit status once the whole marker line has been printed."""
    if "Stopped" in transcript:
        return None
    match = re.search(r"(?:^|\n)" + re.escape(marker) + r":(\d+)\r*\n", transcript)
    return int(match[1]) if match else None


def command_error(status):
    """Reject timeouts and failed exits before publishing a timing sample."""
    if status is None:
        return "timed out"
    if status != SUCCESS_STATUS:
        return f"command exited with status {status}"
    return None


STORE_PATH = re.compile(r"(/nix/store/[a-z0-9]{32}-[^/\s]+)")


def store_root(text):
    """The store path a resolved binary lives under, from readlink's
    output: /nix/store/<hash>-hello-2.12.2/bin/hello gives the package."""
    match = STORE_PATH.search(text)
    return match[1] if match else None


def parse_time(text):
    """busybox time's three lines, in seconds; whichever are present."""
    result = {}
    for match in TIME_LINE.finditer(text):
        result[match[1]] = int(match[2]) * 60 + float(match[3])
    return result


def group_processes(pgid):
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            if os.getpgid(int(entry)) == pgid:
                pids.append(int(entry))
        except (OSError, ProcessLookupError):
            continue
    return pids


def group_usage(pgid):
    """(cpu seconds, rss bytes) summed over the process group right now."""
    cpu_ticks = 0
    rss = 0
    for pid in group_processes(pgid):
        try:
            with open(f"/proc/{pid}/stat") as f:
                fields = f.read().rsplit(")", 1)[1].split()
            cpu_ticks += int(fields[11]) + int(fields[12])
            with open(f"/proc/{pid}/status") as f:
                match = re.search(r"^VmRSS:\s+(\d+) kB$", f.read(), re.MULTILINE)
            if match:
                rss += int(match[1]) * KIB
        except (OSError, ProcessLookupError, IndexError, ValueError):
            continue
    return cpu_ticks / CLOCK_TICKS, rss


def run_entry(entry, base, browser_binary, runs_dir):
    """Boot a fresh guest with the entry's package, run its command cold
    then warm, and return the measurements."""
    kind, value = entry["spec"].split("=", 1)
    query = urllib.parse.urlencode({kind: value, "boot": "1"})
    url = f"{base}/?{query}"
    profile = tempfile.mkdtemp(prefix="exec-bench-", dir=runs_dir)
    browser = cpu.Browser(browser_binary, profile)
    result = {"name": entry["name"], "spec": entry["spec"], "command": entry["command"]}
    try:
        started = time.monotonic()
        browser.send("Page.navigate", url=url)
        taken = cpu.await_marker(browser, cpu.SHELL_MARKER, cpu.BOOT_LIMIT_SECONDS)
        if taken is None:
            result["error"] = "no shell: " + browser.page_text()[-400:]
            return result
        # the page's final redraw lands after the welcome line
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if browser.evaluate("document.getElementById('console-veil')?.hidden === true"):
                break
            time.sleep(0.1)
        time.sleep(0.5)
        result["shell_seconds"] = round(time.monotonic() - started, 2)
        pgid = os.getpgid(browser.process.pid)

        # which package the command resolves to, from the guest's own
        # PATH: the page picks a version, and a link to the run should
        # name it. This is a readlink, not a run; nothing below is warm.
        program = entry["command"].split()[0]
        marker = "EXEC_BENCH_WHICH"
        mark = len(browser.transcript())
        browser.type(wrap_command(f'readlink -f "$(command -v {program})"', marker) + "\n")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and completion(browser.transcript()[mark:], marker) is None:
            time.sleep(POLL_SECONDS)
        result["resolved"] = store_root(browser.transcript()[mark:])

        for index, label in enumerate(ITERATIONS):
            marker = f"EXEC_BENCH_{index}"
            mark = len(browser.transcript())
            cpu_before, _ = group_usage(pgid)
            peak_rss = 0
            t0 = time.monotonic()
            browser.type(wrap_command(entry["command"], marker) + "\n")
            status = None
            while time.monotonic() - t0 < COMMAND_LIMIT_SECONDS:
                _, rss = group_usage(pgid)
                peak_rss = max(peak_rss, rss)
                status = completion(browser.transcript()[mark:], marker)
                if status is not None:
                    break
                time.sleep(POLL_SECONDS)
            wall = time.monotonic() - t0
            cpu_after, _ = group_usage(pgid)
            said = browser.transcript()[mark:]
            measurement = {
                "wall_seconds": round(wall, 2),
                "status": status,
                "guest": parse_time(said),
                "browser_cpu_seconds": round(cpu_after - cpu_before, 2),
                "browser_peak_rss_bytes": peak_rss,
            }
            # Report a failed benchmark run and preserve the guest's diagnosis.
            error = command_error(status)
            if error is not None:
                measurement["error"] = error
                result["transcript_tail"] = said[-TRANSCRIPT_TAIL_LENGTH:]
            result[label] = measurement
            if status is None:
                break
            print(
                f"  {entry['name']:9s} {label:4s} wall {wall:8.2f}s"
                f" guest user {measurement['guest'].get('user', float('nan')):7.2f}s"
                f" browser cpu {measurement['browser_cpu_seconds']:7.2f}s"
                f" rss {peak_rss / (1 << 20):6.0f} MiB status {status}",
                flush=True,
            )
    finally:
        browser.close()
    return result


def print_summary(results, baseline):
    """One line per entry and execution; ratios against the baseline."""
    old = {r["name"]: r for r in baseline["results"]} if baseline else {}
    header = f"{'entry':9s} {'exec':4s} {'wall s':>8s} {'guest user s':>13s} {'browser cpu s':>14s} {'peak rss MiB':>13s}"
    if baseline:
        header += f" {'wall x':>7s} {'cpu x':>7s} {'rss x':>7s}"
    print(header)
    for r in results:
        line = f"{r['name']:9s} boot {r.get('shell_seconds', float('nan')):8.2f}"
        if baseline and r["name"] in old and "shell_seconds" in old[r["name"]]:
            line += " " * 42 + f" {old[r['name']]['shell_seconds'] / r['shell_seconds']:7.2f}"
        print(line)
        for label in ITERATIONS:
            m = r.get(label)
            if not m:
                continue
            line = (
                f"{'':9s} {label:4s} {m['wall_seconds']:8.2f} {m['guest'].get('user', float('nan')):13.2f}"
                f" {m['browser_cpu_seconds']:14.2f} {m['browser_peak_rss_bytes'] / (1 << 20):13.0f}"
            )
            b = old.get(r["name"], {}).get(label)
            if baseline and b:
                def ratio(key, sub=None):
                    x = b[key] if sub is None else b[key].get(sub)
                    y = m[key] if sub is None else m[key].get(sub)
                    return f"{x / y:7.2f}" if x and y else f"{'-':>7s}"
                line += f" {ratio('wall_seconds')} {ratio('browser_cpu_seconds')} {ratio('browser_peak_rss_bytes')}"
            print(line)


def main():
    # the browser driver pulls in websocket-client; the parsers above
    # stay importable without it, which is what the unit tests want
    global cpu, emu
    cpu = load("cputest", "cpu-test.py")
    emu = load("emubench", "emubench.py")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="test this address instead of serving a directory")
    parser.add_argument("--engine", help="overlay this engine directory over the site's qemu/")
    parser.add_argument("--json", help="write the measurements here")
    parser.add_argument("--baseline", help="an earlier --json file to print ratios against")
    parser.add_argument("--only", action="append", help="run only this entry (repeatable)")
    parser.add_argument(
        "--browser",
        default=os.environ.get("TRYNIX_BROWSER", "chromium"),
        help="the headless browser to drive",
    )
    args = parser.parse_args()
    if not args.url and not args.site:
        sys.exit("pass --site <directory> or --url <address>")
    if args.engine and not args.site:
        sys.exit("--engine needs --site")

    scratch = None
    shutdown = None
    if args.url:
        base = args.url.rstrip("/")
    else:
        site = args.site
        if args.engine:
            site, scratch = emu.overlay_engine(site, args.engine)
        base, shutdown = cpu.serve(site)

    suite = [e for e in SUITE if not args.only or e["name"] in args.only]
    baseline = None
    if args.baseline:
        with open(args.baseline) as f:
            baseline = json.load(f)

    runs_dir = tempfile.mkdtemp(prefix="exec-bench-runs-")
    results = []
    try:
        for entry in suite:
            print(f"== {entry['name']}: {entry['command']}", flush=True)
            results.append(run_entry(entry, base, args.browser, runs_dir))
            if args.json:
                with open(args.json, "w") as f:
                    json.dump({"engine": args.engine or "site", "results": results}, f, indent=2)
    finally:
        if shutdown:
            shutdown()
        shutil.rmtree(runs_dir, ignore_errors=True)
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)

    print()
    print_summary(results, baseline)
    failed = [r["name"] for r in results if "error" in r or any("error" in r.get(l, {}) for l in ITERATIONS)]
    if failed:
        sys.exit(f"failed: {', '.join(failed)}")


if __name__ == "__main__":
    main()
