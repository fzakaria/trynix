// GUI programs in the unkernel guest, shown as windows on the page.
//
// A Wayland program in the guest connects to wland's relay (wlandr), a
// small static program the page writes into the share and starts in
// the guest. The relay keeps the program's file descriptors and sends
// the rest of the protocol to the page over vsock, where wland's
// compositor, compiled to wasm, runs on the page's thread and draws
// each toplevel as a window over the terminal, in the console's frame
// (frame.js). Nothing leaves the tab: the guest, the relay, the
// compositor and the GL renderer all run in it (docs/gui.md).
//
// The pixels do not travel over the link. A program's shared-memory
// buffers are exported through unkernel's /dev/kwshm and the compositor
// reads them in place from the kernel's memory (handleSource). A GL
// program renders through Mesa's virgl driver on the guest's
// virtio-gpu device, which unkernel backs with virglrenderer compiled
// to wasm on a WebGL2 context of the page; the relay names such a
// buffer by its GPU resource and the compositor asks the renderer for
// the resource's picture (gpuSource).
//
// The page loads wland only when the relay first dials, which it does
// when the first program connects (--link-on-demand). A boot that runs
// no GUI program fetches none of it.
//
// An X11 program connects to an X display the relay holds, and the
// relay starts the X server, xwayland-satellite, for the first one
// (x11.js). The satellite runs Xwayland rootless and hands each X11
// window to the relay as a Wayland window of its own.

import { GUEST_STORE_DIR, SHARE_DIR } from "./share.js";
import { GUI_DIR, GUI_FONTS, GUI_RELAY, GUI_WLAND } from "./config.js";
import { log } from "./log.js";

// The host port the relay dials (wlandr --link vsock:2:<port>). 1023
// is the port unkernel's own page uses, so a guest set up for either
// page speaks to the other.
const WAYLAND_PORT = 1023;

// vsock's well-known CID for the host.
const HOST_CID = 2;

// Where the page puts the GUI files in the share, and the names under
// it. The share is the guest's /share, read-only to the guest.
const GUI_SHARE_DIR = `${SHARE_DIR}/gui`;
const RELAY_PATH = `${GUI_SHARE_DIR}/wlandr`;
const FONT_DIR = `${GUI_SHARE_DIR}/fonts`;
const FONTS_CONF = `${GUI_SHARE_DIR}/fonts.conf`;

// The session's runtime directory and socket, as logind would make
// them for root, the user the guest's shell runs as.
const RUNTIME_DIR = "/run/user/0";
const DISPLAY_NAME = "wayland-0";
const RELAY_LOG = `${RUNTIME_DIR}/wlandr.log`;
const RELAY_SOCKET = `${RUNTIME_DIR}/${DISPLAY_NAME}`;

// How often the guest is asked whether the relay listens on its socket,
// and how long before the page stops asking. The relay makes the socket
// as it starts; the limit is for a guest busy with other work, such as
// the shell and the programs read ahead at the boot.
const SOCKET_POLL_MS = 100;
const SOCKET_LIMIT_MS = 10000;

// What the guest says about the relay (relayState's exit status).
const RelayState = Object.freeze({
  // The socket is there.
  LISTENING: 0,
  // The relay runs and has no socket yet.
  STARTING: 1,
  // The relay is not running; it printed why to its log, which the
  // command prints.
  GONE: 2,
});

// Where nixpkgs' libglvnd, libgbm and Vulkan loader look for the
// system's GL driver: on NixOS a link to Mesa (hardware.graphics).
const RUN_DIR = "/run";
const OPENGL_DRIVER = `${RUN_DIR}/opengl-driver`;

// The virtio-gpu render node unkernel's kernel makes with `gpu`.
const RENDER_NODE = "/dev/dri/renderD128";

// The guest's machine id, which D-Bus reads (and GTK programs and
// firefox through it, warning without one), and where the kernel keeps
// a random UUID to make one from. A machine id is 32 hex digits: the
// UUID without its dashes.
const MACHINE_ID = "/etc/machine-id";
const RANDOM_UUID = "/proc/sys/kernel/random/uuid";

// X11 programs (x11.js). The relay claims an X display and runs the
// launcher for the first X client that connects (wlandr --xwayland);
// the launcher starts the X server the page linked into the guest, or
// fails when there is none, and the relay then refuses X clients. The
// launcher is there from the session's start so a relay already
// running when an addition brings the X server serves X clients too.
const X11_LAUNCHER = `${GUI_SHARE_DIR}/start-x11`;
const X11_SERVER_LINK = `${RUN_DIR}/x11-server`;

// The program in the X server's store path: xwayland-satellite, which
// nixpkgs wraps with Xwayland on its PATH.
const X11_SERVER_PROGRAM = "bin/xwayland-satellite";

// The display the relay claims: the first free one in /tmp, and a
// fresh guest has none in use before the relay starts.
export const X11_DISPLAY = ":0";

// X resources for X11 programs, which Xt programs read from the file
// XENVIRONMENT names. Xwayland has no core fonts but its built-in
// "fixed", so xterm, asking for one it lacks, printed a warning on the
// reader's terminal and drew in a 6x13 bitmap. The resources give it
// the monospace family fontconfig maps to the page's DejaVu Sans Mono,
// drawn through Xft, at a size in points.
const X11_RESOURCES = `${GUI_SHARE_DIR}/Xresources`;
const XTERM_FACE = "monospace";
const XTERM_FACE_POINTS = 10;

// fontconfig keeps its cache somewhere writable; the share is not.
const FONT_CACHE_DIR = "/tmp/fontconfig";

// File modes for what the page writes into the share.
const MODE_EXECUTABLE = 0o755;

// The name of the libwayland package in nixpkgs. A closure holding it
// has a program that speaks Wayland, and only then does the page set
// up a session.
const WAYLAND_PATH = /^[0-9a-z]{32}-wayland-\d/;

// The file Mesa installs to register itself with libglvnd's EGL. A
// store path holding it is a GL driver the guest can use.
const MESA_EGL_VENDOR = "share/glvnd/egl_vendor.d/50_mesa.json";

// libcanberra's driver: ALSA, the guest's card 0. libcanberra plays GTK
// programs' event sounds and aisleriot's, and takes its PulseAudio
// backend whenever that backend's module loads. The guest runs no
// PulseAudio server, and libcanberra does not fall back from one that
// does not answer.
const CANBERRA_DRIVER = "alsa";

// The environment every guest shell gets, so a GUI program started
// plainly finds the relay and picks its Wayland backend. Toolkits that
// would otherwise look for X are told to use Wayland; each falls back
// to X where it has no Wayland backend, which works only once the
// closure holds an X server (x11Env). libcanberra is sent to ALSA.
export function sessionEnv() {
  return {
    XDG_RUNTIME_DIR: RUNTIME_DIR,
    WAYLAND_DISPLAY: DISPLAY_NAME,
    XDG_SESSION_TYPE: "wayland",
    GDK_BACKEND: "wayland",
    QT_QPA_PLATFORM: "wayland",
    SDL_VIDEODRIVER: "wayland",
    MOZ_ENABLE_WAYLAND: "1",
    ELECTRON_OZONE_PLATFORM_HINT: "wayland",
    FONTCONFIG_FILE: FONTS_CONF,
    CANBERRA_DRIVER,
  };
}

// The environment a guest shell gets once the closure holds an X
// server, so an X11 program started plainly finds the relay's display.
// Shells get none without one: a program with both backends that tries
// X11 first would find a display with no server behind it.
//
// Java's AWT waits for its window manager to reparent each window into
// a frame of its own, and the satellite, whose windows' frames are the
// compositor's, does not: a Swing window opened blank and stayed so
// until AWT was told.
export function x11Env() {
  return {
    DISPLAY: X11_DISPLAY,
    XENVIRONMENT: X11_RESOURCES,
    _JAVA_AWT_WM_NONREPARENTING: "1",
  };
}

// What a shell started before an addition can lack: the addition
// brought an X server, and the shell sourced its environment
// (unkernel.js, manifest) before one was there. Each value is how the
// reader is told what needs it.
export const ShellUpdate = Object.freeze({
  // DISPLAY and the rest of x11Env.
  X11: "X11 programs",
});

// What the page tells the reader after an addition whose `updates`
// (ShellUpdate) the shell already running lacks, or null for none. A
// shell sources the file ENV names as it starts, so a new one has them,
// and sourcing the file again brings the running one up to date.
export function shellNote(updates) {
  if (updates.length === 0) {
    return null;
  }
  return (
    `${updates.join(" and ")} work now in new shells (type sh for one), ` +
    "or in this one after . $ENV"
  );
}

// Whether a set of store basenames holds a Wayland program.
export const speaksWayland = (basenames) =>
  basenames.some((basename) => WAYLAND_PATH.test(basename));

// Whether a parsed NAR is a GL driver (see MESA_EGL_VENDOR).
export const isGlDriver = (entries) =>
  entries.some((entry) => entry.path === MESA_EGL_VENDOR);

// The generic families programs ask fontconfig for, and the page's font
// for each. Without these a request for "monospace" matches whichever
// font fontconfig likes best, and foot gets a proportional one.
const FONT_FAMILIES = {
  monospace: "DejaVu Sans Mono",
  "sans-serif": "DejaVu Sans",
  serif: "DejaVu Sans",
};

// fontconfig's configuration: the page's fonts, the generic families,
// and a cache in /tmp. nixpkgs' fontconfig reads /etc/fonts by default,
// which the guest does not have, so without this file it finds no font
// at all.
function fontsConf() {
  const aliases = Object.entries(FONT_FAMILIES).map(
    ([generic, family]) =>
      `  <alias><family>${generic}</family>` +
      `<prefer><family>${family}</family></prefer></alias>`,
  );
  return [
    `<?xml version="1.0"?>`,
    `<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">`,
    `<fontconfig>`,
    `  <dir>${FONT_DIR}</dir>`,
    `  <cachedir>${FONT_CACHE_DIR}</cachedir>`,
    ...aliases,
    `</fontconfig>`,
    ``,
  ].join("\n");
}

// The launcher the relay runs for the first X client, with the
// relay's arguments (the display and its listening sockets). With a GL
// driver in the guest, Xwayland draws with glamor through that driver,
// which is what gives it DRI3: a GLX program renders with the virgl
// driver only through DRI3, and without it Mesa's GLX wants a software
// driver, which the site's Mesa does not have. Without a GL driver,
// Xwayland draws into shared memory, which the compositor reads through
// kwshm like any other program's buffers: glamor needs the driver, and
// xterm's first window took longer to open with it.
function x11Launcher() {
  return [
    `#!/bin/sh`,
    `[ -e ${X11_SERVER_LINK} ] || {`,
    `  echo "trynix: no X server in this guest; select xwayland-satellite" >&2`,
    `  exit 1`,
    `}`,
    `[ -e ${OPENGL_DRIVER} ] || export XWAYLAND_NO_GLAMOR=1`,
    `exec ${X11_SERVER_LINK} "$@"`,
    ``,
  ].join("\n");
}

// The X resources file (X11_RESOURCES).
function x11Resources() {
  return [
    `! X resources for X11 programs in the trynix guest (site/js/gui.js).`,
    `XTerm*faceName: ${XTERM_FACE}`,
    `XTerm*faceSize: ${XTERM_FACE_POINTS}`,
    ``,
  ].join("\n");
}

// Fetch a file of the site's GUI directory, as bytes.
async function fetchGuiFile(name) {
  const url = `${GUI_DIR}/${name}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// The shell command that gives the guest a machine id unless it has
// one, and starts the relay unless it runs, ready for X clients
// (X11_LAUNCHER). With the render node the relay takes GL programs'
// buffers by GPU resource; without one they render in software into
// shared memory like any other program. setsid gives the relay a
// session of its own, so no shell's hangup reaches it. The command
// prints the relay's PID, the running one's or the new one's. A
// background job keeps its PID through setsid: setsid forks only when
// its caller leads a process group, and a background job of a shell
// without job control does not.
function relayCommand() {
  const link = `vsock:${HOST_CID}:${WAYLAND_PORT}`;
  return [
    `[ -s ${MACHINE_ID} ] || tr -d - < ${RANDOM_UUID} > ${MACHINE_ID}`,
    `relay=$(pidof -s wlandr) && echo "$relay" && exit 0`,
    `mkdir -p -m 700 ${RUNTIME_DIR}`,
    `flags=--link-on-demand`,
    `[ -c ${RENDER_NODE} ] && flags="$flags --dmabuf virtgpu:${RENDER_NODE} --no-fence-wait"`,
    `XDG_RUNTIME_DIR=${RUNTIME_DIR} setsid ${RELAY_PATH} --link ${link}` +
      ` --buffers kwshm --display ${DISPLAY_NAME} --xwayland ${X11_LAUNCHER} $flags` +
      ` < /dev/null > ${RELAY_LOG} 2>&1 &`,
    `echo $!`,
  ].join("\n");
}

// The shell command that says how the relay with PID `pid` is doing, as
// a RelayState exit status. The PID, not the name: until the shell's
// child has run setsid and then the relay, no process is named wlandr.
function relayState(pid) {
  return [
    `[ -S ${RELAY_SOCKET} ] && exit ${RelayState.LISTENING}`,
    `kill -0 ${pid} 2> /dev/null && exit ${RelayState.STARTING}`,
    `cat ${RELAY_LOG} >&2`,
    `exit ${RelayState.GONE}`,
  ].join("\n");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait until the relay with PID `pid` listens on its socket. The
// command that starts the relay puts it in the background, so that
// command's exit status says the shell ran it and nothing more; the
// socket is what a Wayland program connects to.
async function relayListening(exec, pid) {
  const deadline = Date.now() + SOCKET_LIMIT_MS;
  for (;;) {
    const result = await exec(relayState(pid));
    if (result.exitCode === RelayState.LISTENING) {
      return;
    }
    if (result.exitCode !== RelayState.STARTING) {
      throw new Error(`the relay exited: ${result.stderr.trim()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the relay runs and has not made ${RELAY_SOCKET} in ${SOCKET_LIMIT_MS} ms`,
      );
    }
    await delay(SOCKET_POLL_MS);
  }
}

// The guest half of the session: the relay, the fonts, the X11
// launcher and X resources in the share, the relay running. `FS` is
// the share's file calls (share.js, memoryFsCalls) and `exec` runs a
// shell command in the guest.
//
// prepare() downloads the files, and can start while the closure is
// still arriving; start() writes them and starts the relay, once the
// guest is up. Each does its work once however often it is called (a
// second GUI program added to a running guest), and a call after one
// that failed tries again: a download or a relay that failed once
// would otherwise keep GUI programs out for the life of the guest.
export function guestSession({ FS, exec }) {
  let files = null;
  let started = null;

  function prepare() {
    files ??= Promise.all([
      fetchGuiFile(GUI_RELAY),
      ...GUI_FONTS.map(fetchGuiFile),
    ]).catch((err) => {
      files = null;
      throw err;
    });
    return files;
  }

  async function run() {
    const [relay, ...fonts] = await prepare();

    FS.mkdir(GUI_SHARE_DIR);
    FS.writeFile(RELAY_PATH, relay);
    FS.chmod(RELAY_PATH, MODE_EXECUTABLE);
    FS.mkdir(FONT_DIR);
    GUI_FONTS.forEach((name, at) =>
      FS.writeFile(`${FONT_DIR}/${name}`, fonts[at]),
    );
    FS.writeFile(FONTS_CONF, new TextEncoder().encode(fontsConf()));
    FS.writeFile(X11_LAUNCHER, new TextEncoder().encode(x11Launcher()));
    FS.chmod(X11_LAUNCHER, MODE_EXECUTABLE);
    FS.writeFile(X11_RESOURCES, new TextEncoder().encode(x11Resources()));

    const result = await exec(relayCommand());
    if (result.exitCode !== 0) {
      throw new Error(`the relay did not start: ${result.stderr.trim()}`);
    }
    const pid = Number.parseInt(result.stdout, 10);
    if (!Number.isInteger(pid)) {
      throw new Error(`the relay did not start: no PID in "${result.stdout}"`);
    }
    await relayListening(exec, pid);
    log("gui: the Wayland relay is running in the guest");
  }

  return {
    prepare,
    start() {
      started ??= run().catch((err) => {
        started = null;
        throw err;
      });
      return started;
    },
  };
}

// Point the guest's GL driver link at a Mesa store path.
export async function linkGlDriver(exec, basename) {
  const target = `${GUEST_STORE_DIR}/${basename}`;
  const result = await exec(
    `mkdir -p ${RUN_DIR} && ln -sfn ${target} ${OPENGL_DRIVER}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`could not link ${OPENGL_DRIVER}: ${result.stderr.trim()}`);
  }
  log(`gui: ${OPENGL_DRIVER} is ${target}`);
}

// Point the X11 launcher's link at an X server's store path
// (x11.js, isX11Server).
export async function linkX11Server(exec, basename) {
  const target = `${GUEST_STORE_DIR}/${basename}/${X11_SERVER_PROGRAM}`;
  const result = await exec(
    `mkdir -p ${RUN_DIR} && ln -sfn ${target} ${X11_SERVER_LINK}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `could not link ${X11_SERVER_LINK}: ${result.stderr.trim()}`,
    );
  }
  log(`gui: ${X11_SERVER_LINK} is ${target}`);
}

// DRM fourccs of the formats with no alpha the relay offers: XR24
// (XRGB8888) and XB24 (XBGR8888). A GPU buffer in one of these is drawn
// opaque.
const XRGB8888 = 0x34325258;
const XBGR8888 = 0x34324258;

// The bit of a GPU buffer's flags that says its rows run bottom up
// (linux-dmabuf's y_invert).
const Y_INVERT = 1;

// The compositor's access to the guest's shared-memory buffers, through
// the kernel's kwshm (createKernel({ shm })). Where the page's thread
// sees the kernel's memory a buffer is read in place (view); where the
// kernel runs in a worker each damaged span is a read the worker
// answers (readv). A read that finds the buffer's pages being replaced
// says EAGAIN, and the compositor falls back to the slower path for
// that commit.
function handleSource(shm) {
  const again = (err) => err?.code === "EAGAIN";

  async function open(handle) {
    if (handle.kind !== "kwshm") {
      throw new Error(
        `a ${handle.kind} buffer: the relay must run with --buffers kwshm`,
      );
    }
    const file = await shm.openId(handle.id);
    if (file.size !== handle.size) {
      file.close();
      throw new Error(
        `kwshm export ${handle.id} is ${file.size} bytes, the relay says ${handle.size}`,
      );
    }
    return file;
  }

  function view(file, offset, length) {
    if (!file.inPlace) {
      return null;
    }
    try {
      return file.views(offset, length);
    } catch (err) {
      if (again(err)) {
        return null;
      }
      throw err;
    }
  }

  function readv(file, reads) {
    if (file.inPlace) {
      try {
        for (const read of reads) {
          file.readSync(read.offset, read.dst.length, read.dst);
        }
        return;
      } catch (err) {
        if (!again(err)) {
          throw err;
        }
      }
    }
    return Promise.all(
      reads.map(async (read) => {
        read.dst.set(await file.read(read.offset, read.dst.length));
      }),
    ).then(() => {});
  }

  return {
    open,
    close: (file) => void file.close(),
    view,
    readv,
    read: (file, offset, dst) => readv(file, [{ offset, dst }]),
  };
}

// The compositor's access to GL programs' buffers: each is a virtio-gpu
// resource, and the renderer blits its current picture into an
// ImageBitmap without reading it back to the CPU. Mesa's virgl driver
// puts a buffer at offset 0 of its resource; any other offset is not
// supported and the window keeps its last picture.
function gpuSource(gpu) {
  let offsetSaid = false;

  return {
    resolve(ref) {
      if (ref.offset !== 0) {
        if (!offsetSaid) {
          log(`gui: a GPU buffer at offset ${ref.offset}: not shown`);
          offsetSaid = true;
        }
        return null;
      }
      return gpu.image(ref.resource, {
        width: ref.width,
        height: ref.height,
        opaque: ref.format === XRGB8888 || ref.format === XBGR8888,
        flipY: (ref.flags & Y_INVERT) !== 0,
      });
    },
    release: (image) => image.close(),
  };
}

// The page half: listen for the relay, load wland on its first dial,
// and show the guest's windows in the console's frame (frame.js,
// consoleFrame): in its container, opened when the first program
// connects, with the frame told of every change to the windows.
//
// The relay dials once per link. A link ends when the relay exits, and
// a relay started again dials again; each dial after the first is
// served by the same compositor, which starts afresh on it.
export function attachDesktop({ kernel, frame }) {
  if (!kernel.vsock || !kernel.shm) {
    log("gui: the kernel has no vsock or no kwshm; no desktop");
    return;
  }
  const listener = kernel.vsock.listen(WAYLAND_PORT);

  // What tools/gui-test.py reads: surface commits the compositor took,
  // and when it took the first, in the page's clock.
  const stats = { commits: 0, firstCommitAt: null };
  window.trynix.desktopStats = stats;

  // The first connection, then every later one the listener takes.
  async function* connections(first) {
    yield first;
    for (;;) {
      const next = await listener.accept();
      if (next === null) {
        return;
      }
      yield next;
    }
  }

  async function start() {
    const first = await listener.accept();
    if (first === null) {
      return;
    }
    log("gui: the relay dialed; loading the compositor");

    const wland = await import(`../${GUI_DIR}/${GUI_WLAND}`);
    const gpu = kernel.gl?.gpu;
    const link = connections(first);
    link.close = () => listener.close();

    // The output apps are told about is the container's size, so the
    // frame is open, and grown, before the compositor measures it.
    frame.open();
    const desktop = await wland.createWland({
      container: frame.container,
      link: wland.createStreamLink(link),
      buffers: handleSource(kernel.shm),
      ...(gpu ? { gpu: gpuSource(gpu) } : {}),
      // Window changes and keyboard focus changes alike: wland calls
      // this for both when no focus callback of its own is given.
      onWindowsChange: frame.changed,
      onEvent(event) {
        if (event.type === "commit") {
          stats.commits++;
          stats.firstCommitAt ??= performance.now();
          return;
        }
        if (event.type === "error") {
          log(`gui: ${event.detail}`);
        }
      },
    });
    log(`gui: compositor started${gpu ? ", GL buffers by GPU resource" : ""}`);

    frame.attach(desktop);
    window.trynix.desktop = desktop;
  }

  start().catch((err) => {
    listener.close();
    log(`gui: the compositor did not start: ${err.message ?? err}`);
  });
}
