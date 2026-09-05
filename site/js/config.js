// Site-wide constants.

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
