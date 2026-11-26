// Tests how many CPUs the unkernel guest asks for (site/js/cpus.js): the
// default for the device and browser, which leaves half the host's
// threads to the browser, the host's threads and the kernel's 16 as the
// most a link or Settings can ask for, the one CPU a page without shared
// memory is held to, and that the link's count wins over the default.
// Each is a pure function of what it is handed, so the tests pass in the
// device rather than read a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

import { UNKERNEL_KERNEL, UNKERNEL_KERNEL_SMP } from "../../site/js/config.js";
import { Pointer } from "../../site/js/memory.js";
import {
  Browser,
  CPU_COUNTS,
  MAX_CPUS,
  defaultCpus,
  kernelPath,
  offeredCpus,
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
  assert.equal(pickCpus({ linked: 4, device }).count, 1);
});

// Checks the precedence: a count in the link wins, else the default. A
// link may name any count from 1 to the kernel's 16, including counts
// Settings does not show, and a count outside that is not taken.
test("the link wins, else the default", () => {
  const device = desktop(16);
  assert.equal(pickCpus({ linked: 1, device }).count, 1);
  assert.equal(pickCpus({ linked: null, device }).count, 4);
  assert.equal(pickCpus({ linked: 3, device }).count, 3);
  assert.equal(pickCpus({ linked: 16, device }).count, 16);
  assert.equal(pickCpus({ linked: 0, device }).count, 4);
  assert.equal(pickCpus({ linked: 17, device }).count, 4);
});

// Checks that a link gets no more CPUs than the host has threads: a
// link asking for more boots on all of them, and says why.
test("no more CPUs than the host has threads", () => {
  const linked = pickCpus({ linked: 16, device: desktop(8) });
  assert.equal(linked.count, 8);
  assert.match(linked.why, /8 threads/);
  assert.equal(pickCpus({ linked: 4, device: desktop(2) }).count, 2);
});

// Checks the counts the Settings control offers: 1, 2, 4, 8 and the
// kernel's 16, cut at the host's threads.
test("the offered counts", () => {
  assert.deepEqual(CPU_COUNTS, [1, 2, 4, 8, 16]);
  assert.equal(MAX_CPUS, 16);
  assert.deepEqual(offeredCpus(desktop(32)), [1, 2, 4, 8, 16]);
  assert.deepEqual(offeredCpus(desktop(16)), [1, 2, 4, 8, 16]);
  assert.deepEqual(offeredCpus(desktop(12)), [1, 2, 4, 8]);
  assert.deepEqual(offeredCpus(desktop(4)), [1, 2, 4]);
  assert.deepEqual(offeredCpus(desktop(1)), [1]);
});

// Checks which kernel file a count boots: the one-CPU kernel for one
// CPU, and the several-CPU kernel the site's build made for any count
// above one, up to the most the kernel boots.
test("the kernel file for a count", () => {
  assert.equal(kernelPath(1), UNKERNEL_KERNEL);
  assert.equal(kernelPath(2), UNKERNEL_KERNEL_SMP);
  assert.equal(kernelPath(MAX_CPUS), UNKERNEL_KERNEL_SMP);
  assert.notEqual(UNKERNEL_KERNEL, UNKERNEL_KERNEL_SMP);
});
