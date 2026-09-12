#!/usr/bin/env python3
"""Call the page's WebMCP tools the way an agent would, and check the answers.

WebMCP (site/js/webmcp.js) is behind an origin trial in Chrome and Edge
and absent everywhere else, so a plain headless chromium has no
document.modelContext and site/js/webmcp.js registers nothing. Waiting
for a browser that ships it would leave the tool definitions covered
by nothing at all: their names, their schemas, their execute
functions.

So this installs a document.modelContext of its own before the page's
modules load, and drives the tools through it. The polyfill is a Map
with three methods; everything under test is the page's. On a browser
that does have the API the polyfill defers to it, since defineProperty
only runs where the property is missing.

This cannot tell you whether Chrome's implementation agrees with the
spec. It tells you the page holds up its end. Run it against a built
site:

    nix run .#webmcp-test -- --site result
    nix run .#webmcp-test -- --url https://trynix.dev
"""
import argparse
import importlib.util
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# Every tool site/js/webmcp.js declares. A tool that stops registering
# is a tool an agent silently loses, which is worth failing over.
EXPECTED_TOOLS = [
    "boot",
    "list-versions",
    "page-state",
    "read-console",
    "run-command",
    "search-packages",
    "select-packages",
    "set-caches",
]

# What is booted: one small package whose output is fixed.
PACKAGE = "hello"
GREETING = "Hello, world!"

# A real cachix cache and its key, used only to check that set-caches
# takes them and puts them in the link. Nothing is fetched from it.
CACHE_URL = "https://trynix.cachix.org"
CACHE_KEY = "trynix.cachix.org-1:xmOWOHz2g/BlpCVQrTEZjSKWPk3S3Dukn1xiSWLidkY="

# How long the page is given to register its tools, and a boot to
# finish. The wait is a poll rather than a sleep: a host that cannot set
# COOP/COEP headers serves the coi-serviceworker shim, which reloads the
# page once before any module runs.
REGISTER_LIMIT_SECONDS = 30
REGISTER_POLL_SECONDS = 0.25
BOOT_LIMIT_MS = 300000

# The missing browser API, installed before any module runs. registerTool
# keeps the whole descriptor; executeTool calls the page's own execute.
POLYFILL = """
(() => {
  if (Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")) {
    return;
  }
  const tools = new Map();
  const context = {
    registerTool(tool) {
      tools.set(tool.name, tool);
      return Promise.resolve();
    },
    getTools() {
      return Promise.resolve(
        [...tools.values()].map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      );
    },
    executeTool(name, input) {
      return tools.get(name).execute(input ?? {});
    },
  };
  Object.defineProperty(Document.prototype, "modelContext", {
    configurable: true,
    get: () => context,
  });
})();
"""


def load(name, filename):
    """Import a sibling tool by file name; they have hyphens."""
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    assert spec is not None and spec.loader is not None, filename
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cpu = load("cputest", "cpu-test.py")


class Checks:
    """Every check run, so one failure does not hide the rest."""

    def __init__(self):
        self.failed = []

    def equal(self, label, got, want):
        ok = got == want
        print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got!r}")
        if not ok:
            self.failed.append(f"{label}: got {got!r}, want {want!r}")

    def true(self, label, got):
        self.equal(label, bool(got), True)


def resolved(browser, expression, timeout_ms=30000):
    """Evaluate an expression that returns a promise, and wait for it.

    cpu-test's evaluate() does not await, and every tool call is a
    promise.
    """
    reply = browser.send(
        "Runtime.evaluate",
        expression=expression,
        awaitPromise=True,
        returnByValue=True,
        timeout=timeout_ms,
    )
    result = reply["result"]["result"]
    if result.get("subtype") == "error":
        sys.exit(f"the page threw: {result.get('description')}")
    return result["value"]


def call(browser, name, timeout_ms=30000, **args):
    """One tool call, returning the text content the tool answered with."""
    expression = (
        "document.modelContext.executeTool("
        + json.dumps(name)
        + ", "
        + json.dumps(args)
        + ").then((r) => r.content[0].text)"
    )
    return resolved(browser, expression, timeout_ms)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="test this address instead of serving a directory")
    parser.add_argument("--browser", default=os.environ.get("TRYNIX_BROWSER", "chromium"))
    args = parser.parse_args()
    if (args.site is None) == (args.url is None):
        parser.error("pass one of --site or --url")

    base, shutdown = (args.url, None) if args.site is None else cpu.serve(args.site)
    workdir = tempfile.mkdtemp()
    browser = cpu.Browser(args.browser, os.path.join(workdir, "profile"))
    checks = Checks()

    try:
        browser.send("Page.addScriptToEvaluateOnNewDocument", source=POLYFILL)
        # No ?boot=1 in the URL: booting is a tool call here, which is
        # the part a link cannot do for an agent.
        browser.send("Page.navigate", url=base)

        deadline = time.monotonic() + REGISTER_LIMIT_SECONDS
        names = []
        while time.monotonic() < deadline and not names:
            names = (
                resolved(
                    browser,
                    "document.modelContext.getTools().then((t) => t.map((x) => x.name))",
                )
                or []
            )
            if not names:
                time.sleep(REGISTER_POLL_SECONDS)
        print(f"tools registered: {names}")
        checks.equal("the tools", sorted(names or []), EXPECTED_TOOLS)

        # Every tool needs a description and a schema: an agent picks
        # tools by reading them, and one without either is unusable.
        described = resolved(
            browser,
            "document.modelContext.getTools().then((t) => t.every("
            "(x) => x.description.length > 0 && x.inputSchema.type === 'object'))",
        )
        checks.true("all described, all with an object schema", described)

        print("page-state, before anything is selected")
        state = json.loads(call(browser, "page-state"))
        checks.equal("booted", state["booted"], False)
        checks.equal("selection", state["selection"], [])

        print("run-command, before there is a guest to run it in")
        checks.true(
            "says so rather than throwing",
            "no guest is running" in call(browser, "run-command", command="true"),
        )

        print("search-packages")
        found = json.loads(call(browser, "search-packages", query=PACKAGE, limit=5))
        checks.true(PACKAGE, any(row["attr"] == PACKAGE for row in found))

        print("list-versions")
        versions = json.loads(call(browser, "list-versions", attr=PACKAGE))
        checks.true("versions listed", len(versions) > 0)
        checks.true("at least one bootable", any(v["bootable"] for v in versions))

        print("select-packages")
        state = json.loads(call(browser, "select-packages", packages=[{"attr": PACKAGE}]))
        checks.equal("one selected", len(state["selection"]), 1)
        checks.equal("named", state["selection"][0]["attr"], PACKAGE)
        # Present even while the cache probe is still in flight.
        # JSON.stringify drops an undefined value, so a key that is
        # sometimes there and sometimes not is easy to ship by accident.
        checks.true("inCache is always a key", "inCache" in state["selection"][0])
        # The selection is the link, which is what makes a tool call
        # something a person can be handed afterwards.
        checks.true("the link names it", f"pkg={PACKAGE}" in state["link"])

        print("set-caches")
        state = json.loads(
            call(browser, "set-caches", caches=[{"url": CACHE_URL, "key": CACHE_KEY}])
        )
        checks.equal("one cache", len(state["caches"]), 1)
        checks.equal("its url", state["caches"][0]["url"], CACHE_URL)
        # The caches ride in the link with the selection, so a boot an
        # agent set up is still a link a person can be handed.
        checks.true("the link carries it", "cache=" in state["link"])
        # Put it back: an unreachable cache would slow every later probe.
        json.loads(call(browser, "set-caches", caches=[]))

        print("boot")
        said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
        print(f"  {said}")
        checks.true("booted", said.startswith("booted;"))

        print("run-command, in the guest the tools booted")
        result = json.loads(call(browser, "run-command", command=PACKAGE))
        checks.equal("status", result["status"], 0)
        checks.equal("output", result["output"], GREETING)

        print("page-state, after the boot")
        state = json.loads(call(browser, "page-state"))
        checks.equal("booted", state["booted"], True)
        checks.true("paths mounted", state["closurePaths"] > 0)

        print("read-console")
        checks.true(
            "carries the guest's welcome",
            cpu.SHELL_MARKER in call(browser, "read-console"),
        )
    finally:
        browser.close()
        if shutdown is not None:
            shutdown()

    if checks.failed:
        print("\n".join(f"FAILED {line}" for line in checks.failed))
        sys.exit(f"{len(checks.failed)} of the page's tools did not answer as expected")
    print("every tool answered as expected")


if __name__ == "__main__":
    main()
