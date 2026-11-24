// The console's activity strip: one line under the terminal that says
// what the guest is waiting on, so a terminal that looks still is not
// taken for a stuck one. Two things are shown:
//
//   downloads in flight, on a lazily served share (lazy.js): the path,
//   or how many, and the bytes so far, with a line along the strip's
//   top edge that fills;
//
//   a program starting that opens windows (opensWindows), from the
//   moment its command is entered until its first window appears or
//   it is no longer running. firefox's first start is half a minute of
//   work inside the emulator with nothing on screen; the strip counts
//   it, with a line that sweeps along the top edge.
//
// The strip shows only once the guest is at its prompt; before that,
// the boot's progress rows say what is happening. It sits between the
// terminal and its resize grip (index.html), so it never covers a row
// of the terminal.

import { humanBytes } from "./format.js";
import { speaksWayland } from "./gui.js";

// A store path's digest and the dash after it, for naming a path.
const DIGEST_PREFIX = /^[0-9a-z]{32}-/;

// The X11 client libraries: a package whose own closure holds one can
// open windows through the X server (x11.js).
const X11_CLIENT_PATH = /^[0-9a-z]{32}-lib(x11|X11|xcb)-\d/;

// A variable assignment before a command (VAR=value).
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// What separates commands on one line.
const COMMAND_SEPARATOR = /[;&|]/;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

// How often a starting program is looked at: whether a window has
// appeared, or the program is still running.
const WATCH_INTERVAL_MS = 1000;

// How many looks in a row may find the program not running before the
// strip stops waiting for it, and the longest it waits at all.
const ABSENT_LOOKS = 3;
const START_LIMIT_MS = 180_000;

// The program a command line runs: the first command's first word past
// any variable assignments, without its directory. null for a blank
// line.
export function commandProgram(line) {
  const first = line.split(COMMAND_SEPARATOR)[0] ?? "";
  const word = first
    .trim()
    .split(/\s+/)
    .find((part) => part !== "" && !ASSIGNMENT.test(part));
  if (word === undefined) {
    return null;
  }
  return word.slice(word.lastIndexOf("/") + 1);
}

// Whether a package opens windows, from the basenames of its own
// closure: a Wayland client library, libX11 or libxcb among them.
export const opensWindows = (basenames) =>
  speaksWayland(basenames) ||
  basenames.some((basename) => X11_CLIENT_PATH.test(basename));

// A store basename without its digest.
const nameOf = (basename) => basename.replace(DIGEST_PREFIX, "");

// Milliseconds as m:ss.
function clock(ms) {
  const seconds = Math.floor(ms / MS_PER_SECOND);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = String(seconds % SECONDS_PER_MINUTE).padStart(2, "0");
  return `${minutes}:${rest}`;
}

// What the strip shows for `starting` ({ program, since } or null) and
// `downloads` ([{ basename, bytes, total }]) at `now`: hidden, or a
// primary line, a secondary one, the downloads' fill from 0 to 1 (null
// when there are none) and the time since the program was started.
export function activityLine({ starting, downloads, now }) {
  if (starting === null && downloads.length === 0) {
    return { visible: false };
  }

  // The downloads, by name when there is one.
  let fetching = "";
  let progress = null;
  if (downloads.length > 0) {
    const bytes = downloads.reduce((sum, d) => sum + d.bytes, 0);
    const total = downloads.reduce((sum, d) => sum + d.total, 0);
    const what =
      downloads.length === 1
        ? nameOf(downloads[0].basename)
        : `${downloads.length} paths`;
    fetching = `downloading ${what}`;
    progress = total > 0 ? Math.min(1, bytes / total) : null;
    const amount = `${humanBytes(bytes)} / ${humanBytes(total)}`;
    if (starting === null) {
      return {
        visible: true,
        primary: fetching,
        secondary: amount,
        progress,
        elapsed: "",
      };
    }
    fetching = `${fetching} · ${amount}`;
  }

  return {
    visible: true,
    primary: `starting ${starting.program}`,
    secondary: fetching,
    progress,
    elapsed: clock(now - starting.since),
  };
}

// The strip on the page. `element` is the strip; `windowCount()` says
// how many GUI windows the page shows, and `isRunning(program)` resolves
// to whether a process of that name runs in the guest.
export function activityStrip({ element, windowCount, isRunning }) {
  const primary = element.querySelector(".activity-primary");
  const secondary = element.querySelector(".activity-secondary");
  const elapsed = element.querySelector(".activity-elapsed");
  const fill = element.querySelector(".activity-fill");

  // Downloads in flight, by basename.
  const downloads = new Map();
  // The program starting, or null, and its watch.
  let starting = null;
  let watch = null;
  // Whether the guest is at its prompt yet.
  let ready = false;
  // The clock that moves the elapsed time while a program starts.
  let ticker = null;

  function render() {
    const line = activityLine({
      starting,
      downloads: [...downloads.values()],
      now: Date.now(),
    });
    const visible = ready && line.visible;
    element.dataset.visible = String(visible);
    element.setAttribute("aria-hidden", String(!visible));
    if (!line.visible) {
      return;
    }
    primary.textContent = line.primary;
    secondary.textContent = line.secondary;
    elapsed.textContent = line.elapsed;
    element.dataset.progress = line.progress === null ? "sweep" : "fill";
    fill.style.width =
      line.progress === null ? "" : `${(line.progress * 100).toFixed(1)}%`;
  }

  // Stop waiting for the program that was starting.
  function stopStarting() {
    starting = null;
    clearInterval(watch);
    clearInterval(ticker);
    watch = null;
    ticker = null;
    render();
  }

  return {
    // The guest is at its prompt: the strip may show.
    ready() {
      ready = true;
      render();
    },

    // A download began, of `total` compressed bytes; it reads `bytes`
    // more at a time; it ended, whichever way.
    downloadStarted(basename, total) {
      downloads.set(basename, { basename, bytes: 0, total });
      render();
    },
    downloadBytes(basename, bytes) {
      const download = downloads.get(basename);
      if (download === undefined) {
        return;
      }
      download.bytes += bytes;
      render();
    },
    downloadEnded(basename) {
      downloads.delete(basename);
      render();
    },

    // A command line was entered that starts `program`, which opens
    // windows: wait for a window more than the page shows now, or for
    // the program to be gone. A new command replaces the one waited on.
    started(program) {
      stopStarting();
      const windowsBefore = windowCount();
      const since = Date.now();
      starting = { program, since };
      let absent = 0;
      let looking = false;
      watch = setInterval(async () => {
        if (
          windowCount() > windowsBefore ||
          Date.now() - since > START_LIMIT_MS
        ) {
          stopStarting();
          return;
        }
        // One look at a time: a guest busy starting the program may
        // answer slowly.
        if (looking) {
          return;
        }
        looking = true;
        const running = await isRunning(program).catch(() => true);
        looking = false;
        absent = running ? 0 : absent + 1;
        if (absent >= ABSENT_LOOKS && starting?.since === since) {
          stopStarting();
        }
      }, WATCH_INTERVAL_MS);
      ticker = setInterval(render, MS_PER_SECOND);
      render();
    },
  };
}
