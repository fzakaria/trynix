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

--guest-engine picks which of the page's two engines runs the guest:
unkernel (aarch64 guest, the page's default) or qemu (x86_64 guest). The
link names the engine outright, so a record never depends on what the
page would have chosen. --fetch says when the closure downloads, and is
named outright too: `all` (the default here, though not the page's)
downloads everything before the shell starts, so the cold execution
measures the engine and not the network; `lazy` measures a first run
that fetches store paths as the guest opens them (site/js/lazy.js). --engine overlays a locally built qemu engine
over the site's qemu/ files in a scratch copy. --baseline prints the
ratio of every number against an earlier run. --only picks entries by
name. The suite is the table below; every entry is a `pkg=` the page's
index resolves, so each engine fetches the build for its own system.

Numbers per entry and execution: seconds from keystroke to the command's
closing line, twice, as `page_seconds` on the page's own clock (a few
milliseconds wide) and as `wall_seconds` on this tool's quarter-second
poll, which is all the records before 2026-11-20 have; the guest's own
real/user/sys from busybox `time`; the browser process group's CPU
seconds and peak RSS over the same window. The RSS is a sum
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
#
# opencode is pinned to one version because its start-up cost moves
# between releases. On x86_64 that version is the store path
# 6pw7n475sa1d4scq8sy1qkdn2bcy0glc-opencode-1.18.29, which is what every
# record in site/bench/history.json measured when this entry was still
# a `path=`.
SUITE = [
    {"name": "hello", "spec": "pkg=hello", "command": "hello"},
    {"name": "ripgrep", "spec": "pkg=ripgrep", "command": "rg --version"},
    {"name": "jujutsu", "spec": "pkg=jujutsu", "command": "jj --version"},
    {"name": "python", "spec": "pkg=python3", "command": "python3 -c 'print(1)'"},
    {"name": "opencode", "spec": "pkg=opencode@1.18.29", "command": "opencode --version"},
]

# The page's engines (site/js/engine.js), by the name a link carries.
GUEST_ENGINES = ["unkernel", "qemu"]
DEFAULT_GUEST_ENGINE = "unkernel"

# When the page downloads a closure (site/js/downloads.js), by the name
# a link carries.
FETCH_MODES = ["all", "lazy"]
DEFAULT_FETCH = "all"

ITERATIONS = ["cold", "warm"]
COMMAND_LIMIT_SECONDS = 1800
POLL_SECONDS = 0.25
# The page's own timer (page_timer): where the page leaves its answer,
# how often the page looks for the closing line, and how long the host
# waits for the answer once the host has seen the line too.
PAGE_TIMER = "__execBenchSeconds"
PAGE_POLL_MILLISECONDS = 2
PAGE_TIMER_GRACE_SECONDS = 2
PAGE_TIMER_READ_SECONDS = 0.02
MILLISECONDS_PER_SECOND = 1000
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


def closing_pattern(marker):
    """The regular expression for the line that ends a command: the
    marker, a colon and the exit status, on a line of their own. Written
    in the syntax Python and JavaScript share, since the page waits on
    the same line (page_timer)."""
    return r"(?:^|\n)" + re.escape(marker) + r":(\d+)\r*\n"


def completion(transcript, marker):
    """The exit status once the whole marker line has been printed."""
    if "Stopped" in transcript:
        return None
    match = re.search(closing_pattern(marker), transcript)
    return int(match[1]) if match else None


def page_timer(line, marker):
    """JavaScript that types `line` into the guest and leaves, in
    window[PAGE_TIMER], the seconds until the closing line of `marker`
    appears, by the page's clock.

    The loop below this function's caller looks at the console every
    POLL_SECONDS, so a command that takes 20 ms reads as a quarter of a
    second from there. The page looks every few milliseconds instead.
    The transcript is searched whole: the marker differs per execution
    and the echo of the typed line carries the marker in two halves, so
    nothing printed earlier can match."""
    return f"""(() => {{
  const closing = new RegExp({json.dumps(closing_pattern(marker))});
  const started = performance.now();
  window.{PAGE_TIMER} = null;
  window.trynix.type({json.dumps(line)});
  const look = () => {{
    if (closing.test(window.trynix.transcript())) {{
      window.{PAGE_TIMER} = (performance.now() - started) / {MILLISECONDS_PER_SECOND};
      return;
    }}
    setTimeout(look, {PAGE_POLL_MILLISECONDS});
  }};
  look();
}})()"""


def read_page_timer(browser):
    """The seconds page_timer measured, or None if the page never saw
    the closing line. The host can see the line a moment before the
    page's own loop does, so the answer is waited for briefly."""
    deadline = time.monotonic() + PAGE_TIMER_GRACE_SECONDS
    while time.monotonic() < deadline:
        seconds = browser.evaluate(f"window.{PAGE_TIMER}")
        if seconds is not None:
            return round(seconds, 3)
        time.sleep(PAGE_TIMER_READ_SECONDS)
    return None


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


def page_query(entry, guest_engine, fetch=DEFAULT_FETCH):
    """The link's parameters for one entry: what to boot, on which
    engine, when its closure downloads, and to start without a click."""
    kind, value = entry["spec"].split("=", 1)
    return {kind: value, "engine": guest_engine, "fetch": fetch, "boot": "1"}


def run_entry(entry, base, browser_binary, runs_dir, guest_engine, fetch=DEFAULT_FETCH):
    """Boot a fresh guest with the entry's package, run its command cold
    then warm, and return the measurements."""
    query = urllib.parse.urlencode(page_query(entry, guest_engine, fetch))
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
            browser.evaluate(page_timer(wrap_command(entry["command"], marker) + "\n", marker))
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
                "page_seconds": read_page_timer(browser) if status is not None else None,
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
                f"  {entry['name']:9s} {label:4s} page {measurement['page_seconds'] or float('nan'):8.3f}s"
                f" wall {wall:8.2f}s"
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
    parser.add_argument(
        "--guest-engine",
        choices=GUEST_ENGINES,
        default=DEFAULT_GUEST_ENGINE,
        help="which of the page's engines runs the guest",
    )
    parser.add_argument(
        "--fetch",
        choices=FETCH_MODES,
        default=DEFAULT_FETCH,
        help="when the closure downloads: all before the shell starts, or as the guest opens it",
    )
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
            results.append(run_entry(entry, base, args.browser, runs_dir, args.guest_engine, args.fetch))
            if args.json:
                record = {
                    "engine": args.engine or "site",
                    "guest_engine": args.guest_engine,
                    "fetch": args.fetch,
                    "results": results,
                }
                with open(args.json, "w") as f:
                    json.dump(record, f, indent=2)
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
