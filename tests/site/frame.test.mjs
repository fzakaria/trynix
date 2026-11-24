// Tests the console frame's rules for GUI windows (site/js/frame.js):
// where a new window opens. Each rule is a function of plain sizes, so
// the tests pass plain objects and need no page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { WINDOW_MARGIN, opensAt } from "../../site/js/frame.js";

// A frame the size of the console's body on a desktop.
const FRAME = { width: 900, height: 700 };

// foot's window at wland's first cascade position.
const FOOT = { left: 24, top: 48, width: 700, height: 494 };

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
