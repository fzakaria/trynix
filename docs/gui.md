# GUI programs

A Wayland program from nixpkgs, run in the unkernel guest, opens a
window on the page. foot, GTK 3 programs (galculator, mousepad,
aisleriot), mpv, wev and GL programs through Mesa have been run this
way, and X11 programs through Xwayland: xterm, xeyes, xclock, Tk's
`wish` and Python's tkinter. Everything runs in the tab: the guest, the
relay that carries the program's protocol, the compositor that draws
its windows, the X server and the GL renderer. There is no server, and
the host's own display is never involved.

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
what GL defines. Without them, on 2026-11-24, the feedback case below
read black where GL defines level 0's red, and (0, 0, 0, 0) where it
defines (0, 0, 0, 1) for an integer sampler with an incomplete texture
or none. In the first,
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

| file                         | raw     | gzip   | fetched                     |
| ---------------------------- | ------- | ------ | --------------------------- |
| wland modules and wasm       | 383 KB  | 109 KB | on the relay's first dial   |
| relay (`wlandr`)             | 353 KB  | 149 KB | while the shell starts      |
| DejaVu Sans and Sans Mono    | 1.10 MB | 587 KB | while the shell starts      |
| `virgl.mjs` and `virgl.wasm` | 597 KB  | 216 KB | on the guest's first GL use |

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
  155, and every case in Chromium 152. Safari has not been run.

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
environment every shell gets among it,
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
  as every other package the page boots does, the X server every guest
  has among them (xwayland-satellite is MPL-2.0, Xwayland MIT). The
  site's Mesa is MIT, built unmodified from nixpkgs' source with fewer
  drivers.
