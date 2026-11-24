# GUI programs

A Wayland program from nixpkgs, run in the unkernel guest, opens a
window on the page. foot, GTK 3 programs (galculator, mousepad,
aisleriot), mpv, wev and GL programs through Mesa have been run this
way. Everything runs in the tab: the guest, the
relay that carries the program's protocol, the compositor that draws
its windows and the GL renderer. There is no server, and the host's
own display is never involved.

Only the unkernel engine has this. The qemu engine's guest has no
device a compositor could read a program's pixels through.

## Using it

Select the program and boot, then type its name at the shell, or let
the link type it with `run=`:

```
https://trynix.dev/?pkg=foot&boot=1&run=foot+%26
https://trynix.dev/?pkg=galculator&boot=1&run=galculator+%26
```

Windows open over the terminal, inside the console's frame, with the
terminal drawn behind them. A new window opens just under the shell's
prompt line, so the command that started it stays in view with the
window right below, and the frame grows only as far as the window
needs, up to nearly the viewport's height; the terminal refits its
rows and the page scrolls the frame on screen. A window that fits
above a low prompt without growing the frame stays where the
compositor put it, and one larger than the tallest frame opens
maximized. Windows move by their title bar or by Alt+drag.

The keyboard goes to one place at a time. A click on a window gives it
the keyboard; a click on the terminal outside every window gives the
keyboard back to the terminal, and wland's window bindings (Alt+F9 and
the rest) stop acting on keys. When the window holding the keyboard
closes or is minimized, the next window takes it, and with none left
the terminal does.

The console bar has two buttons. "hide windows" minimizes every window
and gives the terminal the keyboard; "show windows" brings them back
in their stacking order, including a window its program minimized
itself. "full screen" puts the whole frame, terminal and windows, in
the browser's full screen. It is missing on iPhone, whose Safari has
the Fullscreen API for video only. What programs are told about the
screen is the frame's size, so maximize fills the frame, in full
screen too.

On a phone a window is usually wider than the frame. A window larger
than the frame opens maximized and fills it, which tells the program
the frame's size, and the windows button is the way back to the
terminal. A floating window moved past the frame's edge, or left there
when the frame shrank on leaving full screen, is pulled back until a
40 by 24 px corner of it is inside, enough to drag it by.

GL programs need a driver, and the page adds one: when the closure
holds a Wayland program that links libglvnd and no Mesa, the page
walks in the site's own Mesa, built with the virgl driver alone (see
[The GL driver](#the-gl-driver)).

The gears demo sets `LIBDECOR_PLUGIN_DIR=` for that command so it can
draw its first frame without downloading GTK for the window decorations.

```
https://trynix.dev/?pkg=mesa-demos&boot=1&run=LIBDECOR_PLUGIN_DIR%3D+es2gears_wayland+%26
```

Selecting a Mesa is how to opt out: with `pkg=mesa` in the link the
page adds nothing, and the guest uses nixpkgs' Mesa (380 MB with its
closure). When no driver the site serves fits the program, the status
line says why.

## How it works

```
 guest (aarch64, unkernel)                 page
 ─────────────────────────                 ────
 foot ──wayland──> wlandr ──vsock 1023──>  wland compositor (wasm) ──> #desktop over #terminal
   │                                          ▲
   └─ wl_shm buffer ── /dev/kwshm ────────────┘  read in place
 es2gears ── Mesa virgl ── virtio-gpu ──────> virglrenderer (wasm) on WebGL2
                                              └─> frame by GPU resource ──┘
```

[site/js/gui.js](../site/js/gui.js) has both halves, and
[site/js/frame.js](../site/js/frame.js) the console frame the windows
open in: its size, where windows open, the keyboard between them and
the terminal, and the bar's buttons. `#desktop` covers the console's
body and takes no pointer itself, so a press outside every window
reaches the terminal; wland gives each window's canvases their own.

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
- **The GL driver** and its link. nixpkgs' libglvnd and libgbm look
  for the driver in `/run/opengl-driver`, as on NixOS. The page adds
  the site's Mesa to a GL program's closure, and a NAR holding Mesa's
  `50_mesa.json` becomes that link in the guest.
- **Store mtimes.** Every file in a nix store has a modification time
  of one second past the epoch, and some programs compare them: guile
  takes a compiled `.go` only when it is no older than its source.
  The share used to stamp files with the time the page wrote them,
  and aisleriot, whose card games are guile, drew nothing in 90 s.
- **A machine id.** D-Bus reads `/etc/machine-id`, which unkernel's
  base system does not have, and GTK programs and firefox warn without
  one. The GUI session writes one from the kernel's random UUID.
- **The handshake.** foot starts a shell that inherits `ENV` and
  sources the manifest; the manifest now reads the page's handshake
  line only in the shell on the page's terminal.

## The GL driver

nixpkgs' Mesa builds every driver it can. Its closure is 380 MB
compressed and 1.47 GB unpacked, held in the page's memory: LLVM for
llvmpipe and the OpenCL frontend (145 MB), python3 for two Vulkan
layer scripts Mesa installs in `bin/` (61 MB; mesa-demos does not
need it), and Vulkan, video and X11 libraries. The guest has one GPU,
virtio-gpu, and one driver that can use it.

[nix/mesa-virgl.nix](../nix/mesa-virgl.nix) is nixpkgs' Mesa with
`gallium-drivers=virgl`, no Vulkan drivers or layers, LLVM off, no
GLX and Wayland as the only EGL platform. nixpkgs builds Mesa with
meson's auto features on, so every feature option is named, on or
off. What libglvnd and a Wayland client need stays: `libEGL_mesa`
with its `50_mesa.json`, GLES, and GBM's backend `dri_gbm.so`.
Mesa is also built against a libdrm without Intel support, since
that support links libpciaccess, which carries hwdata's PCI id tables
(10 MB) and virtio-gpu has no PCI ids to look up; and against a libgbm
without the file nixpkgs' libgbm uses to propagate libdrm, which put
libdrm's headers and test programs in the runtime closure. The build
refuses to finish if LLVM, python3, hwdata, libpciaccess or libdrm's
dev and bin outputs are in its closure.

The result is Mesa 26.2.2 with `libgallium` holding the one driver:

| Mesa            | closure paths | compressed | unpacked | only on the site |
| --------------- | ------------- | ---------- | -------- | ---------------- |
| nixpkgs' `mesa` | 60            | 301 MB     | 1.12 GB  | none             |
| `mesa-virgl`    | 13            | 18 MB      | 83 MB    | 3 NARs, 3.1 MB   |

Three paths are the site's own: Mesa (3.0 MB) and the libdrm (114 KB)
and libgbm (13 KB) it is built against. The other ten (expat, zstd,
libwayland, libffi, glibc, gcc's runtime and their dependencies) are
nixpkgs' own builds from cache.nixos.org.

None of those ten is shared with a program the index resolves today:
the index picks each program's newest build, from a newer nixpkgs
than the one this flake locks, so mesa-demos 9.0.0 comes with glibc
2.44 and gcc 16 where the driver has 2.42 and 15. The whole driver
closure comes along, and the guest holds two glibcs, of which the
program's is the one loaded:

| selection                          | paths | compressed | unpacked |
| ---------------------------------- | ----- | ---------- | -------- |
| mesa-demos + `mesa`                | 133   | 380 MB     | 1.47 GB  |
| mesa-demos, with the site's driver | 124   | 123 MB     | 541 MB   |

A program that never draws with GL pays the same when its closure
holds libglvnd and Wayland, because the page cannot tell from the
closure whether the program will load the driver: GTK 3 programs and
mpv get it. For galculator, mousepad, aisleriot and mpv the driver
adds 13 paths, 14.7 MB from cache.nixos.org and 3.1 MB from the site,
83 MB unpacked in the page's memory. The page adds it anyway rather
than guess from the binaries: SDL, GTK 4, Qt and Firefox load GL with
`dlopen`, so no `NEEDED` entry says they will.

### Which glibc it is built against

Mesa is not a program of its own. libglvnd loads it into the
program's process with `dlopen`, so it runs against the program's
glibc, and against the program's libstdc++ when the program has
already loaded one. A Mesa that asks glibc for a symbol version newer
than the program's fails to load (`version GLIBC_2.xx not found`).

The index does not resolve a link against one nixpkgs. The
multiverse holds 1,581 nixpkgs revisions from 2012 to 2026, and each
`(attribute, version)` resolves to the one store path Hydra built for
it in whichever revision shipped it. For aarch64-linux the programs
it serves link glibc from 2.25 to 2.44, and libglvnd from April 2018 on. A link can also mix revisions: `pkg=a@1&pkg=b@2`
may name two glibcs.

So there is no single right base. Building Mesa against the oldest
glibc a GL program in the index uses would mean a 2019 nixpkgs and
the Mesa of its day; building one per revision would mean hundreds.
What the page does instead:

- each driver the site publishes carries two floors in its manifest
  (`gl/drivers.json`): the newest `GLIBC_` symbol version anything in
  its closure asks for, computed from the binaries by
  [tools/publish-gl.py](../tools/publish-gl.py), and the gcc whose
  libstdc++ it was built with;
- the page reads the program's own floors from its closure, the
  version in its glibc and gcc runtime store paths, taking the oldest
  when a selection mixes revisions;
- it adds the newest driver whose floors are no newer than the
  program's ([site/js/gldriver.js](../site/js/gldriver.js)), and when
  none fits it says so and suggests a Mesa from the program's own
  nixpkgs, which the reader can select with `pkg=mesa@<version>`;
- a program added to a running guest is judged the same way, with the
  guest's closure and the driver it already has, so an added program
  older than that driver gets the same note a fresh boot gives.

One driver is published, built on the nixpkgs this flake locks. Its
floors are glibc 2.38 and gcc 11.1: the `GLIBC_2.38` comes from
building against glibc 2.42 with gcc 15, which turns `strtol` and its
kin into the `__isoc23_` versions glibc added in 2.38, and the
`GLIBCXX_3.4.29` from libstdc++. So it serves programs from nixpkgs
23.11 (November 2023) on. A second, older driver is the same derivation called
with an older nixpkgs' aarch64 package set, and one more entry in the
manifest; nothing on the page changes.

The gcc floor is the first gcc whose libstdc++ has every `GLIBCXX_`
version the driver asks for. A program that links no C++ has loaded
no libstdc++, and Mesa then brings its own, so a closure with no gcc
runtime is judged by glibc alone. Other libraries Mesa links,
libwayland among them, have the same shape of problem: when the
program has loaded an older one, Mesa gets that one. The glibc floor
keeps the two in the same era of nixpkgs, which is what has held for
the programs tried; it is not a proof.

`checks.gl-driver` recomputes the glibc floor from the pinned NAR and
fails when the pin claims less than the binaries ask for, and
[tests/site/gldriver.test.mjs](../tests/site/gldriver.test.mjs)
covers the choice: a program older than every driver gets none, a
mixed selection is judged by its older glibc, a selected Mesa wins,
and the site's driver in a running guest is held to a program added
later.

### Where it is served from

No public cache holds this build, so the site carries a binary cache
of its own: `site/gl/cache/`, committed to the repository and served
by Pages with the page, as the example cache under `site/examples/`
is. It is a `nix-cache-info`, one narinfo and one NAR per store path,
and it holds only what cache.nixos.org does not: Mesa and the libdrm
and libgbm built for it. The rest of Mesa's closure is nixpkgs' own
builds. Beside it,
`site/gl/drivers.json` names the driver and its two floors.

The cache is the second default substituter in
[site/js/substituters.js](../site/js/substituters.js), after
cache.nixos.org, so a path cache.nixos.org holds never costs a
request to the site. Its narinfos are not signed. The page trusts its
own origin, which also serves the JavaScript that checks signatures:
whoever can replace a narinfo there can replace the check, so a key
would vouch for nothing the origin does not already. Each NAR is
still checked against its narinfo's `NarHash` when it arrives.

The pages workflow builds the site on an x86_64 runner, which cannot
build an aarch64 Mesa and should not have to: it copies `site/` as it
always has. The driver is built by hand and its files committed:

```sh
nix run .#make-gl-cache    # build mesa-virgl, rewrite site/gl/, print the sizes
```

The build is `packages.aarch64-linux.mesa-virgl`; on an x86_64 host
it runs through binfmt (`extra-platforms = aarch64-linux`), and only
Mesa itself compiles under emulation, since its inputs come from
cache.nixos.org. That build took 25 minutes on a 16-core laptop
through binfmt and 10 minutes on a native aarch64 remote builder. jj
refuses to snapshot a new file over 1 MiB unless told otherwise, so
commit the NAR with `jj --config snapshot.max-new-file-size=<bytes>`.
The tool replaces whatever driver the
directory held, and refuses to write a file over 50 MB, where GitHub
starts warning.

Each driver update adds its NAR to the repository's history for good:
removing a file from the tree does not remove it from the clones that
already have it.

## Firefox and whole compositors

nixpkgs' `firefox` runs in the guest, as a Wayland client, loading GL
through libglvnd with `dlopen`, so the page adds the GL driver for it.
Its closure with the driver is 322 paths, 457 MB compressed and 1.7 GB
unpacked. It needs memory: in a 512 MiB guest the kernel ran out of
contiguous 128 KiB blocks (`page allocation failure: order:5`) while
firefox started, and of five runs one ended in SIGILL, one in SIGSEGV
and one left the guest unable to start a process; the other two
survived with 35 MiB to spare. In a 2 GiB guest, the computer's
default (docs/unkernel.md, "Memory"), it runs and draws its pages. The
signal a run died of was not caught with its address; that the fault
follows the allocation failures is what the runs show, and why the
allocation failures turn into SIGILL is not known.

Measured in headless Chromium on a laptop, 2026-11-23, from typing
`firefox` to its window, in a 2 GiB guest with a new profile:

| start  | 1 CPU  | 4 CPUs |
| ------ | ------ | ------ |
| first  | 37.3 s | 28.9 s |
| second | 32.7 s | 23.7 s |

A compositor can run as one window on the page, with its own windows
inside it:

- **weston** runs with nothing set: it finds `WAYLAND_DISPLAY`, uses
  its Wayland backend and opens its socket as `wayland-1`. A program
  started with `WAYLAND_DISPLAY=wayland-1` opens inside it; foot and
  weston-terminal there take keys (0.1 to 0.7 s from the keys to the
  program's effect, measured by polling). First frame 2.0 to 3.3 s.
  Its closure is 313 paths, 372 MB.
- **sway** runs with `WLR_BACKENDS=wayland WLR_RENDERER=pixman`, a
  config path (`sway -c <sway's store path>/etc/sway/config`: nixpkgs
  sway looks in `/etc/sway`, which the guest does not have) and
  `DBUS_SESSION_BUS_ADDRESS` set to anything: nixpkgs wraps sway in
  `dbus-run-session` when it is unset, which fails without
  `/etc/dbus-1/session.conf`. First frame 1.5 s; foot inside takes
  keys. Closure 155 paths, 119 MB.
- **labwc** does not start: its wlroots asks the parent compositor for
  a DRM render node, which wland does not name, and gives up ("Failed
  to get DRM render node from remote Wayland compositor"). sway's
  wlroots goes on without one.

## Sound

The guest has a sound card: unkernel's `kwsnd` driver, ALSA card 0,
offered on every boot ([site/js/unkernel.js](../site/js/unkernel.js)).
Nothing runs until a program opens it. While one plays, a kernel timer
hands the page the frames due every 5 to 10 ms, and the page plays them
with Web Audio ([site/js/sound.js](../site/js/sound.js)). The SDK stops
at the samples, so the player is the page's, adapted from unkernel's
own page (`web/src/audio.ts`, MIT): an AudioWorklet plays from a queue
that starts once 60 ms is in, resamples to the device's rate, and
steers by up to 1% to absorb the drift between the guest's clock and
the audio device's ([site/js/sound-queue.js](../site/js/sound-queue.js)).

Browsers start sound only after a click or key press on the page. A
Try link boots and runs its command with no click on the new page, so
the AudioContext is made only once the page has had one, and until
then up to 10 s of what programs play is held. The console bar shows
"sound: click to play"; a clip that ended by the click plays whole,
and a stream still playing joins live. After that the same control
switches sound off and on, remembered by this browser.

```
https://trynix.dev/?pkg=espeak-ng&boot=1&run=espeak-ng+%27Hello%27
```

Measured in headless Chromium, 2026-11-23: espeak-ng's 1.9 s greeting,
held before the click, played whole after it, then a second line live,
with no underruns and nothing dropped.

### Which programs play

Most programs that speak PulseAudio try it first and fall back to ALSA
when no server answers. Measured in headless Chromium, 2026-11-23,
each program selected with no server in the guest, by the chunks of
audio that reached the page (a headless browser has no speakers):

| program                               | tries                                 | with no server |
| ------------------------------------- | ------------------------------------- | -------------- |
| espeak-ng                             | PulseAudio, then ALSA                 | plays          |
| `aplay`                               | ALSA                                  | plays          |
| mpv, its default output               | PipeWire, PulseAudio, then ALSA       | plays          |
| ffplay (SDL 3, through sdl2-compat)   | PipeWire, PulseAudio, then ALSA       | plays          |
| `gst-launch-1.0` with `autoaudiosink` | pulsesink, then alsasink              | plays          |
| firefox, a Web Audio tone             | PulseAudio, then ALSA (cubeb)         | plays          |
| `canberra-gtk-play` (libcanberra)     | PulseAudio, whenever its module loads | silent         |
| `paplay`, `pacat`                     | PulseAudio only                       | silent         |
| `pw-play`                             | PipeWire only                         | silent         |

libcanberra plays GTK programs' event sounds and the sounds of games
that use it, aisleriot's among them (off until turned on in its menu).
It takes its PulseAudio backend whenever that backend's module loads,
and when no server answers it fails there, with no fallback. So every
shell of a guest with no server gets `CANBERRA_DRIVER=alsa`, and
`canberra-gtk-play` plays.

### A PulseAudio server

When the closure holds nixpkgs' `pulseaudio` package, which carries the
daemon, the page starts the daemon before the shell is ready
([site/js/pulse.js](../site/js/pulse.js)). Selecting pulseaudio with a
program is how to get a server:

```
https://trynix.dev/?pkg=pulseaudio&pkg=sox&boot=1&run=sox+-n+-t+raw+-r+44100+-e+signed+-b+16+-c+2+-+synth+2+sine+440+%7C+pacat
```

The daemon loads no default script (`-n`), only three modules: an ALSA
sink on card 0, the native protocol's socket at
`$XDG_RUNTIME_DIR/pulse/native` with anonymous access (the guest has
one user, root), and `module-suspend-on-idle`, which closes the card
1 s after the last client stops. Shared memory is off, so audio goes
over the socket. Every shell gets `PULSE_SERVER`. A client of any
nixpkgs era speaks the native protocol to the daemon over the socket,
so no library crosses from one era's process into another's
([design.md](./design.md) says why that matters).

The daemon runs with no realtime thread and no CPU limit
(`--realtime=no --high-priority=no --no-cpu-limit`). With its defaults
it was killed, status 137, as soon as a client played: under the
emulated CPU its realtime thread overruns the time limit the daemon
sets for it.

With the daemon up, paplay, pacat, `canberra-gtk-play`, espeak-ng, mpv,
ffplay and firefox played through it. The sink runs at the daemon's
default 44.1 kHz, the rate most of them play at, and the page
resamples to the device's rate.

What it costs, measured with `pulseaudio-ctl`, whose closure holds the
daemon without selecting it, so the daemon's libraries download only
when it starts (three boots each, lazy downloads):

| boot               | paths written | downloaded | running to prompt |
| ------------------ | ------------- | ---------- | ----------------- |
| without the daemon | 15            | 15.8 MB    | 2.2–2.5 s         |
| with the daemon    | 44            | 32.5 MB    | 4.1–4.9 s         |

The page does not add a daemon of its own to closures that hold only
the client library. espeak-ng, mpv, firefox and most GTK programs hold
it, they play without a server, and each boot would pay the 17 MB and
2.5 s above. A server would also take the card from programs that
write to ALSA themselves.

The card has one stream. While the daemon plays, and for 1 s after, a
program that opens the card itself gets EBUSY. The other way round, a
PulseAudio client started while such a program holds the card waits,
and goes on waiting after the card is free until it is stopped; the
next client plays. With the daemon up, programs that try PulseAudio
first go through it, so this takes a program that writes only to ALSA,
such as `aplay`, playing at the same moment.

The daemon opens the card as it starts and plays zeros until it
closes it. The page shows the sound control only once a chunk holds a
sample that is not zero, and the clip it holds for the first click
starts there, so a boot with a daemon and nothing playing asks for no
click.

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

| selection                     | paths | compressed | unpacked |
| ----------------------------- | ----- | ---------- | -------- |
| foot                          | 36    | 29 MB      | 115 MB   |
| mesa-demos + `mesa`           | 133   | 380 MB     | 1.47 GB  |
| mesa-demos, the site's driver | 124   | 123 MB     | 541 MB   |

The unpacked closure is held in the page's memory. With nixpkgs' Mesa
a GL boot asked the browser for 1.5 GB before the guest did anything;
with the site's driver it is 541 MB, 458 MB of it mesa-demos' own
closure. These numbers, and the times below, are for a boot that
downloads the whole closure first, which is no longer the default:
with downloads on first use the page fetches and holds only what the
program opens ([unkernel.md](./unkernel.md#downloads-on-first-use) has
the comparison).

Time and frame rate:

| program                       | shell after | first frame after the command |
| ----------------------------- | ----------- | ----------------------------- |
| foot                          | 2.8–3.7 s   | 0.8–0.9 s                     |
| galculator                    | 8.0 s       | 2.8 s                         |
| es2gears_wayland + mesa       | 26–43 s     | 3.1–3.7 s                     |
| es2gears_wayland, site driver | 11.1 s      | 3.3 s                         |
| sol (aisleriot)               | 29 s        | 16 s                          |
| mousepad                      | 17 s        | 26 s                          |
| mpv, a lavfi test video       | 38 s        | 28 s                          |
| wev                           | 5.3 s       | 0.7 s                         |

The galculator to wev rows were taken while an aarch64 build ran on
the same machine, so read them as orders of magnitude. es2gears'
first frame is the guest loading the program and Mesa under the
emulator, and it is no faster with the small Mesa, since the virgl
driver was never what took the time; the GL renderer itself loads in 0.06 s on
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

- **GL programs from before nixpkgs 23.11** get no driver: the one
  the site serves needs glibc 2.38. The page says so; a Mesa from the
  program's own nixpkgs, selected with `pkg=mesa@<version>`, is the
  way around it until an older driver is published.
- **A selected `mesa`** resolves to the newest Mesa in the index,
  which may be built against a newer glibc than the program; the page
  does not check one the reader chose.
- **No X11.** There is no Xwayland in the guest, so programs with only
  an X11 backend do not start.
- **Reloads end the programs**, as they end the guest: the page boots a
  fresh kernel every time.
- **Keyboard layout** is US, which is wland's.
- **The touch key bar** types into the terminal only. A tap on it gives
  the terminal the keyboard, even while a window has it.
- **PipeWire-only programs**, such as `pw-play`, stay silent: the
  page starts no PipeWire daemon.
- **Browsers.** `gui-test` passes in Chromium and in Firefox 160, both
  headless: foot takes keys, and es2gears draws through virgl at
  60 FPS. Safari has not been run.

## Testing

`nix run .#gui-test -- --site <site>` boots foot and es2gears from
links (es2gears alone, so the page has to add the driver), starts each at the shell and waits for the compositor's first
frame. It types into foot's window and checks that the keys reached the
program, then presses the terminal beside the window, types a line,
and checks that the page's shell ran it while wland sent no key to any
window and holds none focused. It checks that es2gears' frames went
through the page's GL renderer by GPU resource and not through
llvmpipe. `--with firefox`
runs the same cases in Firefox, driven over WebDriver BiDi, the
protocol Firefox speaks since it dropped the DevTools one.
`--viewport phone` runs them in a phone-sized window, where foot opens
maximized and the terminal is reached through the windows button;
Chromium also emulates a touch screen there.
`--gpu hardware` draws Chromium's WebGL with the host's GPU instead of
SwiftShader (Firefox picks its own), and `--screenshots <dir>` saves
the console, terminal and windows, at each step.

[tests/site/gui.test.mjs](../tests/site/gui.test.mjs) covers what the
page writes into the share and runs in the guest, offline, and
[tests/site/frame.test.mjs](../tests/site/frame.test.mjs) the frame's
rules: which windows open maximized, where the others open, where a
window past the edge goes back to, and what the windows button offers.

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
- The programs come from cache.nixos.org and keep nixpkgs' licenses,
  as every other package the page boots does. The site's Mesa is
  MIT, built unmodified from nixpkgs' source with fewer drivers.
