// Tests the guest Vulkan switch (site/js/vulkan.js): which link values
// name a position, and what each position hands unkernel's
// createKernel, where the next boot takes its position from, and what
// the Settings lane says about this browser's WebGPU. The options are
// compared as plain objects, the way the page spreads them into
// createKernel's.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Adapter,
  adapterNote,
  kernelVulkan,
  pickVulkan,
  probeAdapter,
  Vulkan,
  vulkanOf,
} from "../../site/js/vulkan.js";

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

// Checks where the next boot's Vulkan switch comes from: the link's
// position, else off, with why, for the page's log.
test("the link's position wins, else off", () => {
  assert.deepEqual(pickVulkan({ linked: null }), {
    mode: Vulkan.OFF,
    why: "the default",
  });
  assert.deepEqual(pickVulkan({ linked: Vulkan.ON }), {
    mode: Vulkan.ON,
    why: "the link asks for it",
  });
  assert.equal(pickVulkan({ linked: Vulkan.OFF }).mode, Vulkan.OFF);
});

// Checks the Settings lane's probe of this browser's WebGPU with stand-in
// navigator.gpu objects: an adapter, null for none, a request that
// throws, and no navigator.gpu at all.
test("the probe says whether WebGPU gives an adapter", async () => {
  const gives = (adapter) => ({ requestAdapter: async () => adapter });
  assert.equal(await probeAdapter(gives({})), Adapter.PRESENT);
  assert.equal(await probeAdapter(gives(null)), Adapter.ABSENT);
  assert.equal(
    await probeAdapter({
      requestAdapter: async () => {
        throw new Error("blocked");
      },
    }),
    Adapter.ABSENT,
  );
  assert.equal(await probeAdapter(undefined), Adapter.ABSENT);
});

// Checks what the status line says for each probe result: without an
// adapter it warns that programs will find no Vulkan device.
test("the status line warns when there is no adapter", () => {
  assert.match(adapterNote(Adapter.PRESENT), /has a WebGPU adapter/);
  assert.match(adapterNote(Adapter.ABSENT), /no Vulkan device/);
});
