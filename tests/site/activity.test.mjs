// Tests the console's activity strip (site/js/activity.js): which
// program a command line starts and whether in the background, which
// selected packages open windows, the line the strip shows for what is
// going on (a program starting, downloads in flight, both, or nothing),
// when the strip stops waiting for a program, and the clock of time
// with downloads in flight. Pure functions of what they are handed, so
// no page is needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Job,
  Screen,
  activityLine,
  commandJob,
  commandProgram,
  downloadClock,
  opensWindows,
  startLook,
  typedLine,
} from "../../site/js/activity.js";

const DIGEST = "0".repeat(32);
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

// One look at a program starting, from a look at a program in the
// background that has been running a second, changed by `overrides`.
const look = (overrides) =>
  startLook({
    windowsBefore: 0,
    windowsNow: 0,
    job: Job.BACKGROUND,
    screenBefore: Screen.NORMAL,
    screenNow: Screen.NORMAL,
    running: true,
    seen: false,
    absent: 0,
    elapsedMs: SECOND_MS,
    downloadingMs: 0,
    ...overrides,
  });

// Checks the program a command line runs: its first word, past any
// variable assignments, for a line with several commands the first.
test("a command line's program is its first word past assignments", () => {
  assert.equal(commandProgram("firefox &"), "firefox");
  assert.equal(commandProgram("  sol &"), "sol");
  assert.equal(
    commandProgram("WAYLAND_DISPLAY=wayland-1 weston-terminal &"),
    "weston-terminal",
  );
  assert.equal(
    commandProgram("weston & until [ -S x ]; do sleep 1; done"),
    "weston",
  );
  assert.equal(
    commandProgram("/nix/store/x-mpv/bin/mpv --vo=wlshm a &"),
    "mpv",
  );
  assert.equal(commandProgram(""), null);
  assert.equal(commandProgram("   "), null);
});

// Checks which packages open windows: those whose own closure holds a
// Wayland client library, libX11 or libxcb.
test("a package that reaches Wayland or X11 opens windows", () => {
  assert.equal(opensWindows([`${DIGEST}-wayland-1.24.0`]), true);
  assert.equal(opensWindows([`${DIGEST}-libX11-1.8.12`]), true);
  assert.equal(opensWindows([`${DIGEST}-libxcb-1.17.0`]), true);
  assert.equal(opensWindows([`${DIGEST}-glibc-2.40-66`]), false);
});

// Checks the strip's line: nothing shown with nothing going on; a
// program starting with the time since; downloads with their bytes and
// a fill, one by name and several by count; and both together, the
// program first.
test("the strip says what is going on", () => {
  assert.deepEqual(activityLine({ starting: null, downloads: [], now: 0 }), {
    visible: false,
  });

  const starting = { program: "firefox", since: 0 };
  assert.deepEqual(activityLine({ starting, downloads: [], now: 12_400 }), {
    visible: true,
    primary: "starting firefox",
    secondary: "",
    progress: null,
    elapsed: "0:12",
  });

  const one = [
    { basename: `${DIGEST}-firefox-unwrapped-160.0.1`, bytes: 50, total: 200 },
  ];
  assert.deepEqual(activityLine({ starting: null, downloads: one, now: 0 }), {
    visible: true,
    primary: "downloading firefox-unwrapped-160.0.1",
    secondary: "50 B / 200 B",
    progress: 0.25,
    elapsed: "",
  });

  const two = [
    ...one,
    { basename: `${DIGEST}-gtk+3-3.24.49`, bytes: 50, total: 200 },
  ];
  const both = activityLine({ starting, downloads: two, now: 65_000 });
  assert.equal(both.primary, "starting firefox");
  assert.equal(both.secondary, "downloading 2 paths · 100 B / 400 B");
  assert.equal(both.progress, 0.25);
  assert.equal(both.elapsed, "1:05");
});

// Checks when the strip stops waiting for a program: once a window more
// than before has appeared; once the program, seen running, has been
// gone for a few looks; once a program never seen has had its grace (a
// typo, or a command that failed); and at the overall limit. A program
// not seen yet within its grace is waited on, since its files may still
// be downloading.
test("the wait for a program ends on a window, its exit, or a limit", () => {
  assert.equal(look({ windowsNow: 1 }).done, true);
  assert.deepEqual(look({}), { done: false, seen: true, absent: 0 });
  assert.deepEqual(look({ running: false }), {
    done: false,
    seen: false,
    absent: 0,
  });
  assert.equal(look({ running: false, elapsedMs: 25_000 }).done, true);
  assert.equal(look({ running: false, seen: true, absent: 2 }).done, true);
  assert.deepEqual(look({ running: false, seen: true, absent: 0 }), {
    done: false,
    seen: true,
    absent: 1,
  });
  assert.equal(look({ elapsedMs: 16 * MINUTE_MS }).done, true);
});

// Checks that a slow start is waited on: a program seen running with
// no window after 10 minutes, as firefox in a guest nested in another
// guest, is still starting, where the limit used to be 3 minutes.
test("the wait for a program running without a window lasts minutes", () => {
  assert.deepEqual(look({ elapsedMs: 10 * MINUTE_MS }), {
    done: false,
    seen: true,
    absent: 0,
  });
});

// Checks that time with a download in flight counts against neither
// limit, since a program waiting for its files is making progress: a
// program unseen for 25 s, 10 s of them downloading, is waited on, and
// one running for 20 minutes, 10 of them downloading, is too; with 4
// minutes downloading the 16 left are past the limit.
test("time with a download in flight does not count against the wait", () => {
  const unseen = { running: false, elapsedMs: 25 * SECOND_MS };
  assert.equal(look({ ...unseen, downloadingMs: 10 * SECOND_MS }).done, false);
  assert.equal(look({ ...unseen, downloadingMs: 0 }).done, true);

  const running = { elapsedMs: 20 * MINUTE_MS };
  assert.equal(look({ ...running, downloadingMs: 10 * MINUTE_MS }).done, false);
  assert.equal(look({ ...running, downloadingMs: 4 * MINUTE_MS }).done, true);
});

// Checks the wait for a full-screen terminal program, like emacs -nw,
// which links X11 but opens no window: run in the foreground, once the
// terminal shows its alternate screen the wait is over. In the
// background the screen is some other program's (top, opened while
// firefox starts), and a screen already alternate when the command was
// entered is a program like tmux, so neither ends the wait.
test("a foreground program that takes the screen ends the wait", () => {
  const takenOver = {
    job: Job.FOREGROUND,
    screenBefore: Screen.NORMAL,
    screenNow: Screen.ALTERNATE,
  };
  assert.equal(look(takenOver).done, true);
  assert.equal(look({ ...takenOver, job: Job.BACKGROUND }).done, false);
  assert.equal(
    look({ ...takenOver, screenBefore: Screen.ALTERNATE }).done,
    false,
  );
  assert.equal(look({ ...takenOver, screenNow: Screen.NORMAL }).done, false);
});

// Checks whether a command line runs its first command in the
// background: a lone & ends it there, while && and the & of a
// redirection (2>&1, &>) do not, and a ; before any & ends the first
// command in the foreground.
test("a command line's job is in the background after a lone &", () => {
  assert.equal(commandJob("firefox &"), Job.BACKGROUND);
  assert.equal(commandJob("firefox&"), Job.BACKGROUND);
  assert.equal(commandJob("a && firefox &"), Job.BACKGROUND);
  assert.equal(
    commandJob("weston & until [ -S x ]; do sleep 1; done"),
    Job.BACKGROUND,
  );
  assert.equal(commandJob("emacs -nw"), Job.FOREGROUND);
  assert.equal(commandJob("a && emacs -nw"), Job.FOREGROUND);
  assert.equal(commandJob("firefox 2>&1 | tee log"), Job.FOREGROUND);
  assert.equal(commandJob("firefox &> log"), Job.FOREGROUND);
  assert.equal(commandJob("emacs -nw; sleep 1 &"), Job.FOREGROUND);
});

// Checks the clock of time with downloads in flight, read at given
// times: it runs from the first download until none is left, a second
// download meanwhile changes nothing, and it stands still between.
test("the download clock runs while a download is in flight", () => {
  const clock = downloadClock();
  assert.equal(clock.read(500), 0);
  clock.inFlight(1, 1000);
  assert.equal(clock.read(1500), 500);
  clock.inFlight(2, 2000);
  clock.inFlight(1, 2500);
  clock.inFlight(0, 3000);
  assert.equal(clock.read(10_000), 2000);
  clock.inFlight(1, 11_000);
  assert.equal(clock.read(12_000), 3000);
});

// Checks the line the page keeps from what is sent to the terminal, for
// a line pasted whole: printable text kept, a backspace taking off the
// last character, arrow keys and other escape sequences left out.
test("a typed line keeps text and backspaces, not escapes", () => {
  assert.equal(typedLine("", "foot &"), "foot &");
  assert.equal(typedLine("foox", "\x7ft &"), "foot &");
  assert.equal(typedLine("sol", "\x1b[A\x1b[D &"), "sol &");
});
