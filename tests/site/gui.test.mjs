// Tests the guest half of a GUI session (site/js/gui.js): the
// environment every shell gets, which store path is taken for a
// selected GL driver, how the guest's fixed names are linked to the X
// server and the GL driver, what the page writes into the share and
// runs in the guest, and how the compositor is given GL and Vulkan
// programs' pictures without reading them back. The share
// is a Map behind the few file calls gui.js makes, the site's files come
// from a stubbed fetch, and the guest's shell is a function that records
// what it was asked to run.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  capabilityLinks,
  enableGlamor,
  gpuSource,
  guestSession,
  isGlDriver,
  sessionEnv,
  speaksWayland,
  X11_DISPLAY,
} from "../../site/js/gui.js";
import { GUI_FONTS, GUI_RELAY } from "../../site/js/config.js";

const DIGEST = "0123456789abcdfghijklmnpqrsvwxyz";

// A share that keeps what is written, by path, with its mode.
function fakeShare() {
  const files = new Map();
  return {
    files,
    mkdir: () => {},
    writeFile: (path, data) => files.set(path, { data, mode: 0o644 }),
    chmod: (path, mode) => {
      files.get(path).mode = mode;
    },
  };
}

// What the guest's shell answers a command with when it succeeds: the
// command that starts the relay prints the relay's PID.
const RELAY_PID = 119;
const RELAY_STARTED = { exitCode: 0, stdout: `${RELAY_PID}\n`, stderr: "" };

// fetch answers every request with the name it was asked for as the
// body, so a written file says which site file it came from.
function stubFetch() {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    return new Response(url.split("/").at(-1));
  };
  return asked;
}

// Checks that only libwayland's own package marks a closure as one with
// a Wayland program: not wayland-protocols, not xwayland.
test("a closure speaks Wayland when it holds libwayland", () => {
  assert.equal(speaksWayland([`${DIGEST}-wayland-1.24.0`]), true);
  assert.equal(speaksWayland([`${DIGEST}-hello-2.12.2`]), false);
  assert.equal(speaksWayland([`${DIGEST}-wayland-protocols-1.45`]), false);
  assert.equal(speaksWayland([`${DIGEST}-xwayland-24.1.8`]), false);
});

// Checks that a NAR is taken for the GL driver by Mesa's libglvnd
// registration file, and that other NARs are not.
test("a store path with Mesa's EGL vendor file is a GL driver", () => {
  const mesa = [
    { path: "share/glvnd/egl_vendor.d/50_mesa.json", type: "regular" },
  ];
  const other = [{ path: "bin/hello", type: "regular" }];
  assert.equal(isGlDriver(mesa), true);
  assert.equal(isGlDriver(other), false);
});

// Checks what a session puts in the share: the relay as an executable,
// each font, and a fontconfig file that names the font directory and
// gives "monospace" a monospace font. The session environment must name
// that same fontconfig file.
test("a session writes the relay, the fonts and fontconfig's file", async () => {
  const asked = stubFetch();
  const share = fakeShare();
  const session = guestSession({
    FS: share,
    exec: async () => RELAY_STARTED,
  });
  await session.start();

  const relay = share.files.get("/share/gui/wlandr");
  assert.equal(new TextDecoder().decode(relay.data), GUI_RELAY);
  assert.equal(relay.mode, 0o755);
  for (const font of GUI_FONTS) {
    assert.ok(share.files.has(`/share/gui/fonts/${font}`), font);
  }
  assert.equal(asked.length, 1 + GUI_FONTS.length);

  const conf = new TextDecoder().decode(
    share.files.get(sessionEnv().FONTCONFIG_FILE).data,
  );
  assert.match(conf, /<dir>\/share\/gui\/fonts<\/dir>/);
  assert.match(
    conf,
    /<family>monospace<\/family><prefer><family>DejaVu Sans Mono<\/family>/,
  );
});

// Checks the command that starts the relay: linked to the page's port
// on vsock, reading buffers through kwshm, serving the socket the
// session's environment names, and started once however often a
// session is asked to start.
test("a session starts the relay once", async () => {
  stubFetch();
  const commands = [];
  const session = guestSession({
    FS: fakeShare(),
    exec: async (command) => {
      commands.push(command);
      return RELAY_STARTED;
    },
  });
  await Promise.all([session.start(), session.start()]);
  await session.start();

  const starts = commands.filter((command) => command.includes("--link"));
  assert.equal(starts.length, 1);
  const [command] = starts;
  const env = sessionEnv();
  assert.match(command, /--link vsock:2:1023/);
  assert.match(command, /--buffers kwshm/);
  assert.match(command, new RegExp(`--display ${env.WAYLAND_DISPLAY}`));
  assert.match(command, new RegExp(`XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}`));
});

// Checks that the relay is started with external buffers, so a Vulkan
// program's swapchain images can reach the compositor by an id the page
// resolves instead of as pixels read back into shared memory. The relay
// tracks the buffers only with the flag, and wland offers them only
// when the relay says it does and the page resolves them (gpuSource).
test("a session starts the relay with external buffers", async () => {
  stubFetch();
  const commands = [];
  const session = guestSession({
    FS: fakeShare(),
    exec: async (command) => {
      commands.push(command);
      return RELAY_STARTED;
    },
  });
  await session.start();

  const [start] = commands.filter((command) => command.includes("--link"));
  assert.match(start, / --external-buffers /);
});

// Checks that a session gives the guest a machine id, which D-Bus and
// with it GTK programs and firefox look for, and keeps one that is
// already there: the command writes /etc/machine-id only when it is
// missing or empty, from the kernel's random UUID with its dashes out.
test("a session writes a machine id where there is none", async () => {
  stubFetch();
  const commands = [];
  const session = guestSession({
    FS: fakeShare(),
    exec: async (command) => {
      commands.push(command);
      return RELAY_STARTED;
    },
  });
  await session.start();

  assert.match(
    commands[0],
    /\[ -s \/etc\/machine-id \] \|\| tr -d - < \/proc\/sys\/kernel\/random\/uuid > \/etc\/machine-id/,
  );
});

// Checks that a relay the guest could not start is an error, so the
// page logs it instead of saying the session is up.
test("a relay that does not start is an error", async () => {
  stubFetch();
  const session = guestSession({
    FS: fakeShare(),
    exec: async () => ({ exitCode: 1, stderr: "wlandr: not found\n" }),
  });
  await assert.rejects(
    session.start(),
    /the relay did not start: wlandr: not found/,
  );
});

// A guest shell for the relay's start: the command that starts the
// relay exits with `started`, and the check for its socket answers with
// each of `states` in turn, the last one for good. Records every
// command.
function relayShell(started, states) {
  const commands = [];
  const answers = [...states];
  return {
    commands,
    exec: async (command) => {
      commands.push(command);
      if (command.includes("--link")) {
        return { ...RELAY_STARTED, exitCode: started };
      }
      const state = answers.length > 1 ? answers.shift() : answers[0];
      return state;
    },
  };
}

// The socket check's answers: the socket is there; the relay runs and
// has no socket yet; the relay has exited, with what it logged.
const LISTENING = { exitCode: 0, stderr: "" };
const STARTING = { exitCode: 1, stderr: "" };
const GONE = { exitCode: 2, stderr: "wlandr: cannot bind wayland-0\n" };

// Checks that the session waits for the relay's socket before saying
// the relay is up: the command that starts the relay puts it in the
// background, so its exit status says nothing about whether the relay
// listens. The guest is asked until the socket is there.
test("a session is up once the relay's socket is there", async () => {
  stubFetch();
  const shell = relayShell(0, [STARTING, STARTING, LISTENING]);
  const session = guestSession({ FS: fakeShare(), exec: shell.exec });
  await session.start();

  const checks = shell.commands.filter(
    (command) => !command.includes("--link"),
  );
  assert.equal(checks.length, 3);
  assert.match(checks[0], new RegExp(`kill -0 ${RELAY_PID}`));
  assert.match(
    checks[0],
    new RegExp(`-S /run/user/0/${sessionEnv().WAYLAND_DISPLAY}`),
  );
});

// Checks that a relay that exits before it listens is an error that
// carries what the relay logged, rather than a session the page calls
// up with nothing behind it.
test("a relay that exits before it listens is an error", async () => {
  stubFetch();
  const shell = relayShell(0, [GONE]);
  const session = guestSession({ FS: fakeShare(), exec: shell.exec });
  await assert.rejects(session.start(), /wlandr: cannot bind wayland-0/);
});

// Checks that a session whose start failed starts afresh the next time
// it is asked, both when the site's files could not be fetched and when
// the relay did not start: one failure used to keep GUI programs from
// the guest for as long as it ran.
test("a session that failed to start tries again when asked", async () => {
  // The site's files cannot be fetched the first time.
  let refusals = 1;
  globalThis.fetch = async (url) => {
    if (refusals > 0) {
      refusals -= 1;
      throw new TypeError("Failed to fetch");
    }
    return new Response(url.split("/").at(-1));
  };
  const share = fakeShare();
  let shell = relayShell(1, [LISTENING]);
  const session = guestSession({
    FS: share,
    exec: (command) => shell.exec(command),
  });
  await assert.rejects(session.prepare(), /Failed to fetch/);

  // The files arrive, and the relay does not start.
  await assert.rejects(session.start(), /the relay did not start/);
  assert.ok(share.files.has("/share/gui/wlandr"));

  // The relay starts.
  shell = relayShell(0, [LISTENING]);
  await session.start();
  assert.equal(
    shell.commands.filter((command) => command.includes("--link")).length,
    1,
  );
});

// Checks that the relay is started ready for X clients: it runs the
// launcher the session writes into the share, as an executable, for
// the first X client.
test("a session starts the relay with the X11 launcher", async () => {
  stubFetch();
  const share = fakeShare();
  const commands = [];
  const session = guestSession({
    FS: share,
    exec: async (command) => {
      commands.push(command);
      return RELAY_STARTED;
    },
  });
  await session.start();

  const launcher = share.files.get("/share/gui/start-x11");
  assert.equal(launcher.mode, 0o755);
  const [start] = commands.filter((command) => command.includes("--link"));
  assert.match(start, /--xwayland \/share\/gui\/start-x11/);
});

// Checks what the launcher does: start the X server the page linked
// into the guest, with the relay's arguments passed on. The link is
// there from the boot, so the launcher has no case without a server.
// Xwayland draws with glamor only where the page has allowed it, for a
// selection that may draw with GLX, which needs glamor for DRI3 and so
// the virgl driver. Otherwise it is told so on its command line, which
// it reads before it asks EGL whether glamor could work (asking loads
// the GL driver; XWAYLAND_NO_GLAMOR is read after, and xterm downloaded
// the driver with it set), and it runs without GLX, whose software path
// loads the driver too and serves no GLX program without DRI3.
test("the X11 launcher uses glamor only where the page allows it", async () => {
  stubFetch();
  const share = fakeShare();
  const session = guestSession({
    FS: share,
    exec: async () => RELAY_STARTED,
  });
  await session.start();

  const script = new TextDecoder().decode(
    share.files.get("/share/gui/start-x11").data,
  );
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(script, /exit 1/);
  assert.doesNotMatch(script, /opengl-driver/);
  assert.match(
    script,
    /\n\[ -e \/share\/gui\/glamor \] \|\| set -- "\$@" -glamor none -extension GLX\n/,
  );
  assert.match(script, /\nexec \/run\/x11-server "\$@"\n/);

  assert.equal(share.files.has("/share/gui/glamor"), false);
  enableGlamor(share);
  assert.equal(share.files.has("/share/gui/glamor"), true);
});

// Checks the command that gives the guest its fixed names at the boot:
// /run/opengl-driver at the GL driver's store path and /run/x11-server
// at the satellite's program. Making a link resolves nothing, so the
// command fetches neither; a guest with no driver gets the X server's
// link alone.
test("the guest's fixed names are linked to the capabilities", () => {
  const driver = `${DIGEST}-mesa-virgl-26.2.2`;
  const server = `${DIGEST}-xwayland-satellite-0.8.3`;
  assert.equal(
    capabilityLinks({ glDriver: driver, x11Server: server }),
    "mkdir -p /run" +
      ` && ln -sfn /nix/store/${driver} /run/opengl-driver` +
      ` && ln -sfn /nix/store/${server}/bin/xwayland-satellite /run/x11-server`,
  );
  assert.equal(
    capabilityLinks({ glDriver: null, x11Server: server }),
    "mkdir -p /run" +
      ` && ln -sfn /nix/store/${server}/bin/xwayland-satellite /run/x11-server`,
  );
  assert.equal(
    capabilityLinks({ glDriver: driver }),
    `mkdir -p /run && ln -sfn /nix/store/${driver} /run/opengl-driver`,
  );
});

// Checks that every shell gets the X display, from the boot on, beside
// the Wayland socket: the X server is always there behind the relay's
// display, so nothing an addition brings changes a shell's
// environment. The display is the first one the relay claims in a
// fresh guest, the X resources file is the session's, and Java's AWT
// is told its window manager does not reparent, without which a Swing
// window opened blank.
test("every shell gets the X display, the resources and AWT's flag", () => {
  const env = sessionEnv();
  assert.equal(X11_DISPLAY, ":0");
  assert.equal(env.DISPLAY, ":0");
  assert.equal(env.XENVIRONMENT, "/share/gui/Xresources");
  assert.equal(env._JAVA_AWT_WM_NONREPARENTING, "1");
  assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
});

// Checks that every shell names, for libva, the directory of guest
// VA-API's driver in the kernel's base system (kwva, which libva loads
// as virtio_gpu_drv_video.so, after the virtio-gpu device's kernel
// driver). nixpkgs' libva looks in /run/opengl-driver/lib/dri, which
// is the GL driver's, and found no driver there, so mpv decoded video
// on the guest's CPU.
test("every shell names guest VA-API's driver to libva", () => {
  assert.equal(
    sessionEnv().LIBVA_DRIVERS_PATH,
    "/kw/layer/usr/lib/aarch64-linux-gnu/dri",
  );
});

// Checks that every shell sends libcanberra to ALSA, through the
// session's environment. libcanberra, which plays GTK programs' event
// sounds and aisleriot's, takes its PulseAudio backend whenever that
// backend's module loads, and with no server to answer it plays nothing.
test("every shell sends libcanberra to ALSA", () => {
  assert.equal(sessionEnv().CANBERRA_DRIVER, "alsa");
});

// Checks that the session writes an OpenAL Soft configuration the
// environment names, giving every OpenAL program four periods of
// buffer instead of three: GZDoom's mixer missed the default 60 ms
// about once every two seconds and printed "mmap commit error: Broken
// pipe" each time.
test("a session gives OpenAL Soft four periods of buffer", async () => {
  stubFetch();
  const share = fakeShare();
  const session = guestSession({
    FS: share,
    exec: async () => RELAY_STARTED,
  });
  await session.start();

  const conf = new TextDecoder().decode(
    share.files.get(sessionEnv().ALSOFT_CONF).data,
  );
  assert.match(conf, /^\[general\]$/m);
  assert.match(conf, /^periods = 4$/m);
});

// Checks that the session writes the X resources the environment names,
// giving xterm the monospace font fontconfig knows, since Xwayland has
// none of the core fonts xterm asks for by default.
test("a session writes X resources that give xterm a font", async () => {
  stubFetch();
  const share = fakeShare();
  const session = guestSession({
    FS: share,
    exec: async () => RELAY_STARTED,
  });
  await session.start();

  const resources = new TextDecoder().decode(
    share.files.get(sessionEnv().XENVIRONMENT).data,
  );
  assert.match(resources, /^XTerm\*faceName: monospace$/m);
  assert.match(resources, /^XTerm\*faceSize: \d+$/m);
});

// An external buffer as wland hands one over: kwvk's swapchain image,
// named by the renderer's token and the image's export id.
const EXTERNAL_REF = Object.freeze({
  id: (7n << 32n) | 3n,
  width: 640,
  height: 480,
  format: 0x34325241,
  flags: 0,
});

// A GPU buffer as wland hands one over: a GL program's virtio-gpu
// resource.
const GPU_REF = Object.freeze({
  resource: 12,
  offset: 0,
  width: 640,
  height: 480,
  format: 0x34325258,
  flags: 0,
});

// A picture the compositor draws and then gives back to be closed.
function fakeImage(name) {
  return {
    name,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

// Checks which resolvers the compositor gets, since each one's presence
// is what wland offers programs: a GL renderer gives resolve (GL
// programs' buffers by virtio-gpu resource), guest Vulkan gives
// resolveExternal (kwvk's swapchain images by id), and a kernel with
// neither gets no source at all.
test("the compositor resolves what the kernel can show", () => {
  const gl = { image: () => fakeImage("gl") };
  const vk = { externalImage: () => fakeImage("vk") };

  const both = gpuSource(gl, vk);
  assert.equal(typeof both.resolve, "function");
  assert.equal(typeof both.resolveExternal, "function");

  const glOnly = gpuSource(gl, undefined);
  assert.equal(typeof glOnly.resolve, "function");
  assert.equal(glOnly.resolveExternal, undefined);

  const vkOnly = gpuSource(undefined, vk);
  assert.equal(vkOnly.resolve, undefined);
  assert.equal(typeof vkOnly.resolveExternal, "function");

  assert.equal(gpuSource(undefined, undefined), undefined);
});

// Checks that an external buffer is resolved by guest Vulkan's renderer
// with the ref as wland gives it, synchronously, that a null from the
// renderer (an id no running program made) keeps the window's last
// picture, and that the compositor closes each picture it was given.
test("an external buffer is the Vulkan renderer's picture of it", () => {
  const asked = [];
  const image = fakeImage("frame");
  let next = image;
  const vk = {
    externalImage(ref) {
      asked.push(ref);
      return next;
    },
  };
  const source = gpuSource(undefined, vk);

  assert.equal(source.resolveExternal(EXTERNAL_REF), image);
  assert.deepEqual(asked, [EXTERNAL_REF]);
  source.release(image);
  assert.equal(image.closed, true);

  next = null;
  assert.equal(source.resolveExternal(EXTERNAL_REF), null);
});

// Checks that a GL program's buffer is still the GL renderer's picture
// of its resource, with the size, opacity and orientation the relay
// gives, beside guest Vulkan's resolver.
test("a GPU buffer is the GL renderer's picture of its resource", () => {
  const asked = [];
  const gl = {
    image(resource, options) {
      asked.push({ resource, options });
      return fakeImage("gl");
    },
  };
  const source = gpuSource(gl, { externalImage: () => null });

  assert.equal(source.resolve(GPU_REF).name, "gl");
  assert.deepEqual(asked, [
    {
      resource: 12,
      options: { width: 640, height: 480, opaque: true, flipY: false },
    },
  ]);
});
