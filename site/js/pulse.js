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

// The file the start records its daemon's PID in, beside its output.
// Every PulseAudio server in the guest runs under the daemon's name, so
// the PID is how the page tells its own daemon from a reader's.
const PULSE_PID_FILE = `${RUNTIME_DIR}/pulseaudio.pid`;

// The process name the daemon runs as. A recorded PID is stopped only
// while its process has that name, since a PID is reused once its
// process is gone.
const DAEMON_NAME = "pulseaudio";

// The ALSA device the daemon plays on: kwsnd, the guest's one card.
const CARD_DEVICE = "hw:0";

// The sink module-alsa-sink makes of the card, as `pactl list short
// sinks` lists it: the name the module gives a sink for hw:0 (the
// device made a valid sink name) and the module as its driver. Both
// are checked, so a null sink, or another module's sink by that name,
// is not taken for the card.
const CARD_SINK_NAME = "alsa_output.hw_0";
const CARD_SINK_DRIVER = "module-alsa-sink.c";

// The column separator in pactl's short listings.
const SHORT_LIST_SEPARATOR = "\t";

// How long the daemon keeps the card open after its last client stops,
// in seconds. The card has one stream, so while the daemon holds it a
// program that writes to ALSA itself cannot open it.
const IDLE_CLOSE_S = 1;

// How often the page looks for the daemon's socket, or for a stopped
// server to have gone, in seconds.
const POLL_S = "0.1";

// How many times the page looks for the daemon's socket: the daemon's
// first start reads its libraries over the share, downloading any not
// fetched yet.
const SOCKET_POLLS = 600;

// The client that asks a server for its sinks, or to exit, from the
// daemon's package, and how long it may take, in seconds: its first run
// may read libraries the daemon did not.
const CLIENT_NAME = "pactl";
const CLIENT_LIMIT_S = 60;

// How many times the page looks for a stopped server to have gone.
const STOP_POLLS = 50;

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
// starts (a store basename) or null; a variable given null is unset.
// Both cases name the same variables: a shell inherits the environment
// of the shell it was started from, and a variable one case left out
// would keep the other case's value. A daemon's clients are given its
// socket, and libcanberra is left to choose, which a shell started from
// one told otherwise before the daemon came would inherit. Without a
// daemon, libcanberra is sent to ALSA: left to choose, it takes
// PulseAudio and plays nothing. No socket is named either: the page's
// shell is told of the closure's daemon at the boot, before the daemon
// is up, and a shell started from the page's shell after the daemon
// failed would inherit a socket nothing listens on.
export function soundEnv(daemon) {
  if (daemon !== null) {
    return { PULSE_SERVER: `unix:${PULSE_SOCKET}`, CANBERRA_DRIVER: null };
  }
  return { PULSE_SERVER: null, CANBERRA_DRIVER: CANBERRA_ALSA };
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
// gives it a session of its own, as the Wayland relay has (gui.js). The
// background job's PID, which the command records, is the daemon's:
// setsid forks only when its caller leads a process group, and a
// background job of a shell without job control does not.
//
// A daemon counts as up only once card 0 is its sink, which the
// closure's pactl is asked. A daemon whose ALSA module failed, because
// another program held the card as it started, logs an error and goes
// on to open its socket, and every client of it fails with "No such
// entity". Any other sink is no sink of the card's: a daemon with only
// a null sink answers every client and plays nothing on the card. A
// server already on the socket is taken as it is only if it has card
// 0's sink; otherwise it is stopped and a new daemon started.
//
// Stopping ends two processes at most: the daemon whose PID the last
// start recorded, and whatever server still answers on the socket,
// which pactl asks to exit. A PulseAudio server a reader started on a
// socket of their own runs under the same name and is left alone.
//
// The command fails if the daemon logs an error (`E:`) or exits before
// its socket opens, if no socket appears in time, or if the daemon has
// no sink on card 0 once it does, printing the end of the daemon's
// output. A daemon whose binary could not be read, because its download
// failed, exits at once, and the polls for its socket would otherwise
// have held the shell for a minute. A daemon that failed is stopped, so
// the next start begins afresh.
function daemonCommand(daemon) {
  const directory = `${GUEST_STORE_DIR}/${daemon}/bin`;
  const binary = `${directory}/${DAEMON_NAME}`;
  const client = `${directory}/${CLIENT_NAME} -s unix:${PULSE_SOCKET}`;

  // The check for card 0's sink: its row in the short listing, the
  // name and driver columns between their separators, with the dots
  // matched as dots.
  const cardSink = [CARD_SINK_NAME, CARD_SINK_DRIVER]
    .map((column) => column.replaceAll(".", "\\."))
    .join(SHORT_LIST_SEPARATOR);
  const hasSink =
    `timeout ${CLIENT_LIMIT_S} ${client} list short sinks 2> /dev/null |` +
    ` grep -q '${SHORT_LIST_SEPARATOR}${cardSink}${SHORT_LIST_SEPARATOR}'`;
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
  const giveUp = `tail -n ${FAILURE_LINES} ${PULSE_LOG} >&2; stop_daemon; exit 1`;
  return [
    // Whether process $1 has exited: it is gone, or it is a zombie
    // nothing has collected yet.
    `exited() {`,
    `  [ ! -e /proc/$1 ] || grep -q '^State:.*zombie' /proc/$1/status 2> /dev/null`,
    `}`,

    // Run the command given until it succeeds, or the polls run out.
    `wait_until() {`,
    `  stops=0`,
    `  until "$@" || [ $stops -ge ${STOP_POLLS} ]; do`,
    `    stops=$((stops + 1))`,
    `    sleep ${POLL_S}`,
    `  done`,
    `}`,

    // Stop the daemon the last start recorded, if its PID still runs
    // under the daemon's name, and then any server left on the socket.
    // A server that exits removes its socket; a daemon that was killed
    // leaves one nothing answers on.
    `stop_daemon() {`,
    `  pid=$(cat ${PULSE_PID_FILE} 2> /dev/null)`,
    `  rm -f ${PULSE_PID_FILE}`,
    `  if [ -n "$pid" ] && [ "$(cat /proc/$pid/comm 2> /dev/null)" = ${DAEMON_NAME} ]; then`,
    `    kill $pid 2> /dev/null`,
    `    wait_until exited $pid`,
    `  fi`,
    `  if [ -S ${PULSE_SOCKET} ] && timeout ${CLIENT_LIMIT_S} ${client} exit > /dev/null 2>&1; then`,
    `    wait_until [ ! -S ${PULSE_SOCKET} ]`,
    `  fi`,
    `}`,

    // Take the server on the socket if card 0 is its sink, and start
    // the daemon afresh otherwise, recording its PID.
    `[ -S ${PULSE_SOCKET} ] && ${hasSink} && exit 0`,
    `stop_daemon`,
    `mkdir -p -m 700 ${PULSE_DIR}`,
    `rm -f ${PULSE_SOCKET}`,
    `XDG_RUNTIME_DIR=${RUNTIME_DIR} setsid ${binary} ${flags.join(" ")} ${modules.join(" ")}` +
      ` < /dev/null > ${PULSE_LOG} 2>&1 &`,
    `daemon=$!`,
    `echo $daemon > ${PULSE_PID_FILE}`,

    // Wait for the socket, and then for card 0's sink.
    `polls=0`,
    `until [ -S ${PULSE_SOCKET} ]; do`,
    `  grep -q '^E: ' ${PULSE_LOG} 2> /dev/null && { ${giveUp}; }`,
    `  exited $daemon && { echo 'the daemon exited' >&2; ${giveUp}; }`,
    `  polls=$((polls + 1))`,
    `  [ $polls -gt ${SOCKET_POLLS} ] && { echo 'no socket after ${SOCKET_POLLS} polls' >&2; ${giveUp}; }`,
    `  sleep ${POLL_S}`,
    `done`,
    `${hasSink} || { echo 'no sink on ${CARD_DEVICE}' >&2; ${giveUp}; }`,
  ].join("\n");
}

// The guest's server: start() runs the daemon of a closure unless it
// is up, and resolves once the daemon is up with card 0 as its sink.
// Calls made while a start is in flight share it. A call after it has
// settled runs the command again, which takes a daemon still up as it
// is: a daemon stopped in the guest (`pactl exit`) is started again,
// and one that failed is tried again, since the card a program held as
// the daemon started is free once the program stops. A start kept
// would keep naming a stopped daemon's socket to new shells, and a
// failure kept would keep PulseAudio's clients out for the life of the
// guest. `exec` runs a shell command in the guest.
//
// `running` is the daemon the last start found up (a store basename),
// or null before one has and after one failed: what the shells started
// from then on are told of (soundEnv).
export function soundServer({ exec }) {
  let starting = null;
  let running = null;

  async function run(daemon) {
    const result = await exec(daemonCommand(daemon));
    if (result.exitCode !== 0) {
      running = null;
      throw new Error(
        `the PulseAudio daemon did not start: ${result.stderr.trim()}`,
      );
    }

    // The page's log names a daemon as it comes up, not at every check.
    if (running !== daemon) {
      log(`sound: the PulseAudio daemon of ${daemon} is running in the guest`);
    }
    running = daemon;
  }

  return {
    start(daemon) {
      starting ??= run(daemon).finally(() => {
        starting = null;
      });
      return starting;
    },

    get running() {
      return running;
    },
  };
}
