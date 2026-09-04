// Page wiring: walk a store path's runtime closure live from
// cache.nixos.org, then boot it — qemu-wasm resumes an x86_64 guest in
// the tab, the closure rides in over virtio-9p, and the serial console
// lands in the terminal below. docs/design.md holds the architecture.

import { walkClosure } from "./closure.js";
import { fetchNar } from "./store.js";
import { bootVM } from "./boot.js";
import { fetchWithProgress, mapConcurrent } from "./net.js";
import { ProgressPanel } from "./progress.js";
import { humanBytes } from "./format.js";
import {
  DIGEST_LENGTH,
  DIGEST_PATTERN,
  GUEST_FILES,
  NAR_CONCURRENCY,
  QEMU_WASM,
} from "./config.js";

const STORE_PREFIX = "/nix/store/";

const form = document.getElementById("walk-form");
const input = document.getElementById("store-path");
const status = document.getElementById("status");
const result = document.getElementById("result");
const bootButton = document.getElementById("boot-button");
const bootSection = document.getElementById("boot");
const bootProgress = document.getElementById("boot-progress");
const terminalElement = document.getElementById("terminal");

// The last successful walk: what the boot button boots.
let walked = null; // { rootDigest, closure }

// Accept a full /nix/store path, a store basename, or a bare digest; the
// walk needs only the digest. Returns null when no digest is there.
function digestFromInput(raw) {
  let s = raw.trim();
  if (s.startsWith(STORE_PREFIX)) {
    s = s.slice(STORE_PREFIX.length);
  }
  s = s.slice(0, DIGEST_LENGTH);
  return DIGEST_PATTERN.test(s) ? s : null;
}

const basenameOf = (info) => info.storePath.slice(STORE_PREFIX.length);

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
    const cells = [
      [info.storePath, "path"],
      [humanBytes(info.fileSize), "size"],
      [humanBytes(info.narSize), "size"],
    ];
    for (const [text, cls] of cells) {
      const td = row.insertCell();
      td.textContent = text;
      td.className = cls;
    }
  }

  result.replaceChildren(table);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const digest = digestFromInput(input.value);
  if (digest === null) {
    status.textContent = `need a store path with its ${DIGEST_LENGTH}-character digest`;
    return;
  }

  status.textContent = "walking…";
  result.replaceChildren();
  bootButton.disabled = true;

  try {
    const closure = await walkClosure(digest, (n) => {
      status.textContent = `walking… ${n} narinfos fetched`;
    });

    const download = [...closure.values()].reduce(
      (sum, i) => sum + i.fileSize,
      0,
    );
    const unpacked = [...closure.values()].reduce(
      (sum, i) => sum + i.narSize,
      0,
    );
    status.textContent =
      `${closure.size} paths · ` +
      `${humanBytes(download)} to download · ${humanBytes(unpacked)} unpacked`;
    renderClosure(closure);

    walked = { rootDigest: digest, closure };
    bootButton.disabled = false;
  } catch (err) {
    status.textContent = String(err);
  }
});

// The boot flow: engine, guest image and closure download in parallel
// under one progress panel, then the VM starts and the terminal is live.
async function boot({ rootDigest, closure }) {
  bootSection.hidden = false;
  bootButton.disabled = true;
  const panel = new ProgressPanel(bootProgress);

  const engineRow = panel.row("qemu engine");
  const guestRow = panel.row("guest image");
  const closureRow = panel.row("closure");
  const vmRow = panel.row("virtual machine");

  try {
    const enginePromise = fetchWithProgress(QEMU_WASM, {
      onTotal: (n) => engineRow.setTotal(n),
      onBytes: (n) => engineRow.add(n),
    }).then((bytes) => {
      engineRow.done();
      return bytes;
    });

    const guestPromise = Promise.all(
      GUEST_FILES.map(async (name) => {
        const bytes = await fetchWithProgress(`guest/${name}`, {
          onBytes: (n) => guestRow.add(n),
        });
        return [name, bytes];
      }),
    ).then((entries) => {
      guestRow.done();
      return new Map(entries);
    });

    const infos = [...closure.values()];
    closureRow.setTotal(infos.reduce((sum, i) => sum + i.fileSize, 0));
    const closurePromise = mapConcurrent(
      infos,
      NAR_CONCURRENCY,
      async (info) => {
        const entries = await fetchNar(info, (n) => closureRow.add(n));
        return { basename: basenameOf(info), entries };
      },
    ).then((paths) => {
      closureRow.done();
      return paths;
    });

    const [wasmBytes, guestFiles, closurePaths] = await Promise.all([
      enginePromise,
      guestPromise,
      closurePromise,
    ]);

    // The manifest the guest init sources: the walked root goes on PATH.
    const root = closure.get(rootDigest);
    const manifest = `export PATH="/nix/store/${basenameOf(root)}/bin:$PATH"\n`;

    await bootVM({
      wasmBinary: wasmBytes.buffer,
      guestFiles,
      closure: closurePaths,
      manifest,
      terminalElement,
    });
    vmRow.done("running");
  } catch (err) {
    vmRow.fail(String(err));
    status.textContent = String(err);
    bootButton.disabled = false;
  }
}

bootButton.addEventListener("click", () => {
  if (walked !== null) {
    boot(walked);
  }
});

// The site build substitutes the derivation's own $out into STORE_PATH, so
// the footer names the store path serving the page. A local checkout still
// carries the placeholder, and the line stays hidden.
const STORE_PATH = "__STORE_PATH__";
if (!STORE_PATH.startsWith("__")) {
  document.getElementById("store-path-footer").textContent = STORE_PATH;
  document.getElementById("store").hidden = false;
}
