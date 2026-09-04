# Design

trynix boots packages from nixpkgs history inside a qemu-wasm virtual
machine, entirely client-side. A static site — no server anywhere — that
resolves a package against the [nixpkgs-multiverse] index, fetches its
closure from cache.nixos.org, and drops the user into a shell with the
package on PATH.

The pieces already exist in sibling projects; trynix is the glue:

- [nixpkgs-multiverse] answers "which store path is `python3` 3.6.2" —
  `outpaths-x86_64-linux.json` maps every `(attribute, version)` pair to
  the digest Hydra built, the census says whether the cache still serves
  it, and the meta shards carry sizes and references.
- [grail] answers "which packages coexist" — clingo compiled to wasm
  solves version-range queries in the browser, so "select multiple" is a
  coexistence query (`python3@3.10.* ^openssl@1.1.*`) whose plan names
  one time-consistent world.
- [qemu-wasm] runs the result — QEMU compiled with emscripten, executing
  an x86_64 guest in the tab.

## The pipeline

1. **Resolve.** Attribute (and optionally a version range, via grail's
   solver) to one or more store-path digests, from static index shards.
2. **Walk.** Breadth-first over narinfos from cache.nixos.org to the full
   runtime closure. The cache serves `access-control-allow-origin: *`
   (verified 2026-09-04 on nix-cache-info, narinfo and NAR URLs come off
   the same S3/Fastly config), so plain `fetch` works from any origin.
   Implemented: `site/js/closure.js`.
3. **Fetch and unpack.** Each NAR is xz whole-file; decompress with a
   wasm xz decoder, parse the NAR format, and write the tree into
   emscripten's in-memory filesystem via `Module.FS` under a shared
   directory. Cache decompressed NARs in OPFS keyed by digest so a
   glibc fetched once is free forever after.
4. **Boot.** qemu-wasm with a prebuilt guest kernel and a tiny initramfs.
   The store enters the guest over virtio-9p; init mounts it, symlinks
   `/nix/store`, puts the selected outputs' `bin/` on PATH, and execs a
   shell on the serial console.
5. **Terminal.** xterm.js + xterm-pty, which is what qemu-wasm links
   against; [ghostty-web] is xterm.js-API-compatible and is the intended
   face once the plumbing works.

## What the qemu-wasm survey established

Surveyed 2026-09-04 at ktock/qemu-wasm (fork of QEMU 8.2.0, last commit
2026-09; the wasm TCG JIT is not yet upstream — QEMU 10.1 has only the
TCI interpreter for 32-bit guests).

- **virtio-9p is the JS-to-guest file channel, and it works.** Every
  documented build passes `--enable-virtfs`. The chain: JS `Module.FS`
  writes into emscripten MEMFS → QEMU's 9p `local` passthrough backend →
  `mount -t 9p -o trans=virtio share0 /mnt -oversion=9p2000.L` in the
  guest. Bidirectional. All examples populate the share in
  `Module.preRun`, before boot — which is all trynix needs, since the
  closure is known before the VM starts.
- **Everything is eager and in-memory.** Guest images arrive as
  emscripten `file_packager` `.data` blobs into MEMFS; there is no lazy
  block device, no fetch-on-demand, and the build pins
  `-sTOTAL_MEMORY=2300MB`. Closure size is bounded by tab memory: fine
  for CLI packages, a real ceiling for GUI-sized closures.
- **No prebuilt artifacts.** No npm package, no releases, no CI. The
  build is `emconfigure`/`emmake` inside a pinned `emscripten/emsdk`
  3.1.50 docker container that first builds zlib, libffi, glib and
  pixman for wasm32. Artifacts: `out.js` (ES6 module), `out.wasm`,
  `out.worker.js`.
- **COOP/COEP required.** Pthreads mean SharedArrayBuffer, which needs
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot set
  response headers; the standard workaround is the coi-serviceworker
  shim, which replays the page through a service worker that injects
  them. Cross-origin fetches to cache.nixos.org then need CORP/CORS —
  satisfied, since the cache sends `access-control-allow-origin: *`
  (use `credentialless` COEP if `require-corp` fights the NAR fetches).
- **Console** is xterm.js 5.3 + xterm-pty, wired at link time
  (`--js-library emscripten-pty.js`), plus a small `Module.TTY.stream_ops.poll`
  monkey-patch every example carries.
- **Performance**: translation blocks start on a ported TCI interpreter
  and hot blocks (1500 executions) are JIT-compiled to little wasm
  modules installed in the function table. MTTCG (`thread=multi -smp 4`)
  works but examples ship it off.
- **Networking** (later, optional): emscripten maps sockets to
  WebSockets; the in-browser path runs container2wasm's
  `c2w-net-proxy.wasm` behind an MSW service-worker interception, egress
  over Fetch — HTTP(S) only, CORS-bound. Not needed to boot a shell.

## The guest image

The examples build Linux v6.1 + busybox by hand in docker; trynix should
build both with nix instead — the flake is on NixOS's side of the fence:

- an x86_64 kernel with virtio, 9p and serial built in (nixpkgs
  `linuxKernel` with a trimmed structured config);
- a busybox (pkgsStatic) initramfs whose init mounts the 9p share as
  `/nix/store`, mounts proc/sys/dev, sets PATH from a manifest file the
  page writes next to the store, and execs `sh` on ttyS0;
- packed with `file_packager` (or fed through `Module.FS` directly —
  the kernel and initramfs are files in MEMFS like everything else).

One kernel + initramfs serves every package, cached by the browser.

## Repository layout

- `site/` — the static site (vanilla ES modules today; the multiverse
  chrome and tokens, so the family of sites reads as one).
- `nix/` — the flake's pieces: `site.nix` assembles the deployable tree
  with the multiverse js.<hash> cache-busting trick, `formatter.nix` is
  `nix fmt`.
- `tests/` — node test suite; run by `checks.tests`, offline.
- `docs/` — this file and what follows it.

## Milestones

1. **Closure walk** (done): store path in, closure table and download
   price out, live from cache.nixos.org.
2. **NAR unpack**: xz + NAR decode in the browser, OPFS cache; "download
   this closure" becomes a real store tree in MEMFS.
3. **Boot**: qemu-wasm artifacts + nix-built kernel/initramfs; a shell
   over 9p with `hello` on PATH. The demo.
4. **Resolve**: the multiverse index shards wired into search — attr +
   version picker, the census gating the boot button.
5. **Coexistence**: grail's solver embedded — boot a world, "python
   3.10 with openssl 1.1", multiple packages on one PATH.
6. **Polish**: ghostty-web terminal, OPFS-persistent store, maybe
   networking via c2w-net-proxy.

## Open questions

- Where do the qemu-wasm artifacts build? The emsdk docker container is
  the upstream path; a nix-native emscripten build of the fork would fit
  this repo better but is unproven. Until one lands, artifacts are built
  out-of-band and vendored or fetched at site-build time.
- Runtime (post-boot) writes into the 9p share are plausible per the
  emscripten FS proxying model but unexercised upstream; milestone 3
  avoids depending on them.
- xz decode: a wasm liblzma vs the smaller decoder-only ports; measured
  against the closure sizes that matter (glibc's NAR is ~6 MiB xz).

[nixpkgs-multiverse]: https://github.com/fzakaria/nixpkgs-multiverse
[grail]: https://github.com/fzakaria/grail
[qemu-wasm]: https://github.com/ktock/qemu-wasm
[ghostty-web]: https://github.com/coder/ghostty-web
