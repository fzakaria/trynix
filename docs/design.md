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
3. **Fetch and unpack.** A NAR arrives xz or zstd compressed depending
   on when it was built; both decoders are vendored. The tree is
   written into emscripten's filesystem via `Module.FS` under the
   share. Compressed NARs are kept in the Cache API — a store path is
   immutable, so a cached NAR can never be stale.
4. **Boot.** qemu-wasm with a prebuilt guest kernel and a tiny initramfs.
   The store enters the guest over virtio-9p; init mounts it, symlinks
   `/nix/store`, puts the selected outputs' `bin/` on PATH, and execs a
   shell on the serial console.
5. **Terminal.** [ghostty-web] — libghostty-vt, the parser the native
   app uses, compiled to wasm — with xterm.js as the fallback. The pty
   is bridged by hand, because xterm-pty's addon wants an `onBinary`
   ghostty does not implement.

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
- a busybox (pkgsStatic) initramfs whose init mounts the 9p share at
  `/share`, symlinks `/nix` into it, sources the manifest the page
  wrote, and execs `sh` on ttyS0;
- packed with `file_packager` (or fed through `Module.FS` directly —
  the kernel and initramfs are files in MEMFS like everything else).

One kernel + initramfs serves every package, cached by the browser.

## Start time

Booting under emulation is the slow path — the upstream Alpine demo
pays for a big eager download, then a full BIOS/kernel/OpenRC boot on
a cold JIT (blocks are interpreted until their 1500th execution, and
boot code runs once). The fix is in the fork already:
`examples/migration/` snapshots a VM on a _native_ build of the same
tree (`migrate file:vm.state` in the monitor) and the browser build
resumes it with `-incoming file:vm.state`, skipping boot entirely.

The trynix shape — one generic snapshot serves every package
selection, because the selection rides the 9p share, not the snapshot:

1. At image-build time, boot the guest natively
   (`--with-coroutine=ucontext`, no emscripten) to the point where init
   has done the one-time work and waits — deliberately before mounting
   the 9p share, so the snapshot holds no open filesystem state against
   a share whose contents change per session. Snapshot and compress; a
   just-booted minimal guest is mostly zero pages, which the migration
   stream elides.
2. On page load, fetch qemu artifacts and snapshot (service-worker /
   OPFS cached — warm visits skip the download) in parallel with the
   closure NARs going into the MEMFS share via `Module.FS`.
3. Start with `-incoming`: resume is RAM-load plus device restore,
   seconds rather than a boot.
4. The page signals the guest (a line on the serial console), init
   mounts the share, reads the manifest the page wrote (store paths,
   what goes on PATH), and execs the shell.

Two details the implementation forced. QEMU refuses to migrate a VM
that has a virtfs export mounted, so init has to wait for the
handshake _before_ mounting rather than polling a mounted share — which
is also why the first mount always sees a finished share. And a VM
restored from a migration stream arrives stopped: `-nographic` muxes
the monitor onto the guest's console, so the page types `cont` there
(Ctrl-A c toggles) before handing the guest its newline.

Measured: a resume reaches a shell in about 17 seconds against a cold
boot's minute-plus, and that is before the engine and snapshot are
served from the browser cache.

Migration demands that snapshotter and restorer agree exactly — QEMU
version, machine type, device config, RAM size. A liability for a
hand-run flow; a non-issue here, where both builds come from the same
pinned fork in the same flake.

Budget: cold visit ≈ parallel downloads + a few seconds of resume;
warm visit ≈ closure download only, itself OPFS-cached per NAR.

## Where emscripten and the guest disagree

Three bugs, all in the seam between emscripten's filesystem and a real
Linux guest reading it over 9p. Each one is invisible until a package
does something more than `hello` does, and each is worth knowing before
changing this code.

**Symlinks.** `FS.readlink` resolves a link against its parent and
returns an absolute path, while the stat beside it reports the
_relative_ target's length. A guest reading such a link gets a string
longer than the size it was promised. trynix writes absolute targets
itself (`absoluteTarget` in `site/js/store.js`) so the two agree, and
mounts the share in the guest at the same path the page built it at
(`/share`) so those absolute targets resolve. The mount point is
load-bearing, not cosmetic.

**Errnos.** 9p2000.L carries Linux errno numbers, but emscripten's libc
numbers its errnos after WASI. qemu-wasm declares emscripten to need no
translation, so ENOENT (44 in WASI, 2 in Linux) reaches the guest as
ECHRNG. A dynamic loader walking `LD_LIBRARY_PATH` expects ENOENT from
directories that lack the library and moves on; given "Error 44" it
stops. Every package that finds libraries by search rather than by
RPATH fails to start, naming a library `ls` will show and `cat` will
read. `patches/0001-9pfs-translate-emscripten-errnos-to-linux.patch`
fixes it in the engine, and is worth sending upstream.

**stdout.** Defining `Module.print` or `printErr` takes stdout and
stderr away from the xterm-pty js-library linked into the build, and
the console stays blank for the whole run — guest output included.
QEMU's diagnostics arrive in the terminal instead.

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
2. **NAR unpack** (done): xz and zstd decode in the browser, the Cache
   API holding the compressed NARs.
3. **Boot** (done): qemu-wasm artifacts + a nix-built kernel and
   initramfs; a shell over 9p with the selection on PATH. The
   migration snapshot (see "Start time") makes starting a resume.
4. **Resolve** (done): the multiverse index read live — search over
   every attribute, versions with their closure sizes, the census
   hiding paths the cache no longer serves, and a version-range lane.
5. **Terminal** (done): libghostty-vt, with xterm.js as the fallback.
6. **Next**: lazy per-NAR 9p so a boot fetches only what the guest
   touches; grail's clingo solver embedded for real coexistence
   answers; networking via c2w-net-proxy; and sending the errno patch
   upstream.

## Alternatives considered

qemu-wasm's own README names the prior art; none of it can run the
x86_64 binaries cache.nixos.org holds, which is the requirement that
decides everything:

- **JSLinux** (bellard.org/jslinux) emulates a 64-bit x86 CPU — AVX-512
  and APX included — and boots in seconds, but that engine's source is
  unreleased: the published TinyEMU (2019-12-21, MIT) carries only the
  old 32-bit x86 and the RISC-V emulators, and its vfsync filesystem
  and websocket VPN are services on bellard.org. Nothing to build on
  today; a future source release would be worth revisiting as a
  smaller, faster backend.
- **v86** is fast and maintained but 32-bit x86 by design; i686
  nixpkgs is not substitutable at any depth of history that matters.
- **qemu.js** (the frozen port) predates wasm threads and asyncify;
  qemu-wasm is that idea done with them.
- **Unicorn.js** is QEMU's CPU core extracted for binary analysis — no
  devices, nothing boots.

JSLinux still contributes the design worth stealing: vfsync faults the
root filesystem in over HTTP per file as the guest touches it, which is
why it boots instantly. The equivalent here — a 9p backend that fetches
and unpacks a store path's NAR on the guest's first access to it,
instead of downloading the whole closure before boot — is the intended
future shape of pipeline step 3; per-NAR granularity is coarser than
vfsync's per-file, but a closure's cold-boot cost drops to the paths a
command actually touches. qemu-wasm has no such hook, so lazy 9p means
writing an emscripten FS backend (or a QEMU fsdev) ourselves; the eager
walk-fetch-unpack path stays as milestone 2-3 and the lazy backend
replaces it underneath, invisible to the rest.

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
