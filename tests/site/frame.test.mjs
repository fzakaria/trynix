// Tests the console frame's rules for GUI windows (site/js/frame.js):
// which new windows open maximized, where the others open, where a
// window that went past the frame's edge is put back, and what the
// bar's windows button offers for a list of windows. Each rule is a
// function of plain sizes or of wland's window entries, so the tests
// pass plain objects and need no page.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WINDOW_GRIP,
  WINDOW_MARGIN,
  WindowsAction,
  keepReachable,
  opensAt,
  oversized,
  windowsButton,
} from "../../site/js/frame.js";

// A frame the size of the console's body on a desktop.
const FRAME = { width: 900, height: 700 };

// foot's window at wland's first cascade position.
const FOOT = { left: 24, top: 48, width: 700, height: 494 };

// Checks that a window opens maximized only when it is wider or taller
// than the frame, and that one exactly the frame's size is left as is.
test("a window larger than the frame is oversized", () => {
  assert.equal(oversized(FOOT, FRAME), false);
  assert.equal(oversized(FRAME, FRAME), false);
  assert.equal(oversized({ ...FOOT, width: FRAME.width + 1 }, FRAME), true);
  assert.equal(oversized({ ...FOOT, height: FRAME.height + 1 }, FRAME), true);
});

// Checks where a new window opens against the terminal's cursor: at the
// frame's bottom while the cursor is in the upper half, so the prompt
// the program was started from stays in view, and where wland put it
// otherwise. A window too tall to clear its place is never moved up.
test("a new window opens away from the terminal's cursor", () => {
  const nearTop = 0.1;
  const nearBottom = 0.9;
  assert.deepEqual(opensAt(FOOT, FRAME, nearTop), {
    left: FOOT.left,
    top: FRAME.height - FOOT.height - WINDOW_MARGIN,
  });
  assert.deepEqual(opensAt(FOOT, FRAME, nearBottom), {
    left: FOOT.left,
    top: FOOT.top,
  });

  const tall = { ...FOOT, height: FRAME.height - WINDOW_MARGIN };
  assert.deepEqual(opensAt(tall, FRAME, nearTop), {
    left: FOOT.left,
    top: FOOT.top,
  });
});

// Checks that a window inside the frame stays where it is, and that one
// moved past an edge comes back with a grip's worth of it inside: its
// left or right strip, and its top edge where the title bar is.
test("a window past the frame's edge is pulled back in", () => {
  assert.deepEqual(keepReachable(FOOT, FRAME), {
    left: FOOT.left,
    top: FOOT.top,
  });

  const pastBottomRight = { ...FOOT, left: 1500, top: 900 };
  assert.deepEqual(keepReachable(pastBottomRight, FRAME), {
    left: FRAME.width - WINDOW_GRIP.width,
    top: FRAME.height - WINDOW_GRIP.height,
  });

  const pastTopLeft = { ...FOOT, left: -2000, top: -10 };
  assert.deepEqual(keepReachable(pastTopLeft, FRAME), {
    left: WINDOW_GRIP.width - FOOT.width,
    top: 0,
  });
});

// Checks the windows button for each mix of shown and minimized
// windows: absent with no windows, "hide" while any window shows, and
// "show" with the count once every window is hidden.
test("the windows button hides shown windows and shows hidden ones", () => {
  const shown = { minimized: false };
  const hidden = { minimized: true };

  assert.equal(windowsButton([]).action, WindowsAction.NONE);

  const hide = windowsButton([shown, hidden]);
  assert.equal(hide.action, WindowsAction.HIDE);
  assert.equal(hide.label, "hide windows");

  const show = windowsButton([hidden, hidden]);
  assert.equal(show.action, WindowsAction.SHOW);
  assert.equal(show.label, "show windows (2)");
});
