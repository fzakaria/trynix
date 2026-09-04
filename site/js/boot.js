// Assembling the emscripten Module and starting the VM. The page hands
// over everything already fetched — the qemu wasm binary, the guest
// files, the parsed closure — so nothing here touches the network; the
// preRun hook materialises it all into MEMFS and QEMU boots from there.
//
// xterm and xterm-pty are vendored UMD scripts: Terminal and openpty
// are globals.
/* global Terminal, openpty */

import { ensureDir, writeEntries } from "./store.js";

// Where the qemu artifacts live relative to the page; the worker
// re-imports the main script by absolute URL.
const QEMU_DIR = "qemu";

// The guest sees: -L /pack (BIOS, kernel, initramfs) and the 9p share
// /share the init script mounts (tag store0, matching nix/guest/init).
const PACK_DIR = "/pack";
const SHARE_DIR = "/share";
const STORE_DIR = `${SHARE_DIR}/nix/store`;

const GUEST_RAM = "512M";
const QEMU_ARGS = [
  "-nographic",
  "-m",
  GUEST_RAM,
  "-accel",
  "tcg,tb-size=500",
  "-L",
  `${PACK_DIR}/`,
  "-nic",
  "none",
  "-kernel",
  `${PACK_DIR}/bzImage`,
  "-initrd",
  `${PACK_DIR}/initramfs.cpio.gz`,
  "-virtfs",
  `local,path=${SHARE_DIR},mount_tag=store0,security_model=none,id=store0`,
  "-append",
  "console=ttyS0 rdinit=/init loglevel=4",
];

// guestFiles: Map of name -> Uint8Array (bzImage, initramfs, BIOS).
// closure: array of { basename, entries } from store.js fetchNar.
// manifest: shell fragment the guest init sources (PATH and friends).
export async function bootVM({
  wasmBinary,
  guestFiles,
  closure,
  manifest,
  terminalElement,
}) {
  const xterm = new Terminal();
  xterm.open(terminalElement);
  const { master, slave } = openpty();
  xterm.loadAddon(master);

  const Module = {
    arguments: QEMU_ARGS,
    wasmBinary,
    pty: slave,
    mainScriptUrlOrBlob: new URL(`${QEMU_DIR}/out.js`, location.href).href,
    locateFile: (file) => `${QEMU_DIR}/${file}`,
    preRun: [
      (mod) => {
        // The -L directory: BIOS blobs, kernel, initramfs.
        ensureDir(mod.FS, PACK_DIR);
        for (const [name, bytes] of guestFiles) {
          mod.FS.writeFile(`${PACK_DIR}/${name}`, bytes);
        }

        // The store share: the fetched closure plus the manifest the
        // guest init sources.
        ensureDir(mod.FS, STORE_DIR);
        for (const { basename, entries } of closure) {
          writeEntries(mod.FS, `${STORE_DIR}/${basename}`, entries);
        }
        mod.FS.writeFile(`${SHARE_DIR}/manifest`, manifest);
      },
    ],
  };

  const initEmscriptenModule = (await import(`../${QEMU_DIR}/out.js`)).default;
  await initEmscriptenModule(Module);

  // The xterm-pty poll workaround every qemu-wasm example carries: an
  // unreadable pty must not park QEMU in a blocking poll.
  const oldPoll = Module.TTY.stream_ops.poll;
  const pty = Module.pty;
  Module.TTY.stream_ops.poll = function (stream, timeout) {
    if (!pty.readable) {
      return (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
    }
    return oldPoll.call(stream, timeout);
  };

  return { xterm };
}
