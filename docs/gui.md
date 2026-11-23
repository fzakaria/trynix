# GUI programs

A Wayland program from nixpkgs, run in the unkernel guest, opens a
window on the page. foot, GTK 3 programs and GL programs through Mesa
have been run this way. Everything runs in the tab: the guest, the
relay that carries the program's protocol, the compositor that draws
its windows and the GL renderer. There is no server, and the host's
own display is never involved.

Only the unkernel engine has this. The qemu engine's guest has no
device a compositor could read a program's pixels through.

## Using it

Select the program and boot, then type its name at the shell:

```
https://trynix.dev/?pkg=foot&boot=1        then: foot &
https://trynix.dev/?pkg=galculator&boot=1  then: galculator &
```

The first window opens a desktop under the terminal, and every window
after it goes there too. Windows move by their title bar or by
Alt+drag, and take the keyboard when clicked.

GL programs need a driver, and the page does not add one unasked:
nixpkgs' Mesa carries LLVM for llvmpipe, and Mesa's closure is 300 MB
compressed. Select `mesa` beside the program:

```
https://trynix.dev/?pkg=mesa-demos&pkg=mesa&boot=1  then: es2gears_wayland &
```

When the closure holds a Wayland program that links libglvnd and no
Mesa, the status line says so.

## How it works

```
 guest (aarch64, unkernel)                 page
 ─────────────────────────                 ────
 foot ──wayland──> wlandr ──vsock 1023──>  wland compositor (wasm) ──> #desktop
   │                                          ▲
   └─ wl_shm buffer ── /dev/kwshm ────────────┘  read in place
 es2gears ── Mesa virgl ── virtio-gpu ──────> virglrenderer (wasm) on WebGL2
                                              └─> frame by GPU resource ──┘
```

[site/js/gui.js](../site/js/gui.js) has both halves.

The guest half is wland's relay, `wlandr`, a 353 KB static aarch64
binary built from source ([nix/wlandr.nix](../nix/wlandr.nix)).
unkernel's base system has no relay (only its Debian image ships one),
so the site serves it. When a NAR whose name is libwayland's arrives,
the page fetches the relay and the fonts while the rest of the closure
downloads, writes them into the share under `/share/gui`, and starts
the relay before it reports the shell ready. Every shell gets
`WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR` and the toolkit hints
(`GDK_BACKEND`, `QT_QPA_PLATFORM`, `SDL_VIDEODRIVER` and the rest), so
a program started plainly picks Wayland.

The relay dials the page only when the first program connects
(`--link-on-demand`), and the page loads wland on that first dial. A
boot that runs no GUI program fetches no compositor.

Pixels do not cross the link. A program's shared-memory buffers are
exported through unkernel's kwshm device, and the compositor reads
them from the kernel's memory. A GL program renders through Mesa's
virgl driver on the guest's virtio-gpu device, which unkernel backs
with virglrenderer compiled to wasm on a WebGL2 context of the page.
The relay names such a buffer by its GPU resource
(`--dmabuf virtgpu`), and the compositor takes the resource's picture
from the renderer as an ImageBitmap, with no readback.

The kernel always boots with kwshm and the virtio-gpu device, since
which programs a reader will run is not known at boot. Neither costs
anything until a program uses it: `boot-test`'s hello boot took a
median 2.1 s before this and 1.7 s after, six runs each.

A few things the guest lacks, the page supplies:

- **Fonts.** nixpkgs' GUI programs carry fontconfig but no font, and
  nixpkgs' fontconfig reads `/etc/fonts`, which the guest does not
  have. The site ships DejaVu Sans and Sans Mono and a `fonts.conf`
  that names them and maps `monospace`, `sans-serif` and `serif`.
- **The GL driver link.** nixpkgs' libglvnd and libgbm look for the
  driver in `/run/opengl-driver`, as on NixOS. A NAR holding Mesa's
  `50_mesa.json` becomes that link in the guest.
- **The handshake.** foot starts a shell that inherits `ENV` and
  sources the manifest; the manifest now reads the page's handshake
  line only in the shell on the page's terminal.

## What it costs

Measured 2026-11-23 on a laptop (AMD Radeon 780M), headless Chromium
157, through `nix run .#gui-test`. The closures come from
cache.nixos.org over a home connection.

What the site adds, fetched only when used:

| file                         | raw     | gzip   | fetched                         |
| ---------------------------- | ------- | ------ | ------------------------------- |
| wland modules and wasm       | 383 KB  | 109 KB | on the relay's first dial       |
| relay (`wlandr`)             | 353 KB  | 149 KB | when the closure has libwayland |
| DejaVu Sans and Sans Mono    | 1.10 MB | 587 KB | when the closure has libwayland |
| `virgl.mjs` and `virgl.wasm` | 597 KB  | 216 KB | on the guest's first GL use     |

The closures, from the cache, for the paths the nixpkgs this flake
locks builds (the page resolves names against the multiverse index,
which can pick a newer build; its Mesa was 26.3.1 against the lock's
26.2.2):

| selection         | paths | compressed | unpacked |
| ----------------- | ----- | ---------- | -------- |
| foot              | 36    | 29 MB      | 115 MB   |
| mesa-demos + mesa | 133   | 380 MB     | 1.47 GB  |

The unpacked closure is held in the page's memory, so a GL boot asks
the browser for 1.5 GB before the guest does anything. LLVM is 145 MB
of the compressed size and python3 61 MB (Mesa ships two python
scripts in `bin/`).

Time and frame rate:

| program                 | shell after | first frame after the command |
| ----------------------- | ----------- | ----------------------------- |
| foot                    | 2.8–3.7 s   | 0.8–0.9 s                     |
| galculator              | 8.0 s       | 2.8 s                         |
| es2gears_wayland + mesa | 26–43 s     | 3.1–3.7 s                     |

es2gears' first frame is mostly the guest loading Mesa (libgallium and
libLLVM) under the emulator; the GL renderer itself loads in 0.06 s on
the GPU and 0.12 s on SwiftShader. es2gears runs at 60 FPS on both,
paced by the compositor's frame callbacks at the page's refresh rate.
glmark2-es2-wayland at 640x480, which does not wait for the
compositor:

| scene          | Radeon 780M | SwiftShader |
| -------------- | ----------- | ----------- |
| build          | 855 FPS     | 176 FPS     |
| texture        | 841 FPS     | 187 FPS     |
| shading, phong | 1107 FPS    | 146 FPS     |
| score          | 933         | 168         |

## Limits

- **Mesa's size.** A Mesa with only the virgl driver would need no LLVM
  and would be a fraction of the closure, but no cache serves one for
  aarch64. Building one and publishing it to trynix.cachix.org, as the
  example databases are, is the way out.
- **Mesa and the program from different nixpkgs.** `pkg=mesa` resolves
  to the newest Mesa in the index, which may be built against a newer
  glibc than the program. The driver is loaded into the program's
  process, so a Mesa that needs symbols the program's glibc lacks fails
  to load. Pinning Mesa to the program's nixpkgs revision would need
  the multiverse to say which revision a path came from.
- **No X11.** There is no Xwayland in the guest, so programs with only
  an X11 backend do not start.
- **Reloads end the programs**, as they end the guest: the page boots a
  fresh kernel every time.
- **Keyboard layout** is US, which is wland's.
- **`/root` does not exist** in unkernel's base system, so programs
  that write settings under `$HOME` complain and carry on.
- **Browsers.** Chromium is what `gui-test` runs. Firefox has not been
  run here: wland's own smoke test passes on Firefox 160 headless, and
  unkernel's GL renderer is reported to work there, but neither has
  been checked through trynix. Safari has not been run at all.

## Testing

`nix run .#gui-test -- --site <site>` boots foot and es2gears from
links, starts each at the shell and waits for the compositor's first
frame. It types into foot's window and checks that the keys reached the
program, and checks that es2gears' frames went through the page's GL
renderer by GPU resource and not through llvmpipe. `--gpu hardware`
draws WebGL with the host's GPU instead of SwiftShader, and
`--screenshots <dir>` saves each window.

[tests/site/gui.test.mjs](../tests/site/gui.test.mjs) covers what the
page writes into the share and runs in the guest, offline.

## Updating it

wland is pinned twice, and the two must name the same commit: the npm
release in [nix/vendor.nix](../nix/vendor.nix) (the compositor) and
the source in [nix/wlandr.nix](../nix/wlandr.nix) (the relay). The
relay and the compositor speak one stream protocol.

## Licenses

The pieces the site ships for this, and their terms, travel in the
site next to the files:

- wland's relay and compositor wasm are MPL-2.0, its JavaScript MIT
  (`gui.<hash>/LICENSE-wland`). The relay is built from the upstream
  commit named in `nix/wlandr.nix`, unmodified.
- unkernel's SDK is MIT and its kernel GPL-2.0
  (`vendor/unkernel/LICENSE`, `LICENSE-MIT`). `virgl.wasm` is
  virglrenderer and parts of Mesa, both MIT; unkernel's releases after
  the one pinned carry those notices in a `THIRD-PARTY.md`, which
  should be shipped beside it once the pin moves past it.
- DejaVu fonts are Bitstream Vera's license with public-domain changes
  (`gui.<hash>/LICENSE-dejavu`).
- The programs and Mesa come from cache.nixos.org and keep nixpkgs'
  licenses, as every other package the page boots does.
