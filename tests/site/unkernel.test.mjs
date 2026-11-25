// Tests the shell fragment every shell in the unkernel guest sources
// (site/js/unkernel.js, manifest, from gui.js's sessionEnv): that it
// names kwvk's Vulkan driver to the Vulkan loader and keeps Mesa from
// running GL through zink.
// The fragment is written as the page writes it, then sourced by a real
// sh, whose environment is read back, so a quoting slip fails here as
// it would in the guest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// unkernel.js imports the terminal, which asks matchMedia about the
// screen as it loads. Node has none; this one says it is no touch
// screen.
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });
const { manifest } = await import("../../site/js/unkernel.js");

// kwvk's manifest in the guest, in the kw layer of unkernel's base
// system, and what LIBGL_KOPPER_DISABLE is set to.
const KWVK_ICD = "/kw/layer/usr/share/vulkan/icd.d/kw_icd.json";
const KOPPER_DISABLED = "1";

// The shells the page writes the fragment for: a guest with no
// network, and one with a network, whose shells are also pointed at the
// CA certificates.
const SHELLS = {
  offline: { caBundle: null },
  network: { caBundle: "/share/certs/ca-bundle.crt" },
};

// The values of `names` in a sh that sourced `fragment`, one a line.
function sourced(fragment, names) {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  try {
    const file = join(dir, "manifest");
    writeFileSync(file, fragment);
    const print = names.map((name) => `printf '%s\\n' "$${name}"`).join("; ");
    const result = spawnSync("sh", ["-c", `. "$1"; ${print}`, "sh", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\n").slice(0, names.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Checks that every shell, with a network or without, gets
// VK_ADD_DRIVER_FILES naming kwvk's manifest and LIBGL_KOPPER_DISABLE,
// by sourcing each fragment in sh and reading both variables back.
test("every shell names kwvk to the Vulkan loader and keeps zink off", () => {
  for (const [shell, options] of Object.entries(SHELLS)) {
    const [driverFiles, kopper] = sourced(manifest(options), [
      "VK_ADD_DRIVER_FILES",
      "LIBGL_KOPPER_DISABLE",
    ]);
    assert.equal(driverFiles, KWVK_ICD, shell);
    assert.equal(kopper, KOPPER_DISABLED, shell);
  }
});
