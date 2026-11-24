// A PulseAudio server for the unkernel guest's programs.
//
// The guest's sound card is unkernel's kwsnd, ALSA card 0, played on the
// page (sound.js). Most programs that speak PulseAudio fall back to ALSA
// when no server answers: mpv, firefox, SDL and GStreamer's
// autoaudiosink all do (docs/gui.md, "Sound"). Two kinds do not.
// PulseAudio's own clients, paplay and pacat, speak nothing else. And
// libcanberra, which GTK programs' event sounds and aisleriot's go
// through, takes its PulseAudio backend whenever the backend's module
// loads, and fails there instead of trying ALSA.
//
// When the closure holds nixpkgs' pulseaudio package, which carries the
// daemon, the page starts that daemon as the guest comes up: card 0 is
// its one sink and its socket is in the session's runtime directory,
// open to any client in the guest. A client of any nixpkgs era speaks
// the native protocol to it over the socket, so nothing of the daemon's
// is loaded into another program's process. Selecting pulseaudio with a
// program is how to get a server. The page adds none of its own: what
// most programs play reaches the card without one, and starting
// nixpkgs' daemon downloads 17 MB of libraries and holds the shell
// 2.4 s longer (docs/gui.md).
//
// Without a daemon, libcanberra is told to use ALSA (soundEnv).

import { GUEST_STORE_DIR } from "./share.js";
import { RUNTIME_DIR } from "./gui.js";
import { compareVersions } from "./version.js";
import { log } from "./log.js";

// nixpkgs' pulseaudio package, whose bin/ holds the daemon. The client
// library alone is libpulseaudio, and the headers are its -dev output;
// neither has a daemon.
const DAEMON_PATH = /^[0-9a-z]{32}-pulseaudio-(\d+(?:\.\d+)*)$/;

// The daemon's runtime directory and socket, where libpulse looks for
// them under XDG_RUNTIME_DIR, and where the daemon's output goes.
const PULSE_DIR = `${RUNTIME_DIR}/pulse`;
export const PULSE_SOCKET = `${PULSE_DIR}/native`;
const PULSE_LOG = `${RUNTIME_DIR}/pulseaudio.log`;

// The process name the daemon runs as, which says whether one is up.
const DAEMON_NAME = "pulseaudio";

// The ALSA device the daemon plays on: kwsnd, the guest's one card.
const CARD_DEVICE = "hw:0";

// How long the daemon keeps the card open after its last client stops,
// in seconds. The card has one stream, so while the daemon holds it a
// program that writes to ALSA itself cannot open it.
const IDLE_CLOSE_S = 1;

// How often the page looks for the daemon's socket, and for how long,
// in tenths of a second: the daemon's first start reads its libraries
// over the share, downloading any not fetched yet.
const SOCKET_POLL_S = "0.1";
const SOCKET_POLLS = 600;

// How many lines of the daemon's output a failure carries.
const FAILURE_LINES = 5;

// libcanberra's driver when no server runs.
const CANBERRA_ALSA = "alsa";

// The newest PulseAudio daemon among a closure's store basenames, or
// null when it holds none.
export function pulseDaemonIn(basenames) {
  let newest = null;
  let newestVersion = null;
  for (const basename of basenames) {
    const match = DAEMON_PATH.exec(basename);
    if (match === null) {
      continue;
    }
    if (newest === null || compareVersions(match[1], newestVersion) > 0) {
      newest = basename;
      newestVersion = match[1];
    }
  }
  return newest;
}

// What every guest shell is told about sound, given the daemon the page
// starts (a store basename) or null. A daemon's clients are given its
// socket. Without one, libcanberra is sent to ALSA: left to choose, it
// takes PulseAudio and plays nothing.
export function soundEnv(daemon) {
  if (daemon !== null) {
    return { PULSE_SERVER: `unix:${PULSE_SOCKET}` };
  }
  return { CANBERRA_DRIVER: CANBERRA_ALSA };
}

// The shell command that starts the daemon unless one runs, and waits
// for its socket. `-n` loads no default script, so the daemon has just
// the modules named here: the card as its sink, the socket with no
// cookie to check (the guest has one user, root), and the card closed
// once nothing plays. Shared memory is off, so the audio travels over
// the socket and no client needs to map the daemon's pool.
//
// The daemon runs with no realtime thread and no CPU limit. Under the
// guest's emulated CPU its realtime thread overran the time limit the
// kernel holds such a thread to and was killed without a word, and the
// daemon's own limit ends it when it uses most of the CPU for long. Its
// sink keeps the daemon's default rate, 44.1 kHz, which most programs
// play at: the page resamples to the device's rate at no cost to the
// guest.
//
// The daemon is not daemonized and never exits on its own; setsid
// gives it a session of its own, as the Wayland relay has (gui.js).
//
// The command fails if the daemon logs an error (`E:`) or no socket
// appears in time, printing the end of the daemon's output.
function daemonCommand(daemon) {
  const binary = `${GUEST_STORE_DIR}/${daemon}/bin/${DAEMON_NAME}`;
  const modules = [
    `module-alsa-sink device=${CARD_DEVICE}`,
    `module-native-protocol-unix auth-anonymous=1 socket=${PULSE_SOCKET}`,
    `module-suspend-on-idle timeout=${IDLE_CLOSE_S}`,
  ].map((module) => `-L '${module}'`);
  const flags = [
    "-n",
    "--daemonize=no",
    "--use-pid-file=no",
    "--exit-idle-time=-1",
    "--disable-shm=yes",
    "--realtime=no",
    "--high-priority=no",
    "--no-cpu-limit",
    "--log-target=stderr",
  ];
  const giveUp = `tail -n ${FAILURE_LINES} ${PULSE_LOG} >&2; exit 1`;
  return [
    `pidof ${DAEMON_NAME} > /dev/null && exit 0`,
    `mkdir -p -m 700 ${PULSE_DIR}`,
    `XDG_RUNTIME_DIR=${RUNTIME_DIR} setsid ${binary} ${flags.join(" ")} ${modules.join(" ")}` +
      ` < /dev/null > ${PULSE_LOG} 2>&1 &`,
    `polls=0`,
    `until [ -S ${PULSE_SOCKET} ]; do`,
    `  grep -q '^E: ' ${PULSE_LOG} 2> /dev/null && { ${giveUp}; }`,
    `  polls=$((polls + 1))`,
    `  [ $polls -gt ${SOCKET_POLLS} ] && { echo 'no socket after ${SOCKET_POLLS} polls' >&2; ${giveUp}; }`,
    `  sleep ${SOCKET_POLL_S}`,
    `done`,
  ].join("\n");
}

// The guest's server: start() runs the daemon of a closure, once per
// guest however often it is called, and resolves when its socket is
// open. `exec` runs a shell command in the guest.
export function soundServer({ exec }) {
  let started = null;

  async function run(daemon) {
    const result = await exec(daemonCommand(daemon));
    if (result.exitCode !== 0) {
      throw new Error(
        `the PulseAudio daemon did not start: ${result.stderr.trim()}`,
      );
    }
    log(`sound: the PulseAudio daemon of ${daemon} is running in the guest`);
  }

  return {
    start(daemon) {
      started ??= run(daemon);
      return started;
    },
  };
}
