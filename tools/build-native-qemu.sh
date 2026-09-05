#!/usr/bin/env bash
# Build a native qemu-system-x86_64 from the same qemu-wasm checkout the
# engine comes from. It exists only to take the migration snapshot
# (tools/make-snapshot.py): both ends of a migration must agree on
# QEMU version, machine type and devices, so nixpkgs' QEMU cannot
# stand in for an 8.2-based fork.
#
#   nix run .#build-native-qemu -- <qemu-wasm checkout> <output directory>
#
# Needs docker. Builds in the fork's own toolchain container (gcc 14
# with glib, pixman, libffi and libattr), statically, so the binary
# runs on any x86_64 Linux — a NixOS host included. The output
# directory receives qemu-system-x86_64.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <qemu-wasm checkout> <output directory>" >&2
  exit 2
fi
SRC_CHECKOUT=$1
OUT=$2

IMAGE=trynix-buildqemu-native
CONTAINER=trynix-build-native-$$
JOBS=$(nproc)

WORK=$(mktemp -d)
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
echo "copying $SRC_CHECKOUT to $WORK/src"
rsync -a --exclude .git "$SRC_CHECKOUT/" "$WORK/src/"

# The last stage of the fork's examples/x86_64/image/Dockerfile.qemu,
# without the kernel and rootfs stages in front of it that trynix
# builds with nix instead.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building the toolchain image $IMAGE"
  docker build -t "$IMAGE" - <<'EOF'
FROM gcc:14
RUN apt-get update && apt-get install -y libffi-dev libglib2.0-dev libpixman-1-dev libattr1 libattr1-dev ninja-build pipx
RUN PIPX_BIN_DIR=/usr/local/bin pipx install meson==1.5.0
WORKDIR /build
CMD sleep infinity
EOF
fi

# The same patches the engine gets, so the binary that takes the
# snapshot and the one that resumes it are the same QEMU.
# patches/0003 in particular only takes effect here, through the define
# below: it makes this build count the monotonic clock the WebAssembly
# build counts, so the guest calibrates its TSC against the clock it
# will actually run on.
PATCHES=${TRYNIX_PATCHES:-$(cd "$(dirname "$0")" && pwd)/../patches}
for patch in "$PATCHES"/*.patch; do
  [ -e "$patch" ] || continue
  echo "applying $(basename "$patch")"
  patch -d "$WORK/src" -p1 < "$patch"
done

docker run --rm -d --name "$CONTAINER" -v "$WORK/src:/qemu" "$IMAGE" >/dev/null
docker exec "$CONTAINER" /qemu/configure --static --target-list=x86_64-softmmu \
  --without-default-features --enable-system --with-coroutine=ucontext --enable-virtfs --enable-attr \
  --extra-cflags=-DQEMU_GENERIC_HOST_TICKS
docker exec "$CONTAINER" make -j "$JOBS" qemu-system-x86_64

mkdir -p "$OUT"
docker cp "$CONTAINER:/build/qemu-system-x86_64" "$OUT/qemu-system-x86_64"
ls -la "$OUT"
