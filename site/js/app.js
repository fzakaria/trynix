// Page wiring: choose packages out of the nixpkgs-multiverse index —
// by search, by version range, or by raw store path — walk the union of
// their runtime closures live from cache.nixos.org, then boot.
// One of two engines runs the guest in the tab (engine.js): unkernel,
// a Linux kernel compiled to wasm that runs aarch64 programs, or
// qemu-wasm, which emulates an x86_64 machine. Either way the closure
// rides in over 9p and the guest's console lands in the terminal.
// docs/design.md holds the architecture.

import {
  AnalyticsEvent,
  BootMode,
  LoadOperation,
  LoadStage,
  ResolutionOutcome,
  SelectionMethod,
  createLoadTelemetry,
  track,
} from "./analytics.js";
import { reachable, walkClosure } from "./closure.js";
import { fetchNar } from "./store.js";
import { lazyStore, Priority, References } from "./lazy.js";
import {
  fetchListing,
  forgetListing,
  listingFetcher,
  programsOfListing,
} from "./listing.js";
import { startVM } from "./boot.js";
import { startUnkernel } from "./unkernel.js";
import { fullScreenButton } from "./frame.js";
import { resizeGrip } from "./grip.js";
import { wireHints } from "./hints.js";
import {
  activityStrip,
  commandJob,
  commandProgram,
  enteredLine,
  opensWindows,
  typedLines,
} from "./activity.js";
import {
  DEFAULT_ENGINE,
  Engine,
  foreignSystem,
  engineFor,
  hasJspi,
} from "./engine.js";
import { fetchWithProgress, mapConcurrent, warmHttpCache } from "./net.js";
import { ProgressPanel } from "./progress.js";
import { PackagePicker } from "./search.js";
import { parseSpecs, resolveSpecs } from "./ranges.js";
import {
  bootable,
  identify,
  multiverseUrl,
  searchAttrs,
  versionRowsOf,
  versionsOf,
} from "./multiverse.js";
import { registerTools } from "./webmcp.js";
import { RangeComplete } from "./complete.js";
import { readUrl, whileRestoring, writeUrl } from "./url.js";
import { isolationOf, LinkBoot, linkBootOf } from "./isolation.js";
import {
  holdsPath,
  NOT_FOUND,
  parseSubstituters,
  readSubstituters,
  setExtraSubstituters,
  verify,
} from "./substituters.js";
import { humanBytes } from "./format.js";
import {
  DIGEST_LENGTH,
  DIGEST_PATTERN,
  ENGINE,
  FETCH_CONCURRENCY,
  ENGINE_NAMED,
  GUEST_FILES,
  MACHINE_URL,
  NAR_CONCURRENCY,
  QEMU_MAIN,
  QEMU_WASM,
  QEMU_WORKER,
  SNAPSHOT_URL,
  SYSTEM,
  UNKERNEL_GL,
  UNKERNEL_KERNEL,
  UNKERNEL_MAIN,
} from "./config.js";
import { asset, assets, manifest } from "./assets.js";
import { buildReport } from "./report.js";
import { binOutputOf } from "./outputs.js";
import { log, onLog } from "./log.js";
import { pause } from "./console.js";
import {
  fallbacksBelow,
  MEMORY_SIZES_MIB,
  memoryLabel,
  pickMemory,
  thisDevice,
} from "./memory.js";
import {
  MAX_CPUS,
  offeredCpus,
  pickCpus,
  thisDevice as cpuDevice,
} from "./cpus.js";
import {
  chooseDriver,
  DriverChoice,
  driverNote,
  isGlDriverPath,
  publishedDrivers,
} from "./gldriver.js";
import { chooseX11Server, X11_SERVER_ATTR, X11Choice, x11Note } from "./x11.js";
import { shellNote } from "./gui.js";
import { Downloads, pickDownloads } from "./downloads.js";
import {
  DEFAULT_RELAY,
  Network,
  netSpec,
  pickNetwork,
  relayOf,
} from "./network.js";
import { Sound } from "./sound.js";
import { rootRecord } from "./roots.js";

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
const keyBarElement = document.getElementById("keybar");
const consoleElement = document.getElementById("console");
const desktopElement = document.getElementById("desktop");
const soundControl = document.getElementById("sound-control");
const windowsButton = document.getElementById("console-windows");
const fullScreenElement = document.getElementById("console-fullscreen");
const consoleVeil = document.getElementById("console-veil");
const consoleNote = document.getElementById("console-note");
const consoleSpinner = document.getElementById("console-spinner");
const rebootLink = document.getElementById("reboot-link");
const debugLog = document.getElementById("debug-log");
const addNote = document.getElementById("add-note");
const guestChoice = document.getElementById("guest");
const guestStatus = document.getElementById("guest-status");
const memorySizes = document.getElementById("memory-sizes");
const memoryStatus = document.getElementById("memory-status");
const cpuCounts = document.getElementById("cpu-counts");
const cpuStatus = document.getElementById("cpu-status");
const downloadsChoice = document.getElementById("downloads");
const downloadsStatus = document.getElementById("downloads-status");
const networkChoice = document.getElementById("network");
const networkRelay = document.getElementById("network-relay");
const networkStatus = document.getElementById("network-status");
const consoleTty = document.getElementById("console-tty");

// What the console veil says once a boot has failed, in place of the
// progress it was reporting.
const BOOT_FAILED_NOTE = "boot failed";

// The selection: digest -> { digest, label, attr, version, storePath }.
// A package chosen any of the three ways lands here in the same shape,
// which is what lets the URL describe all of them.
//
// Two fields are filled in afterwards, from the network:
//
//   held   whether a configured cache actually holds the path: true,
//          false, or null while nothing has answered yet
//   named  the (attribute, version) a pasted store path turned out to
//          be, when the index can name it
//
// `held` is the page checking rather than claiming, and the store-path
// lane is why it exists: a pasted digest is whatever the reader typed,
// and no index can say whether a cache serves it. For a version that
// came out of the index the answer is nearly always yes, and it still
// costs nothing, since the boot needs that narinfo anyway.
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

// Clicking a version already in the selection takes it back out. The
// picker offers this on the pill itself, so a misclick is undone where
// it happened rather than down at the chips.
function toggle(entry) {
  if (selection.has(entry.digest)) {
    deselect(entry.digest);
    return;
  }
  select(entry);
}

function select(entry) {
  selection.set(entry.digest, entry);
  // A change to the selection ends a failed link's hold on the address.
  unrestored = null;
  render();
  probe(entry);
  if (entry.attr === undefined) {
    name(entry);
  }
}

// Ask the caches whether they hold this path, and redraw when they
// answer. This is the one failure the page can see coming, so it is
// worth saying while there is still a caches box to paste into, rather
// than three seconds into a walk.
async function probe(entry) {
  const held = await holdsPath(entry.digest, readSubstituters());
  entry.held = held;
  // A selection removed while the fetch was in flight stays removed.
  if (selection.has(entry.digest)) {
    render();
  }
}

// Every path that no cache admitted to having, asked again. Adding a
// cache is exactly the fix for a path cache.nixos.org does not serve,
// so the warning on the chip is re-earned rather than left standing.
function reprobe() {
  for (const entry of selection.values()) {
    if (entry.held !== true) {
      probe(entry);
    }
  }
}

// What a pasted store path is, when the index can say. The multiverse
// publishes a digest-keyed lookup, so 32 opaque characters become an
// attribute, a version, and a link to the page describing them.
async function name(entry) {
  // A path nobody can name is still a path this page can boot, so a
  // lookup that failed goes to the log and leaves the chip as pasted.
  let named;
  try {
    named = await identify(entry.digest);
  } catch (err) {
    log(`naming ${entry.label}: ${err.message}`);
    return;
  }
  if (named === null) {
    return;
  }
  entry.named = named;
  if (selection.has(entry.digest)) {
    render();
  }
}

function deselect(digest) {
  selection.delete(digest);
  notes = [];
  // A change to the selection ends a failed link's hold on the address.
  unrestored = null;
  render();
}

// The extra caches in effect: the page's copy of what the caches box
// under Settings says, and what the link carries.
let extraCaches = [];

// The package picker, once the lanes below have built it. Named here
// because render() marks its pills, and a selection can change before
// the lanes are wired (a shared link restores one).
let picker;

// The link for what is on screen: the selection and the caches.
function urlState() {
  const entries = [...selection.values()];
  return {
    pkgs: entries
      .filter((e) => e.attr !== undefined)
      .map((e) => ({ attr: e.attr, version: e.version })),
    paths: entries
      .filter((e) => e.attr === undefined)
      .map((e) => e.storePath ?? e.digest),
    caches: extraCaches,
  };
}

// The engine a link for `state` has to name, or null when the link
// can leave the engine out.
//
// A store path runs on one engine only, the one whose system the path
// was built for, so a link carrying a store path always says which. A
// link of package names resolves against whichever engine opens the
// link, and names the engine only when the reader's own link did and
// the engine is not the default. An engine the page fell back to for
// this browser stays out, because the next reader's browser may be
// able to run the default.
function linkEngine(state) {
  if (state.paths.length > 0) {
    return ENGINE;
  }
  return ENGINE_NAMED && ENGINE !== DEFAULT_ENGINE ? ENGINE : null;
}

// The memory size the page's link names (url.js, `mem`), or null. A
// size chosen in Settings goes into the link too, so the address bar
// always says what the next boot asks for.
let linkedMemory = readUrl().memory;

// The unkernel guest's memory for the next boot (memory.js): the link's
// size, else the device's default.
const device = thisDevice();
let memory = pickMemory({ linked: linkedMemory, device });

// The CPU count the page's link names (url.js, `cpus`), or null, and
// the count for the next boot (cpus.js), chosen the way memory is.
let linkedCpus = readUrl().cpus;
const cpuHost = cpuDevice(device);
let cpus = pickCpus({ linked: linkedCpus, device: cpuHost });

// When the next boot downloads its closure (downloads.js, url.js
// `fetch`): the link's choice, else on first use. A choice made in
// Settings goes into the link, as the memory does.
let linkedDownloads = readUrl().downloads;
let downloads = pickDownloads({ linked: linkedDownloads, engine: ENGINE });

// The command the page's link types at the shell once the guest is up
// (url.js, `run`), or null. The link keeps it, so a copied link shows
// the next reader the same thing; without boot=1 that link still waits
// for the Boot button.
const linkedRun = readUrl().run;

// Whether the next boot has a network, and through which Wisp relay
// (network.js, url.js `net` and `wisp`): the link's choice and relay,
// else on through unkernel's relay. A choice made in Settings goes into
// the link, as the memory does.
let linkedNetwork = readUrl().network;
let linkedRelay = readUrl().relay;
let network = pickNetwork({
  linked: linkedNetwork,
  linkedRelay,
  engine: ENGINE,
});

// The guest's sound switch (sound.js, url.js `sound`): on unless the
// link turns it off. The console bar's switch puts its position in the
// link.
let linkedSound = readUrl().sound;

// The link the page was opened with, while restore() is still looking
// the link's packages up in the index, or null. Until the restore is
// done every link the page writes keeps the opening link's packages
// and paths (url.js, whileRestoring).
let opening = null;

// The link the page was opened with, after a restore that failed, or
// null. The address keeps the link's packages and paths, so a reload
// tries the link again, until the selection changes.
let unrestored = null;

// Whether the boot a link asked for (boot=1) is still to start. The
// address keeps boot=1 until a boot starts, so a reload before then
// boots: the reader's reload, or on a first visit the COOP/COEP shim's.
let linkedBoot = false;

// What the status line says while a link's boot waits for the shim's
// reload (restored, below).
const WAITING_FOR_ISOLATION =
  "the boot waits for the page to reload with cross-origin isolation";

// This load's cross-origin isolation (isolation.js). Read once, before
// the shim's worker can take control of the page, which would not
// isolate this load.
const ISOLATION = isolationOf({
  crossOriginIsolated: globalThis.crossOriginIsolated,
  isSecureContext: globalThis.isSecureContext,
  serviceWorker: globalThis.navigator?.serviceWorker,
});

// The link for what is on screen, as a URL relative to this page.
// `engine` names an engine for the link in place of the one
// linkEngine picks, which is how the guest choice under Settings moves
// the page to the other engine with every other setting kept.
function link({ boot = false, engine = null } = {}) {
  const state = whileRestoring(urlState(), opening ?? unrestored);
  return writeUrl(state, {
    boot: boot || linkedBoot,
    engine: engine ?? linkEngine(state),
    memory: linkedMemory,
    cpus: linkedCpus,
    downloads: linkedDownloads,
    network: linkedNetwork,
    relay: linkedRelay,
    sound: linkedSound,
    run: linkedRun,
  });
}

// What the page has to say about the selection beyond the chips: a
// version a link asked for that the index does not have, or has and
// cannot boot. Kept here rather than written straight to the status
// line because every redraw rewrites that line, and a note about a
// package is still true after the next chip lands. Cleared by the next
// thing the reader does.
let notes = [];

function setNotes(list) {
  notes = list;
  render();
}

// One chip, carrying the same two targets a version pill in the picker
// carries: the label links to what the index says about this package,
// and the x removes it from the selection. A pasted store path the
// index cannot name has nothing to link to, so its label is plain text.
function chipFor(entry) {
  const target =
    entry.attr !== undefined
      ? { attr: entry.attr, version: entry.version }
      : (entry.named ?? null);

  const chip = document.createElement("span");
  chip.className = entry.held === false ? "chip missing" : "chip";

  // A pasted store path the index could name says what it is. The path
  // itself stays in the tooltip either way.
  const text =
    entry.named === undefined
      ? entry.label
      : `${entry.named.attr} ${entry.named.version}`;
  const held = entry.held === false ? `: ${NOT_FOUND}` : "";

  const label = document.createElement(target === null ? "span" : "a");
  label.textContent = `${text}${entry.held === false ? " ⚠" : ""}`;
  label.title = `${entry.storePath ?? entry.digest}${held}`;
  if (target !== null) {
    label.className = "out";
    label.href = multiverseUrl(target);
    label.title =
      `${target.attr} ${target.version ?? ""} on nixmultiverse.com`.trim() +
      `. ${entry.storePath ?? entry.digest}${held}`;
    label.rel = "noopener";
    label.target = "_blank";
  }

  const drop = document.createElement("button");
  drop.type = "button";
  drop.className = "drop";
  drop.textContent = "✕";
  drop.title = `remove ${text}`;
  drop.ariaLabel = `remove ${text} from the selection`;
  drop.onclick = () => deselect(entry.digest);

  chip.append(label, drop);
  return chip;
}

// Selected paths that a configured cache answered for and none holds.
// A path whose probe is still in flight, or whose caches could not be
// reached, is not among them: neither proves the boot fails.
function unheld() {
  return [...selection.values()].filter((e) => e.held === false);
}

// Why a selection with unheld paths cannot boot, for the status line
// and for an agent's boot call.
function missingNote(missing) {
  return `${NOT_FOUND}: ${missing.map((e) => e.label).join(", ")}`;
}

// The button offers a boot only when there is something to boot and no
// cache has said it lacks any of it. One missing path fails the whole
// closure walk. Adding a cache reprobes, and removing the chip redraws,
// so either fix turns the button back on.
function refreshBootButton() {
  bootButton.disabled = selection.size === 0 || unheld().length > 0;
}

// The chips, the status line, and the address bar all describe the same
// selection, so they are redrawn together.
function render() {
  const entries = [...selection.values()];

  selectionElement.replaceChildren(...entries.map(chipFor));
  // The pills in the search list say which versions are chosen, and a
  // version can leave the selection by its chip as well as by its pill.
  picker?.refresh();

  refreshBootButton();

  // A path no cache holds is the one thing worth repeating on every
  // redraw, next to the button it disables.
  const missing = unheld();
  const lines = [...notes];
  if (entries.length === 0) {
    lines.push("nothing selected yet");
  }
  if (missing.length > 0) {
    lines.push(missingNote(missing));
  }
  status.textContent = lines.join(" · ");

  // A package with an attribute is shareable by name; a raw store path
  // rides as a path, and the caches ride along. Either way the link
  // reproduces this screen.
  history.replaceState(null, "", link());
}

// The guest choice under Settings: the architecture this page boots
// and the engine that runs it, which are one choice because each engine
// runs one architecture (engine.js).
//
// Choosing reloads the page at a link that names the choice, because
// the engine is fixed for the life of the page (config.js, ENGINE).
// The link keeps every setting the page's own link carries (memory,
// CPUs, downloads, network, relay, sound, the command to run), so each
// engine applies the ones it supports and a switch there and back loses
// none. Package names resolve again on the other side; a store path
// does not travel, and the boot says so if one is carried across
// (checkSystem).
function wireGuestChoice() {
  const option = (engine) =>
    guestChoice.querySelector(`input[value="${engine}"]`);
  option(ENGINE).checked = true;

  // unkernel cannot run without JSPI, so a browser that lacks it is
  // not offered the choice, and is told why.
  if (!hasJspi()) {
    option(Engine.UNKERNEL).disabled = true;
    guestStatus.hidden = false;
    guestStatus.textContent =
      "This browser cannot suspend WebAssembly (JSPI), which unkernel needs, so only the x86_64 guest runs here. Chrome 137, Firefox 153 and Safari 27 have it.";
  }

  guestChoice.addEventListener("change", (event) => {
    location.href = link({ engine: event.target.value });
  });
}
wireGuestChoice();

// Say under Settings when the guest runs on fewer CPUs than it asked
// for: the browser could not start the CPU threads. Only the unkernel
// guest reports a count.
function reportCpus(vm) {
  const ran = vm.cpus;
  if (ran === undefined || ran === cpus.count) {
    return;
  }
  log(`unkernel: asked for ${cpus.count} CPUs, runs on ${ran}`);
  cpuStatus.textContent = `This guest runs on ${ran} CPU${ran === 1 ? "" : "s"}: the browser could not start ${cpus.count}.`;
}

// The memory choice under Settings: one radio per size memory.js offers,
// the size the next boot will ask for checked. A choice goes into the
// link.
function wireMemoryChoice() {
  for (const mib of MEMORY_SIZES_MIB) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "memory";
    input.value = String(mib);
    input.checked = mib === memory.mib;
    label.append(input, memoryLabel(mib));
    memorySizes.append(label);
  }

  memorySizes.addEventListener("change", (event) => {
    const mib = Number(event.target.value);
    memory = { mib, why: "chosen in Settings" };
    linkedMemory = mib;
    history.replaceState(null, "", link());
    memoryStatus.textContent = vmStarted
      ? `${memoryLabel(mib)} from the next boot; this guest keeps what it booted with`
      : "";
  });
}
wireMemoryChoice();

// The CPU choice under Settings, wired as the memory choice is, with
// the counts this host has the threads for. A page without shared
// memory boots one CPU whatever is chosen, and says so. A link can ask
// for a count Settings does not show, such as 3, or for more than the
// host has threads; the lane says what the guest gets then.
function wireCpuChoice() {
  for (const count of offeredCpus(cpuHost)) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "cpus";
    input.value = String(count);
    input.checked = count === cpus.count;
    input.disabled = !cpuHost.shared && count > 1;
    label.append(input, String(count));
    cpuCounts.append(label);
  }
  if (!cpuHost.shared) {
    cpuStatus.textContent =
      "This page is not cross-origin isolated, so the guest runs on one CPU.";
  } else if (
    linkedCpus !== null &&
    linkedCpus <= MAX_CPUS &&
    cpus.count < linkedCpus
  ) {
    cpuStatus.textContent = `The link asks for ${linkedCpus} CPUs; this browser has ${cpuHost.threads} threads, so the guest gets ${cpus.count}.`;
  }

  cpuCounts.addEventListener("change", (event) => {
    const count = Number(event.target.value);
    cpus = { count, why: "chosen in Settings" };
    linkedCpus = count;
    history.replaceState(null, "", link());
    cpuStatus.textContent = vmStarted
      ? `${count} from the next boot; this guest keeps what it booted with`
      : "";
  });
}
wireCpuChoice();

// The downloads choice under Settings: on first use, or everything
// before the shell starts. A choice goes into the link and takes effect
// at the next boot.
function wireDownloadsChoice() {
  const option = (mode) =>
    downloadsChoice.querySelector(`input[value="${mode}"]`);
  option(downloads.mode).checked = true;

  downloadsChoice.addEventListener("change", (event) => {
    const mode = event.target.value;
    downloads = { mode, why: "chosen in Settings" };
    linkedDownloads = mode;
    history.replaceState(null, "", link());
    downloadsStatus.textContent = vmStarted
      ? "from the next boot; this guest keeps the way it started"
      : "";
  });
}
wireDownloadsChoice();

// The settings only the aarch64 guest has (its memory, CPUs, downloads
// and network) are not shown on the x86_64 guest, which has a fixed
// machine, downloads everything first and has no network device.
const UNKERNEL_ONLY_SETTINGS = [
  memorySizes.closest("fieldset"),
  cpuCounts.closest("fieldset"),
  downloadsChoice,
  networkChoice,
];
if (ENGINE !== Engine.UNKERNEL) {
  for (const setting of UNKERNEL_ONLY_SETTINGS) {
    setting.hidden = true;
  }
}

// The network choice under Settings: on or off, and the relay, empty
// for unkernel's. Both go into the link and take effect at the next
// boot. A relay that is not a ws: or wss: URL is refused, and says so.
// A relay the link names says so, since that relay sees the guest's
// traffic.
function wireNetworkChoice() {
  const option = (mode) =>
    networkChoice.querySelector(`input[name="network"][value="${mode}"]`);
  option(network.mode).checked = true;
  networkRelay.value = linkedRelay ?? "";

  // What the status line says about the relay the link names, if any.
  const relayNote = () =>
    linkedRelay === null
      ? ""
      : `This link sends the guest's network through ${new URL(linkedRelay).host}, not unkernel's relay.`;
  networkStatus.textContent = relayNote();

  // What the status line says once something changed.
  const fromNextBoot = () =>
    [
      relayNote(),
      vmStarted
        ? "From the next boot; this guest keeps the network it booted with."
        : "",
    ]
      .filter(Boolean)
      .join(" ");

  networkChoice.addEventListener("change", (event) => {
    // On or off.
    if (event.target.name === "network") {
      const mode = event.target.value;
      network = { ...network, mode, why: "chosen in Settings" };
      linkedNetwork = mode;
      history.replaceState(null, "", link());
      networkStatus.textContent = fromNextBoot();
      return;
    }
    if (event.target !== networkRelay) {
      return;
    }

    // The relay: empty goes back to unkernel's.
    const text = networkRelay.value.trim();
    if (text === "") {
      linkedRelay = null;
      network = { ...network, relay: DEFAULT_RELAY };
      history.replaceState(null, "", link());
      networkStatus.textContent = fromNextBoot();
      return;
    }
    const relay = relayOf(text);
    if (relay === null) {
      networkStatus.textContent = `Not used: a relay is a ws:// or wss:// URL, and "${text}" is not one.`;
      return;
    }
    linkedRelay = relay;
    network = { ...network, relay };
    history.replaceState(null, "", link());
    networkStatus.textContent = fromNextBoot();
  });
}
wireNetworkChoice();

// The console bar's full-screen button, for the terminal and any GUI
// windows over it, whichever engine boots.
fullScreenButton({ consoleElement, button: fullScreenElement });

// The intro's two phrases with a note under each.
wireHints();

// The grip along the console's bottom edge, which resizes the terminal.
resizeGrip({
  grip: document.getElementById("console-grip"),
  terminal: terminalElement,
});

// The debug pane mirrors the log as it is written.
onLog((lines) => {
  debugLog.textContent = lines.join("\n");
  debugLog.scrollTop = debugLog.scrollHeight;
});

const entryOf = (version, selectionMethod = SelectionMethod.PICKER) => ({
  selectionMethod,
  digest: version.digest,
  label: `${version.attr} ${version.version}`,
  attr: version.attr,
  version: version.version,
  storePath: version.storePath,
});

// ---------- the three lanes ----------

picker = new PackagePicker({
  input: document.getElementById("search"),
  results: document.getElementById("search-results"),
  selected: (version) => selection.has(version.digest),
  onToggle: (version) => {
    notes = [];
    toggle(entryOf(version));
  },
});

rangesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  rangesResults.replaceChildren();
  notes = [];

  // Measure the time spent parsing and resolving package ranges.
  const started = performance.now();
  let specs;
  try {
    specs = parseSpecs(rangesInput.value);
  } catch (err) {
    track(AnalyticsEvent.RANGE, {
      outcome: ResolutionOutcome.FAILED,
      duration_ms: Math.round(performance.now() - started),
    });
    rangesResults.textContent = String(err);
    return;
  }

  let resolution;
  try {
    resolution = await resolveSpecs(specs);
  } catch (err) {
    track(AnalyticsEvent.RANGE, {
      outcome: ResolutionOutcome.FAILED,
      duration_ms: Math.round(performance.now() - started),
    });
    rangesResults.textContent = String(err);
    return;
  }
  const { resolved, problems } = resolution;
  track(AnalyticsEvent.RANGE, {
    outcome:
      problems.length === 0
        ? ResolutionOutcome.SUCCESS
        : resolved.length === 0
          ? ResolutionOutcome.FAILED
          : ResolutionOutcome.PARTIAL,
    duration_ms: Math.round(performance.now() - started),
    package_count: resolved.length,
  });
  for (const version of resolved) {
    select(entryOf(version, SelectionMethod.RANGE));
  }

  const lines = [
    ...resolved.map((v) => `${v.attr} ${v.version}`),
    ...problems.map((p) => `unresolved: ${p}`),
  ];
  rangesResults.textContent = lines.join(" · ");
});

// Autocomplete for the range box, and a live grail link for the line.
// grail answers a question this lane does not ask: whether one moment
// in nixpkgs history satisfied every spec at once, so the versions were
// built against each other.
const grailLink = document.getElementById("grail-link");
grailLink.addEventListener("click", (event) => {
  if (event.target.closest("a") !== null) {
    track(AnalyticsEvent.GRAIL);
  }
});
const GRAIL_URL = "https://fzakaria.github.io/grail/";

function renderGrailLink() {
  const query = rangesInput.value.trim();
  grailLink.replaceChildren();
  if (query === "") {
    return;
  }
  const link = document.createElement("a");
  link.href = `${GRAIL_URL}?q=${encodeURIComponent(query)}`;
  link.textContent = "Check in grail whether these versions ever coexisted";
  link.rel = "noopener";
  link.target = "_blank";
  grailLink.append(link);
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
  notes = [];
  select({
    digest,
    label: raw.startsWith(STORE_PREFIX) ? raw.slice(STORE_PREFIX.length) : raw,
    storePath: raw.startsWith(STORE_PREFIX) ? raw : undefined,
  });
  storePathInput.value = "";
});

// The cache list: extra substituters and their keys. Every edit that
// parses goes straight into the link; one that does not is said so and
// leaves the last good list in effect.
const cachesInput = document.getElementById("caches-input");
const cachesStatus = document.getElementById("caches-status");

function applyCaches(list) {
  extraCaches = list;
  setExtraSubstituters(list);
  cachesInput.value = list.map((s) => `${s.url} ${s.key}`).join("\n");
  render();
}

cachesInput.addEventListener("input", () => {
  try {
    extraCaches = parseSubstituters(cachesInput.value);
    setExtraSubstituters(extraCaches);
    cachesStatus.textContent =
      extraCaches.length === 0 ? "" : "in the link above";
    render();
    reprobe();
  } catch (err) {
    cachesStatus.textContent = String(err);
  }
});

// The lane tabs: anchors so each is a real link, one visible at a time.
const laneNav = document.getElementById("lanes");

// Show the lane named `name` and mark its tab.
function showLane(name) {
  for (const link of laneNav.querySelectorAll("a[data-lane]")) {
    link.classList.toggle("active", link.dataset.lane === name);
  }
  for (const lane of document.querySelectorAll(".lane[data-lane]")) {
    lane.hidden = lane.dataset.lane !== name;
  }
}

laneNav.addEventListener("click", (event) => {
  const tab = event.target.closest("a[data-lane]");
  if (tab === null) {
    return;
  }
  event.preventDefault();
  showLane(tab.dataset.lane);
});

// A progress row's label that links to a setting (FIRST_USE_ROW) opens
// the Settings lane at that setting and marks it for a moment, so the
// reader sees which box the row meant.
const SETTINGS_LANE = "settings";
const FLASH_CLASS = "flash";
bootProgress.addEventListener("click", (event) => {
  const link = event.target.closest('a.label[href^="#"]');
  if (link === null) {
    return;
  }
  event.preventDefault();
  const setting = document.getElementById(link.hash.slice(1));
  if (setting === null) {
    return;
  }
  showLane(SETTINGS_LANE);
  setting.scrollIntoView({ behavior: "smooth", block: "center" });
  setting.classList.remove(FLASH_CLASS);
  // Read layout so the animation restarts on a second click.
  void setting.offsetWidth;
  setting.classList.add(FLASH_CLASS);
});

// ---------- the boot ----------

// What the reader selected, each with the `bin` output of a package
// that keeps its programs in one. Booting jq means booting jq.out *and*
// jq.bin: the two are separate store paths and neither references the
// other. Returns [{ digest, bin }], bin null when there is no such
// sibling, or when the index could not say.
async function rootsOf(digests) {
  const roots = [];
  const unknown = [];
  for (const digest of digests) {
    try {
      const bin = await binOutputOf(digest);
      roots.push({ digest, bin: bin === digest ? null : bin });
    } catch (err) {
      // The boot goes on without a sibling: a path from another cache
      // has none, and an index that is down is no reason to refuse it.
      log(`bin output of ${digest}: ${err.message}`);
      unknown.push(
        `${selection.get(digest)?.label ?? digest} (${err.message})`,
      );
      roots.push({ digest, bin: null });
    }
  }

  // The status line names each package whose programs may be missing.
  if (unknown.length > 0) {
    setNotes([
      ...notes,
      `the index could not say where the programs of ${unknown.join(", ")} are, so they may be missing`,
    ]);
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

// How the status line starts when it names silent selections.
const SILENT_PREFIX = "no programs in ";

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
    `${SILENT_PREFIX}${silent.join(", ")} — nixpkgs splits some packages so ` +
    `their binaries live in a separate output, and the index publishes the default one`;
}

// The GL driver a closure's GL programs need, on the unkernel engine
// (gldriver.js): the driver's own closure, walked past what `known`
// already holds, and the choice, for reportGl. Nothing is added on the
// qemu engine, whose guest has no GPU to drive.
//
// The programs are the selected ones (`rootDigests`) with their
// closures. What the page added beside them is left out: the X server
// links libglvnd and Wayland, and Xwayland draws without GL here
// (gui.js), so a guest with X11 programs would otherwise get the
// driver on every later addition. The site's driver is held to that
// closure (gldriver.js), an added program's glibc and gcc included,
// even where the guest has had the driver since its boot.
async function glDriverPaths(known, rootDigests, onProgress) {
  if (ENGINE !== Engine.UNKERNEL) {
    return { added: new Map(), result: { choice: DriverChoice.NOT_NEEDED } };
  }
  const basenames = [...reachable(known, rootDigests).values()].map(basenameOf);
  const result = chooseDriver(basenames, await publishedDrivers());
  if (result.choice !== DriverChoice.ADD) {
    return { added: new Map(), result };
  }

  // A running guest the page gave the driver at its boot, or at an
  // earlier addition, has it in `known`, outside the selection's
  // closure, and needs nothing more.
  const digest = result.driver.storePath
    .slice(STORE_PREFIX.length)
    .slice(0, DIGEST_LENGTH);
  if (known.has(digest)) {
    return { added: new Map(), result };
  }
  const added = await walkRoots([digest], onProgress, known);
  log(
    `gl: added ${result.driver.storePath} (${added.size} paths) for GL programs`,
  );
  return { added, result };
}

// The newest build of the X server the index has for the guest's
// system, or undefined when it has none or cannot be reached.
async function newestX11Server() {
  try {
    return (await versionsOf(X11_SERVER_ATTR)).find(bootable);
  } catch (err) {
    log(
      `x11: the index could not be asked for ${X11_SERVER_ATTR}: ${err.message}`,
    );
    return undefined;
  }
}

// The X server a closure's X11 programs need, on the unkernel engine
// (x11.js): the server's own closure, walked past what `known` already
// holds, and the choice, for reportX11. Nothing is added on the qemu
// engine, whose guest has no compositor to show X11 windows in.
async function x11ServerPaths(known, rootDigests, onProgress) {
  if (ENGINE !== Engine.UNKERNEL) {
    return { added: new Map(), result: { choice: X11Choice.NOT_NEEDED } };
  }
  const result = chooseX11Server(known, rootDigests);
  if (result.choice !== X11Choice.ADD) {
    return { added: new Map(), result };
  }

  const server = await newestX11Server();
  if (server === undefined) {
    return {
      added: new Map(),
      result: { choice: X11Choice.UNAVAILABLE },
    };
  }
  const added = await walkRoots([server.digest], onProgress, known);
  log(
    `x11: added ${server.storePath} (${added.size} paths) for ${result.programs.join(", ")}`,
  );
  return { added, result };
}

// Say what the selection's X11 programs lack (x11.js, x11Note), unless
// the status names silent selections.
function reportX11(result) {
  const note = x11Note(result);
  if (note === null || status.textContent.startsWith(SILENT_PREFIX)) {
    return;
  }
  status.textContent = note;
}

// Say how the shell already running gets what an addition brought it,
// an X server or a PulseAudio daemon (`added`, what the engine's add
// resolved to; gui.js, shellNote), unless the status names silent
// selections.
function reportShell(added) {
  const note = shellNote(added.shellUpdates);
  if (note === null || status.textContent.startsWith(SILENT_PREFIX)) {
    return;
  }
  status.textContent = note;
}

// Say what the selection's GL programs lack (gldriver.js, driverNote),
// unless the status names silent selections.
function reportGl(result) {
  const note = driverNote(result);
  if (note === null || status.textContent.startsWith(SILENT_PREFIX)) {
    return;
  }
  status.textContent = note;
}

// The union of every selected root's runtime closure, in one map. Roots
// that share a glibc fetch it once.
async function walkRoots(digests, onProgress, known = new Map()) {
  const closure = new Map(known);
  for (const digest of digests) {
    const one = await walkClosure(
      digest,
      (n, info) => onProgress(closure.size + n, info),
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

// The digests of every package selected into the guest, at its boot and
// by each addition since that succeeded (roots.js).
const guestRoots = rootRecord();

// The strip under the terminal that says what the guest is waiting on
// (activity.js): a download, or a program that opens windows starting.
const activity = activityStrip({
  element: document.getElementById("console-activity"),
  windowCount: () => desktopElement.querySelectorAll(".wland-window").length,
  screen: () => vm?.terminal?.buffer.active.type,
  isRunning: (program) =>
    vm?.isRunning === undefined
      ? Promise.resolve(false)
      : vm.isRunning(program),
});

// The programs of the selected packages that open windows, each judged
// by its own closure (activity.js, opensWindows).
function windowPrograms() {
  const programs = new Set();
  if (vm?.programsOf === undefined) {
    return programs;
  }
  for (const digest of guestRoots.all()) {
    const own = reachable(mounted, [digest]);
    const root = own.get(digest);
    if (
      root === undefined ||
      !opensWindows([...own.values()].map(basenameOf))
    ) {
      continue;
    }
    for (const name of vm.programsOf(basenameOf(root))) {
      programs.add(name);
    }
  }
  return programs;
}

// A command line entered at the guest's shell: if its program opens
// windows, the strip says it is starting until its first window.
function commandEntered(line) {
  const program = commandProgram(line);
  if (program === null || !windowPrograms().has(program)) {
    return;
  }
  log(`waiting for ${program}'s first window`);
  activity.started(program, commandJob(line));
}

// How the guest started, for the report.
let bootMode = "not started";

function reboot() {
  location.href = link({ boot: true });
  location.reload();
}

// ---------- a closure served on first use ----------

// The progress row for the paths that download on first use. Its label
// links to the Downloads setting, where a reader who would rather wait
// once at the boot can choose that instead.
const FIRST_USE_ROW = [
  "on first use",
  {
    href: "#downloads",
    title: "Downloads setting: when the rest of the closure downloads",
  },
];

// The closure a guest is served lazily (lazy.js, downloads.js), for the
// life of the guest it booted with; null for a guest that booted with
// its whole closure downloaded.
let served = null;

// The digests selected so far, which a lazily fetched path is checked
// against: a selected path built for another system is refused
// (checkSystem).
let selectedDigests = [];

const digestOfInfo = (info) => basenameOf(info).slice(0, DIGEST_LENGTH);

// The paths a lazily served boot or addition fetches before it is
// done: the selected ones, whose programs are linked onto PATH from
// their listings, and any Mesa, which the guest takes as its GL driver
// only once it has seen the driver's files (gui.js).
function eagerOf(infos, rootDigests) {
  return infos.filter(
    (info) =>
      rootDigests.includes(digestOfInfo(info)) ||
      isGlDriverPath(basenameOf(info)),
  );
}

// Fetch the eager paths through the store. A selected path is touched,
// which starts all its references in the background as well, since the
// reader is about to run it; a driver's references wait until a GL
// program loads the driver.
function fetchEager(store, eager, rootDigests) {
  return Promise.all(
    eager.map((info) =>
      rootDigests.includes(digestOfInfo(info))
        ? store.touch(basenameOf(info), References.ALL)
        : store.ensure(basenameOf(info), Priority.DEMAND),
    ),
  );
}

// How long a boot or an addition waits, once its selected packages are
// in, for the listings still on their way. A listing is a few
// kilobytes, fetched while the closure is walked, so nearly all are in
// by then; the wait is for the farm, which takes every listed path's
// programs (share.js, offer). One that comes later is linked when it
// arrives, and one that never comes leaves its path to be downloaded
// whole when the guest touches it.
const LISTINGS_GRACE_MS = 2000;

// The NAR listings of a lazily served closure (listing.js), fetched a
// few at a time, each once, from the moment the walk finds its path.
function newListings() {
  return listingFetcher({
    fetchOne: fetchListing,
    concurrency: FETCH_CONCURRENCY,
  });
}

// A store for the guest `vmPromise` resolves to, and the progress rows
// its downloads count into. A boot sets the rows up and an addition
// replaces them (show), since each has a panel of its own. `listings`
// gives the store each path's NAR listing.
function serveLazily(vmPromise, listings) {
  // { selected, closure, eager: Set of basenames }: the row of what the
  // boot or addition waits for, the row of the whole closure, and the
  // basenames that count into the first.
  let rows = null;
  let telemetry = null;
  // Compressed bytes read for the closure, from the network or the
  // Cache API, retries taken back.
  let streamed = 0;

  // Every download counts into the closure's row, and the eager ones
  // into the row the boot waits on as well.
  function count(info, bytes) {
    streamed += bytes;
    rows.closure.add(bytes);
    if (rows.eager.has(basenameOf(info))) {
      rows.selected.add(bytes);
    }
  }

  // The closure's row is done once every path is in: called as each
  // path is written, and when the rows are shown.
  function finished() {
    const { paths, writtenPaths } = store.stats();
    if (writtenPaths === paths) {
      rows.closure.done(`all ${paths} paths`);
    }
  }

  const store = lazyStore({
    concurrency: NAR_CONCURRENCY,
    listing: (info) => listings.of(info),
    dropListing: forgetListing,
    async fetch(info) {
      // The strip under the terminal shows the download while it runs,
      // each attempt after the first, and a failure the guest's read
      // is about to hear of as an I/O error.
      const basename = basenameOf(info);
      activity.downloadStarted(basename, info.fileSize);
      // Why the download's last attempt failed, once it has: shorter on
      // the strip than the error, which names the URL.
      let lastReason = null;
      try {
        const entries = await fetchNar(
          info,
          (bytes) => {
            count(info, bytes);
            activity.downloadBytes(basename, bytes);
          },
          (result, bytes) => telemetry.cacheRead(result, bytes),
          ({ attempt, attempts, reason }) => {
            if (attempt === attempts) {
              lastReason = reason;
              return;
            }
            activity.downloadRetrying(basename, {
              attempt: attempt + 1,
              attempts,
              reason,
            });
          },
        );
        checkSystem(info, entries, selectedDigests);
        return entries;
      } catch (err) {
        activity.downloadFailed(basename, lastReason ?? err.message);
        throw err;
      } finally {
        activity.downloadEnded(basename);
      }
    },
    async write(basename, entries) {
      (await vmPromise).share.write(basename, entries);
    },
    onWritten: finished,
  });

  return {
    store,
    listings,
    // The bytes read so far, for window.trynix.downloads.
    streamed: () => streamed,

    // Offer each listed path's programs to the share as its listing
    // arrives. Resolves once every listing has arrived or failed.
    offer(infos) {
      return Promise.all(
        infos.map(async (info) => {
          const root = await store.list(basenameOf(info));
          if (root !== null) {
            (await vmPromise).share.offer(
              basenameOf(info),
              programsOfListing(root),
            );
          }
        }),
      );
    },
    // Count into these rows from now on: `selected` for the `eager`
    // infos, `closure` for everything, which starts at what has been
    // downloaded already. `loadTelemetry` hears cache reads.
    show({ selected, closure, eager, loadTelemetry }) {
      rows = {
        selected,
        closure,
        eager: new Set(eager.map(basenameOf)),
      };
      telemetry = loadTelemetry;
      selected.setTotal(eager.reduce((sum, info) => sum + info.fileSize, 0));
      closure.setTotal(store.stats().bytes);
      closure.add(streamed);
      finished();
    },
  };
}

// What the guest's closure has cost so far, for the tools in tools/
// (window.trynix.downloads): the closure in paths and compressed bytes,
// what of it has been written, and the compressed bytes read for it,
// from the network or, on a return visit, the Cache API. A guest that
// booted with everything downloaded has written all of it.
function downloadStats() {
  if (served !== null) {
    return {
      mode: Downloads.LAZY,
      ...served.store.stats(),
      streamedBytes: served.streamed(),
      listedPaths: served.listings.count(),
      listingBytes: served.listings.bytes(),
    };
  }
  const bytes = [...mounted.values()].reduce((sum, i) => sum + i.fileSize, 0);
  return {
    mode: Downloads.ALL,
    paths: mounted.size,
    bytes,
    writtenPaths: mounted.size,
    writtenBytes: bytes,
    streamedBytes: bytes,
  };
}

// ---------- the two engines ----------

// Each of these lays an engine's rows out in the progress panel and
// returns the function that starts the engine: fetch what the engine
// needs, bring a guest up to the point where the share is writable, and
// resolve to its handle (boot.js and unkernel.js return the same
// shape). `started` is called once the engine's inputs are in, with
// how the guest is starting: the analytics mode, the phrase the report
// uses, and the verb the page shows while the guest comes up.

// qemu: the engine, the guest image (kernel, initramfs, BIOS) and the
// snapshot the guest resumes from.
function qemuEngine(panel, telemetry) {
  const engineRow = panel.row("qemu engine");
  const guestRow = panel.row("guest image");
  const snapshotRow = panel.row("snapshot");

  return async function start(started) {
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

    const machinePromise = fetch(await asset(MACHINE_URL)).then((res) => {
      if (!res.ok) {
        throw new Error(`${MACHINE_URL}: HTTP ${res.status}`);
      }
      return res.json();
    });

    const guestPromise = Promise.all(
      GUEST_FILES.map(async (name) => [
        name,
        await fetchWithProgress(await asset(`guest/${name}`), {
          onBytes: (n) => guestRow.add(n),
          onCacheRead: telemetry.cacheRead,
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
      onCacheRead: telemetry.cacheRead,
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

    // The guest files and the snapshot are handed over rather than
    // kept.
    const [, guestFiles, machine, snapshot] = await Promise.all([
      enginePromise,
      guestPromise,
      machinePromise,
      snapshotPromise,
    ]);
    const resuming = snapshot !== null;
    started({
      mode: resuming ? BootMode.SNAPSHOT : BootMode.COLD,
      described: resuming ? "resumed from the snapshot" : "cold booted",
      verb: resuming ? "resuming" : "booting",
    });
    log(
      resuming
        ? "engine instantiated; the guest will resume from the snapshot"
        : "no snapshot; the guest will cold boot",
    );
    return startVM({
      guestFiles,
      machine,
      snapshot,
      terminalElement,
      keyBarElement,
      engine,
    });
  };
}

// unkernel: the kernel, which carries its own base system. There is no
// guest image and no snapshot to fetch, since the kernel boots faster
// than a snapshot loads.
function unkernelEngine(panel) {
  const engineRow = panel.row("unkernel engine");

  return async function start(started) {
    const urls = await assets([UNKERNEL_MAIN, UNKERNEL_KERNEL, UNKERNEL_GL]);

    // The kernel is not held by the page: the SDK streams the wasm from
    // the URL and the browser compiles as the bytes arrive. This
    // download fills the HTTP cache, and the bar.
    await warmHttpCache(urls.get(UNKERNEL_KERNEL), {
      onTotal: (n) => engineRow.setTotal(n),
      onBytes: (n) => engineRow.add(n),
    });
    engineRow.done();

    started({
      mode: BootMode.UNKERNEL,
      described: "booted on unkernel",
      verb: "booting",
    });
    consoleTty.textContent = "pts/0";
    log(`unkernel memory: ${memory.mib} MiB (${memory.why})`);
    log(`unkernel CPUs: ${cpus.count} (${cpus.why})`);
    log(
      network.mode === Network.ON
        ? `unkernel network: through ${network.relay} (${network.why})`
        : `unkernel network: off (${network.why})`,
    );
    const vm = await startUnkernel({
      terminalElement,
      keyBarElement,
      consoleElement,
      desktopElement,
      soundControl,
      soundPosition: linkedSound ?? Sound.ON,
      onSoundSwitch: (position) => {
        linkedSound = position === Sound.ON ? null : position;
        history.replaceState(null, "", link());
      },
      windowsButton,
      memory: { mib: memory.mib, fallbacks: fallbacksBelow(memory.mib) },
      cpus: cpus.count,
      net: netSpec(network),
      engine: {
        main: urls.get(UNKERNEL_MAIN),
        kernel: urls.get(UNKERNEL_KERNEL),
        gl: urls.get(UNKERNEL_GL),
      },
    });
    log("unkernel booted");
    memoryStatus.textContent =
      vm.memoryMiB === memory.mib
        ? `This guest booted with ${memoryLabel(vm.memoryMiB)}.`
        : `This guest booted with ${memoryLabel(vm.memoryMiB)}: the browser could not set aside ${memoryLabel(memory.mib)}.`;
    return vm;
  };
}

// Refuse a selected store path whose programs were built for a system
// this page's engine does not run, naming the engine that does.
//
// Only the roots are looked at. A dependency is built for the system
// its root was, and the roots are where a reader's pasted path lands.
function checkSystem(info, entries, rootDigests) {
  const digest = basenameOf(info).slice(0, DIGEST_LENGTH);
  if (!rootDigests.includes(digest)) {
    return;
  }

  const built = foreignSystem(entries, SYSTEM);
  if (built === null) {
    return;
  }
  throw new Error(
    `${info.storePath} is built for ${built}, and the ${ENGINE} engine runs ${SYSTEM}; open the page with engine=${engineFor(built)} to run it`,
  );
}

// The boot flow. The engine's own files (for qemu the engine, the
// guest image and the snapshot; for unkernel the kernel) and the
// closure download in parallel under one progress panel; the engine
// is started the moment its inputs are in, and every NAR is written
// into the share as it lands, while the rest are still on their way.
// When the last one is in, the guest is let run and the terminal goes
// live.
//
// Resolves to null once the guest is at its prompt, or to why the boot
// did not get there, in the words the page shows it with: the status
// line for a boot the page cannot start, the progress row for one that
// failed. The boot tool answers with it (page.boot).
async function boot() {
  // Capture the requested selection before asynchronous work can change it.
  const entries = [...selection.values()];
  const telemetry = createLoadTelemetry(entries, LoadOperation.BOOT);
  let stage = LoadStage.CLOSURE;
  let mode = BootMode.UNKNOWN;

  // The qemu engine is threaded, and its threads need SharedArrayBuffer,
  // which a browser only hands to a cross-origin isolated page. Say so
  // before anything downloads: without this the closure is fetched and
  // the engine instantiated, and the run dies seconds later on a
  // missing global, with nothing on the page to say why.
  if (ENGINE === Engine.QEMU && !globalThis.crossOriginIsolated) {
    telemetry.finish(LoadStage.ISOLATION);
    log("not cross-origin isolated: SharedArrayBuffer is unavailable");
    status.textContent =
      "not cross-origin isolated, so SharedArrayBuffer is missing and the engine cannot start — reload once, and if that does not help the browser is blocking the service worker that sets the headers";
    return status.textContent;
  }

  // unkernel's kernel switches tasks by suspending WebAssembly, which
  // needs JSPI. The page only picks unkernel by itself where the
  // browser has JSPI (engine.js), so this is a link that named the
  // engine, opened in a browser that cannot run it.
  if (ENGINE === Engine.UNKERNEL && !hasJspi()) {
    telemetry.finish(LoadStage.ENGINE);
    log("no JSPI: WebAssembly.Suspending is unavailable");
    status.textContent =
      "this browser cannot suspend WebAssembly (JSPI), which the unkernel engine needs; Chrome 137, Firefox 153 and Safari 27 have it. The x86_64 guest runs here: choose it under Settings";
    return status.textContent;
  }

  // The boot a link asked for has started: boot=1 leaves the address,
  // so a reload from here on offers the boot rather than starting a
  // second one, and the status line stops saying the boot waits.
  linkedBoot = false;
  notes = notes.filter((note) => note !== WAITING_FOR_ISOLATION);
  render();

  bootSection.hidden = false;
  bootButton.disabled = true;
  consoleVeil.hidden = false;
  consoleSpinner.hidden = false;
  consoleNote.textContent = "fetching…";
  const panel = new ProgressPanel(bootProgress);

  // Served lazily, the boot waits for the selected packages alone and
  // the rest of the closure arrives as the guest asks for it; the last
  // row counts the whole closure, and goes on after the shell is up.
  const lazily = downloads.mode === Downloads.LAZY;
  log(`downloads: ${downloads.mode} (${downloads.why})`);

  const walkRow = panel.row("closure walk");
  const signatureRow = panel.row("signatures");
  const startEngine =
    ENGINE === Engine.UNKERNEL
      ? unkernelEngine(panel)
      : qemuEngine(panel, telemetry);
  const closureRow = panel.row(lazily ? "selected packages" : "closure");
  const vmRow = panel.row("virtual machine");
  const firstUseRow = lazily ? panel.row(...FIRST_USE_ROW) : null;

  try {
    const roots = await rootsOf(entries.map((entry) => entry.digest));
    const rootDigests = digestsOf(roots);
    guestRoots.booted(rootDigests);

    // Served lazily, each path's listing is on its way the moment the
    // walk finds the path.
    const listings = lazily ? newListings() : null;
    const found = (info) => listings?.of(info);
    const closure = await walkRoots(rootDigests, (n, info) => {
      walkRow.note(`${n} narinfos`);
      found(info);
    });
    const gl = await glDriverPaths(closure, rootDigests, (n, info) => {
      walkRow.note(`${closure.size + n} narinfos`);
      found(info);
    });
    for (const [digest, info] of gl.added) {
      closure.set(digest, info);
    }
    const x11 = await x11ServerPaths(closure, rootDigests, (n, info) => {
      walkRow.note(`${closure.size + n} narinfos`);
      found(info);
    });
    for (const [digest, info] of x11.added) {
      closure.set(digest, info);
    }
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

    stage = LoadStage.DOWNLOAD;
    // The engine starts as soon as its own inputs are in, without
    // waiting for the closure.
    let waiting = "booting";
    const vmPromise = startEngine((started) => {
      mode = started.mode;
      bootMode = started.described;
      waiting = started.verb;
    });

    // Each NAR goes into the share the moment it is parsed, and is
    // dropped from the page's hands right after. Nothing here ever
    // holds more than the few NARs in flight.
    const infos = [...closure.values()];
    let closurePromise;
    let offered = null;
    if (lazily) {
      // The selected packages now, and the rest of the closure as the
      // guest touches it (lazy.js).
      selectedDigests = rootDigests;
      served = serveLazily(vmPromise, listings);
      served.store.add(infos);
      offered = served.offer(infos);
      const eager = eagerOf(infos, rootDigests);
      served.show({
        selected: closureRow,
        closure: firstUseRow,
        eager,
        loadTelemetry: telemetry,
      });
      closurePromise = fetchEager(served.store, eager, rootDigests).then(() => {
        closureRow.done();
        log(
          `selected packages written to the share; the other ${infos.length - eager.length} paths on first use`,
        );
      });
    } else {
      closureRow.setTotal(infos.reduce((sum, i) => sum + i.fileSize, 0));
      closurePromise = mapConcurrent(infos, NAR_CONCURRENCY, async (info) => {
        const entries = await fetchNar(
          info,
          (n) => closureRow.add(n),
          telemetry.cacheRead,
        );
        checkSystem(info, entries, rootDigests);
        const vm = await vmPromise;
        vm.share.write(basenameOf(info), entries);
      }).then(() => {
        closureRow.done();
        log("closure written to the share");
      });
    }
    // A NAR that fails while the engine is still starting has nobody
    // awaiting it yet. The await below reports the failure; this keeps
    // the same failure from also being logged as unhandled.
    closurePromise.catch(() => {});

    vm = await vmPromise;
    await closurePromise;
    await listed(offered);
    if (window.trynix !== undefined) {
      window.trynix.downloads = downloadStats;
    }

    consoleNote.textContent = `${waiting} the guest…`;
    // The bar fills when the guest is at its prompt; until then the row
    // says what the guest is doing, not that it is done.
    vmRow.note(`${waiting}…`);
    vmStarted = true;
    mounted = closure;

    stage = LoadStage.GUEST;
    const ready = vm.run(basenamesOf(closure, rootDigests), {
      store: served?.store ?? null,
    });
    log("virtual machine running");
    reportSilent(vm, closure, roots);
    reportGl(gl.result);
    reportX11(x11.result);
    bootButton.textContent = "Add to the running VM";
    rebootLink.hidden = false;
    addNote.hidden = false;
    bootButton.disabled = false;

    await ready;
    reportCpus(vm);
    telemetry.finish(LoadStage.READY, mode);
    log("guest at its prompt");
    vmRow.done("running");
    consoleVeil.hidden = true;

    // The link's command, typed as the reader would type it: it shows at
    // the prompt, lands in the shell's history, and Ctrl-C stops it. It
    // runs inside the guest, like anything the reader types there.
    if (linkedRun !== null) {
      log(`typing the link's command: ${linkedRun}`);
      vm.type(`${linkedRun}\n`);
    }

    // The strip under the terminal may show from now on, for a command
    // the link typed and for each one the reader enters. Only the aarch64
    // guest downloads on first use and opens windows.
    if (ENGINE === Engine.UNKERNEL) {
      activity.ready();
      if (linkedRun !== null) {
        commandEntered(linkedRun);
      }
      // What was sent since the last Enter, for a line pasted whole,
      // whose text the shell has not echoed onto the row yet.
      const typed = typedLines();
      vm.terminal.onData((data) => {
        const shown = enteredLine(vm.terminal);
        const screen = vm.terminal.buffer.active.type;
        const sent = typed.send(data, screen, shown);
        if (sent === null) {
          return;
        }
        const line = shown !== null && shown.trim() !== "" ? shown : sent;
        commandEntered(line);
      });
    }
    return null;
  } catch (err) {
    telemetry.finish(stage, mode);
    log(`boot failed: ${err.message}`);
    const reason = String(err);
    vmRow.fail(reason);
    // The error is on the progress row. The status line goes back to
    // describing the selection, which names any path no cache holds.
    render();
    document.getElementById("debug").open = true;
    // The veil stays over the empty terminal, and says the boot is over
    // rather than still fetching.
    consoleSpinner.hidden = true;
    consoleNote.textContent = BOOT_FAILED_NOTE;
    refreshBootButton();
    return reason;
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
//
// Resolves to null once the selection is in the guest, or to why the
// addition failed, in the words its progress row fails with. The boot
// tool answers with it, so an agent knows the addition needs a retry.
async function addToRunningVM() {
  // Count only new selected roots when extending an existing guest.
  const entries = [...selection.values()].filter(
    (entry) => !mounted.has(entry.digest),
  );
  const telemetry = createLoadTelemetry(entries, LoadOperation.ADD);
  let stage = LoadStage.CLOSURE;

  bootButton.disabled = true;
  const panel = new ProgressPanel(bootProgress);
  const row = panel.row("adding");

  try {
    const roots = await rootsOf([...selection.keys()]);
    const rootDigests = digestsOf(roots);

    // The roots this addition brings, which alone may take a program's
    // name from a package already in the guest, so the most recently
    // added package wins (the page's add note). Every selected root
    // used to, and the one selected last took each name it shared:
    // adding figlet switched which of two hellos booted together ran.
    // They are the guest's once the addition is in (addition.done), so
    // an addition that fails leaves them to its retry (roots.js).
    const addition = guestRoots.adding(rootDigests);
    const newRootDigests = addition.roots;

    const fresh = await walkRoots(
      rootDigests,
      (n) => row.note(`${n} narinfos`),
      mounted,
    );
    const gl = await glDriverPaths(
      new Map([...mounted, ...fresh]),
      rootDigests,
      (n) => row.note(`${fresh.size + n} narinfos`),
    );
    for (const [digest, info] of gl.added) {
      fresh.set(digest, info);
    }
    const x11 = await x11ServerPaths(
      new Map([...mounted, ...fresh]),
      rootDigests,
      (n) => row.note(`${fresh.size + n} narinfos`),
    );
    for (const [digest, info] of x11.added) {
      fresh.set(digest, info);
    }
    if (fresh.size === 0 && unfetchedSelections(rootDigests).length === 0) {
      addition.done();
      telemetry.finish(LoadStage.READY);
      row.done("already there");
      refreshBootButton();
      return null;
    }

    stage = LoadStage.DOWNLOAD;
    if (served !== null) {
      await addLazily({
        fresh,
        roots,
        rootDigests,
        newRootDigests,
        gl,
        x11,
        panel,
        row,
        telemetry,
      });
      addition.done();
      return null;
    }
    const infos = [...fresh.values()];
    row.setTotal(infos.reduce((sum, i) => sum + i.fileSize, 0));
    const unpacked = await mapConcurrent(
      infos,
      NAR_CONCURRENCY,
      async (info) => {
        const entries = await fetchNar(
          info,
          (n) => row.add(n),
          telemetry.cacheRead,
        );
        checkSystem(info, entries, rootDigests);
        return { basename: basenameOf(info), entries };
      },
    );

    for (const [digest, info] of fresh) {
      mounted.set(digest, info);
    }
    const added = await vm.add(unpacked, basenamesOf(mounted, newRootDigests));
    addition.done();
    reportSilent(vm, mounted, roots);
    reportGl(gl.result);
    reportX11(x11.result);
    reportShell(added);
    telemetry.finish(LoadStage.READY);
    row.done(`${fresh.size} paths added`);
    renderClosure(mounted);
    return null;
  } catch (err) {
    telemetry.finish(stage);
    const reason = String(err);
    row.fail(reason);
    return reason;
  } finally {
    refreshBootButton();
  }
}

// Wait for the listings `offered` is offering, up to LISTINGS_GRACE_MS;
// nothing to wait for when it is null.
async function listed(offered) {
  if (offered === null) {
    return;
  }
  const late = await Promise.race([
    offered.then(() => false),
    pause(LISTINGS_GRACE_MS).then(() => true),
  ]);
  if (late) {
    log(
      `listings: still waiting after ${LISTINGS_GRACE_MS} ms; their programs join PATH as they arrive`,
    );
  }
}

// Selected paths a lazily served guest lists and has not fetched: a
// package selected after the boot that was in the closure already, as
// something another package needs. It is fetched, and its programs
// linked, as any new selection's are.
function unfetchedSelections(rootDigests) {
  if (served === null) {
    return [];
  }
  return rootDigests
    .map((digest) => mounted.get(digest))
    .filter(
      (info) => info !== undefined && !served.store.ready(basenameOf(info)),
    );
}

// Add to a guest whose closure is served lazily. What the addition
// brings joins the closure the guest lists at once; the new selections
// are fetched before the page says they were added, and the rest
// arrives on first use, as at the boot. `newRootDigests` are the roots
// the guest did not have, whose programs take their names
// (addToRunningVM).
async function addLazily({
  fresh,
  roots,
  rootDigests,
  newRootDigests,
  gl,
  x11,
  panel,
  row,
  telemetry,
}) {
  const waiting = unfetchedSelections(rootDigests);
  served.store.add(fresh.values());
  for (const [digest, info] of fresh) {
    mounted.set(digest, info);
  }
  const offered = served.offer([...fresh.values()]);

  selectedDigests = rootDigests;
  const eager = [...eagerOf([...fresh.values()], rootDigests), ...waiting];
  served.show({
    selected: row,
    closure: panel.row(...FIRST_USE_ROW),
    eager,
    loadTelemetry: telemetry,
  });
  await fetchEager(served.store, eager, rootDigests);
  await listed(offered);

  const added = await vm.add(
    [],
    basenamesOf(mounted, newRootDigests),
    eager.map(basenameOf),
  );
  reportSilent(vm, mounted, roots);
  reportGl(gl.result);
  reportX11(x11.result);
  reportShell(added);
  telemetry.finish(LoadStage.READY);
  row.done(`${fresh.size} paths added, ${eager.length} fetched`);
  renderClosure(mounted);
}

// ---------- the report ----------

// Built when pressed, from what the page already has (report.js). The
// clipboard needs a secure context and a user gesture; when it is
// refused, the report replaces the log so it can be selected by hand.
const reportStatus = document.getElementById("report-status");
document.getElementById("copy-report").addEventListener("click", async () => {
  const report = buildReport({
    manifest: await manifest(),
    closure: mounted,
    terminal: vm?.terminal ?? null,
    transcript: window.trynix?.transcript() ?? "",
    boot: bootMode,
  });
  try {
    await navigator.clipboard.writeText(report);
    reportStatus.textContent = "copied";
  } catch {
    debugLog.textContent = report;
    reportStatus.textContent = "select it below and copy";
  }
});

// ---------- restoring a shared link ----------

// A package named without a version means "whatever the index has
// newest", which is what makes ?pkg=ripgrep a durable link.
async function restore({ pkgs, paths }, selectionMethod = SelectionMethod.URL) {
  const said = [];

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

  // The whole version list, not only the versions with a build, so a
  // link asking for a version that exists and cannot boot is answered
  // with that fact instead of "not in the index".
  for (const { attr, version } of pkgs) {
    const versions = await versionRowsOf(attr);
    const hit =
      version === null
        ? versions.find(bootable)
        : versions.find((v) => v.version === version);

    // Three different misses, and the difference matters to whoever
    // sent the link.
    if (hit === undefined) {
      if (versions.length === 0) {
        said.push(`${attr} is not in the index`);
      } else if (version === null) {
        said.push(`no version of ${attr} can be booted here`);
      } else {
        said.push(`the index has no ${attr} ${version}`);
      }
      continue;
    }

    // A version nixpkgs shipped without a build for this system has no
    // store path to select, so the link cannot be honoured at all.
    if (!bootable(hit)) {
      said.push(
        `${attr} ${hit.version} shipped in nixpkgs with no ${SYSTEM} build, so there is nothing to fetch`,
      );
      continue;
    }

    select(entryOf(hit, selectionMethod));
  }

  if (said.length > 0) {
    setNotes(said);
  }
}

// The opening link is restored. The address goes back to describing
// the selection, and the boot the link asked for starts, or waits for
// the shim's reload (isolation.js, linkBootOf).
function restored() {
  opening = null;
  const start = linkBootOf({
    asked: linkedBoot,
    selected: selection.size,
    isolation: ISOLATION,
  });

  // No boot: nothing for boot=1 to start, so it leaves the address.
  if (start === LinkBoot.NONE) {
    linkedBoot = false;
    render();
    return;
  }

  // The shim is about to reload the page, which would cut a boot short;
  // boot=1 stays in the address for the reloaded page.
  if (start === LinkBoot.AFTER_RELOAD) {
    setNotes([...notes, WAITING_FOR_ISOLATION]);
    return;
  }

  // Boot now: the page is isolated, or never will be, in which case the
  // boot says what it lacks or runs on one CPU.
  render();
  boot();
}

// The opening link could not be restored, because the index could not
// be read. The page says so, and the address keeps the link, boot=1
// included, so a reload tries again.
function unrestorable(err) {
  unrestored = opening;
  opening = null;
  log(`restoring the link failed: ${err.message}`);
  setNotes([
    ...notes,
    `the package index could not be read (${err.message}); reload to try again`,
  ]);
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
  // unkernel has one file worth warming, the kernel, which goes to the
  // HTTP cache where the SDK's own fetch finds it.
  if (ENGINE === Engine.UNKERNEL) {
    warm(UNKERNEL_KERNEL, warmHttpCache);
    return;
  }

  // The wasm goes to the HTTP cache, where the engine's own fetch
  // finds it; the rest to the Cache API, where the page's do.
  warm(QEMU_WASM, warmHttpCache);
  warm(SNAPSHOT_URL, fetchWithProgress);
  for (const name of GUEST_FILES) {
    warm(`guest/${name}`, fetchWithProgress);
  }
}

const initial = readUrl();

// A link naming packages or paths holds the address until restore()
// has selected the link's packages and paths, and holds the link's
// boot=1 until a boot starts. Set before the first redraw, which
// applyCaches does.
if (initial.pkgs.length > 0 || initial.paths.length > 0) {
  opening = initial;
  linkedBoot = initial.boot;
}
applyCaches(initial.caches);

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
if (opening !== null) {
  restore(initial).then(restored, unrestorable);
}

// The site build substitutes the derivation's own $out into STORE_PATH, so
// the footer names the store path serving the page. A local checkout still
// carries the placeholder, and the line stays hidden.
const STORE_PATH = "__STORE_PATH__";
if (!STORE_PATH.startsWith("__")) {
  document.getElementById("store-path-footer").textContent = STORE_PATH;
  document.getElementById("store").hidden = false;
}

// ---------- the tools an agent drives this page with ----------

// The same operations the three lanes and the boot button perform,
// named and given argument schemas so an agent can call them instead
// of clicking (webmcp.js). Nothing new happens here: every one of
// these is the function the reader's click already runs.
const page = {
  state: () => ({
    booted: vmStarted,
    bootMode,
    // The guest this page boots: packages resolve to builds for this
    // system, and a store path has to be one.
    engine: ENGINE,
    system: SYSTEM,
    closurePaths: mounted.size,
    selection: [...selection.values()].map((entry) => ({
      attr: entry.attr ?? entry.named?.attr ?? null,
      version: entry.version ?? entry.named?.version ?? null,
      storePath: entry.storePath ?? null,
      // Whether a configured cache admits to holding it: false is the
      // one failure worth knowing about before a boot rather than
      // three seconds into one.
      // null rather than undefined, which JSON.stringify drops: a key
      // that is missing only while a probe is in flight is worse to
      // read than one that is explicitly unanswered.
      inCache: entry.held ?? null,
    })),
    caches: extraCaches,
    link: new URL(link(), location.href).href,
  }),

  search: (query, limit) => searchAttrs(query, limit),

  // Trimmed to what a caller choosing a version needs. The full row
  // carries sizes and a name the picker draws with, and none of that
  // helps an agent decide.
  versions: async (attr) =>
    (await versionRowsOf(attr)).map((row) => ({
      version: row.version,
      bootable: bootable(row),
      closureSize: row.closureSize,
    })),

  // An attribute named without a version means the newest the index
  // can boot, which is what restore() reads a missing version as, but
  // only when it is null rather than absent.
  select: ({ packages, storePaths }) =>
    restore(
      {
        pkgs: packages.map(({ attr, version = null }) => ({ attr, version })),
        paths: storePaths,
      },
      SelectionMethod.AGENT,
    ),

  // A guest that is already running takes the new paths without a
  // reboot, which is the same thing the button does once it is up. A
  // boot or an addition that fails says why, as the page does, so the
  // caller knows it failed; a failed addition can be retried by calling
  // boot again.
  async boot() {
    // The button is disabled for a path no cache holds, so the tool
    // answers the same way instead of downloading toward a failure.
    const missing = unheld();
    if (missing.length > 0) {
      return `the boot did not start: ${missingNote(missing)}`;
    }
    if (vmStarted) {
      const failure = await addToRunningVM();
      if (failure !== null) {
        return `the addition failed: ${failure}; call boot again to retry it`;
      }
      return `added to the running guest; ${mounted.size} paths mounted`;
    }
    const failure = await boot();
    if (failure === null) {
      return `booted; ${mounted.size} paths mounted`;
    }

    // A boot can fail once the page has started the guest, as when the
    // guest's store cannot be mounted or linked at /nix. The guest is
    // there and the page takes the next call as an addition to it, so
    // the answer says it had started.
    if (vmStarted) {
      return `the boot failed after the guest started: ${failure}`;
    }
    return `the boot did not start: ${failure}`;
  },

  // The caches box under Settings, as an operation. A cache is reachable from a page
  // only if it allows cross-origin reads, and every path it serves is
  // still checked against the key given here before it is booted.
  caches(list) {
    applyCaches(list);
    reprobe();
    return page.state();
  },

  guest: () => window.trynix ?? null,
};

registerTools(page, ENGINE);
