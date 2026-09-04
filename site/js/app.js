// Page wiring for the first working slice: take a store path, walk its
// runtime closure live from cache.nixos.org, and price the download.
// Every later stage — the NAR fetches, the unpack into the guest's 9p
// share, the qemu-wasm boot — starts from exactly the closure computed
// here; docs/design.md holds that plan.

import { walkClosure } from "./closure.js";
import { humanBytes } from "./format.js";
import { DIGEST_LENGTH, DIGEST_PATTERN } from "./config.js";

const STORE_PREFIX = "/nix/store/";

const form = document.getElementById("walk-form");
const input = document.getElementById("store-path");
const status = document.getElementById("status");
const result = document.getElementById("result");

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

// The closure as a table, largest unpacked size first, with a totals row
// the walk's status line repeats.
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
  } catch (err) {
    status.textContent = String(err);
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
