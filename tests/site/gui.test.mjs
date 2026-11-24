// Tests the guest half of a GUI session (site/js/gui.js): which
// closures start one, which store path is taken for the GL driver, and
// what the page writes into the share and runs in the guest. The share
// is a Map behind the few file calls gui.js makes, the site's files come
// from a stubbed fetch, and the guest's shell is a function that records
// what it was asked to run.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  guestSession,
  isGlDriver,
  linkX11Server,
  sessionEnv,
  ShellUpdate,
  shellNote,
  speaksWayland,
  X11_DISPLAY,
  x11Env,
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

// Checks that the relay is started ready for X clients whether or not
// the closure has an X server yet: it runs the launcher the session
// writes into the share, as an executable, for the first X client.
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
// into the guest, with Xwayland drawing in shared memory rather than
// GL, and the relay's arguments passed on; without a linked server, say
// so and fail, which the relay takes as no X server.
test("the X11 launcher runs the linked X server without glamor", async () => {
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
  assert.match(script, /\[ -e \/run\/x11-server \] \|\|/);
  assert.match(script, /exit 1/);
  assert.match(script, /XWAYLAND_NO_GLAMOR=1 exec \/run\/x11-server "\$@"/);
});

// Checks how the page gives the guest its X server: a link from the
// launcher's fixed path to the satellite's program in the store, made
// by the guest's shell, and an error when the link cannot be made.
test("the X server is linked from the store into /run", async () => {
  const commands = [];
  const basename = `${DIGEST}-xwayland-satellite-0.8.2`;
  await linkX11Server(async (command) => {
    commands.push(command);
    return { exitCode: 0 };
  }, basename);
  assert.deepEqual(commands, [
    `mkdir -p /run && ln -sfn /nix/store/${basename}/bin/xwayland-satellite /run/x11-server`,
  ]);

  await assert.rejects(
    linkX11Server(
      async () => ({ exitCode: 1, stderr: "ln: read-only\n" }),
      basename,
    ),
    /could not link \/run\/x11-server: ln: read-only/,
  );
});

// Checks the X display shells are told of, which is the first one the
// relay claims in a fresh guest, the X resources file they are pointed
// at, and that Java's AWT is told its window manager does not reparent,
// without which a Swing window opened blank.
test("the X11 environment names display :0, the resources and AWT's flag", () => {
  assert.equal(X11_DISPLAY, ":0");
  assert.deepEqual(x11Env(), {
    DISPLAY: ":0",
    XENVIRONMENT: "/share/gui/Xresources",
    _JAVA_AWT_WM_NONREPARENTING: "1",
  });
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
    share.files.get(x11Env().XENVIRONMENT).data,
  );
  assert.match(resources, /^XTerm\*faceName: monospace$/m);
  assert.match(resources, /^XTerm\*faceSize: \d+$/m);
});

// Checks what the reader is told after an addition that changed the
// shells' environment: nothing when it changed nothing, and otherwise
// one line naming everything that works now, with the command that
// brings the shell already running up to date. That command sources
// again the file the shell's ENV names, which every shell sources as it
// starts, so it carries whatever the addition brought.
test("one note names what an addition brought the running shell", () => {
  assert.equal(shellNote([]), null);
  assert.equal(
    shellNote([ShellUpdate.PULSE]),
    "PulseAudio clients work now in new shells (type sh for one), or in this one after . $ENV",
  );
  assert.equal(
    shellNote([ShellUpdate.X11, ShellUpdate.PULSE]),
    "X11 programs and PulseAudio clients work now in new shells (type sh for one), or in this one after . $ENV",
  );
});
