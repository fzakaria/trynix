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
// A link can ask for any count up to the kernel's 16 (url.js, `cpus`),
// and the Settings lane can choose 1, 2, 4, 8 or 16, which this browser
// then remembers. Either is held to the host's threads.

import { Pointer } from "./memory.js";

// The most CPUs unkernel's SMP kernel boots (NR_CPUS in its
// kw_smp.config).
export const MAX_CPUS = 16;

// The counts the Settings lane offers, where the host has the threads.
export const CPU_COUNTS = [1, 2, 4, 8, 16];

// The most CPUs the page suggests, by device and browser.
const SUGGESTED = Object.freeze({ desktop: 4, firefox: 2, touch: 2 });

// The default leaves half the host's threads to the browser.
const THREADS_PER_DEFAULT_CPU = 2;

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

// The most CPUs this device can be given: one per host thread, up to
// the kernel's limit, and one without shared memory.
function mostFor({ threads, shared }) {
  if (!shared) {
    return 1;
  }
  return threadsUpToKernel(threads);
}

// A host's threads, at least one and at most the kernel's limit.
const threadsUpToKernel = (threads) => Math.max(1, Math.min(MAX_CPUS, threads));

// The counts the Settings lane shows this device: those it has the
// threads for. A page without shared memory still shows them, disabled
// above one (app.js), so the reader sees what isolation would give.
export function offeredCpus({ threads }) {
  const most = threadsUpToKernel(threads);
  return CPU_COUNTS.filter((count) => count <= most);
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
  const half = Math.max(
    1,
    Math.floor(device.threads / THREADS_PER_DEFAULT_CPU),
  );
  const count = offeredUpTo(Math.min(suggested, half));
  return {
    count,
    why: `half of ${device.threads} threads, at most ${suggested}`,
  };
}

// Whether a link's count is one the kernel can boot: a whole number
// from 1 to MAX_CPUS.
const bootable = (count) =>
  Number.isInteger(count) && count >= 1 && count <= MAX_CPUS;

// The count to boot with: the link's, then the one this browser
// remembers, then the device's default. Each with why, for the log and
// for the Settings lane when the link asked for more than it gets.
//
// A link asking for more CPUs than the host has threads gets one per
// thread rather than the default: the reader asked for many. A
// remembered count the host cannot run is this browser's choice from
// another day, and gives way to the default.
export function pickCpus({ linked, remembered, device }) {
  if (!device.shared) {
    return defaultCpus(device);
  }
  const most = mostFor(device);
  if (bootable(linked)) {
    if (linked > most) {
      return {
        count: most,
        why: `the link asks for ${linked}, and this browser has ${device.threads} threads`,
      };
    }
    return { count: linked, why: "the link asks for it" };
  }
  if (CPU_COUNTS.includes(remembered) && remembered <= most) {
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
