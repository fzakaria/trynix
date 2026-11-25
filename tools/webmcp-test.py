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
import contextlib
import importlib.util
import json
import os
import shlex
import sys
import tempfile
import time
import urllib.parse

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

# figlet exercises a new store directory and a new command in the shared bin farm.
ADDED_PACKAGE = "figlet"
ADDED_VERSION = "2.2.5"
ADDED_ARGUMENT = "-I1"
ADDED_OUTPUT = "20205"
BOOT_ID_COMMAND = "cat /proc/sys/kernel/random/boot_id"
COMMAND_NOT_FOUND = 127

# Two versions of PACKAGE selected together for one boot, in this order,
# and the first line `hello --version` prints for one of them.
BOTH_VERSIONS = ["2.10", "2.12.2"]
VERSION_COMMAND = f"{PACKAGE} --version"
VERSION_LINE = "hello (GNU Hello) {}"

# An addition whose download failed: the first of BOTH_VERSIONS is
# booted on the unkernel engine and the second is added, with the added
# version's NAR refused on the first try. A refused download fails in
# the page as a dropped connection does, and the addition's progress row
# says so. The boot tool's answer for a failed addition opens with
# ADDITION_FAILED.
RETRY_ENGINE = "unkernel"
REFUSED_PATH_SUFFIX = f"-{PACKAGE}-{BOTH_VERSIONS[1]}"
REFUSAL_MESSAGE = "Failed to fetch"
FAILED_ROW = "document.querySelector('#boot-progress .failed')?.textContent ?? ''"
ADDITION_FAILED = "the addition failed: "

# A boot that fails once its engine started: once before its guest
# starts, with the second of BOTH_VERSIONS refused as above, and once
# after, with the guest's link of its store at /nix failing
# (BREAK_LINK). The boot tool's answer opens with BOOT_FAILED, carries
# the error, and names a link that boots the selection in a fresh page
# (BOOT_PARAMETER). The page holds its engine for its life, so the next
# boot call opens with LAST_BOOT_FAILED, and the button reads
# START_OVER and opens a fresh page.
BOOT_FAILED = "the boot failed: "
LAST_BOOT_FAILED = "the last boot failed; "
BOOT_PARAMETER = "boot=1"
START_OVER = "Start over"
BOOT_BUTTON = "document.getElementById('boot-button')"
# The guest's link of its store at /nix, which the page runs with the
# links to the X server and the GL driver in one shell command
# (site/js/unkernel.js): an exec whose command line holds it is refused.
LINK_COMMAND = "ln -s /share/nix /nix"
LINK_ERROR = "ln: refused by webmcp-test"

# Set on a page before its button is clicked, and gone from the page the
# click opens.
OLD_PAGE_MARK = "window.webmcpTestOldPage"
# True once a guest is at its prompt: the veil over the terminal goes.
AT_PROMPT = "document.getElementById('console-veil').hidden"

# A real cachix cache and its key, used only to check that set-caches
# takes them and puts them in the link. Nothing is fetched from it.
CACHE_URL = "https://trynix.cachix.org"
CACHE_KEY = "trynix.cachix.org-1:xmOWOHz2g/BlpCVQrTEZjSKWPk3S3Dukn1xiSWLidkY="

# A well-formed store path no cache holds, and what the console veil
# says while a boot is still downloading.
MISSING_PATH = "/nix/store/00000000000000000000000000000000-missing"
FETCHING_NOTE = "fetching…"
# How the page words a path no cache holds, and how the boot tool's
# answer opens when the page already knows that and refuses to start.
NOT_FOUND = "not found in any configured cache"
REFUSAL = f"the boot did not start: {NOT_FOUND}"
# How long a doomed boot and the cache probe are given to answer.
MISSING_LIMIT_SECONDS = 60

# How long the page is given to register its tools, and a boot to
# finish. The wait is a poll rather than a sleep: a host that cannot set
# COOP/COEP headers serves the coi-serviceworker shim, which reloads the
# page once before any module runs.
REGISTER_LIMIT_SECONDS = 30
REGISTER_POLL_SECONDS = 0.25
BOOT_LIMIT_MS = 300000
MS_PER_SECOND = 1000

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

# Installed before the page's own scripts for the failed addition and
# the boot that fails before its guest starts. It wraps the page's
# fetch: the narinfo of the store path ending in
# REFUSED_PATH_SUFFIX names the NAR to refuse, and while
# window.refuseTest.refusing is true a download of that NAR fails the
# way a browser fails a dropped connection. window.refuseTest counts
# the refusals, so a check cannot pass without one.
REFUSE = (
    r"""
(() => {
  const state = { refusing: false, nar: null, refused: 0 };
  window.refuseTest = state;
  const pageFetch = window.fetch.bind(window);

  window.fetch = async (resource, options) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    if (state.refusing && url === state.nar) {
      state.refused += 1;
      throw new TypeError(REFUSAL_MESSAGE);
    }
    const response = await pageFetch(resource, options);
    if (url.endsWith(".narinfo") && response.ok) {
      const text = await response.clone().text();
      const storePath = text.match(/^StorePath: (\S+)$/m)?.[1] ?? "";
      const narUrl = text.match(/^URL: (\S+)$/m)?.[1];
      if (narUrl !== undefined && storePath.endsWith(REFUSED_PATH_SUFFIX)) {
        state.nar = new URL(narUrl, url).href;
      }
    }
    return response;
  };
})();
"""
    .replace("REFUSED_PATH_SUFFIX", json.dumps(REFUSED_PATH_SUFFIX))
    .replace("REFUSAL_MESSAGE", json.dumps(REFUSAL_MESSAGE))
)

# Installed before the page's own scripts for the boot that fails after
# its guest starts. The unkernel engine hands the page the guest's
# kernel as window.trynix.kernel (site/js/unkernel.js), and once the
# guest is started it runs LINK_COMMAND in the guest to put the store at
# /nix. This makes that run exit 1 with LINK_ERROR, and every other run
# go through as it would.
BREAK_LINK = (
    r"""
(() => {
  let guest;
  Object.defineProperty(window, "trynix", {
    configurable: true,
    get: () => guest,
    set(value) {
      guest = value;
      const kernel = value?.kernel;
      if (kernel === undefined) {
        return;
      }
      const exec = kernel.exec.bind(kernel);
      kernel.exec = (path, args = [], ...rest) =>
        [path, ...args].join(" ").includes(LINK_COMMAND)
          ? Promise.resolve({ exitCode: 1, stdout: "", stderr: LINK_ERROR })
          : exec(path, args, ...rest);
    },
  });
})();
"""
    .replace("LINK_COMMAND", json.dumps(LINK_COMMAND))
    .replace("LINK_ERROR", json.dumps(LINK_ERROR))
)


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


def await_tools(browser):
    """Poll until the page has registered its tools; returns their names."""
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
    return names


def poll(browser, expression, limit_seconds=MISSING_LIMIT_SECONDS):
    """Evaluate `expression`, awaited, until it is truthy or
    `limit_seconds` pass."""
    deadline = time.monotonic() + limit_seconds
    while time.monotonic() < deadline:
        value = resolved(browser, expression)
        if value:
            return value
        time.sleep(REGISTER_POLL_SECONDS)
    return None


def check_missing_path(browser, checks, base):
    """A link to a store path no cache holds: the boot fails and says so.

    The link carries boot=1, so the boot starts before the cache probe
    answers and fails in the closure walk. The veil must stop saying it
    is fetching. Once the probe has answered, the button is disabled and
    the boot tool refuses without downloading anything.
    """
    print("a link to a missing store path, booting at once")
    query = urllib.parse.urlencode({"path": MISSING_PATH, "boot": "1"})
    browser.send("Page.navigate", url=f"{base}/?{query}")
    await_tools(browser)

    # The boot that raced the probe fails in the walk, and the error
    # lands on its progress row.
    failed = poll(
        browser,
        "document.querySelector('#boot-progress .failed')?.textContent ?? ''",
    )
    print(f"  {failed}")
    checks.true("the failed row says the path was not found", NOT_FOUND in (failed or ""))
    checks.true(
        "the veil no longer says it is fetching",
        browser.evaluate("document.getElementById('console-note').textContent")
        != FETCHING_NOTE,
    )
    checks.true(
        "the spinner stopped",
        browser.evaluate("document.getElementById('console-spinner')?.hidden"),
    )

    # Once the probe has answered, a second boot is not offered.
    answered = poll(
        browser,
        "document.modelContext.executeTool('page-state', {})"
        ".then((r) => JSON.parse(r.content[0].text).selection[0].inCache === false)",
    )
    checks.true("the probe says no cache holds it", answered)

    # The status line describes the selection rather than repeating the
    # row's error.
    status = poll(
        browser,
        "(() => { const s = document.getElementById('status').textContent;"
        f" return s.includes({json.dumps(NOT_FOUND)}) && s; }})()",
    )
    print(f"  {status}")
    checks.true("the status line names the missing path", status)
    checks.true("the status line does not repeat the error", "Error" not in (status or ""))
    checks.true(
        "the boot button is disabled",
        browser.evaluate("document.getElementById('boot-button').disabled"),
    )
    # The walk's own error names the missing path too, so only the
    # refusal's opening tells a refusal from a boot that tried and failed.
    said = call(browser, "boot")
    print(f"  {said}")
    checks.true("the boot tool refuses and says why", said.startswith(REFUSAL))


def check_live_addition(browser, checks):
    """Cache missing paths, add figlet, and execute figlet without replacing the VM."""
    print("select-packages, after boot")
    before = json.loads(call(browser, "page-state"))
    boot_id = json.loads(call(browser, "run-command", command=BOOT_ID_COMMAND))
    checks.equal("boot ID readable", boot_id["status"], 0)
    checks.true("boot ID present", boot_id["output"])
    state = json.loads(
        call(browser, "select-packages", packages=[{"attr": ADDED_PACKAGE, "version": ADDED_VERSION}])
    )
    selected = next(row for row in state["selection"] if row["attr"] == ADDED_PACKAGE)
    executable = selected["storePath"] + "/bin/" + ADDED_PACKAGE

    # Prime negative dentries in the store and bin farm before publishing figlet.
    for command in (shlex.quote(executable), ADDED_PACKAGE):
        missing = json.loads(call(browser, "run-command", command=command))
        checks.equal(f"absent before adding: {command}", missing["status"], COMMAND_NOT_FOUND)

    print("boot, adding to the running guest")
    said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
    checks.true("added without booting", said.startswith("added to the running guest;"))

    # Execute both previously missing names; PATH alone would miss store lookup bugs.
    for command in (shlex.quote(executable), ADDED_PACKAGE):
        result = json.loads(
            call(browser, "run-command", command=f"{command} {ADDED_ARGUMENT}")
        )
        checks.equal(f"added command status: {command}", result["status"], 0)
        checks.equal(f"added command output: {command}", result["output"], ADDED_OUTPUT)

    # A successful fresh boot must not pass as a successful live addition.
    after = json.loads(call(browser, "run-command", command=BOOT_ID_COMMAND))
    checks.equal("same guest boot ID", after, boot_id)
    state = json.loads(call(browser, "page-state"))
    checks.true("closure grew", state["closurePaths"] > before["closurePaths"])
    original = json.loads(call(browser, "run-command", command=PACKAGE))
    checks.equal("original command status", original["status"], 0)
    checks.equal("original command output", original["output"], GREETING)


def version_line(browser):
    """The first line `hello --version` prints in the running guest, or
    None when the command failed."""
    result = json.loads(call(browser, "run-command", command=VERSION_COMMAND))
    if result["status"] != 0:
        return None
    return result["output"].splitlines()[0]


def check_addition_keeps_winner(browser, checks, base):
    """Two versions of one command booted together, then figlet added.

    Of the two, the one selected first runs: a boot links the roots in
    selection order and the first keeps the name. Adding figlet, which
    has no such command, must leave the same version running. The
    page's add note says the most recently added package wins a name,
    and neither version was added after the other. Each addition used
    to relink every selected package with replacement on, so the last
    one selected took the name, and hello --version said 2.12.2 after
    saying 2.10.
    """
    print("two versions of one command, booted together")
    browser.send("Page.navigate", url=base)
    await_tools(browser)
    call(
        browser,
        "select-packages",
        packages=[{"attr": PACKAGE, "version": version} for version in BOTH_VERSIONS],
    )
    said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
    checks.true("booted", said.startswith("booted;"))
    booted = version_line(browser)
    checks.equal(
        "the version selected first runs", booted, VERSION_LINE.format(BOTH_VERSIONS[0])
    )

    print("figlet added")
    call(
        browser,
        "select-packages",
        packages=[{"attr": ADDED_PACKAGE, "version": ADDED_VERSION}],
    )
    said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
    checks.true("added without booting", said.startswith("added to the running guest;"))
    checks.equal("the same version runs after the addition", version_line(browser), booted)


def forget_cached_paths(browser, base):
    """Empty the page's Cache Storage, where it keeps NARs and narinfos.

    A hit there is read without a fetch REFUSE could refuse, and an
    earlier check may have fetched the path a check refuses.
    """
    origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(base))
    browser.send("Storage.clearDataForOrigin", origin=origin, storageTypes="cache_storage")


@contextlib.contextmanager
def preloaded(browser, source):
    """Run `source` before the page's own scripts in every document the
    tab opens while the block runs."""
    script = browser.send("Page.addScriptToEvaluateOnNewDocument", source=source)
    try:
        yield
    finally:
        browser.send(
            "Page.removeScriptToEvaluateOnNewDocument",
            identifier=script["result"]["identifier"],
        )


def check_failed_addition(browser, checks, base):
    """An addition whose download failed, retried once the download works.

    The first of BOTH_VERSIONS is booted, and the second is added while
    its NAR is refused, so the addition fails. The boot tool has to say
    so and why, as the progress row does: it used to answer that the
    packages were added, which left a caller no reason to retry. Then
    the NAR is let through, and calling boot again adds the package.
    """
    print("an addition whose download failed")
    forget_cached_paths(browser, base)
    with preloaded(browser, REFUSE):
        query = urllib.parse.urlencode({"engine": RETRY_ENGINE})
        browser.send("Page.navigate", url=f"{base}/?{query}")
        await_tools(browser)
        booted, added = BOTH_VERSIONS
        call(browser, "select-packages", packages=[{"attr": PACKAGE, "version": booted}])
        said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
        checks.true("booted", said.startswith("booted;"))

        # The first try: the added version's NAR is refused.
        call(browser, "select-packages", packages=[{"attr": PACKAGE, "version": added}])
        browser.evaluate("window.refuseTest.refusing = true")
        said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
        print(f"  {said}")
        checks.true("the NAR was refused", browser.evaluate("window.refuseTest.refused"))
        failed = browser.evaluate(FAILED_ROW)
        print(f"  {failed}")
        checks.true("the addition's row failed", REFUSAL_MESSAGE in failed)
        checks.true("the boot tool says the addition failed", said.startswith(ADDITION_FAILED))
        checks.true("the boot tool says why", REFUSAL_MESSAGE in said)

        # The retry, with the NAR let through.
        browser.evaluate("window.refuseTest.refusing = false")
        said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
        print(f"  {said}")
        checks.true("the retry added", said.startswith("added to the running guest;"))


def await_new_page(browser):
    """Wait until the tab holds a new page: OLD_PAGE_MARK, set on the
    old one, is gone. Evaluated without awaiting, so a look that lands
    while the old page goes answers None rather than failing."""
    deadline = time.monotonic() + REGISTER_LIMIT_SECONDS
    while time.monotonic() < deadline:
        if browser.evaluate(f"{OLD_PAGE_MARK} === undefined"):
            return True
        time.sleep(REGISTER_POLL_SECONDS)
    return False


def check_start_over(browser, checks):
    """Press the button on a page whose boot failed once its engine
    started, and check that the fresh page it opens boots the selection
    as it opens."""
    print("the button, after the boot that failed")
    browser.evaluate(f"{OLD_PAGE_MARK} = true")
    browser.evaluate(f"{BOOT_BUTTON}.click()")
    fresh = await_new_page(browser)
    checks.true("the button opens a fresh page", fresh)
    if not fresh:
        return

    await_tools(browser)
    at_prompt = poll(browser, AT_PROMPT, limit_seconds=BOOT_LIMIT_MS / MS_PER_SECOND)
    checks.true("the fresh page boots", at_prompt)
    if not at_prompt:
        return
    result = json.loads(call(browser, "run-command", command=PACKAGE))
    checks.equal("the booted package runs", result["output"], GREETING)


def check_failed_boot(browser, checks, base):
    """A boot that fails once its engine started, before its guest
    starts and after.

    The boot tool has to say that the boot failed and why, as the
    progress row does. A boot that failed once the page had started its
    guest used to be answered "booted", and one that failed before
    that was answered with the status line, which by then describes the
    selection and not the error.

    The engine stays in the page, so the button has to start over in a
    fresh page, and the next boot call has to say the last one failed
    rather than start a second engine. The fresh page has to boot: the
    page's reboot used to reload the old address, which does not boot.
    """
    query = urllib.parse.urlencode({"engine": RETRY_ENGINE})
    booted, refused = BOTH_VERSIONS

    print("a boot whose package's NAR is refused")
    forget_cached_paths(browser, base)
    with preloaded(browser, REFUSE):
        browser.send("Page.navigate", url=f"{base}/?{query}")
        await_tools(browser)
        call(browser, "select-packages", packages=[{"attr": PACKAGE, "version": refused}])
        browser.evaluate("window.refuseTest.refusing = true")
        said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
        print(f"  {said}")
        checks.true("the NAR was refused", browser.evaluate("window.refuseTest.refused"))
        checks.true("the boot tool says the boot failed", said.startswith(BOOT_FAILED))
        checks.true("the boot tool says why", REFUSAL_MESSAGE in said)
        checks.true("the boot tool names a link that boots", BOOT_PARAMETER in said)

        # The engine started before the download failed, so this page
        # cannot boot again.
        checks.equal(
            "the button starts over", browser.evaluate(f"{BOOT_BUTTON}.textContent"), START_OVER
        )
        checks.equal("the button is enabled", browser.evaluate(f"{BOOT_BUTTON}.disabled"), False)
        said = call(browser, "boot")
        print(f"  {said}")
        checks.true("the next boot says the last one failed", said.startswith(LAST_BOOT_FAILED))
        checks.true("the next boot names a link that boots", BOOT_PARAMETER in said)
    check_start_over(browser, checks)

    print("a boot whose guest cannot link its store at /nix")
    with preloaded(browser, BREAK_LINK):
        browser.send("Page.navigate", url=f"{base}/?{query}")
        await_tools(browser)
        call(browser, "select-packages", packages=[{"attr": PACKAGE, "version": booted}])
        said = call(browser, "boot", timeout_ms=BOOT_LIMIT_MS)
        print(f"  {said}")
        failed = browser.evaluate(FAILED_ROW)
        print(f"  {failed}")
        checks.true("the boot's row failed", LINK_ERROR in failed)
        checks.true("the boot tool says the boot failed", said.startswith(BOOT_FAILED))
        checks.true("the boot tool says why", LINK_ERROR in said)


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
        check_missing_path(browser, checks, base)

        # A fresh page for the rest. No ?boot=1 in the URL: booting is a
        # tool call here, which is the part a link cannot do for an agent.
        browser.send("Page.navigate", url=base)
        names = await_tools(browser)
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

        check_live_addition(browser, checks)

        print("read-console")
        checks.true(
            "carries the guest's welcome",
            cpu.SHELL_MARKER in call(browser, "read-console"),
        )

        # A fresh page and guest, since this boot selects two versions.
        check_addition_keeps_winner(browser, checks, base)

        # A fresh page and guest for an addition that fails.
        check_failed_addition(browser, checks, base)

        # A fresh page for each boot that fails.
        check_failed_boot(browser, checks, base)
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
