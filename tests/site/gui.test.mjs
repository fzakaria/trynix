// Tests the guest half of a GUI session (site/js/gui.js): which
// closures start one, which store path is taken for the GL driver, and
// what the page writes into the share and runs in the guest. The share
// is a Map behind the few file calls gui.js makes, the site's files come
// from a stubbed fetch, and the guest's shell is a function that records
// what it was asked to run.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DriverState,
  guestSession,
  isGlDriver,
  missingDriverNote,
  sessionEnv,
  speaksWayland,
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
    exec: async () => ({ exitCode: 0 }),
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
      return { exitCode: 0 };
    },
  });
  await Promise.all([session.start(), session.start()]);
  await session.start();

  assert.equal(commands.length, 1);
  const [command] = commands;
  const env = sessionEnv();
  assert.match(command, /--link vsock:2:1023/);
  assert.match(command, /--buffers kwshm/);
  assert.match(command, new RegExp(`--display ${env.WAYLAND_DISPLAY}`));
  assert.match(command, new RegExp(`XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}`));
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

// Checks when the page tells the reader to add Mesa: a closure with a
// Wayland program that loads GL through libglvnd and no driver gets the
// note; one with Mesa, or with no Wayland program, does not.
test("a GL program with no driver gets a note naming mesa", () => {
  const wayland = `${DIGEST}-wayland-1.24.0`;
  const glvnd = `${DIGEST}-libglvnd-1.7.0`;
  assert.match(missingDriverNote([wayland, glvnd], DriverState.ABSENT), /mesa/);
  assert.equal(missingDriverNote([wayland, glvnd], DriverState.PRESENT), null);
  assert.equal(missingDriverNote([wayland], DriverState.ABSENT), null);
  assert.equal(missingDriverNote([glvnd], DriverState.ABSENT), null);
});
