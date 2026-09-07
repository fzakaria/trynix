// The translated lane: fetch a closure the same way the VM's boot does,
// then run one of its programs through site/js/x86 in a Worker, with
// the terminal attached. docs/translate.md is the design.
//
//   ?pkg=python3&exec=python3            newest python3, its REPL
//   ?pkg=ruby&exec=ruby&arg=-e&arg=puts+1  arguments, one arg= each
//   ?path=/nix/store/...&exec=jq          a store path verbatim
//   &cache=<url> <key>                    an extra binary cache
//
// exec names a program under bin/ of any selected root; without it the
// first program of the first root runs.
/* global openpty */

import { walkClosure } from "./closure.js";
import { fetchNar, programsOf } from "./store.js";
import { openTerminal } from "./terminal.js";
import { readUrl } from "./url.js";
import { versionsOf } from "./multiverse.js";
import { binOutputOf } from "./outputs.js";
import { mapConcurrent } from "./net.js";
import { ProgressPanel } from "./progress.js";
import {
  readSubstituters,
  setExtraSubstituters,
  verify,
} from "./substituters.js";
import { humanBytes } from "./format.js";
import { DIGEST_LENGTH, DIGEST_PATTERN, NAR_CONCURRENCY } from "./config.js";
import { log, onLog } from "./log.js";
import { createInputRing, InputWriter } from "./x86/stdio-shared.js";
import {
  loadTranslations,
  openTranslationCache,
  storeTranslation,
} from "./x86/cache.js";

const STORE_PREFIX = "/nix/store/";
const PARAM_EXEC = "exec";
const PARAM_ARG = "arg";
const PARAM_TRACE = "trace";
// nocache=1 neither loads nor stores translations, for measuring.
const PARAM_NOCACHE = "nocache";

const status = document.getElementById("status");
const bootSection = document.getElementById("boot");
const bootProgress = document.getElementById("boot-progress");
const terminalElement = document.getElementById("terminal");
const keyBarElement = document.getElementById("keybar");
const consoleVeil = document.getElementById("console-veil");
const consoleNote = document.getElementById("console-note");
const consoleTitle = document.getElementById("console-title");
const statsElement = document.getElementById("stats");
const debugLog = document.getElementById("debug-log");

onLog((line) => {
  debugLog.textContent += `${line}\n`;
});

const digestFromPath = (path) => {
  const base = path.startsWith(STORE_PREFIX)
    ? path.slice(STORE_PREFIX.length)
    : path;
  const digest = base.slice(0, DIGEST_LENGTH);
  return DIGEST_PATTERN.test(digest) ? digest : null;
};

// Every process worker reads the store in place, so an archive's
// bytes move into a SharedArrayBuffer once and its entries become
// views into that: the closure is copied once, here, and never again.
function shareEntries(entries) {
  const shared = new Map();
  return entries.map((entry) => {
    if (entry.data === undefined) {
      return entry;
    }
    let buffer = shared.get(entry.data.buffer);
    if (buffer === undefined) {
      buffer = new SharedArrayBuffer(entry.data.buffer.byteLength);
      new Uint8Array(buffer).set(new Uint8Array(entry.data.buffer));
      shared.set(entry.data.buffer, buffer);
    }
    return {
      ...entry,
      data: new Uint8Array(
        buffer,
        entry.data.byteOffset,
        entry.data.byteLength,
      ),
    };
  });
}

// The environment a program sees: what a shell in the VM would give
// it, minus what only a kernel can provide.
function environment(binDirs) {
  return [
    `PATH=${binDirs.join(":")}`,
    "HOME=/home/user",
    "USER=user",
    "LOGNAME=user",
    "SHELL=/bin/sh",
    "TERM=xterm-256color",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    "PYTHONUNBUFFERED=1",
    "TMPDIR=/tmp",
  ];
}

async function main() {
  const params = new URLSearchParams(location.search);
  const { pkgs, paths, caches } = readUrl();
  const exec = params.get(PARAM_EXEC);
  const args = params.getAll(PARAM_ARG);
  const trace = params.get(PARAM_TRACE) === "1";
  const noCache = params.get(PARAM_NOCACHE) === "1";
  setExtraSubstituters(caches);

  if (pkgs.length === 0 && paths.length === 0) {
    status.textContent =
      "nothing selected: add ?pkg=<attribute> or ?path=<store path> to the URL";
    return;
  }
  if (!globalThis.crossOriginIsolated) {
    status.textContent =
      "not cross-origin isolated, so SharedArrayBuffer is missing and the process cannot block on input; reload once";
    return;
  }

  bootSection.hidden = false;
  consoleVeil.hidden = false;
  consoleNote.textContent = "fetching…";
  const panel = new ProgressPanel(bootProgress);
  const walkRow = panel.row("closure walk");
  const signatureRow = panel.row("signatures");
  const closureRow = panel.row("closure");
  const cacheRow = panel.row("translations");
  const runRow = panel.row("process");

  try {
    // Roots: store paths as given, packages through the index, plus
    // the bin sibling of each where nixpkgs split the outputs.
    const rootDigests = [];
    for (const path of paths) {
      const digest = digestFromPath(path);
      if (digest !== null) {
        rootDigests.push(digest);
      }
    }
    for (const { attr, version } of pkgs) {
      const versions = await versionsOf(attr);
      const hit =
        version === null
          ? versions.find((v) => v.alive !== false)
          : versions.find((v) => v.version === version);
      if (hit === undefined) {
        throw new Error(
          `${attr}${version === null ? "" : ` ${version}`} is not in the index`,
        );
      }
      rootDigests.push(hit.digest);
    }
    const allRoots = [];
    for (const digest of rootDigests) {
      allRoots.push(digest);
      const bin = await binOutputOf(digest);
      if (bin !== null && bin !== digest) {
        allRoots.push(bin);
      }
    }

    const closure = new Map();
    for (const digest of allRoots) {
      const one = await walkClosure(
        digest,
        (n) => walkRow.note(`${closure.size + n} narinfos`),
        closure,
      );
      for (const [key, info] of one) {
        closure.set(key, info);
      }
    }
    walkRow.done(`${closure.size} paths`);
    log(`closure: ${closure.size} paths from ${allRoots.length} roots`);

    const substituters = readSubstituters();
    const verdicts = await Promise.all(
      [...closure.values()].map((i) => verify(i, substituters)),
    );
    const unsigned = verdicts.filter((v) => v === false).length;
    if (verdicts.some((v) => v === null)) {
      signatureRow.done("this browser cannot check Ed25519");
    } else if (unsigned > 0) {
      signatureRow.fail(
        `${unsigned} of ${closure.size} unsigned by a known key`,
      );
    } else {
      signatureRow.done(`${closure.size} verified`);
    }

    // Every NAR, unpacked and kept: the process's filesystem is the
    // whole closure in memory.
    const infos = [...closure.values()];
    closureRow.setTotal(infos.reduce((sum, i) => sum + i.fileSize, 0));
    const storePaths = [];
    const t0 = performance.now();
    await mapConcurrent(infos, NAR_CONCURRENCY, async (info) => {
      const entries = await fetchNar(info, (n) => closureRow.add(n));
      storePaths.push({ path: info.storePath, entries: shareEntries(entries) });
    });
    const unpacked = infos.reduce((sum, i) => sum + i.narSize, 0);
    closureRow.done(
      `${humanBytes(unpacked)} unpacked in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );

    // The program: exec= under bin/ of a root, else the first program
    // of the first root.
    const rootPaths = allRoots
      .map((d) => closure.get(d))
      .filter((i) => i !== undefined)
      .map((i) => i.storePath);
    let program = null;
    for (const path of rootPaths) {
      const sp = storePaths.find((s) => s.path === path);
      if (sp === undefined) {
        continue;
      }
      const programs = programsOf(sp.entries);
      if (exec !== null ? programs.includes(exec) : programs.length > 0) {
        program = `${path}/bin/${exec ?? programs[0]}`;
        break;
      }
    }
    if (program === null) {
      throw new Error(
        exec === null
          ? "the selection has no programs under bin/"
          : `no bin/${exec} in the selection`,
      );
    }
    const binDirs = rootPaths.map((p) => `${p}/bin`);

    // Translations of this closure's files from earlier runs.
    const translationCache = noCache ? null : await openTranslationCache();
    const t1 = performance.now();
    const translations = await loadTranslations(
      translationCache,
      [...closure.values()].map((i) => i.storePath),
    );
    const cachedBytes = translations.reduce(
      (sum, t) => sum + t.bytes.length,
      0,
    );
    cacheRow.done(
      translations.length === 0
        ? "none cached yet"
        : `${translations.length} regions, ${humanBytes(cachedBytes)}, loaded in ${((performance.now() - t1) / 1000).toFixed(1)} s`,
    );

    // The terminal and its pty. The page keeps the line discipline;
    // the worker gets bytes through the ring and sends termios
    // changes back so raw mode reaches the discipline.
    const ui = await openTerminal(terminalElement, keyBarElement);
    const { master, slave } = openpty();
    ui.attach(master);
    const ring = createInputRing();
    const input = new InputWriter(ring);
    const [cols, rows] = slave.ioctl("TIOCGWINSZ");
    input.setSize(rows, cols);
    slave.onReadable(() => input.push(Uint8Array.from(slave.read())));
    slave.onSignal((sig) => {
      if (sig === "SIGWINCH") {
        const [c, r] = slave.ioctl("TIOCGWINSZ");
        input.setSize(r, c);
      } else if (sig === "SIGINT") {
        input.interrupt();
      }
    });

    // What the process wrote, for the page's tests to read: ghostty
    // draws on a canvas, so the DOM never holds the text.
    const transcript = [];
    const decoder = new TextDecoder();
    window.trynixRun = {
      transcript: () => transcript.join(""),
      type: (text) => master.ldisc.writeFromLower(text),
      exit: null,
    };

    consoleTitle.textContent = program.slice(STORE_PREFIX.length);
    consoleNote.textContent = "starting…";
    runRow.note("running…");
    const started = performance.now();
    let lastStats = null;
    const worker = new Worker(
      new URL("./x86/kernel-worker.js", import.meta.url),
      { type: "module" },
    );
    const done = new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const msg = event.data;
        switch (msg.type) {
          case "output":
            transcript.push(decoder.decode(msg.bytes, { stream: true }));
            slave.write(Array.from(msg.bytes));
            break;
          case "termios":
            slave.ioctl("TCSETS", msg.termios);
            break;
          case "translated":
            storeTranslation(translationCache, msg).catch((e) =>
              log(`cache put failed: ${e.message}`),
            );
            break;
          case "log":
            log(msg.text);
            if (msg.text.includes("[stats]")) {
              lastStats = msg.text.slice(msg.text.indexOf("[stats]") + 8);
            }
            break;
          case "trace":
            log(`[sys] ${msg.line}`);
            break;
          case "exit":
            resolve(msg);
            break;
          default:
            break;
        }
      };
      worker.onerror = (e) => reject(new Error(e.message));
    });

    worker.postMessage({
      type: "start",
      argv: [program, ...args],
      envp: environment(binDirs),
      cwd: "/home/user",
      storePaths,
      stdin: ring,
      trace,
      translations,
      files: {
        "/etc/passwd":
          "root:x:0:0:root:/root:/bin/sh\nuser:x:1000:100:user:/home/user:/bin/sh\n",
        "/etc/group": "root:x:0:\nusers:x:100:\n",
        "/etc/hosts": "127.0.0.1 localhost\n",
      },
    });
    consoleVeil.hidden = true;
    log(`running ${program} ${args.join(" ")}`);

    const exit = await done;
    const wall = (performance.now() - started) / 1000;
    window.trynixRun.exit = { code: exit.code, wall, stats: lastStats };
    runRow.done(`exit ${exit.code} after ${wall.toFixed(1)} s`);
    statsElement.textContent = `exit ${exit.code} in ${wall.toFixed(2)} s${lastStats ? `; ${lastStats}` : ""}`;
    slave.write(`\r\n[process exited with ${exit.code}]\r\n`);
    worker.terminate();
  } catch (err) {
    log(`failed: ${err.message}`);
    runRow.fail(String(err));
    status.textContent = `${err} — see the debug log`;
    document.getElementById("debug").open = true;
  }
}

main();
