// Guest Vulkan's switch: whether a boot gives the guest kwvk, the
// Vulkan driver whose GPU is the page's WebGPU (unkernel.js, the vk
// option; docs/gui.md, "Vulkan programs").
//
// Off unless a link asks for it with vk=1, or the reader turns it on in
// the Settings lane, which puts the choice in the link. With it on,
// programs that try Vulkan before GL find a device and go further
// before they give up on it: mpv's default output asks for Vulkan on
// Wayland and then on X11, fails both on kwvk's missing
// timelineSemaphore, and starts the X server on the way, which put its
// first frame 3 s later with nothing gained. Off, the guest is as it
// was before guest Vulkan: no vk option reaches createKernel and no
// shell names the driver.

// The switch's positions, as a link writes them (url.js, `vk`).
export const Vulkan = Object.freeze({
  ON: "1",
  OFF: "0",
});

// A position as a link holds it, or null when the value is not one.
export function vulkanOf(value) {
  return Object.values(Vulkan).includes(value) ? value : null;
}

// The position for the next boot: the link's, else off, with why, for
// the log.
export function pickVulkan({ linked }) {
  if (vulkanOf(linked) !== null) {
    return { mode: linked, why: "the link asks for it" };
  }
  return { mode: Vulkan.OFF, why: "the default" };
}

// Whether this browser's WebGPU gives the page an adapter, which kwvk's
// renderer needs.
export const Adapter = Object.freeze({
  PRESENT: "present",
  ABSENT: "absent",
});

// Ask `gpu`, the browser's navigator.gpu or undefined, for an adapter.
// A browser with no WebGPU, one that gives none, and a request that
// throws all leave the renderer without one.
export async function probeAdapter(gpu) {
  if (gpu === undefined) {
    return Adapter.ABSENT;
  }
  try {
    return (await gpu.requestAdapter()) === null
      ? Adapter.ABSENT
      : Adapter.PRESENT;
  } catch {
    return Adapter.ABSENT;
  }
}

// What the Settings lane says about the probe's answer.
const ADAPTER_NOTES = {
  [Adapter.PRESENT]: "This browser has a WebGPU adapter for Vulkan programs.",
  [Adapter.ABSENT]:
    "This browser gives WebGPU no adapter, so programs will find no Vulkan device.",
};

export const adapterNote = (adapter) => ADAPTER_NOTES[adapter];

// What createKernel gets for the switch at `vulkan`: nothing when off,
// so the SDK starts no Vulkan host; when on, the vk option naming the
// shader translator's wasm by `shaderWasm`, its versioned URL. The SDK
// asks for an adapter and fetches the renderer and the translator on
// the guest's first VkInstance and never before; with no adapter the
// load fails, the SDK logs why, and the driver answers the program
// VK_ERROR_INCOMPATIBLE_DRIVER.
export function kernelVulkan(vulkan, shaderWasm) {
  if (vulkan !== Vulkan.ON) {
    return {};
  }
  return { vk: { shaderWasm } };
}
