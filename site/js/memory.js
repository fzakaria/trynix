// How much memory the unkernel guest asks for.
//
// unkernel allocates the guest's memory as the guest touches pages, so a
// size the guest never fills costs the host little: what a large guest
// pays is address space, which a phone may not have to give. The page
// asks for 2 GiB on a computer and 512 MiB on a touch screen, less where
// the browser reports a device with little memory, and the SDK falls
// back to the smaller sizes here when an allocation fails
// (docs/unkernel.md, "Memory").
//
// A link can ask for a size (url.js, `mem`), and a size chosen in the
// Settings lane goes into the link. The qemu engine's guest
// is a fixed machine (nix/guest/machine.json) and is not sized here.

// The sizes the Settings lane offers, in MiB, smallest first.
export const MEMORY_SIZES_MIB = [512, 1024, 2048, 4096];

// The sizes tried, in order, when the asked-for one cannot be allocated.
const FALLBACK_SIZES_MIB = [1024, 512];

// The default on a computer and on a touch screen.
const DESKTOP_MIB = 2048;
const PHONE_MIB = 512;

// navigator.deviceMemory is coarse (0.25 to 8, in GB) and capped at 8.
// At 4 GB or less the guest gets a quarter of it, at most the desktop
// default: a guest that fills its memory should not take the rest of
// the browser with it.
const DEVICE_SHARE = 4;
const MIB_PER_GB = 1024;
const LOW_DEVICE_GB = 4;

const MIB_PER_GIB = 1024;

// The kind of pointer the device has: a touch screen's is coarse. The
// same test decides whether the page shows its phone key bar (style.css).
export const Pointer = Object.freeze({
  FINE: "fine",
  COARSE: "coarse",
});

// The pointer and reported memory of this browser's device.
export function thisDevice() {
  const coarse =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return {
    pointer: coarse ? Pointer.COARSE : Pointer.FINE,
    deviceMemoryGb: globalThis.navigator?.deviceMemory ?? null,
  };
}

// The default size for a device, and why, for the log.
export function defaultMemory({ pointer, deviceMemoryGb = null }) {
  if (pointer === Pointer.COARSE) {
    return { mib: PHONE_MIB, why: "a touch screen" };
  }
  if (deviceMemoryGb !== null && deviceMemoryGb <= LOW_DEVICE_GB) {
    const share = (deviceMemoryGb * MIB_PER_GB) / DEVICE_SHARE;
    const mib = Math.max(
      ...MEMORY_SIZES_MIB.filter((size) => size <= share),
      PHONE_MIB,
    );
    return { mib, why: `the device reports ${deviceMemoryGb} GB` };
  }
  return { mib: DESKTOP_MIB, why: "the default" };
}

// The smaller sizes to try after `mib` cannot be allocated.
export const fallbacksBelow = (mib) =>
  FALLBACK_SIZES_MIB.filter((size) => size < mib);

// A size the page offers, or null.
const offered = (mib) => (MEMORY_SIZES_MIB.includes(mib) ? mib : null);

// The size to boot with: the link's, else the device's default. Each
// with why, for the log.
export function pickMemory({ linked, device }) {
  if (offered(linked) !== null) {
    return { mib: linked, why: "the link asks for it" };
  }
  return defaultMemory(device);
}

// How the Settings control names a size.
export const memoryLabel = (mib) =>
  mib < MIB_PER_GIB ? `${mib} MiB` : `${mib / MIB_PER_GIB} GiB`;
