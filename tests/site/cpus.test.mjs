// Tests how many CPUs the unkernel guest asks for (site/js/cpus.js): the
// default for the device and browser, the cap of half the host's
// threads, the one CPU a page without shared memory is held to, and which
// of the link, the browser's remembered choice and the default wins.
// Each is a pure function of what it is handed, so the tests pass in the
// device rather than read a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Pointer } from "../../site/js/memory.js";
import {
  Browser,
  CPU_COUNTS,
  defaultCpus,
  pickCpus,
} from "../../site/js/cpus.js";

const desktop = (threads, browser = Browser.OTHER) => ({
  pointer: Pointer.FINE,
  threads,
  browser,
  shared: true,
});

// Checks the defaults: 4 on a desktop browser, 2 in Firefox and on a
// touch screen, never more than half the host's threads (rounded down to
// a count the page offers), and one where that half is under two.
test("the default follows the device and the browser", () => {
  assert.equal(defaultCpus(desktop(16)).count, 4);
  assert.equal(defaultCpus(desktop(16, Browser.FIREFOX)).count, 2);
  assert.equal(
    defaultCpus({ ...desktop(8), pointer: Pointer.COARSE }).count,
    2,
  );
  assert.equal(defaultCpus(desktop(6)).count, 2);
  assert.equal(defaultCpus(desktop(4)).count, 2);
  assert.equal(defaultCpus(desktop(3)).count, 1);
  assert.equal(defaultCpus(desktop(1)).count, 1);
});

// Checks that a page without shared memory (not cross-origin isolated)
// boots one CPU whatever is asked: each guest CPU is a worker on one
// shared memory.
test("a page without shared memory gets one CPU", () => {
  const device = { ...desktop(16), shared: false };
  assert.equal(defaultCpus(device).count, 1);
  assert.equal(pickCpus({ linked: 4, remembered: null, device }).count, 1);
});

// Checks the precedence: a count in the link wins, then the one this
// browser remembers, then the default; a count the page does not offer,
// or more than the host has threads, is not taken.
test("the link wins, then the remembered choice, then the default", () => {
  const device = desktop(16);
  assert.equal(pickCpus({ linked: 1, remembered: 2, device }).count, 1);
  assert.equal(pickCpus({ linked: null, remembered: 2, device }).count, 2);
  assert.equal(pickCpus({ linked: null, remembered: null, device }).count, 4);
  assert.equal(pickCpus({ linked: 3, remembered: null, device }).count, 4);
  assert.equal(
    pickCpus({ linked: 4, remembered: null, device: desktop(2) }).count,
    1,
  );
});

// Checks the counts the Settings control offers.
test("the offered counts", () => {
  assert.deepEqual(CPU_COUNTS, [1, 2, 4]);
});
