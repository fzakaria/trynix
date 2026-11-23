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
  STORE_DIR,
  storeShare,
} from "./share.js";
import { Precedence } from "./store.js";
import { lazyFs } from "./lazy.js";
import { openTerminal } from "./terminal.js";
import { guestDriver } from "./agent.js";
import { consoleRecorder, pause } from "./console.js";
import { log } from "./log.js";
import {
  attachDesktop,
  guestSession,
  isGlDriver,
  linkGlDriver,
  sessionEnv,
  speaksWayland,
} from "./gui.js";

// The guest's shell: busybox ash from unkernel's base system, the same
// shell the qemu guest runs.
const SHELL = "/bin/sh";

// The store's directory inside the MemoryFs, whose root the guest
// mounts at SHARE_DIR.
const MEMORY_FS_STORE_DIR = STORE_DIR.slice(SHARE_DIR.length);

// How long a request on a lazily served share may take before the
// guest is told it timed out: never. A lookup that waits for a download
// takes as long as the download, which for gcc's 82 MiB on a slow line
// is minutes, and the SDK's default of 30 s would fail it, three times
// over as the guest retries. A download that cannot finish fails on
// its own, and the lookup is then answered EIO (lazy.js).
const LAZY_REQUEST_TIMEOUT_MS = 0;

// The file the shell sources as it starts. ash reads the file ENV names
// when the shell is interactive, which is how PATH reaches the shell
// without the page typing anything.
const MANIFEST_FILE = `${SHARE_DIR}/manifest`;

// Set only for the shell on the page's terminal, which is the one shell
// that takes the page's handshake (see HANDSHAKE). Every other
// interactive shell inherits ENV and sources the manifest too: one
// typed at the prompt, or the shell a terminal emulator such as foot
// starts in its window. Those must not stop to read a line nobody
// sends, so the manifest clears this before anything else can inherit
// it.
const HANDSHAKE_VARIABLE = "TRYNIX_HANDSHAKE";

// What the shell prints once the manifest is sourced: the same line the
// qemu guest's init prints, so the harnesses in tools/ wait for one
// thing whichever engine they are pointed at.
const MOUNTED_MARKER = "trynix: welcome to the multiverse";

// What the page types once a shell has printed that line: the newline
// the manifest is waiting to read, and Ctrl-L, which the shell's line
// editor answers by clearing the screen and drawing its prompt.
//
// The pair is how a shell is brought to a clean prompt with nothing in
// flight. ash's line editor asks the terminal where the cursor is as it
// draws a prompt (ESC [ 6 n), and reads the terminal's answer as input,
// sixteen bytes at a time, dropping whatever else such a read brought.
// A command typed just behind the answer therefore loses its first
// characters: the harnesses in tools/ type within a millisecond of the
// boot finishing, and their first command arrived with ten of them
// gone. The qemu engine never met this because its page waits for the
// console to go quiet first, which costs 0.4 s of every boot.
//
// The editor skips the question when input is already waiting. So the
// manifest ends by reading one line from the terminal, which holds the
// shell short of its first prompt until this arrives; the newline ends
// that read and the Ctrl-L is still waiting when the editor starts. No
// question is asked, nothing is answered, and the redraw the Ctrl-L
// causes is the one moment the page can name at which the shell is
// ready and the screen holds a prompt and nothing else.
const HANDSHAKE = "\n\x0c";

// What the line editor prints for that Ctrl-L before the prompt: cursor
// home, erase to the end of the screen.
const REDRAWN = "\x1b[H\x1b[J";

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
// why each is what it is, and why there is no LD_LIBRARY_PATH). Every
// shell gets the Wayland session's environment too (gui.js), so a GUI
// program added after the boot finds the relay from the shell it is
// typed into.
function manifest() {
  const session = Object.entries(sessionEnv()).map(
    ([name, value]) => `export ${name}="${value}"`,
  );
  return [
    `export PATH="${GUEST_BIN_DIR}:$PATH"`,
    "export TERM=xterm-256color",
    "export LANG=C.UTF-8",
    ...session,
    // Wait for the page's handshake (see HANDSHAKE), on the page's
    // shell alone (see HANDSHAKE_VARIABLE).
    `if [ -n "$${HANDSHAKE_VARIABLE}" ]; then`,
    `  unset ${HANDSHAKE_VARIABLE}`,
    `  echo "${MOUNTED_MARKER}"`,
    "  read -r _handshake",
    "fi",
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
//
// The first thing a shell prints is the welcome line, and the loop
// answers that line with the handshake, once per shell, so a shell
// started after an `exit` comes up the same way the first one did.
async function pump(shell, port, console_) {
  const reader = shell.output.getReader();

  // What this shell has said so far, as text, until the welcome line
  // has been seen in it; null from then on.
  const decoder = new TextDecoder();
  let awaitingWelcome = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    console_.hear(value);
    port.draw(value);
    if (awaitingWelcome === null) {
      continue;
    }

    awaitingWelcome += decoder.decode(value, { stream: true });
    if (awaitingWelcome.includes(MOUNTED_MARKER)) {
      awaitingWelcome = null;
      shell.write(HANDSHAKE).catch(() => {});
    }
  }
}

// engine: { main, kernel, gl }, the versioned URLs of the SDK's
// browser entry, of the kernel and of the GL renderer's module.
// desktopElement is where GUI programs' windows go (gui.js). memory is
// { mib, fallbacks }: the size to ask for, and the smaller sizes to try
// if the browser cannot allocate it (memory.js). cpus is how many CPUs
// to ask for (cpus.js); more than one boots the SDK's SMP kernel, each
// CPU in a worker, which needs the kernel in a worker too.
//
// Resolves once the kernel is running and the share is writable. The
// share is page-side memory, so the closure streams into the share
// whether or not the guest has mounted anything yet.
export async function startUnkernel({
  terminalElement,
  keyBarElement,
  desktopElement,
  memory,
  cpus,
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

  // The closure's lazily served paths (lazy.js), once run() is given
  // them; null when every path is written before the shell starts. From
  // then on, a path that arrives is linked as it is written.
  let lazyStore = null;
  let linkArrivals = false;

  // Watch the paths as they are written. A Wayland library in the
  // closure starts the download of the GUI session's files, while the
  // rest of the closure is still arriving, and a Mesa store path
  // becomes the guest's /run/opengl-driver once the guest is up.
  //
  // A path served lazily that arrives after the shell started offers
  // its programs at once, behind any program of the same name already
  // there, so a dependency never shadows a selection.
  const glDrivers = [];
  const write = share.write.bind(share);
  share.write = (basename, entries) => {
    if (speaksWayland([basename])) {
      session.prepare();
    }
    if (isGlDriver(entries)) {
      glDrivers.push(basename);
    }
    write(basename, entries);
    if (linkArrivals) {
      share.link(basename, Precedence.KEEP);
    }
  };

  // The kernel runs in a worker where the page may share memory with
  // one, which keeps a busy guest from stalling the page; without
  // cross-origin isolation the kernel runs on the page's own thread
  // and yields to it between slices.
  //
  // The devices a GUI program needs are always there, since which
  // programs the reader runs is not known when the kernel boots: kwshm,
  // through which the compositor reads programs' buffers, and a
  // virtio-gpu device with 3D, which Mesa's virgl driver renders on.
  // Neither costs a download until a program uses it: the GL renderer
  // is fetched on the guest's first GL use, the compositor on the
  // relay's first dial.
  //
  // The SDK's own notes (the GL renderer loading, its link connecting)
  // go to the page's log with the rest of the boot. Without a `log` the
  // SDK prints them with console.error, and every boot showed the
  // reader a column of red lines that were not errors.
  const kernel = await createKernel({
    kernel: new URL(engine.kernel, location.href).href,
    memoryMiB: memory.mib,
    memoryFallbackMiB: memory.fallbacks,
    cpus,
    worker: globalThis.crossOriginIsolated === true,
    shm: true,
    gpu: true,
    gl: { module: new URL(engine.gl, location.href).href },
    log,
  });
  if (kernel.memoryMiB !== memory.mib) {
    log(
      `unkernel: ${memory.mib} MiB could not be allocated; booted with ${kernel.memoryMiB} MiB`,
    );
  }
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
        env: { ENV: MANIFEST_FILE, [HANDSHAKE_VARIABLE]: "1" },
      });
      port.connect(shell);
      await pump(shell, port, console_);
    }
  }

  // A command in the guest's shell, for the GUI session's setup.
  const sh = (command) => kernel.exec(SHELL, ["-c", command]);
  const session = guestSession({ FS, exec: sh });

  // Every path of the closure the guest sees: the written ones, and on a
  // lazily served share the ones still to come.
  const closure = () => [
    ...share.written(),
    ...(lazyStore === null ? [] : lazyStore.pending()),
  ];

  // Start the GUI session where `basenames` hold a Wayland program,
  // and link the newest GL driver written. Resolves once both are done,
  // so a GUI program typed at the prompt finds the relay running. A
  // failure is logged rather than thrown: the shell works without
  // either.
  async function guiSetup(basenames) {
    const steps = [];
    if (speaksWayland(basenames)) {
      steps.push(session.start());
    }
    const driver = glDrivers.at(-1);
    if (driver !== undefined) {
      glDrivers.length = 0;
      steps.push(linkGlDriver(sh, driver));
    }
    await Promise.all(steps).catch((err) =>
      log(`gui: setup failed: ${err.message ?? err}`),
    );
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
  attachDesktop({
    kernel,
    container: desktopElement,
    show: () => {
      desktopElement.hidden = false;
    },
  });

  return {
    terminal: ui.terminal,
    share,

    // Finish the share, mount it, and start the shell. `roots` are the
    // basenames the reader selected, in selection order. Resolves when
    // the guest is at its prompt.
    //
    // `store` is the closure served lazily (lazy.js), or null when every
    // path has been written. Served lazily, the guest sees every path of
    // the closure in its store, and a lookup inside one that has not
    // arrived waits for it.
    async run(roots, { store = null } = {}) {
      share.linkAll(share.written(), roots, Precedence.KEEP);
      FS.writeFile(MANIFEST_FILE, manifest());

      // The share is read-only to the guest: a store is immutable, and
      // everything the page adds later arrives from this side.
      if (store === null) {
        await kernel.mount(SHARE_DIR, files, { readOnly: true });
      } else {
        lazyStore = store;
        linkArrivals = true;
        FS.mkdir(STORE_DIR);
        await kernel.mount(
          SHARE_DIR,
          lazyFs(files, store, MEMORY_FS_STORE_DIR),
          {
            readOnly: true,
            requestTimeout: LAZY_REQUEST_TIMEOUT_MS,
          },
        );
      }

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

      // Read the programs ahead of the first command, as the qemu
      // guest's init does. A first run is slowed by its binary coming
      // in over 9p a piece at a time, and reading it once puts it in
      // the guest's page cache: measured on unkernel, a cold
      // `jj --version` went from 0.27 s to 0.19 s with the binary read
      // first. The read runs at the lowest priority and is not waited
      // for, so a command typed at once still goes ahead of it.
      kernel
        .exec(SHELL, [
          "-c",
          `nice -n 19 cat ${GUEST_BIN_DIR}/* > /dev/null 2>&1`,
        ])
        .catch(() => {});

      // The shell is ready once it has sourced the manifest, taken the
      // handshake and redrawn its prompt on a cleared screen (see
      // HANDSHAKE for why that moment and no earlier one). The GUI
      // session comes up meanwhile, and is waited for as well.
      const gui = guiSetup(closure());
      await console_.waitFor(MOUNTED_MARKER);
      await console_.waitFor(REDRAWN);
      await gui;
    },

    // Add store paths to a guest that is already running. The share is
    // page-side memory the guest reads through 9p, so writing a path
    // here is enough: no remount, no reboot. Resolves once the guest
    // sees the new paths and the roots' programs (see visible), so
    // "added" is true by the time the page says so.
    //
    // `written` names paths of this addition already written into the
    // share, which a lazily served closure does as each path arrives.
    // The rest of a lazy addition is in the store, and is neither
    // written nor waited for here.
    async add(unpacked, roots, written = []) {
      const basenames = [...written];
      while (unpacked.length > 0) {
        const { basename, entries } = unpacked.shift();
        share.write(basename, entries);
        basenames.push(basename);
      }
      share.linkAll(basenames, roots, Precedence.REPLACE);
      await guiSetup(lazyStore === null ? basenames : closure());

      const added = roots.filter((basename) => basenames.includes(basename));
      await visible(kernel, [
        ...basenames.map((basename) => `${GUEST_STORE_DIR}/${basename}`),
        ...added.flatMap((basename) =>
          share.programsOf(basename).map((name) => `${GUEST_BIN_DIR}/${name}`),
        ),
      ]);
    },

    // The memory the guest booted with, in MiB: the size asked for, or
    // a fallback when the browser could not allocate it.
    memoryMiB: kernel.memoryMiB,

    // The CPUs the guest runs on: the count asked for, or one where the
    // browser could not start CPU threads. Read from the kernel's stats,
    // which a kernel in a worker sends after it starts.
    get cpus() {
      return kernel.stats().cpus;
    },

    // The programs a written path offers, by basename.
    programsOf: (basename) => share.programsOf(basename),
  };
}
