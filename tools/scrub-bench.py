#!/usr/bin/env python3
"""Measure what the unkernel guest's timeline costs, in a real browser.

For each package: boot it on the unkernel engine, type a fixed list of
commands at the shell (each prompt after a command takes a keyframe),
then go back to the first command's prompt and forward to the last,
and report

  the guest's pause per keyframe: the whole snapshot() call, and the
  page diff inside it, which runs while every task is parked;

  each keyframe's size: pages changed, bytes before and after
  compression;

  each restore: the page's wait for go(), the worker's share of it
  (moving the shadow, booting the restored instance), and how long the
  restored shell then takes to run `true`, which is when the reader
  has a shell again.

    nix run .#scrub-bench -- --site "$(nix build .#site --print-out-paths)"
    nix run .#scrub-bench -- --url https://trynix.dev/ --package hello

docs/scrub.md has the numbers this printed. A boot needs the network:
the closure comes from cache.nixos.org.
"""

import argparse
import importlib.util
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# What each package's session types, in order. A long command is in
# each so the keyframes taken while a command runs are measured too.
SESSIONS = {
    "hello": [
        "hello",
        "hello -g 'scrub me'",
        "ls -la /share/bin",
        "sleep 6",
    ],
    "jujutsu": [
        "jj --version",
        "cd /tmp && jj git init repo && cd repo",
        "echo hi > file && jj st",
        "jj describe -m first && jj log",
    ],
    "python3": [
        "python3 -c 'print(1)'",
        "python3 -c 'import json, sqlite3; print(json.dumps([1, 2]))'",
        "python3 -c 'print(sum(range(30_000_000)))'",
    ],
}

READY_MARKER = "welcome to the multiverse"
BOOT_LIMIT_SECONDS = 120
COMMAND_LIMIT_SECONDS = 120
POLL_SECONDS = 0.1
MS_PER_SECOND = 1000


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    assert spec is not None and spec.loader is not None, filename
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluate(browser, expression):
    """The value of a JavaScript expression, awaited if it is a promise."""
    reply = browser.send(
        "Runtime.evaluate",
        expression=expression,
        returnByValue=True,
        awaitPromise=True,
        timeout=COMMAND_LIMIT_SECONDS * MS_PER_SECOND,
    )
    result = reply.get("result", {})
    if "exceptionDetails" in result:
        raise RuntimeError(json.dumps(result["exceptionDetails"])[:500])
    return result.get("result", {}).get("value")


def wait_for(browser, expression, limit, what):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        if evaluate(browser, expression):
            return
        time.sleep(POLL_SECONDS)
    raise RuntimeError(f"timed out waiting for {what}")


# Type a command and wait for the keyframe at the prompt after it.
TYPE_AND_WAIT = """
(async (line) => {
  const prompts = () => trynix.scrub.frames().filter((f) => f.kind === "prompt").length;
  const before = prompts();
  const started = performance.now();
  trynix.type(line + "\\r");
  while (prompts() === before) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return performance.now() - started;
})
"""

# Go to a keyframe, then time a `true` in the restored shell.
GO_AND_RESPOND = """
(async (id) => {
  const started = performance.now();
  await trynix.scrub.go(id);
  const restored = performance.now();
  await trynix.run("true");
  return { goMs: restored - started, respondMs: performance.now() - restored };
})
"""


def session(bootlib, binary, base, package, workdir):
    browser = bootlib.Browser(binary, os.path.join(workdir, f"profile-{package}"))
    try:
        browser.send(
            "Page.navigate", url=f"{base}/?pkg={package}&engine=unkernel&boot=1"
        )
        wait_for(
            browser,
            f"!!(window.trynix && window.trynix.transcript().includes({json.dumps(READY_MARKER)}) "
            "&& trynix.scrub.frames().length > 0)",
            BOOT_LIMIT_SECONDS,
            "the first prompt",
        )

        commands = []
        for line in SESSIONS[package]:
            ms = evaluate(browser, f"{TYPE_AND_WAIT}({json.dumps(line)})")
            commands.append({"command": line, "ms": ms})

        prompts = evaluate(
            browser,
            "trynix.scrub.frames().filter((f) => f.kind === 'prompt').map((f) => f.id)",
        )
        back = evaluate(browser, f"{GO_AND_RESPOND}({prompts[1]})")
        forward = evaluate(browser, f"{GO_AND_RESPOND}({prompts[-1]})")
        stats = evaluate(browser, "trynix.scrub.stats()")
        return {
            "package": package,
            "commands": commands,
            "frames": stats["frames"],
            "store": stats["store"],
            "restores": [
                {**back, **stats["restores"][0], "to": "first command"},
                {**forward, **stats["restores"][1], "to": "last prompt"},
            ],
        }
    finally:
        browser.close()


KIB = 1024


def report(result):
    print(f"\n{result['package']}")
    print("  keyframe                                   pages  raw KiB  stored KiB  pause ms  diff ms")
    for frame in result["frames"]:
        label = frame["kind"]
        if frame["kind"] == "prompt":
            label = f"after {frame['prompt']['command'] or '(boot)'}"
        print(
            f"  {label[:42]:42} {frame['pageCount']:6} {frame['rawBytes'] / KIB:8.0f}"
            f" {frame['storedBytes'] / KIB:11.0f} {frame['snapshotMs']:9.1f} {frame['captureMs']:8.1f}"
        )
    for restore in result["restores"]:
        print(
            f"  restore to {restore['to']}: go {restore['goMs']:.0f} ms"
            f" (shadow {restore['moveMs']:.0f}, boot {restore['bootMs']:.0f}),"
            f" then `true` {restore['respondMs']:.0f} ms"
        )


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="measure this address instead of serving a directory")
    parser.add_argument(
        "--package", action="append", choices=sorted(SESSIONS), help="repeatable; default all"
    )
    parser.add_argument("--json", help="write the measurements here")
    parser.add_argument("--browser", default="chromium")
    args = parser.parse_args()
    if (args.site is None) == (args.url is None):
        parser.error("give exactly one of --site and --url")

    bootlib = load("boottest", "boot-test.py")
    if args.site is not None:
        base, shutdown = bootlib.serve(args.site)
    else:
        base, shutdown = args.url.rstrip("/"), lambda: None

    results = []
    with tempfile.TemporaryDirectory() as workdir:
        try:
            for package in args.package or list(SESSIONS):
                result = session(bootlib, args.browser, base, package, workdir)
                report(result)
                results.append(result)
        finally:
            shutdown()

    if args.json is not None:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
