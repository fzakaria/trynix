#!/usr/bin/env bash
# Build the qemu-wasm engine: QEMU compiled to WebAssembly with
# emscripten, from a checkout of the fork, with this repository's
# patches applied. docs/engine.md explains the recipe; this is it as a
# command.
#
#   nix run .#build-engine -- <qemu-wasm checkout> <output directory>
#
# Needs docker. The first run builds the fork's toolchain image
# (emscripten/emsdk plus zlib, libffi, glib and pixman cross-built for
# wasm32), which takes a while; later runs reuse it. The QEMU build
# itself takes tens of minutes on a laptop.
#
# The output directory receives out.js, qemu-system-x86_64.wasm and
# qemu-system-x86_64.worker.js, ready for tools/publish-engine.py.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <qemu-wasm checkout> <output directory>" >&2
  exit 2
fi
SRC_CHECKOUT=$1
OUT=$2
HERE=$(cd "$(dirname "$0")" && pwd)
PATCHES=$HERE/../patches

IMAGE=trynix-buildqemu
CONTAINER=trynix-build-engine-$$
JOBS=$(nproc)

# The emscripten flags are upstream's, verbatim: they decide the ABI
# the page's xterm-pty and the snapshot rely on.
EXTRA_CFLAGS="-O3 -g -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=mimalloc --js-library=/build/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js"
EXTRA_LDFLAGS="-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS"

# A writable copy of the tree: meson runs `git init` for the dtc
# subproject, which fails on the read-only mount upstream's README
# suggests, and the patches have to be applied somewhere.
WORK=$(mktemp -d)
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
echo "copying $SRC_CHECKOUT to $WORK/src"
rsync -a --exclude .git "$SRC_CHECKOUT/" "$WORK/src/"

for patch in "$PATCHES"/*.patch; do
  echo "applying $(basename "$patch")"
  patch -d "$WORK/src" -p1 < "$patch"
done

# The toolchain image. zlib.net answers curl with a bot-wall page, so
# the Dockerfile is pointed at the GitHub release mirror first.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building the toolchain image $IMAGE"
  sed 's|https://zlib.net/zlib-$ZLIB_VERSION.tar.xz|https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.xz|' \
    "$WORK/src/Dockerfile" | docker build -t "$IMAGE" -
fi

docker run --rm -d --name "$CONTAINER" -v "$WORK/src:/qemu" "$IMAGE" >/dev/null
docker exec "$CONTAINER" emconfigure /qemu/configure --static --target-list=x86_64-softmmu --cpu=wasm32 --cross-prefix= \
  --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs \
  --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" --extra-ldflags="$EXTRA_LDFLAGS"
docker exec "$CONTAINER" emmake make -j "$JOBS" qemu-system-x86_64

# The -g flag emits ~24 MB of DWARF into the ~41 MB wasm, none of it
# read at runtime; strip it so the browser downloads and compiles a
# third of the bytes. llvm-strip drops the .debug_* custom sections and
# keeps the name section, so a profile still shows function names.
docker exec "$CONTAINER" /emsdk/upstream/bin/llvm-strip --strip-debug /build/qemu-system-x86_64.wasm

mkdir -p "$OUT"
docker cp "$CONTAINER:/build/qemu-system-x86_64" "$OUT/out.js"
docker cp "$CONTAINER:/build/qemu-system-x86_64.wasm" "$OUT/qemu-system-x86_64.wasm"
docker cp "$CONTAINER:/build/qemu-system-x86_64.worker.js" "$OUT/qemu-system-x86_64.worker.js"
ls -la "$OUT"
