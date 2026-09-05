# Building the qemu engine

The browser runs [qemu-wasm] — QEMU compiled to WebAssembly with
emscripten. Three artifacts make up the engine:

```
out.js                        the ES6 module the page imports
qemu-system-x86_64.wasm       ~13 MB, stripped of its DWARF
qemu-system-x86_64.worker.js  the pthread bootstrap
```

A fourth file rides along in the same release:

```
vm.state                      the migration snapshot, ~35 MB
```

None of them are in this repository and none are built by CI. The
engine needs docker and a pinned emscripten SDK and takes tens of
minutes; the snapshot needs a _native_ build of the same fork. They
change only when the qemu-wasm pin, the patches, or the guest image
move, so they are built by hand with the tools below and published as
a release, which the site build fetches by hash into `qemu/`
(nix/engine.nix).

Every tool is a flake app. Each needs a checkout of [qemu-wasm] at the
pinned commit (`0ef7b4e2`, a fork of QEMU 8.2.0) and docker on the
host.

## The engine

```console
$ nix run .#build-engine -- ~/src/qemu-wasm ./engine
```

This is the fork's own recipe, with three deviations that
`tools/build-engine.sh` carries so nobody has to remember them: the
tree is copied somewhere writable first (meson runs `git init` for the
`dtc` subproject and fails on the read-only mount the fork's README
suggests), zlib is fetched from the GitHub release mirror (zlib.net
answers curl with a bot-wall page), and `patches/` are applied.

The patches matter more than the build flags:

- `0001-9pfs-translate-emscripten-errnos-to-linux.patch` makes 9p
  report Linux errno numbers instead of emscripten's WASI ones.
  Without it no package can find a library by search (docs/design.md).
- `0002-9p-local-resolve-a-path-in-one-syscall-under-emscripten.patch`
  opens and stats a path in one syscall instead of one per component.
  Under emscripten each syscall is a round trip to the browser's main
  thread, and the share is a private in-memory directory with nothing
  for the component walk to protect.

Otherwise the emscripten flags are upstream's verbatim (`-sASYNCIFY`,
`-pthread -sPROXY_TO_PTHREAD`, `-sTOTAL_MEMORY=2300MB`, the xterm-pty
`--js-library`, `-sEXPORT_ES6`), and the configure line keeps
`--enable-virtfs`, which is what makes the 9p store share possible.

## The native QEMU

```console
$ nix run .#build-native-qemu -- ~/src/qemu-wasm ./native
```

The browser resumes a VM rather than booting one, and the snapshot has
to come from a native build of the same fork: both ends of a migration
must agree on QEMU version, machine type and devices, which rules out
nixpkgs' QEMU. The binary is static, so it runs on a NixOS host.

## The snapshot

```console
$ nix build .#guest
$ nix run .#make-snapshot -- --qemu ./native/qemu-system-x86_64 \
    --guest ./result --out ./engine/vm.state
```

The tool boots the guest natively, waits for init to park on its
handshake, and migrates the running VM to a file. QEMU's arguments
come from the guest image's `machine.json`, which the page starts QEMU
from as well; that file is the one description of the machine.

Retake the snapshot whenever the guest image changes — a new kernel,
initramfs or machine definition. The snapshot holds the kernel and
initramfs in its RAM, and `checks.snapshot` fails when the guest the
tree builds is not the one the pins say the snapshot came from.

## Publishing

```console
$ nix run .#publish-engine -- --dir ./engine --guest ./result
```

The directory holds the three engine files and `vm.state`. The tool
creates a release tagged `engine-<UTC date>-<UTC time>`, uploads the
four files, and rewrites `nix/engine-pins.json` with the tag, the hash
of each file, and the hashes of the guest image. Commit the pins with
the change that needed them.

A tag is never reused. The pins of every commit in the history resolve
against the release they name, so replacing an asset in place would
break `nix build` on all of them; a fresh tag per publish costs some
release storage and nothing else.

## Serving locally

`nix run .#serve` serves exactly the tree `nix build .#site` produces,
engine and snapshot included. `TRYNIX_QEMU_DIR=<directory>` overlays
a locally built engine (and a `vm.state` beside it) over `qemu/`, for
trying a build before publishing it.

## Hosting and cross-origin isolation

The page is cross-origin isolated (COOP/COEP), which SharedArrayBuffer
needs. GitHub Pages cannot set response headers, so the site loads
`coi-serviceworker.js`, a shim that registers a service worker and
reloads the page so that worker can inject the two headers.

`site/_headers` sets the headers directly on a host that reads such a
file (Cloudflare Pages, Netlify). It is inert on GitHub Pages, and the
shim registers nothing once the page is already cross-origin isolated,
so the tag stays in `index.html` as the fallback for both.

What the move is worth, measured on localhost with the 13 MB engine
booting hello, page load to the guest prompt:

    coi shim        3.42 s cold    2.25 s warm
    real headers    2.95 s cold    2.28 s warm

So the shim costs about half a second on a first-ever visit, which is
the extra reload, and nothing afterwards. Compiling the engine is 56 ms
either way, so the browser's compiled-WebAssembly cache is not a reason
to move: an earlier note held that a service worker defeats that cache,
and these numbers do not support it. Move `trynix.dev` to Cloudflare
Pages (build `nix build .#site`, output `result/`) for control over
headers and caching, not for speed.

## Why not build it with nix

nixpkgs has an emscripten toolchain, so a nix-native build of the fork
is plausible and would fit this repo better than a docker recipe. It is
unproven: the Dockerfile builds zlib, libffi, glib and pixman for wasm32
with hand-patched configs first, and glib in particular needs the
`sed`-out of several `HAVE_*` probes. Worth attempting once the rest
settles; until then the release asset is the contract.

[qemu-wasm]: https://github.com/ktock/qemu-wasm
