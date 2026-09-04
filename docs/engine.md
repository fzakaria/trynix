# Building the qemu engine

The browser runs [qemu-wasm] — QEMU compiled to WebAssembly with
emscripten. Three artifacts make up the engine:

```
out.js                        the ES6 module the page imports
qemu-system-x86_64.wasm       ~40 MB
qemu-system-x86_64.worker.js  the pthread bootstrap
```

They are **not** in this repository and are not built by CI. The build
needs docker and a pinned emscripten SDK, takes tens of minutes, and the
output changes only when the qemu-wasm pin moves — so it is built by
hand and uploaded once to the `engine` release tag, which the pages
workflow downloads into `qemu/`.

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
