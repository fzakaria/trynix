// The console's activity strip: one line under the terminal that says
// what the guest is waiting on, so a terminal that looks still is not
// taken for a stuck one. Two things are shown:
//
//   downloads in flight, on a lazily served share (lazy.js): the path,
//   or how many, and the bytes so far, with a line along the strip's
//   top edge that fills. A download being tried again says which
//   attempt it is on and why the one before failed (net.js), and one
//   the page gave up on says so for a while, since the guest's read
//   that waited on it has just failed with an I/O error;
//
//   a program starting that opens windows (opensWindows), from the
//   moment its command is entered until its first window appears, it
//   is no longer running, or, run in the foreground, it has taken the
//   terminal's screen as emacs -nw does. firefox's first start is half
//   a minute of work inside the emulator with nothing on screen; the
//   strip counts it, with a line that sweeps along the top edge.
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

// What ends a line's first command: a semicolon, or an ampersand that
// is not part of && or of a redirection (2>&1, <&, &>, |&).
const COMMAND_END = /(^|[^&<>|])&(?![&>])|;/;
const BACKGROUND_END = "&";

// Where a command line runs its first command: in the foreground,
// holding the terminal, or in the background, after a lone &.
export const Job = Object.freeze({
  FOREGROUND: "foreground",
  BACKGROUND: "background",
});

// The terminal's screens, as its buffer's type names them (xterm.js,
// which ghostty-web follows): a full-screen terminal program such as
// emacs -nw, vim or top switches to the alternate one while it runs.
export const Screen = Object.freeze({
  NORMAL: "normal",
  ALTERNATE: "alternate",
});

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

// How often a starting program is looked at: whether a window has
// appeared, or the program is still running.
const WATCH_INTERVAL_MS = 1000;

// How many looks in a row may find a program not running, once it has
// been seen running, before the strip stops waiting for it.
const ABSENT_LOOKS = 3;

// How long a program never seen running is waited on: the command
// failed, or the program exited between two looks. Time with a
// download in flight is left out (startLook), since the program's own
// files may still be on their way.
const UNSEEN_GRACE_MS = 20_000;

// The longest the strip waits for a program, again leaving out time
// with a download in flight. The limit ends the wait for a program that
// links X11 or Wayland, opens no window and does not take the screen,
// such as a REPL. firefox's first start is 37 s on a laptop
// (docs/gui.md); 15 minutes is 24 times that, for a phone or a guest
// nested in another trynix guest, where a 3 minute limit ran out with
// firefox still starting.
const START_LIMIT_MINUTES = 15;
const START_LIMIT_MS = START_LIMIT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

// How long the strip stays open after the last thing it showed ended,
// so a run of small downloads does not open and close it each time.
const LINGER_MS = 1200;

// How long a download the page gave up on stays on the strip: long
// enough to read beside the error the guest printed for it.
const FAILURE_SHOWN_MS = 20_000;

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

// Where a command line runs its first command: in the background when
// a lone & ends it, in the foreground otherwise.
export function commandJob(line) {
  const end = line.match(COMMAND_END);
  if (end === null || !end[0].endsWith(BACKGROUND_END)) {
    return Job.FOREGROUND;
  }
  return Job.BACKGROUND;
}

// The command line the reader just entered at the terminal: the row the
// cursor is on, after the shell's prompt ("# " or "$ "), or null.
//
// The buffer counts rows from the oldest one scrolled off, and the
// screen is its last `rows` rows. ghostty-web's baseY is always 0, so
// baseY + cursorY named a row scrolled off once the terminal had any.
export function enteredLine(terminal) {
  try {
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.length - terminal.rows + buffer.cursorY;
    const row = buffer.getLine(cursorRow)?.translateToString(true) ?? "";
    const at = Math.max(row.lastIndexOf("# "), row.lastIndexOf("$ "));
    return at === -1 ? null : row.slice(at + 2);
  } catch {
    return null;
  }
}

// A line being typed, after `data` is sent: printable text added, a
// backspace taking the last character off, and anything else (arrows,
// control keys, escape sequences) left out.
const BACKSPACE = "\x7f";
const ESCAPE_SEQUENCE = /\x1b(\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;
export function typedLine(line, data) {
  let next = line;
  for (const char of data.replace(ESCAPE_SEQUENCE, "")) {
    if (char === BACKSPACE) {
      next = next.slice(0, -1);
    } else if (char >= " ") {
      next += char;
    }
  }
  return next;
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

// What the strip shows for `starting` ({ program, since } or null),
// `downloads` ([{ basename, bytes, total, retry }], `retry` being
// { attempt, attempts, reason } for a download on its second attempt or
// later) and `failures` ([{ basename, reason }], downloads the page
// gave up on) at `now`: hidden, or a primary line, a secondary one,
// whether it reports a failure, the downloads' fill from 0 to 1 (null
// when there are none) and the time since the program was started.
export function activityLine({ starting, downloads, failures = [], now }) {
  if (starting === null && downloads.length === 0 && failures.length === 0) {
    return { visible: false };
  }

  // The failures, by name when there is one. They take the strip from
  // the downloads, since they explain an error the guest just printed.
  const failed = failures.length > 0;
  const lost =
    failures.length === 1
      ? nameOf(failures[0].basename)
      : `${failures.length} paths`;
  if (failed && starting === null) {
    return {
      visible: true,
      failed,
      primary: `could not download ${lost}`,
      secondary: failures.length === 1 ? failures[0].reason : "",
      progress: null,
      elapsed: "",
    };
  }

  // The downloads, by name when there is one, with the attempt one is
  // on, or how many are being tried again.
  let fetching = "";
  let progress = null;
  if (downloads.length > 0) {
    const bytes = downloads.reduce((sum, d) => sum + d.bytes, 0);
    const total = downloads.reduce((sum, d) => sum + d.total, 0);
    const single = downloads.length === 1 ? downloads[0] : null;
    const what =
      single !== null ? nameOf(single.basename) : `${downloads.length} paths`;
    fetching = `downloading ${what}`;
    progress = total > 0 ? Math.min(1, bytes / total) : null;
    let amount = `${humanBytes(bytes)} / ${humanBytes(total)}`;
    const retry = single?.retry;
    const retrying = downloads.filter((d) => d.retry !== undefined).length;
    if (retry !== undefined) {
      amount = `${amount} · attempt ${retry.attempt} of ${retry.attempts}`;
    } else if (retrying > 0) {
      amount = `${amount} · ${retrying} retrying`;
    }
    if (starting === null) {
      return {
        visible: true,
        failed,
        primary: fetching,
        secondary: retry !== undefined ? `${amount} (${retry.reason})` : amount,
        progress,
        elapsed: "",
      };
    }
    fetching = `${fetching} · ${amount}`;
  }

  return {
    visible: true,
    failed,
    primary: `starting ${starting.program}`,
    secondary: failed ? `could not download ${lost}` : fetching,
    progress,
    elapsed: clock(now - starting.since),
  };
}

// The time downloads have been in flight, over the page's life: a
// clock that runs while at least one download is in flight, told the
// count as it changes and read at `now`, in milliseconds.
export function downloadClock() {
  // The time from runs that ended, and when the one running began, or
  // null while none is in flight.
  let totalMs = 0;
  let since = null;

  return {
    inFlight(count, now) {
      if (count > 0 && since === null) {
        since = now;
        return;
      }
      if (count === 0 && since !== null) {
        totalMs += now - since;
        since = null;
      }
    },
    read(now) {
      return since === null ? totalMs : totalMs + (now - since);
    },
  };
}

// One look at a program starting: whether the wait is over, and what to
// carry to the next look. Over once a window more than before has
// appeared; once the program, run in the foreground, has switched the
// terminal to its alternate screen; once the program, seen running, has
// been gone for ABSENT_LOOKS looks; once a program never seen has had
// its grace; and at START_LIMIT_MS. `elapsedMs` is the time since the
// command, and `downloadingMs` the part of it with a download in
// flight, which the limits leave out.
export function startLook({
  windowsBefore,
  windowsNow,
  job,
  screenBefore,
  screenNow,
  running,
  seen,
  absent,
  elapsedMs,
  downloadingMs,
}) {
  // A window more than before: the program has opened its first one.
  if (windowsNow > windowsBefore) {
    return { done: true, seen, absent };
  }

  // A foreground program that switched the terminal to the alternate
  // screen is a full-screen terminal program the reader now uses, like
  // emacs -nw, and opens no window. For a program in the background the
  // alternate screen is another program's, such as top opened while
  // firefox starts, and a screen already alternate when the command was
  // entered belongs to a program like tmux; neither ends the wait.
  if (
    job === Job.FOREGROUND &&
    screenBefore !== Screen.ALTERNATE &&
    screenNow === Screen.ALTERNATE
  ) {
    return { done: true, seen, absent };
  }

  // Time with a download in flight is progress, since the program waits
  // for its files: the limits count only the rest.
  const waitedMs = elapsedMs - downloadingMs;
  if (waitedMs > START_LIMIT_MS) {
    return { done: true, seen, absent };
  }

  // Running: wait on, and start the count of absent looks over.
  if (running) {
    return { done: false, seen: true, absent: 0 };
  }

  // Never seen running: wait out the grace.
  if (!seen) {
    return { done: waitedMs > UNSEEN_GRACE_MS, seen, absent };
  }

  // Seen running, and now gone: over after ABSENT_LOOKS looks.
  const gone = absent + 1;
  return { done: gone >= ABSENT_LOOKS, seen, absent: gone };
}

// The strip on the page. `element` is the strip; `windowCount()` says
// how many GUI windows the page shows, `screen()` which of the
// terminal's screens shows (Screen), and `isRunning(program)` resolves
// to whether a process of that name runs in the guest.
export function activityStrip({ element, windowCount, screen, isRunning }) {
  const primary = element.querySelector(".activity-primary");
  const secondary = element.querySelector(".activity-secondary");
  const elapsed = element.querySelector(".activity-elapsed");
  const fill = element.querySelector(".activity-fill");

  // Downloads in flight, by basename, and the time any have been.
  const downloads = new Map();
  const downloading = downloadClock();
  // Downloads the page gave up on, by basename, each with the timer
  // that takes it off the strip.
  const failures = new Map();
  // The program starting, or null, and its watch.
  let starting = null;
  let watch = null;
  // Whether the guest is at its prompt yet.
  let ready = false;
  // The clock that moves the elapsed time while a program starts.
  let ticker = null;

  // The timer that closes the strip once it has lingered.
  let closing = null;

  function show(visible) {
    element.dataset.visible = String(visible);
    element.setAttribute("aria-hidden", String(!visible));
  }

  function render() {
    const line = activityLine({
      starting,
      downloads: [...downloads.values()],
      failures: [...failures.values()].map(({ basename, reason }) => ({
        basename,
        reason,
      })),
      now: Date.now(),
    });

    // Nothing to show: close after a moment, leaving the last line up
    // meanwhile.
    if (!(ready && line.visible)) {
      if (closing === null && element.dataset.visible === "true") {
        closing = setTimeout(() => {
          closing = null;
          show(false);
        }, LINGER_MS);
      }
      return;
    }
    clearTimeout(closing);
    closing = null;
    show(true);
    primary.textContent = line.primary;
    secondary.textContent = line.secondary;
    elapsed.textContent = line.elapsed;
    element.dataset.failed = String(line.failed);
    element.dataset.progress = line.progress === null ? "sweep" : "fill";
    fill.style.width =
      line.progress === null ? "" : `${(line.progress * 100).toFixed(1)}%`;
  }

  // Take a failed download off the strip.
  function forget(basename) {
    clearTimeout(failures.get(basename)?.timer);
    failures.delete(basename);
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
    // more at a time; it ended, whichever way. A path downloaded again
    // is no longer one the page gave up on.
    downloadStarted(basename, total) {
      forget(basename);
      downloads.set(basename, { basename, bytes: 0, total });
      downloading.inFlight(downloads.size, Date.now());
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
      downloading.inFlight(downloads.size, Date.now());
      render();
    },

    // A download in flight is on its attempt `attempt` of `attempts`,
    // the one before having failed for `reason` (net.js).
    downloadRetrying(basename, { attempt, attempts, reason }) {
      const download = downloads.get(basename);
      if (download === undefined) {
        return;
      }
      download.retry = { attempt, attempts, reason };
      render();
    },

    // The page gave up on a download, for `reason`: shown for
    // FAILURE_SHOWN_MS, or until the path is downloaded again.
    downloadFailed(basename, reason) {
      forget(basename);
      const timer = setTimeout(() => {
        failures.delete(basename);
        render();
      }, FAILURE_SHOWN_MS);
      failures.set(basename, { basename, reason, timer });
      render();
    },

    // A command line was entered that starts `program`, which opens
    // windows, as `job` (Job): wait for a window more than the page
    // shows now, for the program to take the terminal's screen, or for
    // the program to be gone. A new command replaces the one waited on.
    started(program, job) {
      stopStarting();
      const windowsBefore = windowCount();
      const screenBefore = screen();
      const since = Date.now();
      const downloadedBefore = downloading.read(since);
      starting = { program, since };
      let carried = { seen: false, absent: 0 };
      let looking = false;
      watch = setInterval(async () => {
        // One look at a time: a guest busy starting the program may
        // answer slowly.
        if (looking) {
          return;
        }
        looking = true;
        const running = await isRunning(program).catch(() => true);
        looking = false;
        if (starting?.since !== since) {
          return;
        }
        const now = Date.now();
        const look = startLook({
          windowsBefore,
          windowsNow: windowCount(),
          job,
          screenBefore,
          screenNow: screen(),
          running,
          ...carried,
          elapsedMs: now - since,
          downloadingMs: downloading.read(now) - downloadedBefore,
        });
        carried = { seen: look.seen, absent: look.absent };
        if (look.done) {
          stopStarting();
        }
      }, WATCH_INTERVAL_MS);
      ticker = setInterval(render, MS_PER_SECOND);
      render();
    },
  };
}
