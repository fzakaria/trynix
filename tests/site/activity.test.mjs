// Tests the console's activity strip (site/js/activity.js): which
// program a command line starts, which selected packages open windows,
// and the line the strip shows for what is going on (a program starting,
// downloads in flight, both, or nothing). Pure functions of what they
// are handed, so no page is needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activityLine,
  commandProgram,
  opensWindows,
  startLook,
} from "../../site/js/activity.js";

const DIGEST = "0".repeat(32);

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
  const look = (overrides) =>
    startLook({
      windowsBefore: 0,
      windowsNow: 0,
      running: true,
      seen: false,
      absent: 0,
      elapsedMs: 1000,
      ...overrides,
    });
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
  assert.equal(look({ elapsedMs: 200_000 }).done, true);
});
