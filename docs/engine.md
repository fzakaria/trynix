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
move — so they are built by hand and uploaded to the `engine` release
tag, which the pages workflow downloads whole into `qemu/`.

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

Rename `qemu-system-x86_64` (the JS glue) to `out.js`, keep the other
two names, and upload all three:

```console
$ gh release create engine --title "qemu-wasm engine" --notes "qemu-wasm 0ef7b4e2, x86_64-softmmu"
$ gh release upload engine out.js qemu-system-x86_64.wasm qemu-system-x86_64.worker.js --clobber
```

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
$ gh release upload engine vm.state --clobber
```

Retake it whenever the guest image changes: the snapshot holds that
kernel and initramfs in its RAM.

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
