// Tests the guest Vulkan switch (site/js/vulkan.js): which link values
// name a position, and what each position hands unkernel's
// createKernel. The options are compared as plain objects, the way the
// page spreads them into createKernel's.
import { test } from "node:test";
import assert from "node:assert/strict";

import { kernelVulkan, Vulkan, vulkanOf } from "../../site/js/vulkan.js";

// The translator's versioned URL, as the page builds it from
// assets.json.
const SHADER_WASM =
  "https://trynix.dev/vendor/unkernel/kwvk-naga.wasm?v=1d8b21f78818";

// Checks that a link's vk value is a position only when it is one the
// switch knows: vk=1 is on, vk=0 is off, and anything else, or none, is
// no choice.
test("a link names guest Vulkan by 1 or 0", () => {
  assert.equal(vulkanOf("1"), Vulkan.ON);
  assert.equal(vulkanOf("0"), Vulkan.OFF);
  assert.equal(vulkanOf("yes"), null);
  assert.equal(vulkanOf(null), null);
});

// Checks that with guest Vulkan off createKernel gets no vk option, so
// the SDK starts no Vulkan host and the guest's driver finds nothing
// to connect to, and that with it on the option names the translator.
test("only vk=1 gives createKernel a vk option", () => {
  assert.deepEqual(kernelVulkan(Vulkan.OFF, SHADER_WASM), {});
  assert.deepEqual(kernelVulkan(Vulkan.ON, SHADER_WASM), {
    vk: { shaderWasm: SHADER_WASM },
  });
});
