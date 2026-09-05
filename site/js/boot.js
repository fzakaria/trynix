// Assembling the emscripten Module and starting the VM. The page hands
// over everything already fetched — the qemu wasm binary, the guest
// files, the parsed closure — so nothing here touches the network; the
// preRun hook materialises it all into MEMFS and QEMU boots from there.
//
// xterm-pty is a vendored UMD script, so openpty is a global; the
// terminal itself comes from terminal.js.
/* global openpty */

import {
  ensureDir,
  linkPrograms,
  Precedence,
  programsOf,
  writeEntries,
} from "./store.js";
import { openTerminal } from "./terminal.js";

// The guest sees: -L /pack (BIOS, kernel, initramfs) and the 9p share
// /share the init script mounts (tag store0, matching nix/guest/init).
const PACK_DIR = "/pack";
const SHARE_DIR = "/share";
const STORE_DIR = `${SHARE_DIR}/nix/store`;

// The farm: one directory of symlinks, one per program in the closure,
// that the guest keeps on PATH for the life of the VM. Adding a package
// later means adding links here, which the guest sees through 9p the
// moment they exist — nothing has to be typed at its shell, and PATH
// never grows past two entries.
const BIN_DIR = `${SHARE_DIR}/bin`;
const GUEST_BIN_DIR = BIN_DIR;
const GUEST_STORE_DIR = "/nix/store";

// The shell fragment the guest init sources. PATH, and deliberately
// nothing else.
//
// An LD_LIBRARY_PATH covering the closure looks helpful and is
// actively harmful here. Every nix binary already names its own
// interpreter in PT_INTERP and its own libraries in DT_RUNPATH, by
// absolute store path — that is what makes two eras able to share a
// machine at all. But the loader searches LD_LIBRARY_PATH *before*
// DT_RUNPATH, so setting it overrides all of that and hands each
// binary whichever copy of a library happens to come first.
//
// Booting ripgrep beside lolcat is where that shows: their closures
// carry glibc 2.42 and 2.30, and the mix died on
// "ld-linux-x86-64.so.2: version `GLIBC_2.35' not found (required by
// glibc-2.42/libc.so.6)" — the older loader, handed the newer libc.
// With nothing set, each binary loads its own and they coexist.
const MANIFEST = `export PATH="${GUEST_BIN_DIR}:$PATH"\n`;

const GUEST_RAM = "512M";
const SNAPSHOT_FILE = `${PACK_DIR}/vm.state`;

// What init prints when it is parked waiting for the share, and how
// long the page will watch for it.
const READY_MARKER = "trynix: waiting for the store";
const MOUNTED_MARKER = "trynix: welcome to the multiverse";

const TRANSCRIPT_LIMIT = 65536;
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

// The store share, as the page maintains it: which paths have been
// written, what programs each one offers, and the farm of links.
function storeShare(FS) {
  const programs = new Map();

  return {
    // Materialise one parsed NAR. A path already there is left alone —
    // a store path is immutable, so there is nothing to update.
    write(basename, entries) {
      if (programs.has(basename)) {
        return;
      }
      writeEntries(FS, `${STORE_DIR}/${basename}`, entries);
      programs.set(basename, programsOf(entries));
    },

    // Offer a written path's programs in the farm.
    link(basename, precedence) {
      linkPrograms(
        FS,
        BIN_DIR,
        `${GUEST_STORE_DIR}/${basename}`,
        programs.get(basename) ?? [],
        precedence,
      );
    },

    programsOf: (basename) => programs.get(basename) ?? [],
  };
}

// Write a batch of paths and link their programs. The roots — what
// the reader asked for — go first and win a collision; everything
// else in the closure only fills names still free, so a dependency
// never shadows a selection. `precedence` says whether a root may
// replace a link an earlier batch made.
//
// The batch is consumed: each path is dropped from the array as it is
// written. Every file exists twice while it is being copied — once as
// the parsed NAR, once in the filesystem — and holding the whole
// closure in both forms at once is what makes a large one fail: the
// tab runs out of room and the next fetch dies with a bare "TypeError:
// Failed to fetch". Releasing as we go keeps the peak at one path
// rather than all of them.
function populate(share, unpacked, roots, precedence) {
  const written = [];
  while (unpacked.length > 0) {
    const { basename, entries } = unpacked.shift();
    share.write(basename, entries);
    written.push(basename);
  }
  for (const basename of roots) {
    share.link(basename, precedence);
  }
  for (const basename of written) {
    if (!roots.includes(basename)) {
      share.link(basename, Precedence.KEEP);
    }
  }
}

// guestFiles: Map of name -> Uint8Array (bzImage, initramfs, BIOS).
// closure: array of { basename, entries } from store.js fetchNar.
// roots: the basenames the reader selected, in selection order.
// engine: { main, locate } — the versioned URL of the emscripten
// module, and a resolver for whatever else it asks for by name.
export async function bootVM({
  wasmBinary,
  guestFiles,
  closure,
  roots,
  terminalElement,
  engine,
  snapshot = null,
  onReady = null,
}) {
  const ui = await openTerminal(terminalElement);
  const { master, slave } = openpty();
  ui.attach(master);

  // The console transcript, tapped before the terminal draws it.
  const console_ = watchConsole(master);

  // Reachable from the browser console: the terminal and the pty pair.
  // Debugging a guest that will not talk is otherwise guesswork.
  window.trynix = { terminal: ui.terminal, master, slave };

  // Resuming a snapshot skips the whole boot — BIOS, kernel, device
  // probe — and lands in a guest already spinning for the store share,
  // which the preRun hook has just filled. Without one, the same
  // arguments cold-boot instead.
  const args =
    snapshot === null
      ? QEMU_ARGS
      : ["-incoming", `file:${SNAPSHOT_FILE}`, ...QEMU_ARGS];

  // Set up in preRun, once the module's filesystem exists.
  let share = null;

  const Module = {
    arguments: args,
    wasmBinary,
    // No `print`/`printErr` here. xterm-pty is linked into this build
    // as a js-library that routes emscripten's output through the pty,
    // and defining either one takes stdout and stderr away from it —
    // the terminal then stays blank for the whole run, guest console
    // included. QEMU's diagnostics arrive in the terminal instead.
    pty: slave,
    // Both of these must be the versioned URLs too: the worker is
    // fetched by emscripten rather than by us, and a stale one is a
    // stale engine.
    mainScriptUrlOrBlob: new URL(engine.main, location.href).href,
    locateFile: (file) => engine.locate(file),
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

        // The store share: the fetched closure, the farm of program
        // links, and the manifest the guest init sources.
        ensureDir(mod.FS, STORE_DIR);
        share = storeShare(mod.FS);
        populate(share, closure, roots, Precedence.KEEP);
        mod.FS.writeFile(`${SHARE_DIR}/manifest`, MANIFEST);
      },
    ],
  };

  const initEmscriptenModule = (await import(`../${engine.main}`)).default;
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
  // Markers are matched against the console stream rather than against
  // the terminal's screen. A screen scrolls, wraps and gets cleared,
  // and reading one ties this to a particular terminal's buffer API;
  // the stream is what the guest actually said.
  //
  // It runs in the background: the VM is running either way, and the
  // caller should say so rather than waiting on a guest that might be
  // slow, or wedged, or built from a different commit. The console
  // stays veiled meanwhile, because what happens in between is
  // plumbing — a kernel booting, or a guest being handed its newline.
  const ready =
    snapshot === null
      ? coldBoot(console_, master, ui.terminal)
      : resume(console_, master, ui.terminal);
  ready.then(() => onReady?.());

  return {
    terminal: ui.terminal,

    // Add store paths to a VM that is already running.
    //
    // The share is an ordinary directory in the emscripten filesystem
    // and 9p's local backend passes every lookup through to it, so
    // writing a new store path after boot is enough for the guest to
    // find it — no remount, no reboot. The farm is what lets the
    // guest's PATH stay as it was: the new roots replace any link of
    // the same name, so the package added last wins.
    add(unpacked, newRoots) {
      populate(share, unpacked, newRoots, Precedence.REPLACE);
    },

    // The programs a written path offers, by basename.
    programsOf: (basename) => share.programsOf(basename),
  };
}

// A cold boot announces itself, takes one newline, and mounts.
async function coldBoot(console_, master, terminal) {
  await console_.waitFor(READY_MARKER);
  sendLine(master);
  await console_.waitFor(MOUNTED_MARKER);
  terminal.clear();
}

// Hand a resumed guest the handshake.
//
// The guest arrives running. The snapshot was taken while the source
// VM ran (tools/make-snapshot.py), the migration stream records that
// runstate, and QEMU starts a restored VM whose source was running
// without being told to — the fork's own migration example resumes
// with -incoming and nothing else. An earlier version of this typed
// `cont` at the monitor first, with a settling delay around each
// keystroke, and spent three seconds of every resume on it.
//
// The guest is parked on init's read, exactly where the snapshot
// caught it, so one newline finishes the handshake. Retries are slow
// on purpose: every extra newline arriving after the read is
// satisfied reaches the shell instead and leaves a bare prompt.
async function resume(console_, master, terminal) {
  const retry = setInterval(() => sendLine(master), RESUME_RETRY_MS);
  sendLine(master);
  await console_.waitFor(MOUNTED_MARKER);
  clearInterval(retry);

  // Drop what the guest said on the way up; the reader starts at a
  // prompt.
  terminal.clear();
}

// Input goes in the way a keystroke does: the line discipline the
// terminal addon feeds when someone types.
function send(master, data) {
  master.ldisc.writeFromLower(data);
}

const sendLine = (master) => send(master, "\n");

// Everything the guest has written, and a way to wait for a line in it.
//
// The transcript is capped: a guest that runs for an hour must not
// grow this without bound, and every marker is answered early in the
// run.
function watchConsole(master) {
  let transcript = "";
  const waiters = [];

  const decoder = new TextDecoder();

  master.onWrite(([data]) => {
    // The pty emits either a string or raw bytes depending on what the
    // guest wrote; concatenating the bytes directly would stringify the
    // array and match no marker ever again.
    transcript +=
      typeof data === "string" ? data : decoder.decode(data, { stream: true });
    if (transcript.length > TRANSCRIPT_LIMIT) {
      transcript = transcript.slice(-TRANSCRIPT_LIMIT);
    }
    for (const waiter of waiters.splice(0)) {
      if (transcript.includes(waiter.marker)) {
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  });

  return {
    // Resolves when the marker has been seen, and gives up quietly
    // after HANDSHAKE_TIMEOUT_MS: a guest this far off script has a
    // worse problem than a missing newline, and unveiling its console
    // is more useful than waiting forever.
    waitFor(marker) {
      if (transcript.includes(marker)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const waiter = { marker, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) {
            waiters.splice(at, 1);
          }
          resolve();
        }, HANDSHAKE_TIMEOUT_MS);
      });
    },
  };
}
