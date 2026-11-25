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
  canChooseOn,
  kernelVulkan,
  pickVulkan,
  probeAdapter,
  Tone,
  Vulkan,
  vulkanOf,
  WEBGPU_REPORT,
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
// navigator.gpu objects: a hardware adapter named by its vendor and
// architecture, SwiftShader's fallback adapter in both the current and
// the older place browsers mark it, null for none, a request that
// throws, and no navigator.gpu at all.
test("the probe names the adapter and says whether it is software", async () => {
  const gives = (adapter) => ({ requestAdapter: async () => adapter });

  assert.deepEqual(
    await probeAdapter(
      gives({ info: { vendor: "amd", architecture: "rdna-3" } }),
    ),
    { kind: Adapter.HARDWARE, name: "amd rdna-3" },
  );
  assert.deepEqual(
    await probeAdapter(
      gives({
        info: {
          vendor: "google",
          architecture: "swiftshader",
          isFallbackAdapter: true,
        },
      }),
    ),
    { kind: Adapter.SOFTWARE, name: "google swiftshader" },
  );
  assert.deepEqual(
    await probeAdapter(
      gives({ isFallbackAdapter: true, info: { vendor: "google" } }),
    ),
    { kind: Adapter.SOFTWARE, name: "google" },
  );

  const none = { kind: Adapter.ABSENT, name: "" };
  assert.deepEqual(await probeAdapter(gives(null)), none);
  assert.deepEqual(
    await probeAdapter({
      requestAdapter: async () => {
        throw new Error("blocked");
      },
    }),
    none,
  );
  assert.deepEqual(await probeAdapter(undefined), none);
});

// Checks what the status line says for each kind of adapter: a
// hardware adapter by name alone, in the good tone; a software one by
// name with a warning that it is slow; none with the warning that
// programs would find no Vulkan device. The last two link to a page
// that reports what this browser's WebGPU has, and the first needs no
// link because the line already names the adapter.
test("the status line names the adapter and warns about software", () => {
  assert.deepEqual(
    adapterNote({ kind: Adapter.HARDWARE, name: "amd rdna-3" }),
    { text: "WebGPU adapter: amd rdna-3.", tone: Tone.GOOD, link: null },
  );

  const software = adapterNote({
    kind: Adapter.SOFTWARE,
    name: "google swiftshader",
  });
  assert.match(software.text, /google swiftshader.*slow/);
  assert.equal(software.tone, Tone.WARN);
  assert.equal(software.link, WEBGPU_REPORT);

  const absent = adapterNote({ kind: Adapter.ABSENT, name: "" });
  assert.match(absent.text, /no Vulkan device/);
  assert.equal(absent.tone, Tone.BAD);
  assert.equal(absent.link, WEBGPU_REPORT);
});

// Checks which adapters let the reader choose On: any adapter, hardware
// or software, and not the lack of one.
test("On can be chosen only with an adapter", () => {
  assert.equal(canChooseOn(Adapter.HARDWARE), true);
  assert.equal(canChooseOn(Adapter.SOFTWARE), true);
  assert.equal(canChooseOn(Adapter.ABSENT), false);
});
