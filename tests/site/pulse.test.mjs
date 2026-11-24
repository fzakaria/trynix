// Tests the guest's PulseAudio server (site/js/pulse.js): which closures
// hold a daemon the page starts, what every shell is told about it, and
// the command that starts and stops it. Closures are lists of store
// basenames, the way the closure walk produces them, and the guest's
// shell is a function that records what it was asked to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  pulseDaemonIn,
  PULSE_SOCKET,
  soundEnv,
  soundServer,
} from "../../site/js/pulse.js";
import { RUNTIME_DIR, sessionEnv } from "../../site/js/gui.js";
import { GUEST_STORE_DIR } from "../../site/js/share.js";

const DIGEST = "0123456789abcdfghijklmnpqrsvwxyz";
const OTHER_DIGEST = "abcdfghijklmnpqrsvwxyz0123456789";
const path = (name, digest = DIGEST) => `${digest}-${name}`;

// A stand-in for a PulseAudio daemon: a shell script, which runs under
// its file's name, pulseaudio, and waits until it is sent SIGTERM.
const STAND_IN_DAEMON = [
  "#!/bin/sh",
  "sleep 600 &",
  "trap 'kill $!; exit 0' TERM",
  "wait",
  "",
].join("\n");

// Whether process `pid` has exited: it is gone, or it is a zombie its
// parent has not collected yet.
function exited(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

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
// under the session's runtime directory; without one, no socket (null),
// and libcanberra is sent to ALSA, since it otherwise picks its
// PulseAudio backend whenever that loads and has nothing to fall back
// to. With a daemon, libcanberra's driver is unset (null): a shell
// typed at a prompt from before the daemon came inherits
// CANBERRA_DRIVER=alsa, and kept, it sent libcanberra to a card the
// daemon holds.
test("the shell's environment follows whether a daemon runs", () => {
  const runtimeDir = sessionEnv().XDG_RUNTIME_DIR;
  assert.ok(PULSE_SOCKET.startsWith(`${runtimeDir}/`));

  const served = soundEnv(path("pulseaudio-17.0"));
  assert.equal(served.PULSE_SERVER, `unix:${PULSE_SOCKET}`);
  assert.equal(served.CANBERRA_DRIVER, null);

  const alone = soundEnv(null);
  assert.equal(alone.CANBERRA_DRIVER, "alsa");
  assert.equal(alone.PULSE_SERVER, null);
});

// Checks that the environment without a daemon clears what the one
// with a daemon sets, and the other way round: each names every
// variable the other does, unset (null) where it has no value. At the
// boot the page's shell is told of the closure's daemon before the
// daemon is up. A daemon that then failed left PULSE_SERVER out of the
// rewritten environment, so a shell started from the page's shell
// inherited the socket nothing listened on and sourced nothing over it.
test("with and without a daemon the shells hear of the same variables", () => {
  const served = soundEnv(path("pulseaudio-17.0"));
  const alone = soundEnv(null);
  assert.deepEqual(Object.keys(alone).sort(), Object.keys(served).sort());
});

// Checks the command that starts the daemon: the closure's own binary,
// card 0 as its one sink, its socket open to any client of the guest,
// no shared memory, the card let go of when nothing plays, and no
// realtime thread or CPU limit, either of which gets the daemon killed
// under the guest's emulated CPU. Two starts asked for together run it
// once.
test("the daemon starts on card 0, from the closure", async () => {
  const daemon = path("pulseaudio-17.0");
  const shell = fakeShell();
  const server = soundServer({ exec: shell.exec });
  await Promise.all([server.start(daemon), server.start(daemon)]);

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
// before it takes a server already on the socket as its own; a daemon
// with no sink is stopped.
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
    "a server already on the socket is taken without asking for its sinks",
  );
  assert.ok(
    asked.some((at) => at > started),
    "a new daemon is taken without asking for its sinks",
  );
  assert.match(command, /list short sinks .*\|\| \{.*stop_daemon/);
});

// Checks that a start that failed is not kept: the next one runs the
// command again, so the daemon can come up once the card is free.
test("a daemon that failed to start is tried again", async () => {
  const daemon = path("pulseaudio-17.0");
  const shell = fakeShell(0, "no sink on hw:0", [1]);
  const server = soundServer({ exec: shell.exec });

  await assert.rejects(server.start(daemon), /no sink on hw:0/);
  await server.start(daemon);
  assert.equal(shell.commands.length, 2);
});

// Checks that a daemon that came up is checked again by the next start,
// once the one before has settled, and is named to the shells only
// while it passes. A daemon stopped in the guest (`pactl exit`) stayed
// named to every shell started after the next addition, which then had
// PULSE_SERVER at a socket nothing listened on. The fake shell lets the
// first start through, fails the second, as a stopped daemon that
// cannot come back does, and lets the third through.
test("a daemon that came up is checked again by the next start", async () => {
  const daemon = path("pulseaudio-17.0");
  const shell = fakeShell(0, "no sink on hw:0", [0, 1]);
  const server = soundServer({ exec: shell.exec });

  await server.start(daemon);
  assert.equal(server.running, daemon);

  await assert.rejects(server.start(daemon), /no sink on hw:0/);
  assert.equal(shell.commands.length, 2);
  assert.equal(server.running, null);

  await server.start(daemon);
  assert.equal(shell.commands.length, 3);
  assert.equal(server.running, daemon);
});

// Checks what the shells are told once a start has been tried: the
// daemon the start brought up, or none when it failed. A daemon that
// could not open the card, because another program held it, was still
// named to every new shell, which then had PULSE_SERVER at a socket
// nothing listened on and no CANBERRA_DRIVER to send libcanberra to
// ALSA. The fake shell fails the first start and lets the second one
// through.
test("a daemon that failed to start leaves the shells on ALSA", async () => {
  const daemon = path("pulseaudio-17.0");
  const shell = fakeShell(0, "no sink on hw:0", [1]);
  const server = soundServer({ exec: shell.exec });
  assert.equal(server.running, null);

  await assert.rejects(server.start(daemon), /no sink on hw:0/);
  assert.equal(server.running, null);
  const failed = soundEnv(server.running);
  assert.equal(failed.CANBERRA_DRIVER, "alsa");
  assert.equal(failed.PULSE_SERVER, null);

  await server.start(daemon);
  assert.equal(server.running, daemon);
  assert.equal(soundEnv(server.running).PULSE_SERVER, `unix:${PULSE_SOCKET}`);
});

// Checks which listings of the daemon's sinks count as card 0's sink,
// by running the filter the start command pipes `pactl list short
// sinks` into through a real shell, over listings in pactl's format
// (index, name, driver, sample spec, state, tab-separated). Only the
// sink module-alsa-sink makes for hw:0 counts. A daemon with a null
// sink alone answered pacat and played nothing on the guest's card.
test("only module-alsa-sink's sink on hw:0 is the card's sink", async () => {
  const shell = fakeShell();
  await soundServer({ exec: shell.exec }).start(path("pulseaudio-17.0"));
  const [command] = shell.commands;
  const filter = /list short sinks 2> \/dev\/null \| (.+?) (?:&&|\|\|) /.exec(
    command,
  )?.[1];
  assert.ok(filter !== undefined, "no filter on the sinks listing");

  const row = (index, name, driver) =>
    `${index}\t${name}\t${driver}\ts16le 2ch 44100Hz\tSUSPENDED\n`;
  const counts = (listing) =>
    spawnSync("sh", ["-c", filter], { input: listing }).status === 0;

  assert.equal(counts(row(0, "alsa_output.hw_0", "module-alsa-sink.c")), true);
  assert.equal(
    counts(
      row(0, "null", "module-null-sink.c") +
        row(1, "alsa_output.hw_0", "module-alsa-sink.c"),
    ),
    true,
  );
  assert.equal(counts(row(0, "null", "module-null-sink.c")), false);
  assert.equal(counts(row(0, "alsa_output.hw_0", "module-null-sink.c")), false);
  assert.equal(counts(row(0, "alsa_output.hw_1", "module-alsa-sink.c")), false);
  assert.equal(counts(""), false);
});

// Checks which processes stopping the daemon ends, by running the start
// command's stop_daemon through a real shell, with the guest's runtime
// directory and store moved under a temporary directory. Stand-ins take
// the place of three servers: the daemon whose PID the start recorded,
// a reader's own daemon, both processes named pulseaudio, and a server
// listening on the page's socket, which a stand-in pactl asked to exit
// removes. Only the recorded daemon and the server on the page's socket
// are stopped. Killing every process named pulseaudio ended a server a
// reader had started on /tmp/private.sock.
test("stopping the daemon spares other PulseAudio servers", async () => {
  const daemon = path("pulseaudio-17.0");
  const shell = fakeShell();
  await soundServer({ exec: shell.exec }).start(daemon);
  const [command] = shell.commands;

  // The file the start records its daemon's PID in, and the shell
  // functions the command opens with, through the one that stops the
  // daemon.
  const pidFile = /^echo \$! > (\S+)$/m.exec(command)?.[1];
  assert.ok(pidFile !== undefined, "the start records no PID");
  const stop = /^[\s\S]*?^stop_daemon\(\) \{$[\s\S]*?^\}$/m.exec(command)?.[0];
  assert.ok(stop !== undefined, "no stop_daemon in the command");

  // The guest's paths, moved under a temporary directory.
  const root = mkdtempSync(join(tmpdir(), "pulse-"));
  const moved = (text) =>
    text
      .replaceAll(RUNTIME_DIR, join(root, "run"))
      .replaceAll(GUEST_STORE_DIR, join(root, "store"));
  const socket = moved(PULSE_SOCKET);
  mkdirSync(dirname(socket), { recursive: true });

  // The stand-in daemons, and the PID of the page's one in its file.
  const standIn = join(root, "pulseaudio");
  writeFileSync(standIn, STAND_IN_DAEMON);
  chmodSync(standIn, 0o755);
  const managed = spawn(standIn, [], { stdio: "ignore" });
  const private_ = spawn(standIn, [], { stdio: "ignore" });
  writeFileSync(moved(pidFile), `${managed.pid}\n`);

  // The server on the page's socket, and a pactl that logs what it is
  // asked and, asked to exit, removes the socket as the server would.
  const server = createServer();
  await new Promise((resolve) => server.listen(socket, resolve));
  const pactlLog = join(root, "pactl.log");
  const pactl = moved(`${GUEST_STORE_DIR}/${daemon}/bin/pactl`);
  mkdirSync(dirname(pactl), { recursive: true });
  writeFileSync(
    pactl,
    [
      "#!/bin/sh",
      `echo "$*" >> ${pactlLog}`,
      `if [ "$3" = exit ]; then rm -f "\${2#unix:}"; fi`,
      "",
    ].join("\n"),
  );
  chmodSync(pactl, 0o755);

  try {
    // Each stand-in daemon runs under the daemon's name before the stop.
    for (const { pid } of [managed, private_]) {
      for (let tries = 0; ; tries += 1) {
        const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (comm === "pulseaudio") {
          break;
        }
        assert.ok(tries < 100, `stand-in ${pid} runs as ${comm}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const stopped = spawnSync("sh", ["-c", `${moved(stop)}\nstop_daemon`], {
      encoding: "utf8",
    });
    assert.equal(stopped.status, 0, stopped.stderr);

    assert.ok(exited(managed.pid), "the page's daemon still runs");
    assert.ok(!exited(private_.pid), "the reader's daemon was stopped");
    assert.match(
      readFileSync(pactlLog, "utf8"),
      new RegExp(`^-s unix:${socket} exit$`, "m"),
    );
    assert.ok(!existsSync(socket), "the server on the socket was not stopped");
  } finally {
    managed.kill();
    private_.kill();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
