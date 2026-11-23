// How many CPUs the unkernel guest boots with.
//
// unkernel runs each guest CPU in a Web Worker on one shared memory, so
// a guest on several CPUs needs a cross-origin isolated page (shared
// memory) and the kernel in a worker, which is how the page runs it
// where it can (unkernel.js); without that the guest gets one CPU. The
// defaults are unkernel's own page's (its web/src/config.ts): 4 in a
// desktop browser, 2 in Firefox and on a touch screen, and never more
// than half the host's threads, since a guest CPU whose thread the host
// deschedules stalls the others that wait for it (docs/unkernel.md,
// "CPUs").
//
// A link can ask for a count (url.js, `cpus`), and the Settings lane can
// choose one, which this browser then remembers.

import { Pointer } from "./memory.js";

// The counts the Settings lane offers.
export const CPU_COUNTS = [1, 2, 4];

// The most CPUs the page suggests, by device and browser.
const SUGGESTED = Object.freeze({ desktop: 4, firefox: 2, touch: 2 });

// The guest CPUs a host thread count leaves room for: half of them.
const THREADS_PER_CPU = 2;

// Where this browser keeps the count chosen in Settings.
const STORAGE_KEY = "trynix.cpus";

// The browser, where it changes the suggestion.
export const Browser = Object.freeze({
  FIREFOX: "firefox",
  OTHER: "other",
});

// This browser's device: pointer, host threads, browser, and whether
// the page has shared memory for CPUs in workers.
export function thisDevice({ pointer }) {
  return {
    pointer,
    threads: globalThis.navigator?.hardwareConcurrency ?? 1,
    browser: /Firefox\//.test(globalThis.navigator?.userAgent ?? "")
      ? Browser.FIREFOX
      : Browser.OTHER,
    shared:
      globalThis.crossOriginIsolated === true &&
      typeof SharedArrayBuffer === "function",
  };
}

// The most CPUs this device can be given: half its threads, and one
// without shared memory.
function mostFor({ threads, shared }) {
  if (!shared) {
    return 1;
  }
  return Math.max(1, Math.floor(threads / THREADS_PER_CPU));
}

// The largest offered count no larger than `limit`.
const offeredUpTo = (limit) =>
  Math.max(...CPU_COUNTS.filter((count) => count <= limit));

// The default count for a device, and why, for the log.
export function defaultCpus(device) {
  if (!device.shared) {
    return { count: 1, why: "the page has no shared memory" };
  }
  const suggested =
    device.pointer === Pointer.COARSE
      ? SUGGESTED.touch
      : device.browser === Browser.FIREFOX
        ? SUGGESTED.firefox
        : SUGGESTED.desktop;
  const count = offeredUpTo(Math.min(suggested, mostFor(device)));
  return {
    count,
    why: `half of ${device.threads} threads, at most ${suggested}`,
  };
}

// A count the page offers and the device can run, or null.
function usable(count, device) {
  return CPU_COUNTS.includes(count) && count <= mostFor(device) ? count : null;
}

// The count to boot with: the link's, then the one this browser
// remembers, then the device's default. Each with why, for the log.
export function pickCpus({ linked, remembered, device }) {
  if (usable(linked, device) !== null) {
    return { count: linked, why: "the link asks for it" };
  }
  if (usable(remembered, device) !== null) {
    return { count: remembered, why: "chosen in Settings" };
  }
  return defaultCpus(device);
}

// The count this browser remembers, or null (memory.js says why storage
// may be refused).
export function rememberedCpus() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return CPU_COUNTS.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberCpus(count) {
  try {
    localStorage.setItem(STORAGE_KEY, String(count));
  } catch {
    // Not remembered; the choice still holds for this page.
  }
}
