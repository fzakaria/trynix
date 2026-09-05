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
const SNAPSHOT_FILE = `${PACK_DIR}/vm.state`;

// What init prints when it is parked waiting for the share, and how
// long the page will watch for it.
const READY_MARKER = "trynix: waiting for the store";
const MOUNTED_MARKER = "trynix: welcome to the multiverse";
const HANDSHAKE_POLL_MS = 500;

// Ctrl-A c toggles the -nographic console between the guest and QEMU's
// monitor, and each step needs a moment to land.
const MONITOR_TOGGLE = "\x01c";
const MONITOR_SETTLE_MS = 800;
const RESUME_RETRY_MS = 4000;
const HANDSHAKE_TIMEOUT_MS = 180000;

// Device for device, these must match what took the snapshot
// (tools/make-snapshot.py) or the resume rejects the stream.
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
  snapshot = null,
}) {
  const xterm = new Terminal();
  xterm.open(terminalElement);
  const { master, slave } = openpty();
  xterm.loadAddon(master);

  // Reachable from the console: the terminal, the pty pair, and (below)
  // whatever QEMU wrote to stderr. Debugging a guest that will not talk
  // is otherwise guesswork.
  window.trynix = { xterm, master, slave };

  // Resuming a snapshot skips the whole boot — BIOS, kernel, device
  // probe — and lands in a guest already spinning for the store share,
  // which the preRun hook has just filled. Without one, the same
  // arguments cold-boot instead.
  const args =
    snapshot === null
      ? QEMU_ARGS
      : ["-incoming", `file:${SNAPSHOT_FILE}`, ...QEMU_ARGS];

  const Module = {
    arguments: args,
    wasmBinary,
    // No `print`/`printErr` here. xterm-pty is linked into this build
    // as a js-library that routes emscripten's output through the pty,
    // and defining either one takes stdout and stderr away from it —
    // the terminal then stays blank for the whole run, guest console
    // included. QEMU's diagnostics arrive in the terminal instead.
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
        if (snapshot !== null) {
          mod.FS.writeFile(SNAPSHOT_FILE, snapshot);
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

  // The handshake: init parks on a read until the page says the share
  // is populated (nix/guest/init). Mounting only after this is what
  // makes the snapshot possible to take at all, since QEMU refuses to
  // migrate a VM with a virtfs export mounted.
  //
  // A resumed guest is already parked on that read, so the newline can
  // go immediately. A cold boot has to reach it first, and the marker
  // it prints on the way is the signal — one that a resumed guest never
  // shows, because it was printed into the snapshotting VM's console
  // long before this page existed.
  // The handshake runs in the background: the VM is running either way,
  // and the caller should say so rather than waiting on a guest that
  // might be slow, or wedged, or built from a different commit.
  if (snapshot === null) {
    // Cold boot: the marker is on its way, and one newline answers it.
    watchFor(xterm, READY_MARKER, { send: "once" });
  } else {
    resume(xterm);
  }

  return { xterm };
}

// Bring a resumed guest back to life and hand it the handshake.
//
// A VM restored from a migration stream arrives stopped, and a stopped
// VM answers nothing at all — no console, no keystrokes. -nographic
// muxes QEMU's monitor onto this same console, so `cont` is typed at
// the monitor, with Ctrl-A c toggling there and back.
//
// The order matters: the monitor conversation has to finish before the
// guest is offered a newline, or the newlines land in the monitor and
// print a prompt each. The screen is wiped afterwards so the reader
// sees a console, not the plumbing.
async function resume(xterm) {
  await delay(MONITOR_SETTLE_MS);
  xterm.paste(MONITOR_TOGGLE);
  await delay(MONITOR_SETTLE_MS);
  xterm.paste("cont\n");
  await delay(MONITOR_SETTLE_MS);
  xterm.paste(MONITOR_TOGGLE);
  await delay(MONITOR_SETTLE_MS);
  xterm.clear();

  // The guest is parked on init's read, exactly where the snapshot
  // caught it, so one newline finishes the handshake. Retries are slow
  // on purpose: every extra newline that arrives after the read is
  // satisfied reaches the shell instead and leaves a bare prompt.
  await watchFor(xterm, MOUNTED_MARKER, {
    send: "repeatedly",
    sendEveryMs: RESUME_RETRY_MS,
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Type a newline into the guest. xterm.js exposes no public `input`,
// but `paste` raises the same onData the master addon listens on, which
// is what carries terminal input into the pty.
function sendLine(xterm) {
  xterm.paste("\n");
}

// Watch the terminal until `marker` shows up.
//
// "once" answers the marker with a newline the moment it appears — the
// cold-boot case, where the marker is the guest asking. "repeatedly"
// offers a newline on every tick until the marker appears — the resume
// case, where the marker is the guest confirming it heard one, and a
// newline sent too early is simply lost.
//
// Both give up quietly after HANDSHAKE_TIMEOUT_MS: a guest this far off
// script has a worse problem than a missing newline, and its console is
// on screen for the reader to look at.
function watchFor(xterm, marker, { send, sendEveryMs = 0 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let lastSend = 0;
    const timer = setInterval(() => {
      const buffer = xterm.buffer.active;
      let text = "";
      for (let i = 0; i < buffer.length; i += 1) {
        text += buffer.getLine(i)?.translateToString(true) ?? "";
      }

      if (text.includes(marker)) {
        clearInterval(timer);
        if (send === "once") {
          sendLine(xterm);
        }
        resolve();
        return;
      }

      if (send === "repeatedly" && Date.now() - lastSend >= sendEveryMs) {
        lastSend = Date.now();
        sendLine(xterm);
      }
      if (Date.now() - started > HANDSHAKE_TIMEOUT_MS) {
        clearInterval(timer);
        resolve();
      }
    }, HANDSHAKE_POLL_MS);
  });
}
