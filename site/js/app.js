// Page wiring: choose packages out of the nixpkgs-multiverse index —
// by search, by version range, or by raw store path — walk the union of
// their runtime closures live from cache.nixos.org, then boot.
// qemu-wasm runs an x86_64 guest in the tab, the closure rides in over
// virtio-9p, and the serial console lands in the terminal.
// docs/design.md holds the architecture.

import { walkClosure } from "./closure.js";
import { fetchNar } from "./store.js";
import { startVM } from "./boot.js";
import { fetchWithProgress, mapConcurrent, warmHttpCache } from "./net.js";
import { ProgressPanel } from "./progress.js";
import { PackagePicker } from "./search.js";
import { parseSpecs, resolveSpecs } from "./ranges.js";
import { versionsOf } from "./multiverse.js";
import { RangeComplete } from "./complete.js";
import { readUrl, writeUrl } from "./url.js";
import {
  DEFAULT_SUBSTITUTERS,
  parseSubstituters,
  readSubstituters,
  verify,
  writeSubstituters,
} from "./substituters.js";
import { humanBytes } from "./format.js";
import {
  DIGEST_LENGTH,
  DIGEST_PATTERN,
  GUEST_FILES,
  NAR_CONCURRENCY,
  QEMU_MAIN,
  QEMU_WASM,
  QEMU_WORKER,
  SNAPSHOT_URL,
} from "./config.js";
import { asset, assets } from "./assets.js";
import { binOutputOf } from "./outputs.js";
import { log, onLog } from "./log.js";

const STORE_PREFIX = "/nix/store/";

const storePathInput = document.getElementById("store-path");
const walkForm = document.getElementById("walk-form");
const rangesForm = document.getElementById("ranges-form");
const rangesInput = document.getElementById("ranges-input");
const rangesResults = document.getElementById("ranges-results");
const selectionElement = document.getElementById("selection");
const status = document.getElementById("status");
const result = document.getElementById("result");
const bootButton = document.getElementById("boot-button");
const bootSection = document.getElementById("boot");
const bootProgress = document.getElementById("boot-progress");
const terminalElement = document.getElementById("terminal");
const consoleVeil = document.getElementById("console-veil");
const consoleNote = document.getElementById("console-note");
const rebootLink = document.getElementById("reboot-link");
const debugLog = document.getElementById("debug-log");
const addNote = document.getElementById("add-note");

// The selection: digest -> { digest, label, attr, version, storePath }.
// A package chosen any of the three ways lands here in the same shape,
// which is what lets the URL describe all of them.
const selection = new Map();

const basenameOf = (info) => info.storePath.slice(STORE_PREFIX.length);

// Accept a full /nix/store path, a store basename, or a bare digest; a
// walk needs only the digest. Returns null when no digest is there.
function digestFromPath(raw) {
  let s = raw.trim();
  if (s.startsWith(STORE_PREFIX)) {
    s = s.slice(STORE_PREFIX.length);
  }
  s = s.slice(0, DIGEST_LENGTH);
  return DIGEST_PATTERN.test(s) ? s : null;
}

function select(entry) {
  selection.set(entry.digest, entry);
  render();
}

function deselect(digest) {
  selection.delete(digest);
  render();
}

// The chips, the status line, and the address bar all describe the same
// selection, so they are redrawn together.
function render() {
  const entries = [...selection.values()];

  selectionElement.replaceChildren(
    ...entries.map((entry) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.title = `${entry.storePath ?? entry.digest} — click to remove`;
      chip.textContent = `${entry.label} ✕`;
      chip.onclick = () => deselect(entry.digest);
      return chip;
    }),
  );

  bootButton.disabled = entries.length === 0;
  status.textContent = entries.length === 0 ? "nothing selected yet" : "";

  // A package with an attribute is shareable by name; a raw store path
  // rides as a path. Either way the link reproduces this screen.
  const url = writeUrl({
    pkgs: entries
      .filter((e) => e.attr !== undefined)
      .map((e) => ({ attr: e.attr, version: e.version })),
    paths: entries
      .filter((e) => e.attr === undefined)
      .map((e) => e.storePath ?? e.digest),
  });
  history.replaceState(null, "", url);
}

// The debug pane mirrors the log as it is written.
onLog((lines) => {
  debugLog.textContent = lines.join("\n");
  debugLog.scrollTop = debugLog.scrollHeight;
});

const entryOf = (version) => ({
  digest: version.digest,
  label: `${version.attr} ${version.version}`,
  attr: version.attr,
  version: version.version,
  storePath: version.storePath,
});

// ---------- the three lanes ----------

new PackagePicker({
  input: document.getElementById("search"),
  results: document.getElementById("search-results"),
  onPick: (version) => select(entryOf(version)),
});

rangesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  rangesResults.replaceChildren();

  let specs;
  try {
    specs = parseSpecs(rangesInput.value);
  } catch (err) {
    rangesResults.textContent = String(err);
    return;
  }

  const { resolved, problems } = await resolveSpecs(specs);
  for (const version of resolved) {
    select(entryOf(version));
  }

  const lines = [
    ...resolved.map((v) => `${v.attr} ${v.version}`),
    ...problems.map((p) => `unresolved: ${p}`),
  ];
  rangesResults.textContent = lines.join(" · ");
});

// Autocomplete for the range box, and a live grail link for the line —
// grail answers the coexistence question this lane deliberately does
// not.
const grailLink = document.getElementById("grail-link");
const GRAIL_URL = "https://fzakaria.github.io/grail/";

function renderGrailLink() {
  const query = rangesInput.value.trim();
  grailLink.replaceChildren();
  if (query === "") {
    return;
  }
  const link = document.createElement("a");
  link.href = `${GRAIL_URL}?q=${encodeURIComponent(query)}`;
  link.textContent = "solve this line in grail";
  link.rel = "noopener";
  link.target = "_blank";
  grailLink.append("Want these versions to have coexisted? ", link);
}

new RangeComplete({
  input: rangesInput,
  dropdown: document.getElementById("ranges-complete"),
  onAccept: renderGrailLink,
});
rangesInput.addEventListener("input", renderGrailLink);

walkForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const raw = storePathInput.value.trim();
  const digest = digestFromPath(raw);
  if (digest === null) {
    status.textContent = `need a store path with its ${DIGEST_LENGTH}-character digest`;
    return;
  }
  select({
    digest,
    label: raw.startsWith(STORE_PREFIX) ? raw.slice(STORE_PREFIX.length) : raw,
    storePath: raw.startsWith(STORE_PREFIX) ? raw : undefined,
  });
  storePathInput.value = "";
});

// The cache list: extra substituters and their keys, kept per reader.
const cachesInput = document.getElementById("caches-input");
const cachesStatus = document.getElementById("caches-status");
cachesInput.value = readSubstituters()
  .slice(DEFAULT_SUBSTITUTERS.length)
  .map((s) => `${s.url} ${s.key}`)
  .join("\n");

document.getElementById("caches-save").addEventListener("click", () => {
  try {
    writeSubstituters(parseSubstituters(cachesInput.value));
    cachesStatus.textContent = "saved";
  } catch (err) {
    cachesStatus.textContent = String(err);
  }
});

// The lane tabs: anchors so each is a real link, one visible at a time.
const laneNav = document.getElementById("lanes");
laneNav.addEventListener("click", (event) => {
  const tab = event.target.closest("a[data-lane]");
  if (tab === null) {
    return;
  }
  event.preventDefault();
  for (const link of laneNav.querySelectorAll("a[data-lane]")) {
    link.classList.toggle("active", link === tab);
  }
  for (const lane of document.querySelectorAll(".lane[data-lane]")) {
    lane.hidden = lane.dataset.lane !== tab.dataset.lane;
  }
});

// ---------- the boot ----------

// What the reader selected, each with the `bin` output of a package
// that keeps its programs in one. Booting jq means booting jq.out *and*
// jq.bin: the two are separate store paths and neither references the
// other. Returns [{ digest, bin }], bin null when there is no such
// sibling.
async function rootsOf(digests) {
  const roots = [];
  for (const digest of digests) {
    const bin = await binOutputOf(digest);
    roots.push({ digest, bin: bin === digest ? null : bin });
  }
  return roots;
}

// Every store path the roots name, selection order, no duplicates.
function digestsOf(roots) {
  const digests = [];
  for (const { digest, bin } of roots) {
    for (const d of [digest, bin]) {
      if (d !== null && !digests.includes(d)) {
        digests.push(d);
      }
    }
  }
  return digests;
}

// Basenames of the digests the closure knows, in the order given.
function basenamesOf(closure, digests) {
  return digests
    .map((digest) => closure.get(digest))
    .filter((info) => info !== undefined)
    .map(basenameOf);
}

// Say which selections put nothing on PATH. A root is silent when
// neither it nor its bin sibling offers a program: nixpkgs splits many
// packages so the binaries live in a separate output, the index
// publishes the default one, and the sibling map does not know every
// split.
function reportSilent(vm, closure, roots) {
  const silent = roots
    .filter(({ digest, bin }) =>
      basenamesOf(
        closure,
        [digest, bin].filter((d) => d !== null),
      ).every((basename) => vm.programsOf(basename).length === 0),
    )
    .map(({ digest }) => basenamesOf(closure, [digest])[0] ?? digest);
  if (silent.length === 0) {
    return;
  }
  status.textContent =
    `no programs in ${silent.join(", ")} — nixpkgs splits some packages so ` +
    `their binaries live in a separate output, and the index publishes the default one`;
}

// The union of every selected root's runtime closure, in one map. Roots
// that share a glibc fetch it once.
async function walkRoots(digests, onProgress, known = new Map()) {
  const closure = new Map(known);
  for (const digest of digests) {
    const one = await walkClosure(
      digest,
      (n) => onProgress(closure.size + n),
      closure,
    );
    for (const [key, info] of one) {
      closure.set(key, info);
    }
  }
  // Only what this walk added; the caller already has the rest.
  for (const key of known.keys()) {
    closure.delete(key);
  }
  return closure;
}

// The closure as a table, largest unpacked size first.
function renderClosure(closure) {
  const infos = [...closure.values()].sort((a, b) => b.narSize - a.narSize);

  const table = document.createElement("table");
  const head = table.insertRow();
  for (const [label, cls] of [
    ["store path", "path"],
    ["download", "size"],
    ["unpacked", "size"],
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    th.className = cls;
    head.append(th);
  }

  for (const info of infos) {
    const row = table.insertRow();
    for (const [text, cls] of [
      [info.storePath, "path"],
      [humanBytes(info.fileSize), "size"],
      [humanBytes(info.narSize), "size"],
    ]) {
      const td = row.insertCell();
      td.textContent = text;
      td.className = cls;
    }
  }

  result.replaceChildren(table);
}

// A booted VM cannot be replaced in place: the emscripten module owns
// its worker pool and linear memory for the life of the page. So a
// second boot restarts the page instead, at a URL that describes the
// new selection and asks for it to start straight away.
let vmStarted = false;
let vm = null;
// Everything the running guest already has, so a later addition only
// fetches what is new.
let mounted = new Map();

function reboot() {
  const entries = [...selection.values()];
  location.href = writeUrl(
    {
      pkgs: entries
        .filter((e) => e.attr !== undefined)
        .map((e) => ({ attr: e.attr, version: e.version })),
      paths: entries
        .filter((e) => e.attr === undefined)
        .map((e) => e.storePath ?? e.digest),
    },
    { boot: true },
  );
  location.reload();
}

// The boot flow. The engine, the guest image, the snapshot and the
// closure download in parallel under one progress panel; the engine
// is instantiated the moment its inputs are in, and every NAR is
// written into the share as it lands, while the rest are still on
// their way. When the last one is in, QEMU is released and the
// terminal goes live.
async function boot() {
  bootSection.hidden = false;
  bootButton.disabled = true;
  consoleVeil.hidden = false;
  consoleNote.textContent = "fetching…";
  const panel = new ProgressPanel(bootProgress);

  const walkRow = panel.row("closure walk");
  const signatureRow = panel.row("signatures");
  const engineRow = panel.row("qemu engine");
  const guestRow = panel.row("guest image");
  const snapshotRow = panel.row("snapshot");
  const closureRow = panel.row("closure");
  const vmRow = panel.row("virtual machine");

  try {
    const roots = await rootsOf([...selection.keys()]);
    const rootDigests = digestsOf(roots);
    const closure = await walkRoots(rootDigests, (n) =>
      walkRow.note(`${n} narinfos`),
    );
    log(`closure: ${closure.size} paths from ${rootDigests.length} roots`);
    walkRow.done(`${closure.size} paths`);
    renderClosure(closure);

    // Signatures are checked against the configured keys. A path no key
    // vouches for is still booted — the reader chose the cache — but
    // the count is reported rather than hidden.
    const substituters = readSubstituters();
    const verdicts = await Promise.all(
      [...closure.values()].map((i) => verify(i, substituters)),
    );
    const unverifiable = verdicts.filter((v) => v === null).length;
    const unsigned = verdicts.filter((v) => v === false).length;
    if (unverifiable > 0) {
      signatureRow.done("this browser cannot check Ed25519");
    } else if (unsigned > 0) {
      signatureRow.fail(
        `${unsigned} of ${closure.size} unsigned by a known key`,
      );
    } else {
      signatureRow.done(`${closure.size} verified`);
    }

    const engineUrls = await assets([QEMU_MAIN, QEMU_WASM, QEMU_WORKER]);
    const engine = {
      main: engineUrls.get(QEMU_MAIN),
      // emscripten asks for files by bare name; hand back the
      // versioned URL when there is one.
      locate: (file) => engineUrls.get(`qemu/${file}`) ?? `qemu/${file}`,
    };

    // The wasm is not held by the page: the engine streams it from
    // the URL and the browser compiles it as it arrives (net.js says
    // why). This download only fills the HTTP cache, and the bar.
    const enginePromise = warmHttpCache(engineUrls.get(QEMU_WASM), {
      onTotal: (n) => engineRow.setTotal(n),
      onBytes: (n) => engineRow.add(n),
    }).then(() => engineRow.done());

    const guestPromise = Promise.all(
      GUEST_FILES.map(async (name) => [
        name,
        await fetchWithProgress(await asset(`guest/${name}`), {
          onBytes: (n) => guestRow.add(n),
        }),
      ]),
    ).then((entries) => {
      guestRow.done();
      return new Map(entries);
    });

    // The snapshot is optional: published, a visit resumes a guest that
    // is already up; absent, the same arguments cold-boot.
    const snapshotPromise = fetchWithProgress(await asset(SNAPSHOT_URL), {
      onTotal: (n) => snapshotRow.setTotal(n),
      onBytes: (n) => snapshotRow.add(n),
    }).then(
      (bytes) => {
        snapshotRow.done();
        return bytes;
      },
      () => {
        snapshotRow.done("none published — cold boot");
        return null;
      },
    );

    // The engine starts as soon as its own inputs are in, without
    // waiting for the closure; the guest files and the snapshot are
    // handed over rather than kept.
    let resuming = false;
    const vmPromise = Promise.all([
      enginePromise,
      guestPromise,
      snapshotPromise,
    ]).then(([, guestFiles, snapshot]) => {
      resuming = snapshot !== null;
      log(
        snapshot === null
          ? "no snapshot; the guest will cold boot"
          : "engine instantiated; the guest will resume from the snapshot",
      );
      return startVM({ guestFiles, snapshot, terminalElement, engine });
    });

    // Each NAR goes into the share the moment it is parsed, and is
    // dropped from the page's hands right after. Nothing here ever
    // holds more than the few NARs in flight.
    const infos = [...closure.values()];
    closureRow.setTotal(infos.reduce((sum, i) => sum + i.fileSize, 0));
    const closurePromise = mapConcurrent(
      infos,
      NAR_CONCURRENCY,
      async (info) => {
        const entries = await fetchNar(info, (n) => closureRow.add(n));
        const vm = await vmPromise;
        vm.share.write(basenameOf(info), entries);
      },
    ).then(() => closureRow.done());

    vm = await vmPromise;
    await closurePromise;

    consoleNote.textContent = resuming
      ? "resuming the guest…"
      : "booting the guest…";
    vmRow.note("running");
    vmStarted = true;
    mounted = closure;

    const ready = vm.run(basenamesOf(closure, rootDigests));
    log("virtual machine running");
    reportSilent(vm, closure, roots);
    bootButton.textContent = "Add to the running VM";
    rebootLink.hidden = false;
    addNote.hidden = false;
    bootButton.disabled = false;

    await ready;
    log("guest at its prompt");
    vmRow.done("running");
    consoleVeil.hidden = true;
  } catch (err) {
    log(`boot failed: ${err.message}`);
    vmRow.fail(String(err));
    status.textContent = `${err} — see the debug log`;
    document.getElementById("debug").open = true;
    bootButton.disabled = false;
  }
}

bootButton.addEventListener("click", () => {
  if (vmStarted) {
    addToRunningVM();
    return;
  }
  boot();
});

rebootLink.addEventListener("click", (event) => {
  event.preventDefault();
  reboot();
});

// Add whatever is selected to the guest that is already running.
//
// Nothing is rebooted and nothing is typed at the guest: the share is
// a directory in the emscripten filesystem, 9p passes the guest's
// lookups straight through to it, and the programs land as links in
// the one directory the guest already has on PATH. Only paths it does
// not already have are fetched.
async function addToRunningVM() {
  bootButton.disabled = true;
  const panel = new ProgressPanel(bootProgress);
  const row = panel.row("adding");

  try {
    const roots = await rootsOf([...selection.keys()]);
    const rootDigests = digestsOf(roots);
    const fresh = await walkRoots(
      rootDigests,
      (n) => row.note(`${n} narinfos`),
      mounted,
    );
    if (fresh.size === 0) {
      row.done("already there");
      bootButton.disabled = false;
      return;
    }

    const infos = [...fresh.values()];
    row.setTotal(infos.reduce((sum, i) => sum + i.fileSize, 0));
    const unpacked = await mapConcurrent(
      infos,
      NAR_CONCURRENCY,
      async (info) => ({
        basename: basenameOf(info),
        entries: await fetchNar(info, (n) => row.add(n)),
      }),
    );

    for (const [digest, info] of fresh) {
      mounted.set(digest, info);
    }
    vm.add(unpacked, basenamesOf(mounted, rootDigests));
    reportSilent(vm, mounted, roots);
    row.done(`${fresh.size} paths added`);
    renderClosure(mounted);
  } catch (err) {
    row.fail(String(err));
  } finally {
    bootButton.disabled = false;
  }
}

// ---------- restoring a shared link ----------

// A package named without a version means "whatever the index has
// newest", which is what makes ?pkg=ripgrep a durable link.
async function restore({ pkgs, paths }) {
  for (const path of paths) {
    const digest = digestFromPath(path);
    if (digest !== null) {
      select({
        digest,
        label: path.startsWith(STORE_PREFIX)
          ? path.slice(STORE_PREFIX.length)
          : path,
        storePath: path.startsWith(STORE_PREFIX) ? path : undefined,
      });
    }
  }

  for (const { attr, version } of pkgs) {
    const versions = await versionsOf(attr);
    const hit =
      version === null
        ? versions.find((v) => v.alive !== false)
        : versions.find((v) => v.version === version);
    if (hit === undefined) {
      status.textContent = `${attr}${version === null ? "" : ` ${version}`} is not in the index`;
      continue;
    }
    select(entryOf(hit));
  }
}

// Warm the cache while the reader is still choosing. The engine, the
// guest image and the snapshot are the same bytes for every boot and
// none of them depend on the selection, so they can be on their way
// before anything is picked. A second visit has them already, and the
// boot's own fetches then find everything in the cache and finish
// instantly. Failures are ignored: this is an optimisation, and the
// boot does its own fetching either way.
async function prefetch() {
  const warm = async (path, fetcher) => {
    try {
      await fetcher(await asset(path));
    } catch {
      // an optimisation that failed is not an error
    }
  };
  // The wasm goes to the HTTP cache, where the engine's own fetch
  // finds it; the rest to the Cache API, where the page's do.
  warm(QEMU_WASM, warmHttpCache);
  warm(SNAPSHOT_URL, fetchWithProgress);
  for (const name of GUEST_FILES) {
    warm(`guest/${name}`, fetchWithProgress);
  }
}

const initial = readUrl();

// Not while a boot is already starting. A reboot lands on ?boot=1 and
// the boot fetches these itself; racing it only doubles ~75 MB of
// engine and snapshot in flight, which is enough to make a fetch fail
// outright on a tab that is already holding a closure in memory.
//
// requestIdleCallback keeps the rest off the critical path on a slow
// device; not every browser has it.
if (!initial.boot) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(prefetch);
  } else {
    setTimeout(prefetch, 0);
  }
}
render();
if (initial.pkgs.length > 0 || initial.paths.length > 0) {
  restore(initial).then(() => {
    if (initial.boot && selection.size > 0) {
      boot();
    }
  });
}

// The site build substitutes the derivation's own $out into STORE_PATH, so
// the footer names the store path serving the page. A local checkout still
// carries the placeholder, and the line stays hidden.
const STORE_PATH = "__STORE_PATH__";
if (!STORE_PATH.startsWith("__")) {
  document.getElementById("store-path-footer").textContent = STORE_PATH;
  document.getElementById("store").hidden = false;
}
