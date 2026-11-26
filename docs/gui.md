# GUI programs

A Wayland program from nixpkgs, run in the unkernel guest, opens a
window on the page. foot, GTK 3 programs (galculator, mousepad,
aisleriot), mpv, wev and GL programs through Mesa have been run this
way, and X11 programs through Xwayland: xterm, xeyes, xclock, Tk's
`wish` and Python's tkinter, and with `vk=1` in the link Vulkan
programs on the page's WebGPU where the browser has an adapter. Video
that a program decodes through VA-API is decoded by the browser's own
decoder (see [Video](#video)). Everything runs in the tab: the
guest, the relay that carries the program's protocol, the compositor
that draws its windows, the X server and the GL and Vulkan renderers.
There is no server, and the host's own display is never involved.

Only the unkernel engine has this. The qemu engine's guest has no
device a compositor could read a program's pixels through.

## Using it

Select the program and boot, then type its name at the shell, or let
the link type it with `run=`:

```
https://trynix.dev/?pkg=foot&boot=1&run=foot+%26
https://trynix.dev/?pkg=galculator&boot=1&run=galculator+%26
```

Until the first window, a strip under the terminal says `starting
<program>` with the time since the command, for a program whose closure
holds a Wayland client library, libX11 or libxcb (site/js/activity.js).
Paths downloading on first use show on the same strip, by name or count,
with their bytes. The wait ends when a window more than before appears,
or when the program, once seen running, is gone for three looks a
second apart. A program run in the foreground that switches the
terminal to its alternate screen, as `emacs -nw` and vim do, is a
terminal program, and that ends the wait too. Two limits end it
otherwise, and time with a download in flight counts toward neither:
20 s for a program never seen running, which covers a command that
failed, and 15 minutes in all. firefox's first start is 37 s on a
laptop (see [Firefox](#firefox-and-whole-compositors)); a 3 minute
limit ran out with firefox still starting in a guest nested in another
trynix guest, and 15 minutes is 24 times the laptop's start. A program
that links X11 or Wayland but opens no window and keeps the normal
screen, such as a REPL, shows as starting for those 15 minutes, unless
it exits or the reader enters another command that opens windows.

Windows open over the terminal, inside the console's frame, with the
terminal drawn behind them. A new window opens just under the shell's
prompt line, so the command that started it stays in view with the
window right below, and the frame grows only as far as the window
needs, up to nearly the viewport's height; the terminal refits its
rows and the page scrolls the frame on screen. A window that fits
above a low prompt without growing the frame stays where the
compositor put it, and one larger than the tallest frame opens
maximized. The compositor puts a new window 24 px from the frame's
left edge; a window nearly as wide as the frame moves left from there,
just far enough for its right edge to be inside. Once the reader has
set the terminal's height with the grip under the console, the frame
keeps that height: a window that does not fit under the prompt opens
as low as it fits whole, and one taller than the frame opens maximized
in it. Windows move by their title bar or by Alt+drag.

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

GL programs need a driver, and every guest has one: the site's own
Mesa, built with the virgl driver alone, is linked at
`/run/opengl-driver` from the boot and downloaded the first time a
program looks inside it (see [The GL driver](#the-gl-driver)).

The gears demo sets `LIBDECOR_PLUGIN_DIR=` for that command so it can
draw its first frame without downloading GTK for the window decorations.

```
https://trynix.dev/?pkg=mesa-demos&boot=1&run=LIBDECOR_PLUGIN_DIR%3D+es2gears_wayland+%26
```

Selecting a Mesa is how to opt out: with `pkg=mesa` in the link the
guest uses nixpkgs' Mesa (380 MB with its closure) in place of the
site's. When the site's driver is too new for the program, the status
line says why.

X11 programs need an X server, and every guest has one the same way:
xwayland-satellite, linked from the boot and downloaded when the first
X client connects, and every shell has `DISPLAY=:0` (see [X11
programs](#x11-programs)). Each X11 window opens as a window of its
own, like a Wayland program's.

```
https://trynix.dev/?pkg=xterm&boot=1&run=xterm+%26
https://trynix.dev/?pkg=xeyes&boot=1&run=xeyes+%26
```

## How it works

```
 guest (aarch64, unkernel)                 page
 ─────────────────────────                 ────
 foot ──wayland──> wlandr ──vsock 1023──>  wland compositor (wasm) ──> #desktop over #terminal
   │                                          ▲
   └─ wl_shm buffer ── /dev/kwshm ────────────┘  read in place
 es2gears ── Mesa virgl ── virtio-gpu ──────> virglrenderer (wasm) on WebGL2
                                              └─> frame by GPU resource ──┘
 xterm ──X11──> Xwayland ──> xwayland-satellite ──wayland──> wlandr
 (wlandr holds :0 and starts the satellite, which starts Xwayland)
 etr ──GLX──> Mesa virgl ──DRI3──> Xwayland, drawing with glamor through Mesa virgl
 vkcube ── kwvk ──vsock 1018──────> kwvk renderer on WebGPU
   └─ wl_buffer named by id ──> wlandr   └─> frame by external buffer to the compositor
 mpv ── libva ── kwva ──vsock 1024──> WebCodecs VideoDecoder
   └─ dmabuf, a GPU resource ─> wlandr   └─> frame drawn into the resource on WebGL2
```

[site/js/gui.js](../site/js/gui.js) has both halves, and
[site/js/frame.js](../site/js/frame.js) the console frame the windows
open in: its size, where windows open, the keyboard between them and
the terminal, and the bar's buttons. `#desktop` covers the console's
body and takes no pointer itself, so a press outside every window
reaches the terminal; wland gives each window's canvases their own.

The guest half is wland's relay, `wlandr`, a 359 KB static aarch64
binary built from source ([nix/wlandr.nix](../nix/wlandr.nix)).
unkernel's base system has no relay (only its Debian image ships one),
so the site serves it. Every unkernel boot fetches the relay and the
fonts while the shell starts, writes them into the share under
`/share/gui`, and starts the relay in the background once the shell is
at its prompt, so the shell never waits for it. A program that
connects before the relay listens finds no socket; the relay listened
0.13 to 0.18 s after the prompt in sixteen runs, and a GUI program
started at the prompt spends longer than that loading its own
libraries. Every shell gets `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, the
toolkit hints (`GDK_BACKEND`, `QT_QPA_PLATFORM`, `SDL_VIDEODRIVER` and
the rest) and `DISPLAY`, the same from the boot to the end, so a
program started plainly picks Wayland, and one with no Wayland backend
finds the X server.

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
from the renderer as an ImageBitmap, with no readback. A Vulkan
program's frames stay on the page's GPU the same way: kwvk names each
swapchain image by an id (`--external-buffers`), and the compositor
takes the image's picture from the Vulkan renderer (see [Frames
without readback](#frames-without-readback)).

The kernel always boots with kwshm and the virtio-gpu device, since
which programs a reader will run is not known at boot. Neither costs
anything until a program uses it: `boot-test`'s hello boot took a
median 2.1 s before this and 1.7 s after, six runs each.

A few things the guest lacks, the page supplies:

- **Fonts.** nixpkgs' GUI programs carry fontconfig but no font, and
  nixpkgs' fontconfig reads `/etc/fonts`, which the guest does not
  have. The site ships DejaVu Sans and Sans Mono and a `fonts.conf`
  that names them and maps `monospace`, `sans-serif` and `serif`.
  Every shell also lists the fonts' parent, `/share/gui`, in
  `XDG_DATA_DIRS`. Firefox draws a website in a content process whose
  sandbox reads fonts only from a fixed list of system directories and
  from `<dir>/fonts` for each directory in that variable. Without it,
  every letter of a website drew as a box with its code in it
  ([#16](https://github.com/fzakaria/trynix/issues/16)), while a
  `file://` page, whose process may read anywhere, drew its text.
- **The GL driver** and its link. nixpkgs' libglvnd and libgbm look
  for the driver in `/run/opengl-driver`, as on NixOS. The page links
  it to the site's Mesa before the shell starts, or to a selected
  package whose NAR holds Mesa's `50_mesa.json`.
- **The X server** and its link, `/run/x11-server`, to
  xwayland-satellite's program, made with the driver's.
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
`gallium-drivers=virgl`, no Vulkan drivers or layers, LLVM off, and
Wayland and X11 as its platforms. nixpkgs builds Mesa with meson's
auto features on, so every feature option is named, on or off. What
libglvnd and a Wayland client need stays: `libEGL_mesa` with its
`50_mesa.json`, GLES, and GBM's backend `dri_gbm.so`; and what an X11
client needs, `libGLX_mesa` (see [GLX programs](#glx-programs)).
Mesa is also built against a libdrm without Intel support, since
that support links libpciaccess, which carries hwdata's PCI id tables
(10 MB) and virtio-gpu has no PCI ids to look up; and against a libgbm
without the file nixpkgs' libgbm uses to propagate libdrm, which put
libdrm's headers and test programs in the runtime closure. The build
refuses to finish if LLVM, python3, hwdata, libpciaccess or libdrm's
dev and bin outputs are in its closure.

Mesa carries two patches for unkernel's renderer. Since unkernel
0.2.0-261124 the renderer no longer loses the context over such a draw
([pithings/unkernel#27](https://github.com/pithings/unkernel/issues/27)):
it keeps a texture WebGL would refuse off the unit, and the draw
lands. The patches stay because what that draw then samples is not
what GL defines. Without them, on 2026-11-24 and again on
0.2.0-261125-cec0a49, the feedback case below read black where GL
defines level 0's red, and (0, 0, 0, 0) where it defines (0, 0, 0, 1)
for an integer sampler with an incomplete texture or none. In the first,
[patches/mesa/0001](../patches/mesa/0001-virgl-stand-in-for-a-sampler-view-in-a-feedback-loop.patch),
a draw that renders into a level of a texture
while a sampler view of the draw covers that level is a feedback loop:
WebGL 2 refuses the draw even when the shader never reads the texture.
unkernel's renderer takes the refusal as a context error and refuses
every later draw of that program's context, so a program that leaves a
texture on a unit and then renders into it goes blank. Firefox's
WebRender does that, and Firefox's window stopped drawing about 100 s
into a page of CSS effects and canvas copies. With the patch the virgl
driver gives the renderer a stand-in view in that slot for such a
draw. When the draw renders into a level above the view's first, the
stand-in is the same texture with its levels cut below the one
rendered into, so a sampler without mipmaps still reads the first
level's contents, as GL defines; the renderer sets those levels as the
texture's base and max level, and WebGL 2 looks for the loop only
between them. When the view's first level is rendered into, GL leaves
every read undefined and the stand-in is a 1x1 texture.

The second,
[patches/mesa/0002](../patches/mesa/0002-virgl-stand-in-for-a-sampler-view-of-another-type.patch),
does the same for a sampler whose unit holds a texture of another type:
an integer texture on a float sampler, or a float or normalized one on
an integer sampler. GL leaves those values undefined too, and WebGL 2
refuses the draw. Firefox's WebRender makes such draws, and Mesa does
when an integer sampler's unit has no complete texture, since it puts
an RGBA8 one there. Firefox in the guest, opening a trynix page that
ran es2gears in its own guest, stopped drawing the lower part of its
window 4.5 minutes in. The virgl driver now gives the renderer a 1x1
texture of the sampler's type in that slot. An integer one holds
(0, 0, 0, 1), the opaque black GLES samples from an incomplete texture
or an empty unit.

The result is Mesa 26.2.2 with `libgallium` holding the one driver:

| Mesa            | closure paths | compressed | unpacked | only on the site |
| --------------- | ------------- | ---------- | -------- | ---------------- |
| nixpkgs' `mesa` | 60            | 301 MB     | 1.12 GB  | none             |
| `mesa-virgl`    | 20            | 19 MB      | 90 MB    | 3 NARs, 3.2 MB   |

Three paths are the site's own: Mesa (3.1 MB) and the libdrm (114 KB)
and libgbm (13 KB) it is built against. The other seventeen (expat,
zstd, libwayland, libffi, glibc, gcc's runtime, the X11 client
libraries GLX links and their dependencies) are nixpkgs' own builds
from cache.nixos.org. GLX added seven of them, 1.4 MB compressed.

None of those seventeen is shared with a program the index resolves today:
the index picks each program's newest build, from a newer nixpkgs
than the one this flake locks, so mesa-demos 9.0.0 comes with glibc
2.44 and gcc 16 where the driver has 2.42 and 15. The whole driver
closure comes along, and the guest holds two glibcs, of which the
program's is the one loaded:

| selection                          | paths | compressed | unpacked |
| ---------------------------------- | ----- | ---------- | -------- |
| mesa-demos + `mesa`                | 133   | 380 MB     | 1.47 GB  |
| mesa-demos, with the site's driver | 131   | 124 MB     | 548 MB   |

Every unkernel guest is linked to the driver, and none of it is
fetched until a program looks inside it. The first lookup starts the
walk of its closure (20 paths) and is answered from the root's
listing once the root's narinfo is in, while the walk goes on; its
files' NARs download as they are opened
([site/js/lazy.js](../site/js/lazy.js), capabilities). The page does not guess from a closure whether a
program will load GL: SDL, GTK 4, Qt and Firefox load it with
`dlopen`, so no `NEEDED` entry says they will, and GTK 3 programs and
mpv link libglvnd and may never call it. The dynamic loader of any
program that links libglvnd looks for each of its libraries in
`/run/opengl-driver/lib` first, which costs the driver root's narinfo
and listing and nothing more: the site's cache serves a listing beside
each narinfo, and the lookup is answered from it.

es2gears from mesa-demos, selected alone and started at the prompt,
measured as in [What X11 costs](#what-x11-costs), four runs each:
the shell came up after a median 3.43 s against 7.29 s when the page
walked the driver in and fetched it with the selection, and the first
frame came 2.64 s after the command against 3.71 s. Both downloaded
48.5 MB by then.

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
- it links the newest driver whose floors are no newer than the
  program's ([site/js/gldriver.js](../site/js/gldriver.js)), and when
  none fits it links the newest anyway, which such a program fails to
  load as it would fail with no driver at all, and says so, suggesting
  a Mesa from the program's own nixpkgs, which the reader can select
  with `pkg=mesa@<version>`;
- a program added to a running guest is judged the same way, with the
  closures of every program selected so far, so an added program older
  than the driver gets the same note a fresh boot gives. The X server
  and the driver's own closures are not judged.

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

A program older than the driver fails cleanly. mesa-demos 8.5.0
(glibc 2.35) with the site's driver linked: `eglinfo` prints
`eglInitialize failed` and exits 1, and `es2gears_wayland` prints
`EGLUT: failed to initialize EGL display` and exits 1. With
`LD_DEBUG=versions` the loader says why: `version 'GLIBC_2.38' not
found (required by .../libEGL_mesa.so.0)`. libglvnd takes the vendor
that did not load for no vendor, and the program reports no display,
as it does with no driver. The attempt fetches the driver's NAR and
the libraries it maps before the loader checks versions. A Mesa that
is only in a program's closure is not one the reader selected:
mesa-demos 8.5.0's holds `mesa-22.3.7-drivers` and
`mesa-22.3.7-osmesa`, which the page used to take for a selected Mesa,
fetch with the selection (148.7 MB) and link as the driver.

`checks.gl-driver` recomputes the glibc floor from the pinned NAR and
fails when the pin claims less than the binaries ask for, or when a
path the site's cache serves has no listing beside its narinfo, and
[tests/site/gldriver.test.mjs](../tests/site/gldriver.test.mjs)
covers the choice: a program older than every driver gets the newest
and a note, a mixed selection is judged by its older glibc, a Mesa
among the selected roots silences the note and one in a program's
closure does not, and the site's driver in a running guest is held to
a program added later.

### Where it is served from

No public cache holds this build, so the site carries a binary cache
of its own: `site/gl/cache/`, committed to the repository and served
by Pages with the page, as the example cache under `site/examples/`
is. It is a `nix-cache-info`, and one narinfo, one NAR listing and one
NAR per store path, and it holds only what cache.nixos.org does not:
Mesa and the libdrm and libgbm built for it. The rest of Mesa's closure is nixpkgs' own
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

## X11 programs

The guest has no X server of its own, and wland's relay has one on
call. Started with `--xwayland`, the relay claims X display `:0` (the
lock `/tmp/.X0-lock`, the socket `/tmp/.X11-unix/X0` and its abstract
twin) and, when the first X client connects, runs xwayland-satellite
with the listening sockets. The satellite starts Xwayland rootless, is
its X window manager, and connects to the relay as an ordinary Wayland
client, so each X11 toplevel becomes a window of its own on the page,
titled with the X11 window's name. The compositor needs nothing for
this that a Wayland program does not already use: no
`xwayland-shell-v1`, which only a compositor that runs Xwayland itself
needs. The relay's side is wland's own (`server/src/xwayland.zig`),
built into the relay the site serves. Nothing X11 runs until a program
connects.

### Which X server

Every unkernel guest has the same one: the multiverse index's newest
aarch64 xwayland-satellite when it was pinned, 0.8.3 with Xwayland
24.1.15, named in [site/js/config.js](../site/js/config.js)
(`X11_SERVER`) and served by cache.nixos.org. The page does not ask
which selected programs speak X11. A rule that did (an X client
library and no libwayland in the program's closure) missed programs
whose closure holds libwayland and that speak X11 alone: Java's AWT
and Swing, whose closure holds GTK 3, and extremetuxracer, whose SFML
reaches libwayland through openal-soft and pipewire, and which then
aborted with `Failed to open X11 display`.

Programs selected by name resolve to their newest builds too, so the
pin shares paths with them while both are recent: glibc, gcc's
runtime and the X client libraries. Of the satellite's 129 paths,
xeyes' closure held 12, xterm's 23 and wish's 22, in November 2026.
The build from the nixpkgs this flake locks shared none with any of
them (its glibc is 2.42, theirs 2.44), and its first use downloaded
glibc again, 10 MB of it. The satellite and Xwayland run as processes
of their own, so unlike the GL driver they need not match the
program's glibc. Moving the pin is an edit of `X11_SERVER`.

### In the guest

Every unkernel boot links `/run/x11-server` to the satellite's program
before the shell starts, writes a launcher, `/share/gui/start-x11`,
and starts the relay with `--xwayland` pointing at it. Nothing of the
X server is fetched until the first X client connects: the relay runs
the launcher, the launcher runs `/run/x11-server`, and that lookup is
what starts the walk of the satellite's closure (106 narinfos and
their listings beyond what the selection shares). The lookup is
answered once the satellite's own narinfo is in; the rest join the
store as the walk finds them, and a lookup of one not found yet waits
for the walk. Then come the NARs the satellite and Xwayland open. A
boot with no X client fetches none of it, and has no X server
process. The X server's programs (Xwayland, `dbus-launch`,
`systemctl` and the rest of its closure's) stay off `PATH`: the farm
takes the selection's programs alone.

The client waits while the server downloads. Xlib and xcb wait for
the server's first answer without a limit, and a lookup on the share
has none either: with the satellite's and Xwayland's NARs held back
35 s, xterm kept running and opened its window after the hold
(gui-test's slowx case).

Every shell has `DISPLAY=:0` from the boot, with `XENVIRONMENT` and
`_JAVA_AWT_WM_NONREPARENTING=1`: Java's AWT waits for its window
manager to reparent each window, which the satellite does not, and a
Swing window stayed blank until AWT was told. Nothing an addition
brings changes a shell's environment. A program that tries X11 before
Wayland and ignores the toolkit hints now finds a working server, and
downloads it, where it used Wayland before.

Xwayland draws with glamor, through the GL driver, when the selection
links libglvnd, a hint that it may draw with GLX: GLX programs need it
(see [GLX programs](#glx-programs)), and a GLX program must link
libGL, which in nixpkgs is libglvnd. The page then writes
`/share/gui/glamor`, and the launcher looks for it. With glamor
Xwayland loads the driver into its own process, so the driver has to
fit Xwayland's glibc too; the pinned satellite comes with glibc 2.44,
above the driver's floor. Otherwise the launcher passes
`-glamor none -extension GLX`, which the satellite hands to Xwayland:
`-glamor none` is Xwayland's `-shm`, read with its command line,
before it asks EGL whether glamor could work, which loads the driver
(`XWAYLAND_NO_GLAMOR` is read after that, and xterm downloaded the
driver with it set); and GLX's software path loads the driver through
Mesa's DRI loader and serves no GLX program without DRI3. Xwayland
then draws with pixman into shared memory, which the compositor reads
through kwshm like any other program's buffers. With glamor always
on, xterm's first window took 2.5 s longer and fetched 18 MB more.
Xwayland chooses once, as it starts.

Xwayland has no core fonts but its built-in `fixed`, and xterm asks
for one it lacks by default, which printed a warning on the reader's
terminal. The session writes X resources, `/share/gui/Xresources`,
named by `XENVIRONMENT` in every shell, which give xterm the
`monospace` family through Xft; fontconfig maps it to the page's
DejaVu Sans Mono. Tk draws through Xft and fontconfig by itself.

### What X11 costs

Measured 2026-11-24 on the laptop below, headless Chromium with
SwiftShader, downloads on first use (the default), each run in a new
browser profile, the closures from cache.nixos.org over a home
connection, against the site before the X server and the driver were
in every guest, the runs of the two interleaved.

A boot with no X client pays nothing for the X server: hello's shell
came up after a median 1.75 s (1.6 to 2.9 s) against 1.70 s (1.5 to
3.5 s) before, sixteen boots each. The first X client pays the
server's walk, behind its own narinfo, and what the satellite and
Xwayland open. Before, an X11 program got the server only when the
rule picked it, or with `xwayland-satellite` selected, which fetches
the satellite and its references before the shell:

| xterm, `xterm &` at the prompt | shell after | first window after the command | downloaded by then |
| ------------------------------ | ----------- | ------------------------------ | ------------------ |
| with the satellite selected    | 3.65 s      | 6.19 s (5.67 to 11.95 s)       | 58.3 MB            |
| alone, the server on first use | 2.29 s      | 4.39 s (4.06 to 6.47 s)        | 39.0 MB            |

Each row is the median of four runs. "Downloaded by then" is the
compressed bytes the page had fetched three seconds after the first
window, xterm's own closure included: 75 NARs alone. The walk of the
satellite's 106 narinfos took 0.63 to 1.6 s, while the satellite's own
NAR downloaded: the first lookup is answered once the satellite's
narinfo is in, and a later one waits only until the path it names has
joined. The driver's root narinfo and listing,
which Xwayland's loader needs to find its libraries are not in
`/run/opengl-driver/lib`, took 0.11 to 0.15 s; its whole walk, before
the lookup was answered early, took 0.11 to 0.65 s.

nixpkgs' Xwayland links libdecor for its rootful `-decorate` mode,
which a rootless Xwayland never uses, and 70 of the satellite's 129
paths, 64 MiB, are in its closure only through libdecor. On first use
that costs little: of xterm's first window's 39.0 MB, 1.5 MB came
through libdecor alone (libdecor, cairo, pango and dbus's library),
4.1 MB counting paths xterm opens anyway. So the site serves nixpkgs'
Xwayland rather than one built without libdecor.

### GLX programs

Most X11 programs that draw with GL make their context with GLX.
nixpkgs builds them against libglvnd, whose GLX loads the vendor
library the X server's screen names, `libGLX_mesa`, from
`/run/opengl-driver`; the site's Mesa has it. SFML 2, which
extremetuxracer draws with, and freeglut, as nixpkgs builds them, make
their contexts this way and no other.

Mesa's GLX renders with the virgl driver only through DRI3: the
program renders into buffers it shares with the X server, which
presents them. Xwayland offers DRI3 only when it draws with glamor,
which is why the launcher turns glamor on whenever the selection
links libglvnd. Without DRI3 Mesa prints `screen 0 does not appear to be DRI3
capable` and falls back to drawing in software with llvmpipe or
softpipe, neither of which the site's Mesa has.

extremetuxracer 0.8.4 is how this was found. Its menu, measured
2026-11-24 in headless Chromium with SwiftShader on the laptop below,
with nixpkgs' Mesa selected beside the game and the satellite:

| Xwayland       | GLX renderer   | frames the compositor took |
| -------------- | -------------- | -------------------------- |
| without glamor | llvmpipe       | 3.0 a second               |
| glamor         | virgl, by DRI3 | 22.6 a second              |

With the site's Mesa in place of nixpkgs', gui-test's glx case counted
206 frames by GPU resource in 10 s, 20.6 a second, and the window
opened 9.0 s after the shell.

With no GLX vendor library, which is how the site's Mesa was before
it had GLX, SFML prints `Failed to create an OpenGL context for this
window` and goes on, and the game dies of SIGSEGV at address 0:
SFML's `sf::priv::ensureExtensionsInit` calls `glGetIntegerv` through
a function pointer that only a context fills in. The same happens to
the aarch64 build run in qemu's user mode against Xvfb on x86_64 with
no aarch64 GLX vendor, and with nixpkgs' aarch64 Mesa as the vendor
the game runs there, so the crash is the missing driver's and not the
package's.

### Routes not taken

Rootless Xwayland through the satellite worked on the first try, so
neither fallback was built: rootful Xwayland as one window holding the
X11 screen, or unkernel's display device (`/dev/fb0`, or Xorg's
modesetting driver on virtio-gpu) drawn on the page. Both would put
every X11 program in one window. An earlier try of `weston --xwayland`
inside wland gave a black window, after which the guest's shell
stopped answering; it was not revisited.

## Vulkan programs

A Vulkan program in the guest draws on the page's WebGPU. unkernel's
kernel bundle carries kwvk, a Vulkan driver whose GPU is the page's
([.agents/vk.md](https://github.com/pithings/unkernel/blob/main/.agents/vk.md)
in unkernel), and the site serves kwvk built with seven fixes of its
own (see [The Vulkan driver](#the-vulkan-driver)), which the guest
uses instead. The loader loads the driver into the program; the driver
sends the program's Vulkan calls over vsock port 1018 to the SDK's
renderer on the page, which makes the objects on one WebGPU device and
translates the program's SPIR-V shaders to WGSL with `kwvk-naga.wasm`.
The program sees "kwvk (WebGPU)", an integrated GPU with Vulkan 1.2.

```
https://trynix.dev/?pkg=vulkan-tools&vk=1&boot=1&run=vulkaninfo+--summary
https://trynix.dev/?pkg=taisei@1.4.6&vk=1&boot=1&run=TAISEI_RENDERER%3Dsdlgpu%3Avulkan+taisei+%26
```

The second is the Try link "Taisei on Vulkan": Taisei's SDL 3 GPU
renderer on kwvk, at 60 frames a second on a Radeon 780M, as on GLES
(see [Frames without readback](#frames-without-readback)).

It is off unless the link has `vk=1`
([site/js/vulkan.js](../site/js/vulkan.js)), which the Vulkan box under
Settings writes for the next boot. The box also names the browser's
WebGPU adapter by vendor and architecture, says when it draws in
software, and offers On only when there is one; the page asks the
first time the Settings lane opens, never at a boot. A `vk=1` link
boots with Vulkan either way. With it on, mpv's first
frame came 3 s later, for nothing: mpv tries Vulkan before GL, fails on
kwvk, and starts the X server on the way (see [Programs that prefer
Vulkan](#programs-that-prefer-vulkan)). Off, the guest is as it was
before kwvk: the page passes unkernel no `vk` option and no shell has
the two variables below. It can become the default once kwvk offers
the `timelineSemaphore` feature, which mpv's renderer, libplacebo,
requires.

With `vk=1`, nothing of it runs until a program asks for it. The SDK
listens on the driver's port and waits for a program to create a
VkInstance. Only then does it
ask the browser for a WebGPU adapter and a device, and fetch the
renderer's two chunks (433 bytes) and the translator (1.39 MB, 442 KB
gzipped). On SwiftShader in headless Chromium the renderer was ready
73 to 150 ms after the first VkInstance.

With `vk=1` every shell gets two variables (`sessionEnv` in
[site/js/gui.js](../site/js/gui.js)):

- `VK_DRIVER_FILES=/nix/store/<kwvk>/share/vulkan/icd.d/kw_icd.json`,
  the manifest of the site's kwvk. nixpkgs' loader looks for drivers in
  `/etc/xdg`, `/run/opengl-driver/share` and `/usr/share`; the guest
  has the manifest in none of them, and `/run/opengl-driver` is the GL
  driver's link. The variable makes kwvk the one driver the loader
  loads: the kernel's own kwvk, in the kw layer, is not loaded beside
  it, and neither is a Vulkan driver a selected `mesa` brings. Where
  the page could not read the site's manifest, the variable names the
  kernel's own kwvk, `/kw/layer/usr/share/vulkan/icd.d/kw_icd.json`.
  The driver is built against glibc 2.34 and links nothing else, so a
  program from nixpkgs 22.05 on loads it. The loaders of older nixpkgs,
  1.2 and before, ignore the variable, and their programs see no Vulkan
  device; 1.3.211, the oldest 1.3 in the index, reads it.
- `LIBGL_KOPPER_DISABLE=1`. A nixpkgs Mesa the reader selects tries
  zink on the first Vulkan device when its own GL driver fails, which
  would run GL through kwvk; unkernel advises the variable for that.
  The site's Mesa has no zink.

### The Vulkan driver

The kwvk in unkernel 0.2.0-261124-75694e2's base system draws none of
the games tried: GZDoom 4.14.2 finds no device it accepts and falls
back to GLES, Taisei 1.4.6's Vulkan renderer loses the device at its
first draw, and the DDNet 20.0 client finds no memory it can map and
gives up. Seven small changes to the driver's `icd.c` make all three
draw, each filed upstream as
[pithings/unkernel#32](https://github.com/pithings/unkernel/issues/32).
0.2.0-261125-cec0a49 left the code they change as it was:

| patch                                             | GZDoom | Taisei | DDNet |
| ------------------------------------------------- | ------ | ------ | ----- |
| 0001, report `multiDrawIndirect`                  | needs  |        |       |
| 0002, storage buffers never written are read-only | needs  |        |       |
| 0003, drop descriptor bindings no function uses   | needs  | needs  |       |
| 0004, uniform bindings in whole 16-byte steps     | needs  |        |       |
| 0005, drop `OpLine` and `OpNoLine`                |        | needs  |       |
| 0006, compressed copies in whole blocks           |        | needs  |       |
| 0007, host-visible memory is `HOST_CACHED`        |        |        | needs |

[nix/kwvk.nix](../nix/kwvk.nix) builds the driver from unkernel's
source at the commit the vendored SDK was published from, with the
changes as [patches/kwvk/](../patches/kwvk/), the way unkernel's
`vk/icd/build.sh` builds it: zig cc for aarch64 against glibc 2.36's
symbols, stripped, against the Vulkan headers unkernel pins. Without
the patches the build gives the base system's driver but for the
compiler version in its `.comment` section: LLVM 21.1.8 in nixpkgs' zig,
21.1.0 in the one unkernel 0.2.0-261125-cec0a49 was built with.
The driver and the SDK's renderer speak one protocol, so
[nix/vendor.nix](../nix/vendor.nix) takes unkernel's version from
kwvk.nix. The output is the driver and a manifest that names it by
its store path: 143 KB, 47.8 KB as the xz NAR the page fetches.

The site serves it as it serves the GL driver: a store path in the
site's cache, `gl/cache/`, named in `gl/drivers.json` (as `vulkan`),
whose closure is walked the first time the guest looks inside it
([site/js/lazy.js](../site/js/lazy.js), capabilities). That lookup is
the Vulkan loader reading the manifest `VK_DRIVER_FILES` names, so a
boot fetches nothing of it, and neither does a `vk=1` guest until a
program loads Vulkan. Unlike the GL driver's, its files are not
committed: zig builds the driver from any system, so the site's build
writes its narinfo, listing and NAR into `gl/cache/` and names it in
the served `drivers.json` ([tools/site-cache.py](../tools/site-cache.py)),
and the served driver can never lag the patches. The committed
`drivers.json` names no Vulkan driver.

`checks.kwvk-spirv` ([nix/kwvk-check.nix](../nix/kwvk-check.nix))
compiles the patched `icd.c` natively into a harness
([tests/kwvk/](../tests/kwvk/)) and runs the three SPIR-V passes on
shaders glslang compiles at build time: buffers only read must come
out read-only and written ones stay writable, unused bindings must go,
from SPIR-V 1.4 entry point interfaces too, no line instructions may
be left, and `spirv-val` must pass. `checks.site` checks that the
built site names the driver, lists it among its cache's paths, has a
listing beside its narinfo, and that its NAR matches the narinfo's
`NarHash` and unpacks to the driver.

### Frames without readback

kwvk presents a Wayland swapchain in one of two ways (unkernel's
`vk/PROTOCOL.md`, Amendments, "External present"). By readback, each
present copies the image's pixels from its GPUTexture into a mapped
buffer, sends them over vsock to the guest, and kwvk copies them into
a `wl_shm` buffer, which the compositor reads through kwshm and uploads
to the GPU again. By external buffer, kwvk makes one `wl_buffer` per
swapchain image with wland's `wland_external_buffer_manager_v1`, named
by the renderer's token and the image's export id, and a present
carries no pixels: at each commit the compositor asks guest Vulkan's
renderer for the image's picture (`kernel.vk.externalImage`), a copy
into a WebGPU OffscreenCanvas on the renderer's device handed over as
an ImageBitmap.

kwvk takes the second way when three things hold: the SDK's probe of
a WebGPU canvas passed, so the renderer's hello carries a token; the
relay runs with `--external-buffers`, which wland has since
0.1.0-261124-3c987e5; and the page gives the compositor a
`resolveExternal` (`gpuSource` in [site/js/gui.js](../site/js/gui.js)).
wland offers the global only with the last two, and kwvk uses it only
with the first. The probe fails in headless Chromium without a GL
backend for canvases (no `--use-angle`), where the canvas path would
destroy the device; kwvk then reads frames back as before. Without
`vk=1` the page has no Vulkan renderer and gives no `resolveExternal`,
so no program is offered the global.

Measured 2026-11-24 on the laptop's Radeon 780M ("amd rdna-3") in
headless Chromium 152 with its hardware WebGPU adapter, on the site
just before external buffers (the patched kwvk, frames read back) and
on the site with them, the two alternated, three runs each, each in a
new browser profile with downloads on first use. "First picture" is
from the command to the first frame in the program's window with more
than 24 colours; frames a second are the compositor's commits over 20
s (vkcube 15 s) after 20 s (10 s) of settling. The 1-minute load
average was 0.6 to 2.5 at the commands and 0.9 to 2.6 while
measuring:

| program                         | frames          | first picture      | frames a second  |
| ------------------------------- | --------------- | ------------------ | ---------------- |
| Taisei 1.4.6, SDL 3 GPU on kwvk | read back       | 15.4 s (15.3–15.7) | 43.1 (41.2–43.2) |
| Taisei 1.4.6, SDL 3 GPU on kwvk | external buffer | 15.8 s (15.5–21.3) | 59.9 (59.9–60.0) |
| Taisei 1.4.6, GLES 3.0 on virgl | GPU resource    | 12.6 s (12.4–12.7) | 59.9 (59.9–60.0) |
| vkcube 500x500, FIFO            | read back       | 0.88 s (0.63–0.89) | 59.8 (59.7–59.9) |
| vkcube 500x500, FIFO            | external buffer | 0.65 s (0.62–3.13) | 60.0 (60.0–60.0) |
| vkcube 500x500, IMMEDIATE       | read back       | 0.89 s (0.64–0.91) | 178 (176–181)    |
| vkcube 500x500, IMMEDIATE       | external buffer | 0.86 s (0.62–0.88) | 869 (834–921)    |

Read back, Taisei's 928x836 frames cost 3.1 MB each and held it at 43
frames a second; by external buffer it draws at 60, the rate of the
compositor's frame callbacks, as on GLES, and nothing is read back.
GLES on the site before external buffers measured the same: 12.7 s
and 60.0. vkcube in FIFO waits for those callbacks too, so both ways
it draws at 60; IMMEDIATE shows what each way can carry, five times as
many frames without readback. First pictures are not what changed:
the slowest of the external rows came with slow downloads. That Taisei
run's shell took 57.5 s against 29 to 32 s for the others, and its
first commit came 15.7 s after the command against 9.8 to 9.9 s; that
vkcube run fetched 16.9 MB before its first frame, against 2.1 to
12.4 MB for the others. Taisei's first picture is 3 s later on Vulkan
than on GLES either way; the renderer's shader translation is 38 to
45 ms of that, and the rest was not traced. On the kernel's own kwvk
Taisei draws nothing: its pipelines fail on `OpLine` among the types.

### GZDoom on Vulkan

The Doom link starts GZDoom 4.14.2 on its Vulkan renderer
(`+vid_preferbackend 1`, with `vk=1`). Its GLES renderer
(`+vid_preferbackend 2`) draws through virgl, which replays the guest's
GL on the page's main thread; in a level that takes most of the
thread, so dragging a window lags and the page's sound runs dry
(unkernel#34). On Vulkan the frames come by external buffer and the
thread stays free. Without a WebGPU adapter the driver answers
`VK_ERROR_INCOMPATIBLE_DRIVER` and GZDoom falls back to GLES by
itself.

Measured 2026-11-25 on unkernel 0.2.0-261125-cec0a49, the laptop's
Radeon 780M in headless Chromium 152 with its hardware adapter, three
runs of each renderer alternated, `+map E1M1`. "In the level" is when
GZDoom's window title names the level; page frames a second are the
page's `requestAnimationFrame` rate:

| GZDoom 4.14.2, E1M1                         | GLES               | Vulkan             |
| ------------------------------------------- | ------------------ | ------------------ |
| first commit                                | 12.1 s (12.1–12.4) | 11.9 s (11.9–12.1) |
| in the level                                | 21.0 s (20.3–21.1) | 30.3 s (29.9–31.8) |
| game frames a second                        | 15.1 (14.8–15.2)   | 19.7 (16.3–20.5)   |
| page frames a second, at rest               | 30.5 (29.5–36.7)   | 60.0               |
| page frames a second, dragging              | 55.9 (55.6–56.5)   | 60.0               |
| pointer moves the page took in 10 s of drag | 332                | 587 (585–587)      |
| sound underruns a second, at rest           | 2.9 (2.5–3.4)      | 0                  |
| sound underruns a second, dragging          | 4.6 (2.9–4.8)      | 0                  |

The 9 s it takes longer to reach the level is GZDoom compiling its
GLSL to SPIR-V with glslang in the guest, on its one thread, before
the level; the renderer meanwhile translated only a few shaders, in
under 60 ms. GZDoom keeps no SPIR-V cache, only a `VkPipelineCache`
file, and every page load is a new guest, so no cache would survive
anyway; more guest CPUs do not help one thread.

### Which browsers have an adapter

The renderer needs a WebGPU adapter. Chrome has one on macOS, Windows,
ChromeOS and Android. On Linux it depends on the GPU and the driver:
Chrome 157 gave a hardware adapter for an AMD Radeon 780M on Mesa
with no WebGPU flags, on a profile with `#ignore-gpu-blocklist` on;
without that override it is untested. Headless Chromium 152 on Linux
gives no adapter unless started with flags; `gui-test` starts it with
the ones unkernel's own tests use (`--enable-unsafe-webgpu`,
`--use-vulkan=swiftshader`, `--use-webgpu-adapter=swiftshader` and the
`Vulkan` and `WebGPU` features), which give any host SwiftShader's
adapter. With `--use-angle=vulkan` and the `Vulkan` feature instead
it gives the host's GPU, `amd rdna-3` for the 780M, which is how [A
language model](#a-language-model) was measured; `--use-vulkan=native`
alone still gives SwiftShader. Firefox 160 on Linux, headless, had no
`navigator.gpu`; with `dom.webgpu.enabled` and
`gfx.webgpu.ignore-blocklist` set in its preferences it had an
adapter, and vulkaninfo and vkcube ran, vkcube at about 10 frames a
second on SwiftShader against 58 in Chromium.
Safari has not been run.

Without an adapter a program gets what it would get on a machine with
no Vulkan driver: the driver answers the loader
`VK_ERROR_INCOMPATIBLE_DRIVER` and prints `kwvk: device lost: the host
closed the link` on the program's stderr, and the page's log says why
(`[host] vk: no renderer: navigator.gpu.requestAdapter() gave no
adapter`, or with no `navigator.gpu` at all, `no WebGPU on this
thread`). vulkaninfo fails that way in 0.4 s the first time and
0.04 s after.

### What runs

Run in trynix, 2026-11-24, headless Chromium with SwiftShader's WebGPU:

- `vulkaninfo`, which names kwvk's device. Every shell has `DISPLAY`,
  so it also asks the X display about surfaces, and its first run
  starts the X server: 3.0 s, against 0.5 s when shells had no
  `DISPLAY`.
- `vkcube --wsi wayland`, 58 frames a second at 500x500, when its
  frames were read back (see [Frames without
  readback](#frames-without-readback) for how they reach the
  compositor now). nixpkgs' vkcube (vulkan-tools 1.4.304
  on) needs a hand: it loads libwayland-client and libxcb with
  `dlopen`, and its RUNPATH names only the Vulkan loader. On NixOS
  Mesa's Vulkan driver links libwayland-client, so the library is
  already in the process when vkcube asks; kwvk opens Wayland with
  `dlopen` too, and vkcube says `Cannot load wayland dynamic library`.
  Naming the store's libwayland directories works; there are several
  once the GL driver's and the X server's closures are in:
  `LD_LIBRARY_PATH=$(ls -d /nix/store/*-wayland-[0-9]*/lib | tr '\n' :) vkcube --wsi wayland`.

unkernel's own tests ran these on Debian 13 on the same driver
(vk.md, "What runs"): vkmark's seven scenes; SDL 2's and SDL 3's
`testvulkan`; SDL 3's GPU API (`testgpu_simple_clear`,
`testgpu_spinning_cube`); GTK 4.18 with `GSK_RENDERER=vulkan`, which
GTK's default renderer is not; vkd3d-gears through Xvfb. llama.cpp's
ggml-vulkan selects kwvk and generates text, with caveats: some of
its pipelines are refused and abort the run (`quantize_q8_1_x4`,
`count_experts`, which rules out mixture-of-experts models, and the
rwkv ones); the guest keeps a copy of every host-visible allocation,
so models need the larger memory settings; and every number upstream
has is from SwiftShader but one, an Apple M4 Pro in Chrome.

### A language model

The Try link "an LLM on your GPU" opens llama.cpp's chat, `llama-cli`
from `llama-cpp-vulkan@1.0.0` (build 12359), on Qwen2.5-0.5B-Instruct
at Q4_K_M, Apache 2.0: a 398 MB file. The link names it as a store
path in trynix.cachix.org (`path=` and `cache=`): the path
`nix store add-file` gives Hugging Face's file, pushed and pinned
there. Hugging Face's CDN sent it at 1.7 to 10 MB/s on one connection,
cachix's Cloudflare CDN at 13.7 MB/s. The version is pinned because the index
sorts the build numbers nixpkgs used before 0.2.0 (up to 10408) above
1.0.0. ggml-vulkan takes kwvk's device and `-ngl 99` puts every layer
on it. `-c 2048` keeps the context buffers small: at Llama 3.2 1B's
own 128k context, llama.cpp asked for 8 GB and gave up. On wikitext-2,
Q4_K_M's perplexity was 15.12, Q8_0's (531 MB) 14.98 and Q4_0's
(353 MB) 16.82.

Measured on a laptop (Radeon 780M) in headless Chromium 152 with its
hardware adapter, 2026-11-24, from opening the link to the first word
of the answer to a question typed at the chat's prompt:

| visit                       | first answer | downloaded                            |
| --------------------------- | ------------ | ------------------------------------- |
| first, in an empty profile  | 57 to 166 s  | 398 MB model, 33 MB llama.cpp closure |
| a reload                    | 15 to 19 s   | nothing                               |
| a reload, no WebGPU adapter | 39 s         | nothing                               |

Each visit also fetched the site's own files, 17 to 28 MB, which the
local server sent uncached. A first visit is the model's download,
which Hugging Face's CDN served at 2.6 to 10 MB/s in the three visits
measured above, before the link moved to cachix;
a reload reads the model from the Cache API, and most of its 15 s is
llama-cli loading it through the share and onto the GPU. The renderer process peaked at 1.9 to 2.0 GiB,
the GPU process at 150 to 225 MiB. The guest needs little: the chat
answered in 512 MiB with 82 MiB to spare, so the link names no `mem=`.
Without an adapter kwvk says `device lost`, llama.cpp warns that it
found no usable GPU, and the same chat runs on the guest's CPU.

llama-bench on the same build and file, 64 prompt tokens and 32
generated:

| where                         | prompt   | generation |
| ----------------------------- | -------- | ---------- |
| kwvk, the 780M through WebGPU | 784 t/s  | 31 t/s     |
| the guest's CPU, 4 CPUs       | 4.3 t/s  | 1.2 t/s    |
| the guest's CPU, 16 CPUs      | 5.8 t/s  | 1.4 t/s    |
| the laptop itself, on RADV    | 2647 t/s | 145 t/s    |

In the chat llama-cli reports 9 to 15 t/s: llama-bench times decoding
alone, and llama-cli also reads each token's logits back and samples
them on the guest's CPU. SmolLM2-135M and Llama-3.2-1B ran on kwvk too,
at Q8_0, Q4_0 and Q4_K_M, all between 28 and 39 t/s; none of the
pipelines kwvk refuses came up.

### An editor

The Try link "Zed on Vulkan" opens nixpkgs' recipe for hello, fetched
with `file=` from raw.githubusercontent.com at a commit, in the Zed
editor 1.29.3, the index's newest aarch64 build. Zed draws with wgpu,
and unkernel 0.2.0-261125-cec0a49's kwvk is what lets wgpu make its
device and draw its pipelines the right way up. Zed refuses to start as
root, which every guest shell is, unless `ZED_ALLOW_ROOT=true` says to.
It opens the file in Restricted Mode and asks whether to trust
`/share/nix/store`, the store's real path; Enter trusts it.

VS Code is unfree, so Hydra does not build it and cache.nixos.org has
none. VSCodium is there, and runs on GL as root with `--no-sandbox
--user-data-dir <dir>`, once the guest has `/usr/bin/env` for its
launcher's `#!` line ([unkernel.md](./unkernel.md#how-the-page-uses-it)).

Measured 2026-11-25 on the laptop (Radeon 780M, headless Chromium 152
with its hardware WebGPU adapter), each run in a new profile with
downloads on first use. "Picture" is from the command to the first
frame with more than 24 colours; typing is from each of twelve keys to
the compositor's next frame from the program, polled every 5 ms, after
the trust dialog was dismissed:

| editor             | runs | shell              | picture            | link to picture    | typing, median   |
| ------------------ | ---- | ------------------ | ------------------ | ------------------ | ---------------- |
| Zed 1.29.3, Vulkan | 5    | 11.9 s (10.2–14.4) | 8.5 s (8.2–9.5)    | 20.1 s (18.6–23.6) | 110 ms (2–193)   |
| VSCodium 1.143, GL | 3    | 24.4 s (18.0–27.2) | 51.8 s (50.7–55.1) | 76.2 s (68.7–82.3) | 296 ms (13–4273) |

Zed's typing column is from the three runs that dismissed the dialog;
its 2 ms is a frame that was already on its way.
VSCodium's first frame came 20 to 22 s after the command, and its
frames had fewer than 25 colours for 30 s more. Its keys took 13 ms to
4.3 s, with one key in each run over 3.7 s.

What they fetch: the selected package's own path comes before the
shell, Zed's 90 MB (387 MB unpacked) and VSCodium's 199 MB (614 MB),
and the rest of the closure on first use. Zed's closure is 247 paths,
417 MB compressed and 1.57 GB unpacked, of which it opened 116 paths,
231 MB unpacked, by its first picture, downloading 80 MB after the
command. VSCodium's is 268 paths, 562 MB and 1.82 GB, of which 172
paths, 379 MB unpacked, by its first picture. Both ran in the default
2 GiB guest.

### What does not

- kwvk does not offer geometry or tessellation shaders, texel buffers,
  1D-array storage images, linear-tiling images, `robustBufferAccess`,
  logic ops, `multiDrawIndirect`, `fillModeNonSolid`, wide lines, large
  points, 16- and 64-bit integers or 64-bit floats in shaders, pipeline
  statistics queries, sparse resources, timeline semaphores, or the
  subgroup operations naga lacks.
- No zink. Mesa's zink connects to kwvk and gives up after the hello:
  it wants far more features. GL stays on virgl.
- No DXVK. It needs texel buffers and geometry shaders.

### Programs that prefer Vulkan

Some programs try Vulkan before GL. Without kwvk their first
`vkCreateInstance` fails at once and they go on to GL; with it they
find a device and go further before they give up on it. This table is
why `vk=1` is opt-in. Measured 2026-11-24 in headless Chromium with
SwiftShader's WebGPU and WebGL, each program on the site before kwvk
and on the site with kwvk in every boot, the closure downloaded before
the shell (`fetch=all`), from the command to the compositor's first
frame:

| program                           | boots | without kwvk       | with kwvk          | draws with              |
| --------------------------------- | ----- | ------------------ | ------------------ | ----------------------- |
| mpv 0.42, a 5 s H.264 file        | 6     | 4.5 s (4.3–4.8)    | 7.5 s (7.0–8.0)    | GL, after probing kwvk  |
| gnome-calculator 51.1 (GTK 4.24)  | 6     | 16.8 s (16.2–17.4) | 16.8 s (16.5–17.6) | GL, after probing kwvk  |
| firefox 160                       | 2     | 24.7–25.1 s        | 24.9–25.5 s        | GL; makes no VkInstance |
| lbreakouthd (SDL 2 through SDL 3) | 2     | 6.0–6.4 s          | 6.1–6.3 s          | GL; makes no VkInstance |
| es2gears_wayland                  | 2     | 2.13–2.16 s        | 2.13–2.14 s        | GL                      |
| foot                              | 2     | 0.81 s             | 0.81 s             | shared memory           |
| xterm                             | 2     | 3.2–3.6 s          | 3.2–3.5 s          | shared memory, by X11   |

mpv is slower by 3 s with kwvk, and gains nothing. Its default
output, gpu-next, asks libplacebo for Vulkan on Wayland, then Vulkan on
X11, then GL. libplacebo requires the `timelineSemaphore` feature, which
kwvk lacks, so both Vulkan attempts fail at the device. The X11 one
opens display `:0` first, and that starts the X server, xwayland-satellite
and Xwayland, with their closure downloaded on first use: 3.1 to 3.4 s
in mpv's own log, for a server nothing then uses. mpv then draws with
GL as it did before, at the same 29.5 frames a second. The Try link's
mpv, `--vo=wlshm`, takes no part in this.

GTK 4 makes an instance and a device on kwvk, logs `Not using Vulkan:
no dmabuf support`, and draws with GL; its first frame did not move.
Its instance stays open while the program runs: one stream to the
renderer, and the renderer's WebGPU device kept on the page.

Without an adapter (Chromium's WebGPU off, as headless Chromium on
Linux has it without flags) both fail at the instance, as before kwvk, no X server starts, and
neither moved: mpv 4.3 and 5.0 s against 4.3 and 4.3 s,
gnome-calculator 16.8 s against 16.7 and 16.8 s.

With Vulkan behind `vk=1`, a link without it is back where it was:
mpv's first frame took 4.3 to 4.8 s in four boots, every Vulkan
attempt failed at the instance, and mpv never opened the X display.

## Video

A program that decodes video through VA-API gets the browser's own
decoder. unkernel's base system carries kwva, a libva driver in its kw
layer, and with the SDK's `va` option, which every boot passes
([site/js/unkernel.js](../site/js/unkernel.js)), the driver sends each
picture over vsock port 1024 to a WebCodecs `VideoDecoder` on the page
([.agents/va.md](https://github.com/pithings/unkernel/blob/main/.agents/va.md)
in unkernel). It decodes H.264, VP9 and AV1, and encodes VP9. With the
virtio-gpu device every guest has, the decoded frame is drawn into the
program's surface on the page's GPU, so mpv's `--vo=dmabuf-wayland`
hands the compositor the picture by GPU resource with no pixels in the
guest's memory.

```
https://trynix.dev/?pkg=mpv&file=<url>%20<hash>&boot=1&run=mpv+--hwdec=vaapi+--vo=dmabuf-wayland+--video-sync=desync+<path>+%26
```

The clip measured below is the first 30 seconds of Big Buck Bunny (CC
BY 3.0, Blender Foundation) at 1080p in H.264, 22.7 MB, fetched with
`file=` from jsDelivr's copy of the npm package video-media-samples
1.0.0. jsDelivr sends CORS headers and sent it at 5 to 16 MB/s. mpv
decodes on the CPU unless told `--hwdec=vaapi`;
`--video-sync=desync` keeps it from dropping frames to follow the
guest's audio clock, as unkernel's own page found. The Try link "a film
in mpv" plays the clip that way, looping.

nixpkgs' libva loads the driver. kwva exports `__vaDriverInit_1_22`,
which libva 2.22 and later take (the index's mpv 0.42 brings libva
2.24), and links glibc alone, at 2.34. libva looks for drivers in
`/run/opengl-driver/lib/dri`, which is the GL driver's link and holds
none, so every shell names the kw layer's directory with
`LIBVA_DRIVERS_PATH` (`sessionEnv` in
[site/js/gui.js](../site/js/gui.js)). The file there is
`virtio_gpu_drv_video.so`, the name libva derives from the virtio-gpu
device's kernel driver, so `LIBVA_DRIVER_NAME` is not needed. `vainfo`
then names `kwva (WebCodecs: software)` in headless Chromium, whose
WebCodecs decodes in software on Linux.

Nothing of it runs until a program opens a VA-API display: only then
does the SDK ask WebCodecs which codecs it decodes. The page passes the
option on every boot because that costs nothing measurable: hello's
cold boot reached its shell in a median 1.4 s (1.3 to 1.7) with it and
1.4 s (1.3 to 1.5) without it, twenty boots each, alternated. Measured
2026-11-25 on the laptop (Radeon 780M, headless Chromium 152 with its
hardware WebGPU adapter), the closure downloaded before the shell
(`fetch=all`), the site without the option and with it alternated,
three runs each, from the command to the first frame with a picture:

| program                           | without VA-API     | with VA-API        |
| --------------------------------- | ------------------ | ------------------ |
| mpv, the Try link's fractal       | 4.16 s (4.14–4.43) | 4.17 s (4.15–4.67) |
| es2gears_wayland                  | 2.17 s (2.16–2.66) | 2.14 s (2.09–2.71) |
| lbreakouthd (SDL 2 through SDL 3) | 11.8 s (11.8–13.7) | 11.8 s (11.5–12.5) |
| firefox                           | 28.9 s (28.4–29.4) | 28.7 s (28.7–28.8) |

Of these only firefox opened a VA-API display, its start-up probe, and
the SDK asked WebCodecs then; its first frame did not move. mpv opens
none unless told to decode with it.

The clip, five runs each in a new browser profile with
downloads on first use, mpv's closure from cache.nixos.org and the clip
from jsDelivr, against mpv's default of decoding on the guest's CPU
(three runs):

| mpv                        | link to picture    | frames a second  | dropped, first 25 s | audio behind |
| -------------------------- | ------------------ | ---------------- | ------------------- | ------------ |
| VA-API, `dmabuf-wayland`   | 13.9 s (11.9–15.2) | 24.0 (24.0–24.0) | 1 to 3              | 0.03 s       |
| on the CPU, its own output | 14.5 s (14.5–14.9) | 4.9 (4.9–5.0)    | 185 to 194          | 7.7 s        |

Both fetched mpv's closure on first use, 139 to 154 MB, and the clip
before the first picture; the picture came 9.0 to 11.5 s after the
command. With VA-API the clip plays at its 24 frames a second. Each
frame costs the page's main thread about 14 ms, the SDK drawing the
decoded frame into the program's surface (`vm.va.stats.gpuUploadMs`),
about a third of the thread at 24 frames a second. On the CPU mpv
decodes about five frames a second and drops the rest.

ffmpeg takes the driver too: `ffmpeg -hwaccel vaapi` decoded 240
frames of the clip at 68 frames a second with each picture read back
into the guest, against 17 on the guest's CPU. VLC 3.0.24 refuses to
run as root, which every guest shell is.

## Firefox and whole compositors

nixpkgs' `firefox` runs in the guest, as a Wayland client, loading GL
through libglvnd with `dlopen`, from the GL driver every guest has.
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
with Web Audio. The player is the SDK's `createAudioOut`
([pithings/unkernel#17](https://github.com/pithings/unkernel/issues/17)):
an AudioWorklet plays from a queue that starts once 60 ms is in,
resamples to the device's rate, and steers by up to 1% to absorb the
drift between the guest's clock and the audio device's. The page adds
the console bar's control ([site/js/sound.js](../site/js/sound.js)).

Browsers start sound only after a click or key press on the page. A
Try link boots and runs its command with no click on the new page, so
the AudioContext is made only once the page has had one, and until
then up to 10 s of what programs play is held. The console bar shows
"sound: click to play"; a clip that ended by the click plays whole,
and a stream still playing joins live. After that the same control
switches sound off and on, and puts its position in the link
(`sound=off`), which a link can also start with.

```
https://trynix.dev/?pkg=espeak-ng&boot=1&run=espeak-ng+%27Hello%27
```

Measured in headless Chromium, 2026-11-23: espeak-ng's 1.9 s greeting,
held before the click, played whole after it, then a second line live,
with no underruns and nothing dropped.

### Which programs play

Programs play through ALSA on card 0, and the page starts no sound
server. Most programs that speak PulseAudio try it first and fall back
to ALSA when no server answers. Measured in headless Chromium, each
program selected alone, by the audio that reached the page (a headless
browser has no speakers):

| program                               | tries                           | plays |
| ------------------------------------- | ------------------------------- | ----- |
| espeak-ng                             | PulseAudio, then ALSA           | yes   |
| `aplay`                               | ALSA                            | yes   |
| mpv, its default output               | PipeWire, PulseAudio, then ALSA | yes   |
| ffplay (SDL 3, through sdl2-compat)   | PipeWire, PulseAudio, then ALSA | yes   |
| `gst-launch-1.0` with `autoaudiosink` | pulsesink, then alsasink        | yes   |
| firefox, a Web Audio tone             | PulseAudio, then ALSA (cubeb)   | yes   |
| aisleriot's card sounds (libcanberra) | ALSA, told by `CANBERRA_DRIVER` | yes   |
| `paplay`, `pacat`                     | PulseAudio only                 | no    |
| `pw-play`                             | PipeWire only                   | no    |

espeak-ng, mpv and aisleriot were measured on 2026-11-24, the rest on
2026-11-23. espeak-ng's line was held 1.3 s for the click, mpv opened
`AO: [alsa]` and held its 2 s tone, and each card aisleriot dealt sent
its 0.15 s click to the page's worklet. A program that speaks only
PulseAudio, such as pavucontrol, has nothing to talk to.

libcanberra plays GTK programs' event sounds and the sounds of games
that use it, aisleriot's among them. It takes its PulseAudio backend
whenever that backend's module loads, and when no server answers it
fails there, with no fallback. So every shell gets
`CANBERRA_DRIVER=alsa` ([site/js/gui.js](../site/js/gui.js),
`sessionEnv`).

OpenAL Soft, which GZDoom and other games play through, keeps three
20 ms periods in the card's buffer by default. In a GZDoom game its
mixer missed that 60 ms about once every two seconds; each miss is an
underrun, which OpenAL Soft recovers from by restarting the stream,
printing `mmap commit error: Broken pipe`. Every shell names an OpenAL
Soft configuration with four periods (`ALSOFT_CONF`, written by
[site/js/gui.js](../site/js/gui.js)), and over 30 s of the game none
came. A program that names its own buffer keeps it.

The page still runs dry while GZDoom plays a level, six to eight times
a second in headless Chromium on SwiftShader. Replaying its GL on the
page's WebGL takes about 90% of the page's main thread, most of it in
`getBufferSubData` and `bufferSubData`, and the kernel hands the page
its sound from CPU 0, which runs on that thread: chunks then come up
to 200 ms apart, the worklet's 60 ms queue empties, and after each
gap kwsnd hands over 30 ms and skips the rest, so about 90% of the
sound's time reaches the page. A tone from OpenAL Soft's `altonegen`
played with no gap alone and beside four busy loops in the guest, and
ran dry 8 times a second beside a silent GZDoom game.

The card has one stream, so one program holds it at a time, and a
second program that opens it meanwhile gets EBUSY. ALSA's dmix plugin,
which mixes several programs into one stream, needs a PCM timer that
unkernel has not turned on yet
([pithings/unkernel#31](https://github.com/pithings/unkernel/issues/31)).

## What it costs

Measured 2026-11-23 on a laptop (AMD Radeon 780M), headless Chromium
157, through `nix run .#gui-test`. The closures come from
cache.nixos.org over a home connection.

What the site adds, fetched only when used:

| file                         | raw     | gzip   | fetched                         |
| ---------------------------- | ------- | ------ | ------------------------------- |
| wland modules and wasm       | 419 KB  | 120 KB | on the relay's first dial       |
| relay (`wlandr`)             | 359 KB  | 150 KB | while the shell starts          |
| DejaVu Sans and Sans Mono    | 1.10 MB | 587 KB | while the shell starts          |
| `virgl.mjs` and `virgl.wasm` | 597 KB  | 216 KB | on the guest's first GL use     |
| `kwvk-naga.wasm` and chunks  | 1.39 MB | 442 KB | on the guest's first VkInstance |

The closures, from the cache, for the paths the nixpkgs this flake
locks builds (the page resolves names against the multiverse index,
which can pick a newer build; its Mesa was 26.3.1 against the lock's
26.2.2):

| selection                     | paths | compressed | unpacked |
| ----------------------------- | ----- | ---------- | -------- |
| foot                          | 36    | 29 MB      | 115 MB   |
| mesa-demos + `mesa`           | 133   | 380 MB     | 1.47 GB  |
| mesa-demos, the site's driver | 131   | 124 MB     | 548 MB   |

The unpacked closure is held in the page's memory. With nixpkgs' Mesa
a GL boot asked the browser for 1.5 GB before the guest did anything;
with the site's driver it is 548 MB, 458 MB of it mesa-demos' own
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
| gzdoom + freedoom             | 10–12 s     | 14 s; title screen 27–32 s    |

The galculator to wev rows were taken while an aarch64 build ran on
the same machine, so read them as orders of magnitude. The gzdoom row
is the Doom Try link, 2026-11-24, in headless Chromium 157 on
SwiftShader with nothing cached: by its title screen the page had
fetched 168 paths, 172.5 MB, on first use. GZDoom's first frame is one
of the windows it opens and closes while it picks a GL context; it
then loads its scripts before it draws the game. es2gears'
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

- **GL programs from before nixpkgs 23.11** fail to load the driver,
  which needs glibc 2.38, and report no display, as with no driver.
  The page says so; a Mesa from the program's own nixpkgs, selected
  with `pkg=mesa@<version>`, is the way around it until an older
  driver is published. Before nixpkgs moved the EGL vendor file into
  Mesa's default output, that Mesa's index entry lacks it (22.3.7 keeps
  it in `mesa-22.3.7-drivers`), and the drivers output has to be
  selected by its store path.
- **A selected `mesa`** resolves to the newest Mesa in the index,
  which may be built against a newer glibc than the program; the page
  does not check one the reader chose.
- **A blit or copy within one texture level**, whose source and
  destination are the same image, is refused by WebGL 2 too, and the
  site's Mesa does not route around it; no program run so far has done
  one.
- **A shadow sampler** whose texture is not a depth texture, or whose
  sampler does not compare, is refused by WebGL 2 as well, and the
  site's Mesa leaves it as it is; no program run so far has made one.
- **A GLX program added after the X server started without glamor**
  gets no DRI3: Xwayland decides as it starts, and it started without
  glamor because the selection then linked no libglvnd. Selecting the
  GLX program at the boot, or reloading, avoids it.
- **A GUI program started within 0.2 s of the prompt** can find no
  relay: the relay starts behind the prompt. A program's own loading
  takes longer than that, and gui-test's cases type theirs at the
  prompt.
- **Reloads end the programs**, as they end the guest: the page boots a
  fresh kernel every time.
- **Keyboard layout** is US, which is wland's.
- **The touch key bar** types into the terminal only. A tap on it gives
  the terminal the keyboard, even while a window has it.
- **PulseAudio and PipeWire's own clients**, such as `paplay`,
  `pacat`, pavucontrol and `pw-play`, stay silent: the page starts no
  sound server, and programs play through ALSA.
- **One program plays at a time**, until unkernel turns on the PCM
  timer ALSA's dmix needs
  ([pithings/unkernel#31](https://github.com/pithings/unkernel/issues/31)).
- **Browsers.** `gui-test` passes in Chromium and in Firefox 160, both
  headless: foot takes keys, and es2gears draws through virgl at
  60 FPS. With the X server and the driver in every guest, its foot,
  xterm and extremetuxracer cases passed in Chromium 152 and Firefox
  155, and every case in Chromium 152. The vulkan case passed in
  Chromium 152 with SwiftShader's WebGPU, and took its no-adapter path
  in Chromium 152 without it and in Firefox 155 and 160, which had no
  `navigator.gpu`. Safari has not been run.

## Testing

`nix run .#gui-test -- --site <site>` boots foot, es2gears and xterm
from links, each selected alone (es2gears with no Mesa, xterm with no
X server), starts each at the shell and waits for the compositor's
first frame. It checks that es2gears' first look brought the driver,
and that xterm's first connection brought the X server, put none of
its programs on `PATH` and downloaded no GL driver. It types into
foot's window and checks that the keys reached the program, then
presses the terminal beside the window, types a line, and checks that
the page's shell ran it while wland sent no key to any window and
holds none focused. It checks that es2gears' frames went through the
page's GL renderer by GPU resource and not through llvmpipe, and types
a line into xterm's window and checks that xterm's shell ran it.
The feedback case runs
[tools/gl-feedback.py](../tools/gl-feedback.py) with python3 in the
guest: ten draws, each read back. The second renders into a texture
still bound to a sampler unit of its program, and the fifth and sixth
leave a texture of another type than its sampler on a unit (an integer
texture on a float sampler, a float one or none on an integer
sampler). WebGL 2 refuses those draws, and unkernel's renderer then
refuses every later draw of the program's context. The last three
sample what GL defines next to the stand-ins: level 0 of a texture
with NEAREST filters while the draw renders into its level 1, which
reads level 0's red, and an integer sampler with an incomplete texture
or none on its unit, which reads (0, 0, 0, 1). The case fails on a
wrong colour or a context error in the renderer's log.
The fds case runs the fds check of
[tools/wayland-probe.py](../tools/wayland-probe.py) with python3 in the
guest: it sends the relay 28 `wl_shm` pools with their file descriptors
in one write, the most one libwayland flush carries, and checks that a
`wl_display.sync` after them is answered. The relay
used to queue 16 descriptors and close the client at a pool left
without one. libdecor's GTK plugin redraws an SDL program's title bar
into a new pool on every pointer motion, so dragging GZDoom's title
bar while it loaded sent such a burst, and the window went with the
program still running.
The frames case runs the probe's frames check: it commits a frame
callback on a surface with no role and no buffer, and checks over two
seconds of roundtrips, and after the surface is destroyed, that the
compositor never fires it. The compositor used to fire every committed
callback. SDL 3 can lose track of a frame callback whose listener
points at a window it later frees, and GZDoom, which shows and
destroys several windows as it starts, crashed on the done.
The glx case boots extremetuxracer alone, with no X server or driver
selected, waits for the game's window, and checks that its frames went
through the page's GL renderer by GPU resource, which GLX reaches only
by DRI3 on a glamor Xwayland. The oldgl case boots mesa-demos 8.5.0,
older than the driver, and checks that `/run/opengl-driver` is the
site's driver, that none of the Mesa in the program's closure is
downloaded, and that `eglinfo` and `es2gears_wayland` exit with their
own error and not a signal. The slowx case holds the X server's NARs
back 35 s and checks that xterm waits through the hold for its window.
The page records which NARs it fetches for these checks from a script
the tool runs before the page's own.
The vulkan case boots vulkan-tools with `vk=1`, which only it and the
llm case set, types `vulkaninfo --summary` at the page's shell and then
starts `vkcube --wsi wayland`. With a WebGPU
adapter vulkaninfo must name kwvk's device, and vkcube's window must
draw through kwvk: 30 frames presented by the renderer and taken by
the compositor, every one by external buffer with no byte read back,
with no renderer error, and a picture with the LunarG
logo's teal, no olive (red and blue swapped) and many colours. Without
one, vulkaninfo must fail with `VK_ERROR_INCOMPATIBLE_DRIVER` and the
guest must go on answering. The llm case boots `llama-cpp-vulkan@1.0.0`,
the LLM Try link's build, with `vk=1` and stories260K, a 1.2 MB model
named by `file=` from Hugging Face, and has llama-completion continue
a prompt for 24 tokens: it must exit 0 and print words past the prompt,
and with an adapter the renderer must have run its compute work with
no error. On SwiftShader that took 19 s; with `--webgpu off` llama.cpp
falls back to the guest's CPU, which answered in 3 s. The video case
boots mpv with a 480p H.264 clip of Big Buck Bunny the link names by
`file=`, plays it with `--hwdec=vaapi --vo=dmabuf-wayland`, and waits
for 48 pictures. Where the page's WebCodecs decodes H.264, mpv's log
must say it decodes with VA-API and the page's VA-API host must have
decoded the pictures with none failed; elsewhere mpv must play on the
guest's CPU. Either way its window must show a picture. `--webgpu` sets
Chromium's WebGPU for every case: SwiftShader's (the default), which
gives an adapter on any host, or `off`, which is Chromium on Linux as
shipped.
`--with firefox`
runs the same cases in Firefox, driven over WebDriver BiDi, the
protocol Firefox speaks since it dropped the DevTools one.
`--viewport phone` runs them in a phone-sized window, where foot opens
maximized and the terminal is reached through the windows button;
Chromium also emulates a touch screen there.
`--gpu hardware` draws Chromium's WebGL with the host's GPU instead of
SwiftShader (Firefox picks its own), and `--screenshots <dir>` saves
the console, terminal and windows, at each step.

[tests/site/gui.test.mjs](../tests/site/gui.test.mjs) covers what the
page writes into the share and runs in the guest, offline, the
environment every shell gets among it, and which of the GL and Vulkan
renderers' pictures the compositor is given,
[tests/site/unkernel.test.mjs](../tests/site/unkernel.test.mjs) that
a shell that sources it has the site's kwvk named as its one Vulkan
driver, or the kernel's own when the site names none, and zink kept
off,
[tests/site/lazy.test.mjs](../tests/site/lazy.test.mjs) how a
capability joins the store on its first lookup and stays out of the
farm, and
[tests/site/frame.test.mjs](../tests/site/frame.test.mjs) the frame's
rules: which windows open maximized, where the others open, where a
window past the edge goes back to, and what the windows button offers.

## Updating it

wland is pinned twice, and the two must name the same commit: the npm
release in [nix/vendor.nix](../nix/vendor.nix) (the compositor) and
the source in [nix/wlandr.nix](../nix/wlandr.nix) (the relay). The
relay and the compositor speak one stream protocol.

The relay ([nix/wlandr.nix](../nix/wlandr.nix)) and the compositor's
wasm core ([nix/wland-wasm.nix](../nix/wland-wasm.nix)) are built from
that commit's source with [patches/wland/](../patches/wland/); the
npm release supplies the browser modules. One patch makes the relay
queue every descriptor of a client's flush, and one makes the
compositor hold the frame callbacks of a surface with nothing on
screen. Each goes once wland has the change, and an update past that
commit drops it.

## Licenses

The pieces the site ships for this, and their terms, travel in the
site next to the files:

- wland's relay and compositor wasm are MPL-2.0, its JavaScript MIT
  (`gui.<hash>/LICENSE-wland`). The relay and the wasm are built from
  the upstream commit named in `nix/wlandr.nix`, with
  `patches/wland/`.
- unkernel's SDK is MIT and its kernel GPL-2.0
  (`vendor/unkernel/LICENSE`, `LICENSE-MIT`). kwvk, the Vulkan driver
  the site serves, is GPL-2.0-or-later, built from the upstream commit
  named in `nix/kwvk.nix` with `patches/kwvk/`. `virgl.wasm` is
  virglrenderer and parts of Mesa, both MIT, and `kwvk-naga.wasm` is
  naga and its Rust dependencies, MIT or Apache-2.0, each with
  unkernel's glue under GPL-2.0-or-later; their notices are in
  `vendor/unkernel/THIRD-PARTY.md`, which the package ships.
- DejaVu fonts are Bitstream Vera's license with public-domain changes
  (`gui.<hash>/LICENSE-dejavu`).
- The programs come from cache.nixos.org and keep nixpkgs' licenses,
  as every other package the page boots does, the X server every guest
  has among them (xwayland-satellite is MPL-2.0, Xwayland MIT). The
  site's Mesa is MIT, built unmodified from nixpkgs' source with fewer
  drivers.
