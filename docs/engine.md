# Building the qemu engine

The browser runs [qemu-wasm] — QEMU compiled to WebAssembly with
emscripten. Three artifacts make up the engine:

```
out.js                        the ES6 module the page imports
qemu-system-x86_64.wasm       ~40 MB
qemu-system-x86_64.worker.js  the pthread bootstrap
```

A fourth file rides along in the same release, built by
`tools/make-snapshot.py`:

```
vm.state                      the migration snapshot, ~35 MB
```

None of them are in this repository and none are built by CI. The
engine needs docker and a pinned emscripten SDK and takes tens of
minutes; the snapshot needs a _native_ build of the same fork. Both
change only when the qemu-wasm pin, the patches, or the guest image
move — so they are built by hand and published as a release by
`tools/publish-engine.py`, which the site build fetches by hash into
`qemu/` (nix/engine.nix).

## Building

Clone [qemu-wasm] (this was written against `0ef7b4e2`, a fork of QEMU
8.2.0) and run its documented x86_64 recipe. Two deviations are needed:

1. **Build from a writable copy of the tree.** The README mounts the
   checkout read-only (`-v $(pwd):/qemu/:ro`), but meson runs
   `git init` for the `dtc` subproject inside it and fails on a
   read-only mount. Mount it writable, or `rsync` the tree somewhere
   scratch first.
2. **Fetch zlib from the GitHub mirror.** The Dockerfile pulls
   `https://zlib.net/zlib-$ZLIB_VERSION.tar.xz`, which answers curl with
   a bot-wall HTML page rather than the tarball; the release mirror
   (`https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/...`)
   serves the same file.

3. **Apply `patches/`.** `0001-9pfs-translate-emscripten-errnos-to-linux.patch`
   makes 9p report Linux errno numbers instead of emscripten's WASI
   ones. Without it no package can find a library by search; see
   docs/design.md.

Otherwise the recipe is upstream's verbatim — the emscripten flags
matter (`-sASYNCIFY`, `-pthread -sPROXY_TO_PTHREAD`,
`-sTOTAL_MEMORY=2300MB`, the xterm-pty `--js-library`, `-sEXPORT_ES6`)
and the configure line must keep `--enable-virtfs`, which is what makes
the 9p store share possible.

Rename `qemu-system-x86_64` (the JS glue) to `out.js` and keep the
other two names. They are published together with the snapshot, below.

## Taking the snapshot

The browser resumes a VM rather than booting one, and the snapshot has
to come from a _native_ build of the same fork — both ends of a
migration must agree on QEMU version, machine type and devices, which
rules out nixpkgs' QEMU. Build it with the fork's own
`examples/x86_64/image/Dockerfile.qemu` and `--with-coroutine=ucontext
--enable-virtfs --enable-attr`, then:

```console
$ nix build .#guest
$ python3 tools/make-snapshot.py --qemu ./qemu-system-x86_64 \
    --guest ./result --out vm.state
```

Retake it whenever the guest image changes: the snapshot holds that
kernel and initramfs in its RAM, and `checks.snapshot` fails when the
guest the tree builds is not the one the pins say the snapshot came
from.

## Publishing

Put the three engine files and `vm.state` in one directory and run

```console
$ python3 tools/publish-engine.py --dir <directory>
```

It creates a release tagged `engine-<UTC date>-<UTC time>`, uploads
the four files, and rewrites `nix/engine-pins.json` with the tag, the
hash of each file, and the hashes of the guest image the current tree
builds. Commit the pins with the change that needed them.

A tag is never reused. The pins of every commit in the history resolve
against the release they name, so replacing an asset in place would
break `nix build` on all of them; a fresh tag per publish costs some
release storage and nothing else.

## Serving locally

`nix run .#serve` overlays the engine from `vendor/qemu-wasm` in the
working directory (`$TRYNIX_QEMU_DIR` overrides), so put the three files
there and the local site boots exactly as the deployed one does.
`vendor/` is gitignored.

## Why not build it with nix

nixpkgs has an emscripten toolchain, so a nix-native build of the fork
is plausible and would fit this repo better than a docker recipe. It is
unproven: the Dockerfile builds zlib, libffi, glib and pixman for wasm32
with hand-patched configs first, and glib in particular needs the
`sed`-out of several `HAVE_*` probes. Worth attempting once the rest
settles; until then the release asset is the contract.

[qemu-wasm]: https://github.com/ktock/qemu-wasm
