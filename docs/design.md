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

1. **Resolve.** Attribute (and optionally a version range) to one or
   more store-path digests, from static index shards. A package split
   across outputs gets its `bin` sibling too, from a digest-keyed map
   the site build shards out of a multiverse release artifact
   (nix/outputs.nix).
2. **Walk.** Breadth-first over narinfos from cache.nixos.org to the
   full runtime closure, and verify every signature against the
   configured keys. The cache serves `access-control-allow-origin: *`,
   so plain `fetch` works from any origin. Narinfos are kept in the
   Cache API like everything else immutable, so a walk done once costs
   no network again.
3. **Fetch and unpack, streaming.** A NAR arrives xz or zstd compressed
   depending on when it was built; both decoders are vendored. Each is
   parsed and written into emscripten's filesystem under the share the
   moment it lands, while the rest are still downloading and the engine
   is still compiling. Compressed NARs are kept in the Cache API — a
   store path is immutable, so a cached NAR can never be stale.
4. **Resume.** qemu-wasm with a prebuilt guest kernel and initramfs,
   resumed from a migration snapshot rather than booted (below). The
   store enters the guest over virtio-9p; init mounts it, sources the
   manifest the page wrote, and execs a shell on the serial console.
5. **Terminal.** [ghostty-web] — libghostty-vt, the parser the native
   app uses, compiled to wasm. The pty is xterm-pty's line discipline,
   which the engine was linked against, bridged by hand.

## The store share

The guest sees the page's directory `/share` through 9p, mounted at the
same path, with `/nix` a symlink into it:

```
/share/nix/store/<basename>/...   the fetched closure
/share/bin/<program> -> /nix/store/<basename>/bin/<program>
/share/manifest                   PATH, TERM, LANG, and `resize`
```

`/share/bin` is a farm of symlinks, one per program in the closure, and
the one directory the guest keeps on PATH. What the reader selected is
linked first and wins a name collision; the rest of the closure only
fills names still free, so a dependency never shadows a selection. It
is what makes adding a package to a running VM silent: the page writes
the new store paths and links, 9p shows them to the guest the moment
they exist, and the new selection's links replace old ones so the most
recent choice runs. Nothing is typed at the guest's shell. (The shell
remembers a command it has already run at its old path until
`hash -r`.)

The manifest sets PATH, and the three things a serial console session
lacks: a window size (`resize` asks the terminal where a cursor parked
in the far corner landed and sets the tty from the answer; nothing
else carries the browser's resize events into a 16550), a TERM
(`xterm-256color`, the one name every era's ncurses knows; ghostty's
own `xterm-ghostty` needs a terminfo only very recent ncurses
carries), and a locale (`C.UTF-8`, built into glibc since 2.35; an
older closure falls back to C, and perl says so). Deliberately not an
LD_LIBRARY_PATH: one over the closure would override every binary's
own DT_RUNPATH and hand two eras of glibc to each other's loader —
that is how ripgrep beside lolcat died before it was removed.

## Start time

Everything is measured in headless Chromium on a warm cache. Page open
to a shell prompt is about 3 seconds:

| stage                                             | about  |
| ------------------------------------------------- | ------ |
| closure walk (cached narinfos)                    | 0.1 s  |
| engine instantiated (wasm from the HTTP cache)    | 1.0 s  |
| QEMU up, migration stream loaded, guest answering | +1.5 s |
| guest mounts the share and starts the shell       | +0.5 s |

What got it there, and what was tried and dropped:

- **The snapshot.** Booting under emulation is the slow path — BIOS,
  kernel and init on a cold JIT take a minute. The fork's
  `examples/migration/` snapshots a VM on a _native_ build of the same
  tree and the browser build resumes it with `-incoming`. The guest
  image boots to the point where init has done its one-time work and
  parks on a `read`, deliberately before mounting the share: QEMU
  refuses to migrate a VM with a virtfs export mounted, and it also
  means one snapshot serves every package selection. On resume the
  page hands the guest a newline and it mounts whatever share the page
  built.
- **No monitor conversation.** A restored VM whose source was running
  starts running; the migration stream carries the runstate. The page
  used to toggle to QEMU's monitor, type `cont`, and toggle back, with
  a settling delay around each keystroke — three seconds of nothing.
- **Polling the handshake.** The first newline of a resume is lost —
  the UART it lands in is overwritten by the restore — and nothing
  says when the restore is done. Retrying after four seconds was most
  of the remaining time; the page now offers a newline every 300 ms
  until the guest says anything. The spares queue in the UART and
  reach the guest together, so the manifest drains them before
  anything reads the tty, and the page has the shell redraw its prompt
  with Ctrl-L after clearing the console.
- **Streaming instantiation.** The wasm is not fetched by the page.
  emscripten streams it from its URL, which compiles while downloading
  and lets the browser keep the compiled code across visits — neither
  happens for a buffer the page passes in. The page only warms the
  HTTP cache, with a progress bar. On GitHub Pages the COOP/COEP
  service worker synthesises the response, which loses the compiled
  code cache; a host that sets the headers itself would keep it.
- **Guest RAM.** A 256M guest resumes about 0.3 s faster than 512M
  (the migration load touches every page) and its snapshot is 5 MB
  smaller. Not worth halving the guest for; 512M stays.

Migration demands that snapshotter and restorer agree exactly — QEMU
version, machine type, device config, RAM size. `nix/guest/machine.json`
is the one description of the machine; the page and the snapshot tool
both start QEMU from it, and its hash rides in the pins.

## Memory

The closure lives once, in emscripten's in-memory filesystem, as the
decompressed NAR buffers themselves: MEMFS is told to keep the views
it is handed (`canOwn`) rather than copy them. The page never holds
more than the few NARs in flight, and once the guest is at its prompt
the kernel, initramfs and snapshot copies in `/pack` are unlinked
(QEMU has read them; the snapshot alone is 35 MB). Before this the
whole closure existed three times over — compressed, decompressed,
and copied into MEMFS — and a large one ran the tab out of room, which
surfaces as a bare "TypeError: Failed to fetch".

The ceiling that remains is the closure's unpacked size, in the tab.
The way past it is a share that decompresses a NAR on the guest's
first touch of it rather than up front, keeping the compressed bytes
until then. Fetching lazily is not possible against cache.nixos.org,
which serves compressed NARs only; decompressing lazily is, and needs
an emscripten filesystem node whose contents are produced on first
read.

## Speed

The guest runs on the fork's wasm TCG backend: a translation block is
interpreted until its 1500th execution, then compiled to a small wasm
module. Measured in the guest, both loops of ten:

| workload                        | before | after |
| ------------------------------- | ------ | ----- |
| exec of `hello` (dynamic, 9p)   | 8.6 s  | 1.1 s |
| exec of busybox `true`          | —      | 0.3 s |
| `cat` of a file on the share    | —      | 0.7 s |
| 20 000 iterations of `$((i+1))` | 7.7 s  | 7.7 s |

Where the exec time went, and what was done:

- **9p with no cache.** The share was mounted `cache=none`: every exec
  walked every path component and read glibc over the wire again.
  `cache=loose` keeps dentries, inodes and page cache in the guest; the
  store is immutable so nothing cached goes stale, and 9p drops
  negative dentries so a name that was missing once is looked up
  again — which is what lets packages be added later.
- **Mitigations.** Page-table isolation and friends make every syscall
  flush the emulated TLB. The guest has nothing to protect from itself
  and runs with `mitigations=off`.
- **One syscall per 9p operation.** Under emscripten every filesystem
  syscall is a synchronous round trip to the browser's main thread,
  and QEMU's local backend opened a path one component at a time to
  keep a symlink from escaping the export. The share is a private
  in-memory directory; `patches/0002` opens and stats a path in one
  call. Worth 10–25% on file operations once the guest caches.
- **A lower JIT threshold** (300 instead of 1500) was built and
  measured: slower on both loops, since short-lived processes pay the
  compile and never amortise it. Not adopted.

What is left is emulation itself: a shell loop runs about 400 µs per
iteration, and a fork-plus-exec about 30 ms even with nothing on 9p.
Nothing in a browser accelerates that — there is no KVM — so the
levers are the emulator's. JSLinux's x86 engine (the one that boasts
AVX-512 and APX) is unreleased, TinyEMU has no x86_64, v86 is 32-bit;
an aarch64 guest on qemu-wasm's aarch64 target is the one untried
experiment with any chance of a different constant, and the multiverse
has aarch64-linux data to feed it.

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

And one thing that is not a bug: busybox's `clear` sends only the
erase-screen sequence, so the terminal's scrollback survives it. The
`clear` from ncurses sends erase-scrollback too, and a guest with it
on PATH behaves as expected.

## Repository layout

- `site/` — the static site (vanilla ES modules; the multiverse chrome
  and tokens, so the family of sites reads as one).
- `nix/` — the flake's pieces: `site.nix` assembles the deployable tree
  with the multiverse js.<hash> cache-busting trick, `guest.nix` builds
  the kernel and initramfs, `engine.nix` fetches the pinned engine,
  `formatter.nix` is `nix fmt`.
- `patches/` — what the engine is built with.
- `tools/` — the engine tools, each a flake app (docs/engine.md).
- `tests/` — node test suite; run by `checks.tests`, offline.
- `docs/` — this file and docs/engine.md.

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
why it boots instantly. The equivalent here is the lazy-decompressing
share described under Memory.

## Open questions

- A nix-native emscripten build of the fork, so the engine is a
  derivation rather than a docker recipe (docs/engine.md).
- The compiled-code cache on GitHub Pages: the COOP/COEP service worker
  costs it. A host that sends the headers (Cloudflare Pages takes a
  `_headers` file) would drop the worker and keep the cache.
- Autocompleting store paths in the store-path lane needs an index
  keyed by digest, which the multiverse does not publish; its shards
  are keyed by attribute.
- An aarch64 guest, as the one emulation experiment left.

[nixpkgs-multiverse]: https://github.com/fzakaria/nixpkgs-multiverse
[grail]: https://github.com/fzakaria/grail
[qemu-wasm]: https://github.com/ktock/qemu-wasm
[ghostty-web]: https://github.com/coder/ghostty-web
