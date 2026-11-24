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
export const RUNTIME_DIR = "/run/user/0";
const DISPLAY_NAME = "wayland-0";
const RELAY_LOG = `${RUNTIME_DIR}/wlandr.log`;

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

// The environment every guest shell gets, so a GUI program started
// plainly finds the relay and picks its Wayland backend. Toolkits that
// would otherwise look for X are told to use Wayland; each falls back
// to X where it has no Wayland backend, which here means it fails, as
// the guest has no X server.
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
  };
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
// one, and starts the relay unless it runs. With the render node the
// relay takes GL programs' buffers by GPU resource; without one they
// render in software into shared memory like any other program. setsid
// gives the relay a session of its own, so no shell's hangup reaches
// it.
function relayCommand() {
  const link = `vsock:${HOST_CID}:${WAYLAND_PORT}`;
  return [
    `[ -s ${MACHINE_ID} ] || tr -d - < ${RANDOM_UUID} > ${MACHINE_ID}`,
    `pidof wlandr > /dev/null && exit 0`,
    `mkdir -p -m 700 ${RUNTIME_DIR}`,
    `flags=--link-on-demand`,
    `[ -c ${RENDER_NODE} ] && flags="$flags --dmabuf virtgpu:${RENDER_NODE} --no-fence-wait"`,
    `XDG_RUNTIME_DIR=${RUNTIME_DIR} setsid ${RELAY_PATH} --link ${link}` +
      ` --buffers kwshm --display ${DISPLAY_NAME} $flags` +
      ` < /dev/null > ${RELAY_LOG} 2>&1 &`,
  ].join("\n");
}

// The guest half of the session: the relay and the fonts in the share,
// the relay running. `FS` is the share's file calls (share.js,
// memoryFsCalls) and `exec` runs a shell command in the guest.
//
// prepare() downloads the files, and can start while the closure is
// still arriving; start() writes them and starts the relay, once the
// guest is up. Each does its work once however often it is called (a
// second GUI program added to a running guest).
export function guestSession({ FS, exec }) {
  let files = null;
  let started = null;

  function prepare() {
    files ??= Promise.all([
      fetchGuiFile(GUI_RELAY),
      ...GUI_FONTS.map(fetchGuiFile),
    ]);
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

    const result = await exec(relayCommand());
    if (result.exitCode !== 0) {
      throw new Error(`the relay did not start: ${result.stderr.trim()}`);
    }
    log("gui: the Wayland relay is running in the guest");
  }

  return {
    prepare,
    start() {
      started ??= run();
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
