// Site-wide constants.

import { chooseEngine, hasJspi, isEngine, systemOf } from "./engine.js";

// The binary cache the closure walk and NAR fetches read from. The cache
// answers browser fetches directly: it serves
// `access-control-allow-origin: *` (verified 2026-09-04 on nix-cache-info
// and narinfo responses alike), so no proxy or server sits anywhere in
// the pipeline.
export const CACHE_URL = "https://cache.nixos.org";

// The nixpkgs-multiverse index: every version of every attribute
// nixpkgs ever shipped, joined to the store path Hydra built. Served
// from GitHub Pages with open CORS, so the browser reads it directly.
export const MULTIVERSE_URL = "https://nixmultiverse.com";

// The engine this page load runs on (engine.js says what the two are
// and how one is chosen). Decided once, from the link the page was
// opened with: an engine holds its memory for the life of the page, so
// changing engines is a reload at a link that names the other one.
const opened = new URLSearchParams(globalThis.location?.search ?? "");
export const ENGINE = chooseEngine({
  requested: opened.get("engine"),
  hasStorePath: opened.has("path"),
  jspi: hasJspi(),
});

// Whether the link named the engine, as opposed to the page choosing
// one. A choice the page made for this browser is not written into
// links (app.js, linkEngine): the next reader's browser may do better.
export const ENGINE_NAMED = isEngine(opened.get("engine"));

// The architecture the engine's guest runs, which is the one every
// store path fetched here has to be built for. The multiverse names its
// per-system data after it (site/js/outputs.js).
export const SYSTEM = systemOf(ENGINE);

// The system the multiverse's own pages show store paths for until a
// reader picks another, declared in its nix/site-system.nix. A link to
// a package page names a system only when it is not this one, so every
// link trynix writes is the canonical URL that site would write for
// itself.
export const MULTIVERSE_SITE_SYSTEM = "x86_64-linux";

// How many attribute matches the search list shows at once, and how
// many completions the range box's dropdown offers.
export const SEARCH_LIMIT = 12;
export const RANGE_COMPLETIONS = 12;

// A store basename is <digest>-<name>; the digest is 32 characters of
// nix base32, which draws from lowercase letters and digits.
export const DIGEST_LENGTH = 32;
export const DIGEST_PATTERN = /^[0-9a-z]{32}$/;

// How many narinfo fetches fly at once during a closure walk. The bound
// exists for the browser's connection queue, not for the cache.
export const FETCH_CONCURRENCY = 20;

// How many NAR downloads decompress at once during a boot.
export const NAR_CONCURRENCY = 4;

// The guest files the page feeds into the VM's -L directory, served
// under guest/ (nix/guest.nix builds them).
export const GUEST_FILES = [
  "bzImage",
  "initramfs.cpio.gz",
  "bios-256k.bin",
  "vgabios-stdvga.bin",
  "kvmvapic.bin",
  "linuxboot_dma.bin",
];

// The machine definition: guest RAM and QEMU's arguments, shared with
// the snapshot tool (nix/guest/machine.json says why).
export const MACHINE_URL = "guest/machine.json";

// The qemu engine artifacts, served under qemu/. The wasm is fetched
// by hand so the biggest download gets a progress bar; out.js and the
// pthread worker are loaded by the module machinery, through the same
// versioned URLs (site/js/assets.js).
export const QEMU_WASM = "qemu/qemu-system-x86_64.wasm";
export const QEMU_MAIN = "qemu/out.js";
export const QEMU_WORKER = "qemu/qemu-system-x86_64.worker.js";

// The migration snapshot: a guest already booted to the point of
// waiting for the store share, so a visit resumes rather than boots.
// Optional — the page cold-boots when it is not published.
export const SNAPSHOT_URL = "qemu/vm.state";

// The unkernel engine, vendored from its npm package (nix/vendor.nix):
// the SDK's browser entry, and the kernel with its base system inside.
export const UNKERNEL_MAIN = "vendor/unkernel/web.mjs";
export const UNKERNEL_KERNEL = "vendor/unkernel/unkernel.wasm";

// The unkernel guest's memory, the same 512 MiB the qemu guest gets
// (nix/guest/machine.json). unkernel allocates the memory as the guest
// touches pages rather than up front, so a phone is asked for what the
// guest uses and not for the whole of it.
export const UNKERNEL_MEMORY_MIB = 512;

// Guest GL's renderer, virglrenderer compiled to wasm (nix/vendor.nix).
// The SDK fetches it on the guest's first GL use and never before.
export const UNKERNEL_GL = "vendor/unkernel/virgl.mjs";

// What a GUI program in the unkernel guest needs from the site
// (gui.js, docs/gui.md), in one directory: wland's compositor, its
// relay and the guest's fonts. nix/site.nix renames the directory
// after a hash of its contents and rewrites this name to match, so a
// deploy never pairs one module with another's cached copy.
export const GUI_DIR = "gui";
export const GUI_WLAND = "client.mjs";
export const GUI_RELAY = "wlandr";
export const GUI_FONTS = ["DejaVuSansMono.ttf", "DejaVuSans.ttf"];
