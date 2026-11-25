// Tests the boot button's rule (site/js/boot-button.js): what the
// button says, and whether it can be pressed, for each place the page's
// boot can be in. The rule is a pure function of the boot's state and
// the selection, so the test hands it each state with selections that
// can and cannot boot, and compares the button it returns.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BootLabel,
  BootState,
  bootButtonOf,
} from "../../site/js/boot-button.js";

// A selection that can boot: one path, held by a cache.
const BOOTABLE = { selected: 1, unheld: 0 };
// A selection with one path no cache holds, which fails the closure walk.
const UNHELD = { selected: 1, unheld: 1 };
// Nothing selected.
const EMPTY = { selected: 0, unheld: 0 };

// Checks the button in every state of the page's boot. A boot under way
// keeps the button disabled even with a selection that can boot: a
// redraw mid-boot used to turn the button back on, and a second press
// started a second engine. A boot that failed once its engine started
// leaves the button starting over, whatever is selected. Otherwise the
// button boots, or adds to the running guest, when the selection can.
test("the boot button follows the page's boot", () => {
  const cases = [
    [BootState.IDLE, BOOTABLE, BootLabel.BOOT, false],
    [BootState.IDLE, UNHELD, BootLabel.BOOT, true],
    [BootState.IDLE, EMPTY, BootLabel.BOOT, true],
    [BootState.BOOTING, BOOTABLE, BootLabel.BOOT, true],
    [BootState.RUNNING, BOOTABLE, BootLabel.ADD, false],
    [BootState.RUNNING, UNHELD, BootLabel.ADD, true],
    [BootState.FAILED, BOOTABLE, BootLabel.START_OVER, false],
    [BootState.FAILED, EMPTY, BootLabel.START_OVER, false],
  ];
  for (const [state, selection, label, disabled] of cases) {
    assert.deepEqual(
      bootButtonOf({ state, ...selection }),
      { label, disabled },
      `${state} with ${JSON.stringify(selection)}`,
    );
  }
});
