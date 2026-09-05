// Assembling the emscripten Module and starting the VM.
//
// The VM is started in two steps, so the closure can stream into the
// store share while the engine is still being compiled:
//
//   startVM   instantiates the engine — the guest image and the
//             snapshot go into MEMFS, QEMU's main() is held back with
//             a run dependency, and the share is open for writing;
//   vm.run    links the programs, releases QEMU, and hands the guest
//             its handshake.
//
// Between the two the page writes each NAR as it arrives, and nothing
// is ever held for the whole closure at once.
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
import { log } from "./log.js";

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
//
// The console is a serial line, and a serial tty has no window size
// until something sets one: TIOCGWINSZ answers 0x0, and a full-screen
// program (btop: "Failed to get size of terminal!") refuses to start.
// The browser's resize events reach the line discipline and stop
// there; nothing carries them into a 16550. `resize` is how a serial
// console has always learned its size — it parks the cursor in the
// far corner, asks the terminal where that landed, and sets the tty
// from the answer — and ghostty answers it. The handshake's spare
// newlines (see resume) are still queued on the tty at this point and
// would be read as that answer, so they are drained first: with
// canonical mode off and a 0.2 s read timeout, `cat` takes what is
// queued and gets end-of-file when nothing more comes. (busybox's
// `read -t` takes whole seconds only, and a whole second is too long
// to wait at every boot.)
//
// TERM is xterm-256color rather than ghostty's own xterm-ghostty: the
// guest's programs look the name up in the terminfo their own ncurses
// carries, and only very recent ncurses knows ghostty's, while every
// era knows xterm-256color — which is the fallback ghostty's docs give
// for a machine without its terminfo. LANG=C.UTF-8 is built into glibc
// since 2.35, so programs that insist on a UTF-8 locale (btop) get
// one; a closure old enough to lack it falls back to C, and perl says
// so.
const MANIFEST = [
  `export PATH="${GUEST_BIN_DIR}:$PATH"`,
  "export TERM=xterm-256color",
  "export LANG=C.UTF-8",
  "stty -icanon min 0 time 2; cat >/dev/null; stty icanon min 1 time 0",
  // stdout only: the cursor query goes out on stderr.
  "resize >/dev/null",
  "",
].join("\n");

const SNAPSHOT_FILE = `${PACK_DIR}/vm.state`;

// What holds QEMU's main() back until the share is complete.
const STORE_DEPENDENCY = "trynix-store";

// What init prints when it is parked waiting for the share, and how
// long the page will watch for it.
const READY_MARKER = "trynix: waiting for the store";
const MOUNTED_MARKER = "trynix: welcome to the multiverse";

const TRANSCRIPT_LIMIT = 65536;
// How often the resuming guest is offered its newline.
const RESUME_POLL_MS = 300;

// Ctrl-L: the shell's line editor clears its screen and draws the
// prompt again. Clearing the terminal from this side wipes the prompt
// with everything else, and a reader facing an empty console assumes
// it is still loading.
const REDRAW_PROMPT = "\x0c";
const HANDSHAKE_TIMEOUT_MS = 180000;

// MEMFS takes the buffer it is handed rather than copying it: the
// bytes then exist once, in the filesystem, instead of once there and
// once in whatever fetched them.
const OWN = { canOwn: true };

// QEMU's arguments, from the machine definition the guest image
// carries (nix/guest/machine.json). The snapshot tool starts QEMU from
// the same file, which is what keeps the two ends of the migration
// identical, device for device.
function qemuArgs(machine) {
  const values = { pack: PACK_DIR, share: SHARE_DIR, ram: machine.ram };
  return machine.args.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (_, name) => values[name]),
  );
}

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

    // Link a batch: the roots — what the reader asked for — first, so
    // they win a collision, then the rest only where a name is still
    // free, so a dependency never shadows a selection. `precedence`
    // says whether a root may replace a link an earlier batch made.
    linkAll(basenames, roots, precedence) {
      for (const basename of roots) {
        this.link(basename, precedence);
      }
      for (const basename of basenames) {
        if (!roots.includes(basename)) {
          this.link(basename, Precedence.KEEP);
        }
      }
    },

    programsOf: (basename) => programs.get(basename) ?? [],
    written: () => [...programs.keys()],
  };
}

// guestFiles: Map of name -> Uint8Array (bzImage, initramfs, BIOS).
// machine: the parsed machine definition (nix/guest/machine.json).
// snapshot: the migration stream, or null to cold-boot.
// engine: { main, locate } — the versioned URL of the emscripten
// module, and a resolver for whatever else it asks for by name. The
// wasm itself is not fetched here: the module streams it from the
// URL, which lets the browser compile while downloading and keep the
// compiled code across visits.
//
// Resolves once the engine is instantiated and the share is writable,
// which is before QEMU runs anything.
export async function startVM({
  guestFiles,
  machine,
  snapshot = null,
  terminalElement,
  engine,
}) {
  const ui = await openTerminal(terminalElement);
  const { master, slave } = openpty();
  ui.attach(master);

  // The console transcript, tapped before the terminal draws it.
  const console_ = watchConsole(master);

  // Resuming a snapshot skips the whole boot — BIOS, kernel, device
  // probe — and lands in a guest already spinning for the store share,
  // which by then is full. Without one, the same arguments cold-boot.
  const args =
    snapshot === null
      ? qemuArgs(machine)
      : ["-incoming", `file:${SNAPSHOT_FILE}`, ...qemuArgs(machine)];

  // preRun hands the module out once its filesystem exists.
  let onFilesystem;
  const filesystem = new Promise((resolve) => {
    onFilesystem = resolve;
  });

  const Module = {
    arguments: args,
    // No `print`/`printErr` here. xterm-pty is linked into this build
    // as a js-library that routes emscripten's output through the pty,
    // and defining either one takes stdout and stderr away from it —
    // the terminal then stays blank for the whole run, guest console
    // included. QEMU's diagnostics arrive in the terminal instead.
    pty: slave,
    // Both of these must be the versioned URLs too: the worker and the
    // wasm are fetched by emscripten rather than by us, and a stale
    // one is a stale engine.
    mainScriptUrlOrBlob: new URL(engine.main, location.href).href,
    locateFile: (file) => engine.locate(file),
    preRun: [
      (mod) => {
        // Holding a run dependency keeps main() from starting until
        // the share is complete; vm.run releases it.
        mod.addRunDependency(STORE_DEPENDENCY);

        // The -L directory: BIOS blobs, kernel, initramfs.
        ensureDir(mod.FS, PACK_DIR);
        for (const [name, bytes] of guestFiles) {
          mod.FS.writeFile(`${PACK_DIR}/${name}`, bytes, OWN);
        }
        if (snapshot !== null) {
          mod.FS.writeFile(SNAPSHOT_FILE, snapshot, OWN);
        }
        ensureDir(mod.FS, STORE_DIR);

        onFilesystem(mod);
      },
    ],
  };

  // The factory's promise settles only once the runtime is up, which
  // is after the run dependency is released — so it is not awaited
  // here. A failure before then (a wasm that will not compile, a
  // worker that will not start) is logged rather than lost.
  const initEmscriptenModule = (await import(`../${engine.main}`)).default;
  const runtime = initEmscriptenModule(Module);
  runtime.catch((err) => log(`engine failed: ${err.message ?? err}`));

  const mod = await filesystem;
  const share = storeShare(mod.FS);

  // Reachable from the browser console: the terminal, the pty pair,
  // and everything the guest has said. Debugging a guest that will not
  // talk is otherwise guesswork.
  window.trynix = {
    terminal: ui.terminal,
    master,
    slave,
    transcript: console_.transcript,
  };

  return {
    terminal: ui.terminal,
    share,

    // Finish the share and let QEMU run. `roots` are the basenames the
    // reader selected, in selection order. Resolves when the guest is
    // at its prompt — or when the page has given up waiting for it.
    async run(roots) {
      share.linkAll(share.written(), roots, Precedence.KEEP);
      mod.FS.writeFile(`${SHARE_DIR}/manifest`, MANIFEST);
      mod.removeRunDependency(STORE_DEPENDENCY);

      // The handshake: init parks on a read until the page says the
      // share is populated (nix/guest/init). Mounting only after this
      // is what makes the snapshot possible to take at all, since
      // QEMU refuses to migrate a VM with a virtfs export mounted.
      //
      // Markers are matched against the console stream rather than
      // against the terminal's screen. A screen scrolls, wraps and
      // gets cleared, and reading one ties this to a particular
      // terminal's buffer API; the stream is what the guest actually
      // said.
      if (snapshot === null) {
        await coldBoot(console_, master, ui.terminal);
      } else {
        await resume(console_, master, ui.terminal);
      }

      // QEMU has read everything it will ever read from /pack: the
      // snapshot is in the guest's RAM and the kernel and initramfs
      // are in the fw_cfg it booted from. The MEMFS copies are dead
      // weight — the snapshot alone is 35 MB — so they go.
      for (const name of [...guestFiles.keys(), SNAPSHOT_FILE]) {
        const path = name.startsWith("/") ? name : `${PACK_DIR}/${name}`;
        try {
          mod.FS.unlink(path);
        } catch {
          // a cold boot never wrote the snapshot
        }
      }
    },

    // Add store paths to a VM that is already running.
    //
    // The share is an ordinary directory in the emscripten filesystem
    // and 9p's local backend passes every lookup through to it, so
    // writing a new store path after boot is enough for the guest to
    // find it — no remount, no reboot. The farm is what lets the
    // guest's PATH stay as it was: the new roots replace any link of
    // the same name, so the package added last wins.
    add(unpacked, roots) {
      const basenames = [];
      while (unpacked.length > 0) {
        const { basename, entries } = unpacked.shift();
        share.write(basename, entries);
        basenames.push(basename);
      }
      share.linkAll(basenames, roots, Precedence.REPLACE);
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
  send(master, REDRAW_PROMPT);
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
// caught it, so one newline finishes the handshake — but a newline
// sent while QEMU is still loading the stream is lost, and nothing
// says when loading is done. So newlines are offered every
// RESUME_POLL_MS until the guest says anything at all. Only the first
// is actually lost (the UART it lands in is overwritten by the
// restore); the rest queue in the UART and reach the guest together,
// as the echo of the one it took plus spares, which the manifest
// drains before anything reads the tty.
async function resume(console_, master, terminal) {
  const poll = setInterval(() => sendLine(master), RESUME_POLL_MS);
  sendLine(master);
  await console_.waitForOutput();
  clearInterval(poll);
  await console_.waitFor(MOUNTED_MARKER);

  // Drop what the guest said on the way up; the reader starts at a
  // prompt.
  terminal.clear();
  send(master, REDRAW_PROMPT);
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

  const outputWaiters = [];

  master.onWrite(([data]) => {
    for (const resolve of outputWaiters.splice(0)) {
      resolve();
    }
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
    transcript: () => transcript,

    // Resolves the next time the guest writes anything at all.
    waitForOutput() {
      return new Promise((resolve) => {
        outputWaiters.push(resolve);
      });
    },

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
