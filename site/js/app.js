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
import { readUrl, writeUrl } from "./url.js";
import { humanBytes } from "./format.js";
import {
  DIGEST_LENGTH,
  DIGEST_PATTERN,
  GUEST_FILES,
  NAR_CONCURRENCY,
  QEMU_WASM,
} from "./config.js";

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

// The shell fragment the guest init sources: every chosen root's bin
// directory on PATH, and every path in the closure on LD_LIBRARY_PATH.
//
// The library path is not redundant with the binaries' own RPATHs. A
// Rust binary reaches libgcc_s.so.1 through the unwinder's dlopen
// rather than a DT_NEEDED entry, so nothing in the executable names the
// directory holding it and the loader falls back to a system path this
// guest does not have. Naming the whole closure costs a longer variable
// and fixes that class of failure outright.
function buildManifest(closure, rootDigests) {
  const path = rootDigests
    .filter((digest) => closure.has(digest))
    .map((digest) => `/nix/store/${basenameOf(closure.get(digest))}/bin`)
    .join(":");

  const libraryPath = [...closure.values()]
    .map((info) => `${info.storePath}/lib`)
    .join(":");

  return `export PATH="${path}:$PATH"\nexport LD_LIBRARY_PATH="${libraryPath}"\n`;
}

// The union of every selected root's runtime closure, in one map. Roots
// that share a glibc fetch it once.
async function walkRoots(digests, onProgress) {
  const closure = new Map();
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
  const panel = new ProgressPanel(bootProgress);

  const walkRow = panel.row("closure walk");
  const engineRow = panel.row("qemu engine");
  const guestRow = panel.row("guest image");
  const closureRow = panel.row("closure");
  const vmRow = panel.row("virtual machine");

  try {
    const rootDigests = [...selection.keys()];
    const closure = await walkRoots(rootDigests, (n) =>
      walkRow.note(`${n} narinfos`),
    );
    walkRow.done(`${closure.size} paths`);
    renderClosure(closure);

    const enginePromise = fetchWithProgress(QEMU_WASM, {
      onTotal: (n) => engineRow.setTotal(n),
      onBytes: (n) => engineRow.add(n),
    }).then((bytes) => {
      engineRow.done();
      return bytes;
    });

    const guestPromise = Promise.all(
      GUEST_FILES.map(async (name) => [
        name,
        await fetchWithProgress(`guest/${name}`, {
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

    const [wasmBytes, guestFiles, closurePaths] = await Promise.all([
      enginePromise,
      guestPromise,
      closurePromise,
    ]);

    await bootVM({
      wasmBinary: wasmBytes.buffer,
      guestFiles,
      closure: closurePaths,
      manifest: buildManifest(closure, rootDigests),
      terminalElement,
    });
    vmRow.done("running");
    vmStarted = true;
    bootButton.textContent = "Reboot";
    bootButton.disabled = false;
  } catch (err) {
    vmRow.fail(String(err));
    status.textContent = String(err);
    bootButton.disabled = false;
  }
}

bootButton.addEventListener("click", () => {
  if (vmStarted) {
    reboot();
    return;
  }
  boot();
});

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

const initial = readUrl();
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
