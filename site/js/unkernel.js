// Starting a guest on the unkernel engine.
//
// unkernel is a Linux kernel compiled to WebAssembly, with a CPU
// emulator inside the kernel that runs unmodified aarch64 programs
// (https://github.com/pithings/unkernel). There is no machine to
// describe and no snapshot to resume: the kernel boots to its base
// shell in under half a second, so the page boots a fresh one every
// time.
//
// The guest gets the same share the qemu guest gets (share.js), mounted
// at the same path, and the same shell fragment to source. What differs
// is the plumbing:
//
//   the share is unkernel's MemoryFs, which the SDK serves to the guest
//   over 9p on a vsock, so nothing is copied into an emulator's heap;
//
//   the terminal is a real pty inside the guest rather than a serial
//   console, so a resize is one call and the guest's own line
//   discipline does the echo.
//
// startUnkernel returns the same handle boot.js's startVM does, and
// app.js drives either one without knowing which engine made the
// handle.

import {
  GUEST_BIN_DIR,
  GUEST_STORE_DIR,
  memoryFsCalls,
  SHARE_DIR,
  storeShare,
} from "./share.js";
import { Precedence } from "./store.js";
import { openTerminal } from "./terminal.js";
import { guestDriver } from "./agent.js";
import { consoleRecorder, pause, settled } from "./console.js";
import { UNKERNEL_MEMORY_MIB } from "./config.js";
import { log } from "./log.js";

// The guest's shell: busybox ash from unkernel's base system, the same
// shell the qemu guest runs.
const SHELL = "/bin/sh";

// The file the shell sources as it starts. ash reads the file ENV names
// when the shell is interactive, which is how PATH reaches the shell
// without the page typing anything.
const MANIFEST_FILE = `${SHARE_DIR}/manifest`;

// What the shell prints once the manifest is sourced: the same line the
// qemu guest's init prints, so the harnesses in tools/ wait for one
// thing whichever engine they are pointed at.
const MOUNTED_MARKER = "trynix: welcome to the multiverse";

// Ctrl-L: the shell's line editor clears its screen and draws the
// prompt again (boot.js says why the terminal is not cleared from this
// side alone).
const REDRAW_PROMPT = "\x0c";

// How often the guest is asked whether paths added to a running guest
// have appeared, and how long before the page stops asking.
//
// unkernel mounts 9p with a one-second attribute timeout
// (metatimeout=1000), and the timeout covers names that did not exist:
// a shell that looked for `figlet` before figlet was added keeps the
// "no such file" answer for up to a second. The limit is several of
// those timeouts, for a guest that is busy.
const VISIBLE_POLL_MS = 100;
const VISIBLE_LIMIT_MS = 5000;

// A shell loop that succeeds once every argument exists.
const ALL_EXIST =
  'for path; do [ -e "$path" ] || [ -L "$path" ] || exit 1; done';

// Wait until the guest can see every path in `paths`, or the limit
// passes. Asking is what makes the answer fresh: each lookup past the
// timeout goes back to the page's file system.
async function visible(kernel, paths) {
  const deadline = Date.now() + VISIBLE_LIMIT_MS;
  for (;;) {
    const seen = await kernel.exec(SHELL, ["-c", ALL_EXIST, SHELL, ...paths]);
    if (seen.exitCode === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      log("added paths are not visible in the guest yet");
      return;
    }
    await pause(VISIBLE_POLL_MS);
  }
}

// The shell fragment the guest's shell sources: PATH with the farm in
// front, and the same TERM and LANG the qemu guest gets (boot.js says
// why each is what it is, and why there is no LD_LIBRARY_PATH).
function manifest() {
  return [
    `export PATH="${GUEST_BIN_DIR}:$PATH"`,
    "export TERM=xterm-256color",
    "export LANG=C.UTF-8",
    `echo; echo "${MOUNTED_MARKER}"; echo`,
    "",
  ].join("\n");
}

// The terminal's view of the guest (terminal.js, bridge), before and
// after there is a shell to talk to.
//
// The terminal is attached while the kernel is still booting, so the
// port exists before the pty does: keystrokes and sizes that arrive
// early are dropped, which is what a terminal with nothing behind it
// should do with them.
function ptyPort() {
  let pty = null;
  let draw = () => {};

  return {
    send(data) {
      pty?.write(data).catch(() => {});
    },
    onOutput(callback) {
      draw = callback;
    },
    resize(rows, cols) {
      pty?.resize(cols, rows);
    },

    // The shell this port talks to from now on.
    connect(shell) {
      pty = shell;
    },
    draw: (data) => draw(data),
  };
}

// Read the shell's output until the shell ends, handing each piece to
// the record and then to the terminal. The stream is pulled: the guest
// is only given room to print as fast as this loop reads.
async function pump(shell, port, console_) {
  const reader = shell.output.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    console_.hear(value);
    port.draw(value);
  }
}

// engine: { main, kernel }, the versioned URLs of the SDK's browser
// entry and of the kernel.
//
// Resolves once the kernel is running and the share is writable. The
// share is page-side memory, so the closure streams into the share
// whether or not the guest has mounted anything yet.
export async function startUnkernel({
  terminalElement,
  keyBarElement,
  engine,
}) {
  const ui = await openTerminal(terminalElement, keyBarElement);
  const port = ptyPort();
  ui.attach(port);

  const console_ = consoleRecorder();

  const { createKernel, MemoryFs } = await import(`../${engine.main}`);
  const files = new MemoryFs();
  const FS = memoryFsCalls(files);
  const share = storeShare(FS);

  // The kernel runs in a worker where the page may share memory with
  // one, which keeps a busy guest from stalling the page; without
  // cross-origin isolation the kernel runs on the page's own thread
  // and yields to it between slices.
  const kernel = await createKernel({
    kernel: new URL(engine.kernel, location.href).href,
    memoryMiB: UNKERNEL_MEMORY_MIB,
    worker: globalThis.crossOriginIsolated === true,
  });
  kernel.exited.then(({ kind, reason }) =>
    log(`unkernel exited: ${kind}${reason ? ` (${reason})` : ""}`),
  );

  // One shell on a pty of the terminal's size, and another whenever
  // one exits: `exit` at the prompt should leave the reader at a
  // prompt, as it does in the qemu guest, where init starts the next
  // shell.
  async function shells() {
    for (;;) {
      const shell = await kernel.spawn(SHELL, [], {
        cols: ui.terminal.cols,
        rows: ui.terminal.rows,
        env: { ENV: MANIFEST_FILE },
      });
      port.connect(shell);
      await pump(shell, port, console_);
    }
  }

  // The handle everything outside the page reaches the guest through
  // (boot.js says who uses it). The driver is the supported surface;
  // the kernel is there for what the driver cannot do.
  window.trynix = {
    ...guestDriver({
      send: (data) => port.send(data),
      transcript: console_.transcript,
    }),
    terminal: ui.terminal,
    kernel,
  };

  return {
    terminal: ui.terminal,
    share,

    // Finish the share, mount it, and start the shell. `roots` are the
    // basenames the reader selected, in selection order. Resolves when
    // the guest is at its prompt.
    async run(roots) {
      share.linkAll(share.written(), roots, Precedence.KEEP);
      FS.writeFile(MANIFEST_FILE, manifest());

      // The share is read-only to the guest: a store is immutable, and
      // everything the page adds later arrives from this side.
      await kernel.mount(SHARE_DIR, files, { readOnly: true });

      // Every nix binary names its loader and libraries by /nix/store
      // paths, so the guest needs the store at /nix as well as where
      // the share is mounted.
      const linked = await kernel.exec("/bin/ln", [
        "-s",
        `${SHARE_DIR}/nix`,
        "/nix",
      ]);
      if (linked.exitCode !== 0) {
        throw new Error(
          `could not link /nix in the guest: ${linked.stderr.trim()}`,
        );
      }

      shells().catch((err) => log(`guest shell failed: ${err.message ?? err}`));

      // Drop what the shell said on the way up; the reader starts at a
      // prompt, as after a qemu boot.
      await console_.waitFor(MOUNTED_MARKER);
      await settled(console_);
      ui.terminal.clear();
      port.send(REDRAW_PROMPT);
    },

    // Add store paths to a guest that is already running. The share is
    // page-side memory the guest reads through 9p, so writing a path
    // here is enough: no remount, no reboot. Resolves once the guest
    // sees the new paths and the roots' programs (see visible), so
    // "added" is true by the time the page says so.
    async add(unpacked, roots) {
      const basenames = [];
      while (unpacked.length > 0) {
        const { basename, entries } = unpacked.shift();
        share.write(basename, entries);
        basenames.push(basename);
      }
      share.linkAll(basenames, roots, Precedence.REPLACE);

      const added = roots.filter((basename) => basenames.includes(basename));
      await visible(kernel, [
        ...basenames.map((basename) => `${GUEST_STORE_DIR}/${basename}`),
        ...added.flatMap((basename) =>
          share.programsOf(basename).map((name) => `${GUEST_BIN_DIR}/${name}`),
        ),
      ]);
    },

    // The programs a written path offers, by basename.
    programsOf: (basename) => share.programsOf(basename),
  };
}
