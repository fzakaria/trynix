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

// The most the frame may grow to on a desktop: about the viewport.
const TALLEST = 900;

// The shell's prompt line in the frame's pixels: near the top after a
// boot, near the bottom once the screen has filled.
const PROMPT_TOP = { top: 20, bottom: 40 };
const PROMPT_LOW = { top: 640, bottom: 660 };

// Checks where a new window opens and how tall the frame becomes for
// it: just under the prompt line when it fits there, the frame growing
// only as far as the window needs; above a low prompt, where wland put
// it, when it fits there without growing; and as low as it fits whole
// when the frame cannot grow enough.
test("a new window opens under the prompt, growing the frame to fit", () => {
  const under = PROMPT_TOP.bottom + WINDOW_MARGIN;
  assert.deepEqual(
    opensAt(FOOT, { frame: FRAME, prompt: PROMPT_TOP, tallest: TALLEST }),
    { left: FOOT.left, top: under, height: FRAME.height },
  );

  const short = { ...FRAME, height: 480 };
  assert.deepEqual(
    opensAt(FOOT, { frame: short, prompt: PROMPT_TOP, tallest: TALLEST }),
    {
      left: FOOT.left,
      top: under,
      height: under + FOOT.height + WINDOW_MARGIN,
    },
  );

  assert.deepEqual(
    opensAt(FOOT, { frame: FRAME, prompt: PROMPT_LOW, tallest: TALLEST }),
    { left: FOOT.left, top: FOOT.top, height: FRAME.height },
  );

  const capped = 560;
  assert.deepEqual(
    opensAt(FOOT, { frame: short, prompt: PROMPT_TOP, tallest: capped }),
    {
      left: FOOT.left,
      top: capped - FOOT.height - WINDOW_MARGIN,
      height: capped,
    },
  );
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
