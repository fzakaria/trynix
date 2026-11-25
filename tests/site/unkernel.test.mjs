// Tests the shell fragment every shell in the unkernel guest sources
// (site/js/unkernel.js, manifest, from gui.js's sessionEnv): that with
// guest Vulkan on (vk=1, site/js/vulkan.js) it names the site's kwvk,
// the Vulkan driver built with trynix's patches, to the Vulkan loader as
// its one driver, or the base system's kwvk when the site publishes
// none, and keeps Mesa from running GL through zink; and that without
// it the shell has none of those variables, as before there was guest
// Vulkan. The fragment is written as the page writes it, then sourced
// by a real sh with nothing else in its environment, whose variables
// are read back, so a quoting slip fails here as it would in the guest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// unkernel.js imports the terminal, which asks matchMedia about the
// screen as it loads. Node has none; this one says it is no touch
// screen.
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });
const { envLink, hostsFile, manifest } =
  await import("../../site/js/unkernel.js");
const { Vulkan } = await import("../../site/js/vulkan.js");

// The site's kwvk as the page names it to the guest (its store path's
// basename), its manifest in the guest's store, the base system's
// manifest in the kw layer, and what LIBGL_KOPPER_DISABLE is set to.
const SITE_DRIVER =
  "0123456789abcdfghijklmnpqrsvwxyz-kwvk-0.2.0-261124-75694e2";
const SITE_ICD = `/nix/store/${SITE_DRIVER}/share/vulkan/icd.d/kw_icd.json`;
const BASE_ICD = "/kw/layer/usr/share/vulkan/icd.d/kw_icd.json";
const KOPPER_DISABLED = "1";

// What the sh prints for a variable it does not have.
const UNSET = "(unset)";

// The variables guest Vulkan sets, and the one it used to set, which
// added kwvk to the drivers the loader finds instead of naming the one
// driver it loads.
const VULKAN_VARIABLES = [
  "VK_DRIVER_FILES",
  "VK_ADD_DRIVER_FILES",
  "LIBGL_KOPPER_DISABLE",
];

// The shells the page writes the fragment for: a guest with no
// network, and one with a network, whose shells are also pointed at the
// CA certificates.
const SHELLS = {
  offline: { caBundle: null },
  network: { caBundle: "/share/certs/ca-bundle.crt" },
};

// The values of `names` in a sh that sourced `fragment`, one a line,
// UNSET for a name the sh does not have. The sh gets PATH alone, so
// nothing reaches it from the environment the tests run in.
function sourced(fragment, names) {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  try {
    const file = join(dir, "manifest");
    writeFileSync(file, fragment);
    const print = names
      .map((name) => `printf '%s\\n' "\${${name}-${UNSET}}"`)
      .join("; ");
    const result = spawnSync("sh", ["-c", `. "$1"; ${print}`, "sh", file], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\n").slice(0, names.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Checks that with guest Vulkan on every shell, with a network or
// without, gets VK_DRIVER_FILES naming the site's kwvk in the store as
// the loader's one driver, no VK_ADD_DRIVER_FILES, and
// LIBGL_KOPPER_DISABLE, by sourcing each fragment in sh and reading the
// variables back.
test("with vk=1 every shell names the site's kwvk and keeps zink off", () => {
  for (const [shell, options] of Object.entries(SHELLS)) {
    const values = sourced(
      manifest({ ...options, vulkan: Vulkan.ON, vulkanDriver: SITE_DRIVER }),
      VULKAN_VARIABLES,
    );
    assert.deepEqual(values, [SITE_ICD, UNSET, KOPPER_DISABLED], shell);
  }
});

// Checks that with guest Vulkan on and no driver from the site, as on a
// site whose manifest could not be read, every shell names the base
// system's kwvk the same way, so Vulkan programs still find a device.
test("with vk=1 and no site driver every shell names the base kwvk", () => {
  for (const [shell, options] of Object.entries(SHELLS)) {
    const values = sourced(
      manifest({ ...options, vulkan: Vulkan.ON, vulkanDriver: null }),
      VULKAN_VARIABLES,
    );
    assert.deepEqual(values, [BASE_ICD, UNSET, KOPPER_DISABLED], shell);
  }
});

// Checks that with guest Vulkan off, the default, no shell has any of
// the variables, the site's driver published or not, by sourcing each
// fragment in sh and asking for them.
test("without vk=1 no shell has the Vulkan variables", () => {
  for (const [shell, options] of Object.entries(SHELLS)) {
    for (const vulkanDriver of [SITE_DRIVER, null]) {
      const values = sourced(
        manifest({ ...options, vulkan: Vulkan.OFF, vulkanDriver }),
        VULKAN_VARIABLES,
      );
      assert.deepEqual(values, [UNSET, UNSET, UNSET], shell);
    }
  }
});

// Checks that the boot puts env where scripts name it in their #! line,
// /usr/bin/env, linked to the base system's /bin/env, and keeps an env
// a base system has there already, by running the command in sh against
// a directory standing in for the guest's root. VSCodium's launcher
// starts "#!/usr/bin/env sh" and failed with "bad interpreter".
test("the boot links env where scripts look for it", () => {
  const root = mkdtempSync(join(tmpdir(), "root-"));
  try {
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    const run = () =>
      spawnSync("sh", ["-c", envLink(root)], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(join(root, "usr", "bin", "env")), "/bin/env");

    // A second boot's command, or a base system with its own env,
    // leaves what is there.
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(join(root, "usr", "bin", "env")), "/bin/env");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Checks that the boot gives the guest an /etc/hosts that names
// localhost as 127.0.0.1, and keeps a hosts file a base system has
// already, by running the command in sh against a directory standing in
// for the guest's root. Without the file a nixpkgs program asks DNS for
// localhost, and the page's DNS answers every name with a stand-in
// address: cloudflared could not bind its metrics listener.
test("the boot names localhost in /etc/hosts", () => {
  const root = mkdtempSync(join(tmpdir(), "root-"));
  try {
    mkdirSync(join(root, "etc"));
    const hosts = join(root, "etc", "hosts");
    const run = () =>
      spawnSync("sh", ["-c", hostsFile(root)], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(hosts, "utf8"), "127.0.0.1\tlocalhost\n");

    // A base system with its own hosts file keeps it.
    const own = "127.0.0.1\tlocalhost\n127.0.1.1\tunkernel\n";
    writeFileSync(hosts, own);
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(hosts, "utf8"), own);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
