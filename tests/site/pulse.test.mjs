// Tests the guest's PulseAudio server (site/js/pulse.js): which closures
// hold a daemon the page starts, what every shell is told about it, and
// the command that starts it. Closures are lists of store basenames, the
// way the closure walk produces them, and the guest's shell is a
// function that records what it was asked to run.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pulseDaemonIn,
  PULSE_SOCKET,
  soundEnv,
  soundServer,
} from "../../site/js/pulse.js";
import { sessionEnv } from "../../site/js/gui.js";

const DIGEST = "0123456789abcdfghijklmnpqrsvwxyz";
const OTHER_DIGEST = "abcdfghijklmnpqrsvwxyz0123456789";
const path = (name, digest = DIGEST) => `${digest}-${name}`;

// A guest shell that answers every command with `exitCode`, or with
// the next of `exitCodes` while any are left, and keeps what it was
// asked.
function fakeShell(exitCode = 0, stderr = "", exitCodes = []) {
  const commands = [];
  return {
    commands,
    exec: async (command) => {
      commands.push(command);
      return { exitCode: exitCodes.shift() ?? exitCode, stderr };
    },
  };
}

// Checks that the client library alone is no daemon: libpulseaudio is
// nixpkgs' pulseaudio built without one, and its dev output is not one
// either.
test("a closure with only the client library holds no daemon", () => {
  const closure = [
    path("mpv-0.41.0"),
    path("libpulseaudio-17.0"),
    path("pulseaudio-17.0-dev"),
    path("glibc-2.42-84"),
  ];
  assert.equal(pulseDaemonIn(closure), null);
});

// Checks that nixpkgs' pulseaudio package, which carries the daemon, is
// found among the rest of a closure.
test("a closure with pulseaudio holds its daemon", () => {
  const daemon = path("pulseaudio-17.0");
  const closure = [path("libpulseaudio-17.0"), daemon, path("glibc-2.42-84")];
  assert.equal(pulseDaemonIn(closure), daemon);
});

// Checks that a selection mixing two nixpkgs eras starts the newer
// daemon, with 17.0 above 9.0 (a string comparison would not say so).
test("of two daemons the newer is started", () => {
  const older = path("pulseaudio-9.0");
  const newer = path("pulseaudio-17.0", OTHER_DIGEST);
  assert.equal(pulseDaemonIn([older, newer]), newer);
  assert.equal(pulseDaemonIn([newer, older]), newer);
});

// Checks what every shell is told: with a daemon, where its socket is,
// under the session's runtime directory; without one, libcanberra is
// sent to ALSA, since it otherwise picks its PulseAudio backend
// whenever that loads and has nothing to fall back to.
test("the shell's environment follows whether a daemon runs", () => {
  const runtimeDir = sessionEnv().XDG_RUNTIME_DIR;
  assert.ok(PULSE_SOCKET.startsWith(`${runtimeDir}/`));

  const served = soundEnv(path("pulseaudio-17.0"));
  assert.equal(served.PULSE_SERVER, `unix:${PULSE_SOCKET}`);
  assert.equal(served.CANBERRA_DRIVER, undefined);

  const alone = soundEnv(null);
  assert.equal(alone.CANBERRA_DRIVER, "alsa");
  assert.equal(alone.PULSE_SERVER, undefined);
});

// Checks the command that starts the daemon: the closure's own binary,
// card 0 as its one sink, its socket open to any client of the guest,
// no shared memory, the card let go of when nothing plays, and no
// realtime thread or CPU limit, either of which gets the daemon killed
// under the guest's emulated CPU. It runs once per guest however often
// it is asked for.
test("the daemon starts once, on card 0, from the closure", async () => {
  const daemon = path("pulseaudio-17.0");
  const shell = fakeShell();
  const server = soundServer({ exec: shell.exec });
  await Promise.all([server.start(daemon), server.start(daemon)]);
  await server.start(path("pulseaudio-16.1", OTHER_DIGEST));

  assert.equal(shell.commands.length, 1);
  const [command] = shell.commands;
  assert.match(command, new RegExp(`/nix/store/${daemon}/bin/pulseaudio `));
  assert.match(command, /module-alsa-sink device=hw:0/);
  assert.match(command, /module-native-protocol-unix auth-anonymous=1/);
  assert.match(command, new RegExp(`socket=${PULSE_SOCKET}`));
  assert.match(command, /module-suspend-on-idle/);
  assert.match(command, /--disable-shm=yes/);
  assert.match(command, /--exit-idle-time=-1/);
  assert.match(command, /--realtime=no/);
  assert.match(command, /--high-priority=no/);
  assert.match(command, /--no-cpu-limit/);
});

// Checks that a daemon that did not come up is an error naming what the
// guest said, so the page can log it.
test("a daemon that fails says why", async () => {
  const shell = fakeShell(1, "Failed to open PCM device hw:0");
  const server = soundServer({ exec: shell.exec });
  await assert.rejects(
    server.start(path("pulseaudio-17.0")),
    /Failed to open PCM device hw:0/,
  );
});

// Checks that the daemon counts as started only once card 0 is its
// sink. A daemon whose ALSA module failed, because another program held
// the card as it started, still opens its socket, and every client then
// failed with "No such entity". So the command asks the daemon for its
// sinks, with the closure's own pactl, once the socket is open, and
// before it takes a daemon already running as the server; a daemon with
// no sink is stopped.
test("the daemon counts as started only with the card's sink", async () => {
  const daemon = path("pulseaudio-17.0");
  const shell = fakeShell();
  await soundServer({ exec: shell.exec }).start(daemon);

  const [command] = shell.commands;
  const sinks = `/nix/store/${daemon}/bin/pactl -s unix:${PULSE_SOCKET} list short sinks`;
  const lines = command.split("\n");
  const asked = lines.flatMap((line, at) => (line.includes(sinks) ? [at] : []));
  const started = lines.findIndex((line) => line.includes("setsid"));
  assert.ok(
    asked.some((at) => at < started),
    "a daemon already running is taken without asking for its sinks",
  );
  assert.ok(
    asked.some((at) => at > started),
    "a new daemon is taken without asking for its sinks",
  );
  assert.match(command, /kill \$\(pidof pulseaudio\)/);
});

// Checks that a start that failed is not kept: the next one runs the
// command again, so the daemon can come up once the card is free.
test("a daemon that failed to start is tried again", async () => {
  const daemon = path("pulseaudio-17.0");
  const shell = fakeShell(0, "no sink on hw:0", [1]);
  const server = soundServer({ exec: shell.exec });

  await assert.rejects(server.start(daemon), /no sink on hw:0/);
  await server.start(daemon);
  await server.start(daemon);
  assert.equal(shell.commands.length, 2);
});
