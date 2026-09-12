#!/usr/bin/env python3
"""Run the throughput probe in a real browser and print what each
instruction class costs.

Where tools/cpu-test.py asks whether the emulator computes the right
answer, this asks how fast. The probe (nix/emubench.nix) is a static
binary of fixed inline-assembly loops, one per mechanism the engine
pays for: a hot single block, block-to-block transitions, call/ret,
computed jumps, the TLB fast path, syscalls, page faults, and cold
straight-line code run pass by pass. docs/engine-execution.md reads
the numbers; this prints them.

    nix run .#emubench -- --site <a built site directory>
    nix run .#emubench -- --site <site> --engine <dir with out.js, .wasm, .worker.js>
    nix run .#emubench -- --url https://trynix.dev/ --json out.json

--engine overlays a locally built engine over the site's qemu/ files in
a scratch copy, so two engines are compared on the same page and guest.
The probe is served from the site's own binary cache, like the CPU
probe, so a local --site needs no network.

In CI this is a smoke run: it fails if the probe does not finish or a
row is missing, and prints the table into the log. The numbers are for
eyes, not for a threshold; a shared runner is too noisy for that.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
cpu = None


def load(name, filename):
    """Import a sibling tool by file name; they have hyphens."""
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    assert spec is not None and spec.loader is not None, filename
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module



# Every row `emubench all` prints, in order. A missing one is a failure.
TESTS = [
    "alu", "alu2", "alu4", "call", "indirect", "mem", "memstride",
    "syscall", "pagefault",
    "cold50k/p1", "cold50k/p2", "cold50k/p3",
    "cold2k/p1", "cold2k/p2", "cold2k/p3", "cold2k/p4",
    "cold2k/p100", "cold2k/p1500", "cold2k/p1600",
]
DONE = "emubench: done"
# the shell reports a probe that died this way instead of finishing; no
# point waiting the limit out
CRASHED = ("Illegal instruction", "Segmentation fault", "Bus error", "Killed")
ROW = re.compile(r"emubench: (\S+)\s+iters=(\d+) ns=(\d+) ns/iter=([\d.]+) mips=([\d.]+)")
PROBE_LIMIT_SECONDS = 600
ROW_POLL_SECONDS = 0.05
# a row has to have run this long on the host for its clock ratio to
# mean anything; the fixed cost of printing a row is milliseconds
MIN_ROW_SECONDS = 0.5


def overlay_engine(site, engine):
    """A scratch copy of the site with `engine` over its qemu/ files.

    The page fetches the engine by content hash from assets.json, so the
    manifest is recomputed to describe the bytes actually served.
    """
    scratch = tempfile.mkdtemp(prefix="emubench-site-")
    shutil.copytree(site, os.path.join(scratch, "site"), symlinks=True)
    copy = os.path.join(scratch, "site")
    subprocess.run(["chmod", "-R", "u+w", copy], check=True)
    for name in ("out.js", "qemu-system-x86_64.wasm", "qemu-system-x86_64.worker.js", "vm.state"):
        source = os.path.join(engine, name)
        if os.path.exists(source):
            shutil.copy(source, os.path.join(copy, "qemu", name))
    subprocess.run(
        [sys.executable, os.path.join(HERE, "asset-versions.py"), copy, "qemu", "guest"],
        check=True, stdout=subprocess.DEVNULL,
    )
    return copy, scratch


def read_manifest(root):
    path = os.path.join(root, cpu.MANIFEST)
    if not os.path.exists(path):
        sys.exit(f"{path} is missing: run `nix run .#make-example-cache -- --secret-key <file>`")
    with open(path) as f:
        manifest = json.load(f)
    if "emubench" not in manifest["paths"]:
        sys.exit("the example cache does not carry emubench; re-run make-example-cache")
    return manifest["paths"]["emubench"], manifest["publicKey"]


def parse_rows(text):
    rows = {}
    for match in ROW.finditer(text):
        rows[match[1]] = {
            "iters": int(match[2]),
            "ns": int(match[3]),
            "ns_per_iter": float(match[4]),
            "mips": float(match[5]),
        }
    return rows


def watch_rows(browser, mark, limit):
    """Poll the transcript until the probe says it is done, noting on the
    host's clock when each row appeared. Returns (seconds taken, what the
    guest said, {row name: host seconds since the command was typed}), or
    None for the first when the probe did not finish."""
    started = time.monotonic()
    arrivals = {}
    said = ""
    while time.monotonic() - started < limit:
        said = browser.transcript()[mark:]
        now = time.monotonic() - started
        for name in parse_rows(said):
            arrivals.setdefault(name, now)
        if DONE in said:
            return now, said, arrivals
        if crashed(said):
            return None, said, arrivals
        time.sleep(ROW_POLL_SECONDS)
    return None, said, arrivals


def crashed(said):
    """The shell's report of the probe dying, if any."""
    for marker in CRASHED:
        if marker in said:
            return marker
    return None


def clock_ratio(rows, arrivals):
    """The guest's clock against the host's: each row's guest-timed
    duration over the host time between its appearance and the previous
    row's, the median over rows that ran long enough to be worth reading.
    A correct clock gives 1.0; the 3.3x-slow clock before patch 0003
    gives about 0.3. None when no row ran long enough."""
    ratios = []
    previous = 0.0
    for name in sorted(arrivals, key=arrivals.get):
        host = arrivals[name] - previous
        previous = arrivals[name]
        if name not in rows or host < MIN_ROW_SECONDS:
            continue
        ratios.append(rows[name]["ns"] / 1e9 / host)
    if not ratios:
        return None
    ratios.sort()
    middle = len(ratios) // 2
    return ratios[middle] if len(ratios) % 2 else (ratios[middle - 1] + ratios[middle]) / 2


def guest_seconds(rows):
    """How long the guest's own clock says the probe took: the sum of
    every row's nanoseconds. The host's wall clock over the same run is
    the check on it -- the guest's clock once ran 3.3x slow
    (docs/performance.md), and every mips figure is measured against it."""
    return sum(row["ns"] for row in rows.values()) / 1e9


def print_table(rows):
    print(f"{'test':14s} {'ns/iter':>10s} {'mips':>9s}")
    for name in TESTS:
        row = rows.get(name)
        if row is None:
            print(f"{name:14s} {'missing':>10s}")
            continue
        print(f"{name:14s} {row['ns_per_iter']:10.1f} {row['mips']:9.1f}")


def main():
    # the browser driver pulls in websocket-client; the parsers above
    # stay importable without it, which is what the unit tests want
    global cpu
    cpu = load("cputest", "cpu-test.py")
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="test this address instead of serving a directory")
    parser.add_argument("--engine", help="overlay this engine directory over the site's qemu/")
    parser.add_argument("--json", help="write the rows here")
    parser.add_argument("--test", default="all", help="one test name, or all")
    parser.add_argument(
        "--probe",
        help="run this store path instead of the probe in the site's example cache",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=PROBE_LIMIT_SECONDS,
        help="seconds to wait for the probe to finish",
    )
    parser.add_argument(
        "--cache",
        help="'<url> <public key>' of the cache serving --probe (default: the site's example cache)",
    )
    parser.add_argument(
        "--browser",
        default=os.environ.get("TRYNIX_BROWSER", "chromium"),
        help="the headless browser to drive",
    )
    args = parser.parse_args()

    if not args.url and not args.site:
        sys.exit("pass --site <directory> or --url <address>")
    if args.engine and not args.site:
        sys.exit("--engine needs --site: the overlay is made on a local copy")

    manifest_root = args.site if args.site else "site"
    if args.probe and args.cache:
        probe = args.probe
        cache = args.cache
    else:
        probe, public_key = read_manifest(manifest_root)
        cache = f"{cpu.CACHE_PATH} {public_key}"
        if args.probe:
            probe = args.probe

    scratch = None
    shutdown = None
    if args.url:
        base = args.url.rstrip("/")
    else:
        site = args.site
        if args.engine:
            site, scratch = overlay_engine(site, args.engine)
        base, shutdown = cpu.serve(site)

    query = urllib.parse.urlencode({"path": probe, "cache": cache, "boot": "1"})
    url = f"{base}/?{query}"
    print(f"booting {url}", flush=True)

    workdir = tempfile.mkdtemp()
    browser = cpu.Browser(args.browser, os.path.join(workdir, "profile"))
    failed = True
    try:
        browser.send("Page.navigate", url=url)
        taken = cpu.await_marker(browser, cpu.SHELL_MARKER, cpu.BOOT_LIMIT_SECONDS)
        if taken is None:
            print(browser.transcript())
            print("=== the page said ===")
            print(browser.page_text())
            sys.exit(f"no shell within {cpu.BOOT_LIMIT_SECONDS}s")
        print(f"shell in {taken:.1f}s", flush=True)

        mark = len(browser.transcript())
        browser.type("emubench " + args.test + chr(10))
        taken, said, arrivals = watch_rows(browser, mark, args.limit)
        if taken is None:
            print(said)
            if crashed(said):
                sys.exit(f"the probe died: {crashed(said)}")
            sys.exit(f"the probe did not finish within {args.limit}s")

        rows = parse_rows(said)
        # a single test prints whatever rows it has; only `all` is checked
        expected = TESTS if args.test == "all" else list(rows)
        missing = [t for t in expected if t not in rows]
        if args.test != "all":
            for name, row in rows.items():
                print(f"{name:14s} {row['ns_per_iter']:10.1f} {row['mips']:9.1f}")
        else:
            print_table(rows)
        if args.json:
            with open(args.json, "w") as f:
                json.dump(
                {
                    # keystroke to the done marker, on the host's clock
                    "host_seconds": round(taken, 2),
                    "guest_seconds": round(guest_seconds(rows), 2),
                    # the guest's clock over the host's, row by row
                    "clock_ratio": clock_ratio(rows, arrivals),
                    "rows": rows,
                },
                f,
                indent=2,
            )
        if missing:
            sys.exit(f"rows missing from the probe's output: {', '.join(missing)}")
        print(f"done in {taken:.1f}s", flush=True)
        failed = False
    finally:
        browser.close()
        if shutdown:
            shutdown()
        shutil.rmtree(workdir, ignore_errors=True)
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
