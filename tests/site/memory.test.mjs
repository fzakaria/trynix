// Tests how much memory the unkernel guest asks for (site/js/memory.js):
// the default for the device, the sizes tried when an allocation fails,
// and which of the link, the browser's remembered choice and the default
// wins. Each is a pure function of what it is handed, so the tests pass
// in the device's pointer and reported memory rather than a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultMemory,
  fallbacksBelow,
  MEMORY_SIZES_MIB,
  memoryLabel,
  Pointer,
  pickMemory,
} from "../../site/js/memory.js";

// Checks the default: 2 GiB with a fine pointer, 512 MiB on a touch
// screen, and less where the browser says the device has little memory.
test("the default follows the device", () => {
  assert.equal(defaultMemory({ pointer: Pointer.FINE }).mib, 2048);
  assert.equal(defaultMemory({ pointer: Pointer.COARSE }).mib, 512);
  assert.equal(
    defaultMemory({ pointer: Pointer.FINE, deviceMemoryGb: 8 }).mib,
    2048,
  );
  assert.equal(
    defaultMemory({ pointer: Pointer.FINE, deviceMemoryGb: 4 }).mib,
    1024,
  );
  assert.equal(
    defaultMemory({ pointer: Pointer.FINE, deviceMemoryGb: 2 }).mib,
    512,
  );
  assert.equal(
    defaultMemory({ pointer: Pointer.COARSE, deviceMemoryGb: 8 }).mib,
    512,
  );
});

// Checks the sizes tried after a failed allocation: 1 GiB, then 512 MiB,
// only those smaller than what was asked for.
test("the fallbacks are the smaller of 1 GiB and 512 MiB", () => {
  assert.deepEqual(fallbacksBelow(4096), [1024, 512]);
  assert.deepEqual(fallbacksBelow(2048), [1024, 512]);
  assert.deepEqual(fallbacksBelow(1024), [512]);
  assert.deepEqual(fallbacksBelow(512), []);
});

// Checks the precedence: a size in the link wins, then the one this
// browser remembers, then the device's default; a size that is not one
// the page offers is ignored wherever it came from.
test("the link wins, then the remembered choice, then the default", () => {
  const device = { pointer: Pointer.FINE };
  assert.equal(
    pickMemory({ linked: 4096, remembered: 1024, device }).mib,
    4096,
  );
  assert.equal(
    pickMemory({ linked: null, remembered: 1024, device }).mib,
    1024,
  );
  assert.equal(
    pickMemory({ linked: null, remembered: null, device }).mib,
    2048,
  );
  assert.equal(pickMemory({ linked: 3000, remembered: 7, device }).mib, 2048);
});

// Checks the labels the Settings control shows for each size.
test("each offered size has a label", () => {
  assert.deepEqual(MEMORY_SIZES_MIB.map(memoryLabel), [
    "512 MiB",
    "1 GiB",
    "2 GiB",
    "4 GiB",
  ]);
});
