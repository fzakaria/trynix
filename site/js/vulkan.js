// Guest Vulkan's switch: whether a boot gives the guest kwvk, the
// Vulkan driver whose GPU is the page's WebGPU (unkernel.js, the vk
// option; docs/gui.md, "Vulkan programs").
//
// Off unless a link asks for it with vk=1. With it on, programs that
// try Vulkan before GL find a device and go further before they give
// up on it: mpv's default output asks for Vulkan on Wayland and then on
// X11, fails both on kwvk's missing timelineSemaphore, and starts the X
// server on the way, which put its first frame 3 s later with nothing
// gained. Off, the guest is as it was before guest Vulkan: no vk option
// reaches createKernel and no shell names the driver.

// The switch's positions, as a link writes them (url.js, `vk`).
export const Vulkan = Object.freeze({
  ON: "1",
  OFF: "0",
});

// A position as a link holds it, or null when the value is not one.
export function vulkanOf(value) {
  return Object.values(Vulkan).includes(value) ? value : null;
}

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
