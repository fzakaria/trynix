// Page wiring: choose packages out of the nixpkgs-multiverse index —
// by search, by version range, or by raw store path — walk the union of
// their runtime closures live from cache.nixos.org, then boot.
// qemu-wasm runs an x86_64 guest in the tab, the closure rides in over
// virtio-9p, and the serial console lands in the terminal.
// docs/design.md holds the architecture.

import { walkClosure } from "./closure.js";
import { fetchNar } from "./store.js";
import { bootVM } from "./boot.js";
import { fetchWithProgress, mapConcurrent } from "./net.js";
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

// The shell fragment the guest init sources. PATH, and deliberately
// nothing else.
//
// An LD_LIBRARY_PATH covering the closure looks helpful and is
// actively harmful here. Every nix binary already names its own
// interpreter in PT_INTERP and its own libraries in DT_RUNPATH, by
// absolute store path — that is what makes two eras able to share a
// machine at all. But the loader searches LD_LIBRARY_PATH *before*
// DT_RUNPATH, so setting it overrides all of that and hands each
// binary whichever copy of a library happens to come first.
//
// Booting ripgrep beside lolcat is where that shows: their closures
// carry glibc 2.42 and 2.30, and the mix died on
// "ld-linux-x86-64.so.2: version `GLIBC_2.35' not found (required by
// glibc-2.42/libc.so.6)" — the older loader, handed the newer libc.
// With nothing set, each binary loads its own and they coexist.
function buildManifest(closure, rootDigests, unpacked) {
  const dirs = binAndLibDirs(closure, rootDigests, unpacked);
  return `export PATH="${dirs.bin.join(":")}:$PATH"\n`;
}

// Selected digests, plus the `bin` output of any package that keeps
// its programs in one. Booting jq means booting jq.out *and* jq.bin:
// the two are separate store paths and neither references the other.
async function withBinOutputs(digests) {
  const roots = [...digests];
  for (const digest of digests) {
    const bin = await binOutputOf(digest);
    if (bin !== null && !roots.includes(bin)) {
      roots.push(bin);
    }
  }
  return roots;
}

// Which directories a closure actually has, as guest paths.
//
// Only directories that exist may be named. A missing one is not
// harmlessly skipped the way it would be on a normal filesystem: the
// engine's 9p answers a lookup of something absent with ENOENT only
// because patches/ makes it: without that patch it answers with
// emscripten's WASI numbering, which the guest reads as ECHRNG, and
// the dynamic loader gives up on the whole search.
//
// PATH leads with the selected roots so that what the reader asked for
// wins a collision, then everything else in the closure — a package
// whose programs live in a dependency still works.
function binAndLibDirs(closure, rootDigests, unpacked) {
  const byBasename = new Map(unpacked.map((p) => [p.basename, p]));
  const has = (basename, directory) =>
    byBasename
      .get(basename)
      ?.entries.some(
        (entry) => entry.path === directory && entry.type === "directory",
      ) ?? false;

  const guestPath = (basename, directory) =>
    `/nix/store/${basename}/${directory}`;
  const basenames = (digests) =>
    digests
      .map((digest) => closure.get(digest))
      .filter((info) => info !== undefined)
      .map(basenameOf);

  const roots = basenames(rootDigests);
  const rest = basenames([...closure.keys()]).filter((b) => !roots.includes(b));

  return {
    bin: [...roots, ...rest]
      .filter((b) => has(b, "bin"))
      .map((b) => guestPath(b, "bin")),
    // Roots that ship no programs of their own: nixpkgs splits many
    // packages so the binaries live in a separate output, and the
    // index publishes the default one.
    silentRoots: roots.filter((b) => !has(b, "bin")),
  };
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

// The boot flow: engine, guest image and closure download in parallel
// under one progress panel, then the VM starts and the terminal is live.
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
    const rootDigests = await withBinOutputs([...selection.keys()]);
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

    const enginePromise = fetchWithProgress(engineUrls.get(QEMU_WASM), {
      onTotal: (n) => engineRow.setTotal(n),
      onBytes: (n) => engineRow.add(n),
    }).then((bytes) => {
      engineRow.done();
      return bytes;
    });

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

    const infos = [...closure.values()];
    closureRow.setTotal(infos.reduce((sum, i) => sum + i.fileSize, 0));
    const closurePromise = mapConcurrent(
      infos,
      NAR_CONCURRENCY,
      async (info) => ({
        basename: basenameOf(info),
        entries: await fetchNar(info, (n) => closureRow.add(n)),
      }),
    ).then((paths) => {
      closureRow.done();
      return paths;
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

    const [wasmBytes, guestFiles, closurePaths, snapshot] = await Promise.all([
      enginePromise,
      guestPromise,
      closurePromise,
      snapshotPromise,
    ]);

    const silent = binAndLibDirs(
      closure,
      rootDigests,
      closurePaths,
    ).silentRoots;
    if (silent.length > 0) {
      status.textContent =
        `no programs in ${silent.join(", ")} — nixpkgs splits some packages so ` +
        `their binaries live in a separate output, and the index publishes the default one`;
    }

    log(
      snapshot === null
        ? "no snapshot; cold booting"
        : "resuming from the snapshot",
    );
    consoleNote.textContent =
      snapshot === null ? "booting the guest…" : "resuming the guest…";
    // bootVM consumes closurePaths as it writes them, and the engine
    // and snapshot buffers are handed over rather than kept: between
    // them they are the largest things this page ever holds.
    vm = await bootVM({
      wasmBinary: wasmBytes.buffer,
      guestFiles,
      closure: closurePaths,
      manifest: buildManifest(closure, rootDigests, closurePaths),
      terminalElement,
      engine,
      snapshot,
      onReady: () => {
        consoleVeil.hidden = true;
      },
    });
    log("virtual machine running");
    vmRow.done("running");
    vmStarted = true;
    mounted = closure;
    bootButton.textContent = "Add to the running VM";
    rebootLink.hidden = false;
    addNote.hidden = false;
    bootButton.disabled = false;
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
// Nothing is rebooted: the share is a directory in the emscripten
// filesystem, and 9p passes the guest's lookups straight through to
// it, so a store path written now is a store path the guest can run a
// moment later. Only paths it does not already have are fetched.
async function addToRunningVM() {
  bootButton.disabled = true;
  const panel = new ProgressPanel(bootProgress);
  const row = panel.row("adding");

  try {
    const rootDigests = await withBinOutputs([...selection.keys()]);
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

    const merged = new Map([...mounted, ...fresh]);
    const dirs = binAndLibDirs(merged, rootDigests, unpacked);
    if (dirs.silentRoots.length > 0) {
      status.textContent = `no programs in ${dirs.silentRoots.join(", ")}`;
    }

    vm.addPaths(unpacked, dirs.bin);
    for (const [digest, info] of fresh) {
      mounted.set(digest, info);
    }
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
  const warm = async (path) => {
    try {
      await fetchWithProgress(await asset(path));
    } catch {
      // an optimisation that failed is not an error
    }
  };
  warm(QEMU_WASM);
  warm(SNAPSHOT_URL);
  for (const name of GUEST_FILES) {
    warm(`guest/${name}`);
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
