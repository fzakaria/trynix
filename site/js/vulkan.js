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

// What this browser's WebGPU gives the page, which kwvk's renderer
// draws with: a GPU, a software adapter such as SwiftShader, which works
// but is slow, or nothing.
export const Adapter = Object.freeze({
  HARDWARE: "hardware",
  SOFTWARE: "software",
  ABSENT: "absent",
});

// What the probe says when there is no adapter.
const NO_ADAPTER = Object.freeze({ kind: Adapter.ABSENT, name: "" });

// Ask `gpu`, the browser's navigator.gpu or undefined, for an adapter,
// and return { kind, name }: an Adapter and the adapter's vendor and
// architecture as GPUAdapterInfo gives them. A browser with no WebGPU,
// one that gives none, and a request that throws all leave the renderer
// without one. Browsers mark a fallback adapter in its info now and on
// the adapter itself before.
export async function probeAdapter(gpu) {
  if (gpu === undefined) {
    return NO_ADAPTER;
  }

  let adapter;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    return NO_ADAPTER;
  }
  if (adapter === null) {
    return NO_ADAPTER;
  }

  const info = adapter.info ?? {};
  const fallback = info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? false;
  const name = [info.vendor, info.architecture].filter(Boolean).join(" ");
  return { kind: fallback ? Adapter.SOFTWARE : Adapter.HARDWARE, name };
}

// How the status line colours its note on the adapter: good for a GPU,
// a warning for a software adapter, bad for none. The values are the
// note's data-tone in the page, which style.css colours.
export const Tone = Object.freeze({
  GOOD: "good",
  WARN: "warn",
  BAD: "bad",
});

// A page that lists what this browser's WebGPU gives a page, from the
// WebGPU group's own repository (github.com/webgpu/webgpureport), for a
// reader whose adapter is missing or in software.
export const WEBGPU_REPORT = "https://webgpureport.org/";

// What the Settings lane says about the probe's answer: { text, tone,
// link }, the link null when the text, naming a GPU, says it all.
export function adapterNote({ kind, name }) {
  switch (kind) {
    case Adapter.HARDWARE:
      return { text: `WebGPU adapter: ${name}.`, tone: Tone.GOOD, link: null };
    case Adapter.SOFTWARE:
      return {
        text: `WebGPU adapter: ${name}, in software, so Vulkan programs would be slow.`,
        tone: Tone.WARN,
        link: WEBGPU_REPORT,
      };
    default:
      return {
        text: "This browser has no WebGPU adapter, so programs would find no Vulkan device.",
        tone: Tone.BAD,
        link: WEBGPU_REPORT,
      };
  }
}

// Whether the reader can choose On: with no adapter, On would give
// programs no Vulkan device, so the lane offers only Off. A link that
// asks for Vulkan still boots with it, and its programs find no device.
export const canChooseOn = (kind) => kind !== Adapter.ABSENT;

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
