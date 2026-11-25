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
import { lazyFs, PathOrigin } from "./lazy.js";
import { openTerminal } from "./terminal.js";
import { consoleFrame } from "./frame.js";
import { guestDriver } from "./agent.js";
import { createSoundOut } from "./sound.js";
import { caBundleShell } from "./network.js";
import { CA_BUNDLE, CERTS_DIR } from "./config.js";
import { consoleRecorder, pause } from "./console.js";
import { log } from "./log.js";
import {
  attachDesktop,
  capabilityLinks,
  enableGlamor,
  guestSession,
  isGlDriver,
  sessionEnv,
} from "./gui.js";
import { kernelVulkan } from "./vulkan.js";

// Where the page writes the CA certificates when the guest has a
// network (network.js), the same path on both sides of the share.
const CERTS_SHARE_DIR = `${SHARE_DIR}/certs`;
const CA_BUNDLE_PATH = `${CERTS_SHARE_DIR}/${CA_BUNDLE}`;

// Fetch the site's CA bundle and write it into the share. Resolves to
// the bundle's path in the guest.
async function writeCaBundle(FS) {
  const url = `${CERTS_DIR}/${CA_BUNDLE}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  FS.mkdir(CERTS_SHARE_DIR);
  FS.writeFile(CA_BUNDLE_PATH, new Uint8Array(await res.arrayBuffer()));
  return CA_BUNDLE_PATH;
}

// The guest's shell: busybox ash from unkernel's base system, the same
// shell the qemu guest runs.
const SHELL = "/bin/sh";

// A program name the page may put in a guest command line as it is.
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// The store's directory inside the MemoryFs, whose root the guest
// mounts at SHARE_DIR.
const MEMORY_FS_STORE_DIR = STORE_DIR.slice(SHARE_DIR.length);

// How long a request on a lazily served share may take before the
// guest is told it timed out: never. A lookup that waits for a download
// takes as long as the download, which for gcc's 82 MiB on a slow line
// is minutes, and the SDK's default of 30 s would fail it, three times
// over as the guest retries. A download that cannot finish fails on
// its own, a stalled one after 30 s without a byte (net.js), and the
// lookup is then answered EIO (lazy.js).
const LAZY_REQUEST_TIMEOUT_MS = 0;

// Where scripts name env in their #! line, as NixOS and every FHS
// system have it, and where unkernel's base system has it: /bin/env
// alone. A script that starts "#!/usr/bin/env sh" failed in the guest
// with "bad interpreter", VSCodium's launcher among them.
const ENV_LINK = "/usr/bin/env";
const BASE_ENV = "/bin/env";

// The command that links env at ENV_LINK under `root`, the guest's root
// when empty, unless something is there already, a file or a link: a
// base system that ships its own env keeps it. `-e` alone follows a
// link, and a link whose target is missing would be made again and fail.
export const envLink = (root = "") =>
  `{ [ -e ${root}${ENV_LINK} ] || [ -L ${root}${ENV_LINK} ] || ln -s ${BASE_ENV} ${root}${ENV_LINK}; }`;

// Where a resolver looks a name up before it asks DNS, and the one name
// the guest needs there. unkernel's base system ships no hosts file, so
// a nixpkgs program, whose glibc reads the file and then asks DNS, sent
// "localhost" to the page's DNS. With a Wisp relay that DNS answers
// every name with a stand-in address (network.js), localhost included,
// and a program that listens on or connects to localhost got an address
// no interface has: cloudflared could not bind its metrics listener.
// The guest's kernel has no IPv6, so ::1 is left out.
const HOSTS_FILE = "/etc/hosts";
const LOOPBACK_ADDRESS = "127.0.0.1";
const LOOPBACK_NAME = "localhost";

// The command that writes HOSTS_FILE under `root`, the guest's root
// when empty, unless a hosts file is there already: a base system that
// ships its own keeps it.
export const hostsFile = (root = "") =>
  `{ [ -e ${root}${HOSTS_FILE} ] || printf '%s\\t%s\\n' ${LOOPBACK_ADDRESS} ${LOOPBACK_NAME} > ${root}${HOSTS_FILE}; }`;

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
// shell gets the GUI session's environment too (gui.js), the Wayland
// socket and the X display alike, so a GUI program added after the boot
// finds the relay from the shell it is typed into, and with guest Vulkan
// on (`vulkan`, vulkan.js) the Vulkan driver: the site's, whose store
// basename is `vulkanDriver`, or the kernel's own when that is null.
// With a network, TLS clients are pointed at the CA bundle in the share
// (`caBundle`, or null without one).
export function manifest({ caBundle, vulkan, vulkanDriver = null }) {
  const session = Object.entries(sessionEnv({ vulkan, vulkanDriver })).map(
    ([name, value]) => `export ${name}="${value}"`,
  );
  return [
    `export PATH="${GUEST_BIN_DIR}:$PATH"`,
    "export TERM=xterm-256color",
    "export LANG=C.UTF-8",
    ...session,
    ...(caBundle === null ? [] : caBundleShell(caBundle)),
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

// engine: { main, kernel, gl, vk }, the versioned URLs of the SDK's
// browser entry, of the kernel, of the GL renderer's module and of the
// Vulkan renderer's shader translator.
// desktopElement is where GUI programs' windows go (gui.js), over the
// terminal in consoleElement, and windowsButton is the console bar's
// button that hides and shows them (frame.js). soundControl is the
// console bar's sound switch (sound.js), soundPosition where it starts
// and onSoundSwitch what hears it move. net is the network device's
// spec, or null for none (network.js). memory is
// { mib, fallbacks }: the size to ask for, and the smaller sizes to try
// if the browser cannot allocate it (memory.js). cpus is how many CPUs
// to ask for (cpus.js); more than one boots the SDK's SMP kernel, each
// CPU in a worker, which needs the kernel in a worker too. vulkan is
// guest Vulkan's switch (vulkan.js): on, the guest gets kwvk and its
// shells name it; off, neither.
//
// Resolves once the kernel is running and the share is writable. The
// share is page-side memory, so the closure streams into the share
// whether or not the guest has mounted anything yet.
export async function startUnkernel({
  terminalElement,
  keyBarElement,
  consoleElement,
  desktopElement,
  soundControl,
  soundPosition,
  onSoundSwitch,
  net,
  windowsButton,
  memory,
  cpus,
  vulkan,
  engine,
}) {
  const ui = await openTerminal(terminalElement, keyBarElement);
  const port = ptyPort();
  ui.attach(port);

  const console_ = consoleRecorder();

  const { createAudioOut, createKernel, MemoryFs } = await import(
    `../${engine.main}`
  );
  const files = new MemoryFs();
  const FS = memoryFsCalls(files);
  const share = storeShare(FS);

  // The closure's lazily served paths (lazy.js), once run() is given
  // them. From then on, a path of the selection that arrives is linked
  // as it is written.
  let lazyStore = null;
  let linkArrivals = false;

  // Watch the paths as they are written. One that holds Mesa's EGL
  // vendor file is a GL driver, which becomes the guest's
  // /run/opengl-driver over the site's when the reader selected it
  // (ownGlDriver).
  //
  // A path that arrives after the shell started offers its programs at
  // once, behind any program of the same name already there, so a
  // dependency never shadows a selection. A capability's paths offer
  // none: Xwayland and the X server's dbus-launch and systemctl stay off
  // PATH.
  const glDrivers = [];
  const write = share.write.bind(share);
  share.write = (basename, entries) => {
    if (isGlDriver(entries)) {
      glDrivers.push(basename);
    }
    write(basename, entries);
    if (linkArrivals && lazyStore.origin(basename) !== PathOrigin.CAPABILITY) {
      share.link(basename, Precedence.KEEP);
    }
  };

  // The same for a path's programs offered from its listing, which can
  // arrive after the shell started too.
  const offer = share.offer.bind(share);
  share.offer = (basename, names) => {
    offer(basename, names);
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
  // relay's first dial. The sound card is there for the same reason,
  // and nothing plays until a program opens it (sound.js).
  //
  // The SDK's own notes (the GL renderer loading, its link connecting)
  // go to the page's log with the rest of the boot. Without a `log` the
  // SDK prints them with console.error, and every boot showed the
  // reader a column of red lines that were not errors.
  // With a network, the CA certificates arrive while the kernel boots,
  // and are in the share before the shell starts. Without them HTTPS
  // from the guest fails, so the page says so, and the boot goes on.
  const caBundle =
    net === null
      ? Promise.resolve(null)
      : writeCaBundle(FS).catch((err) => {
          log(
            `network: no CA certificates (${err.message}); HTTPS from the guest will fail`,
          );
          return null;
        });

  const sound = createSoundOut({
    createAudioOut,
    log,
    control: soundControl,
    position: soundPosition,
    onSwitch: onSoundSwitch,
  });
  const kernel = await createKernel({
    kernel: new URL(engine.kernel, location.href).href,
    memoryMiB: memory.mib,
    memoryFallbackMiB: memory.fallbacks,
    cpus,
    worker: globalThis.crossOriginIsolated === true,
    shm: true,
    gpu: true,
    // Guest VA-API: kwva, the libva driver in the kernel's base system,
    // sends each picture a program decodes to a WebCodecs VideoDecoder
    // on the page, and with the virtio-gpu device the decoded frame is
    // drawn into the program's surface on the GPU (docs/gui.md,
    // "Video"). The SDK asks nothing of WebCodecs before the guest's
    // first VA-API connection, and in a browser without VideoDecoder it
    // logs a line and goes on without.
    va: true,
    // Guest Vulkan, with vk=1 only: kwvk, the Vulkan driver in the
    // kernel's base system, sends a program's Vulkan calls to the SDK's
    // renderer on the page's WebGPU (vulkan.js; docs/gui.md).
    ...kernelVulkan(vulkan, new URL(engine.vk, location.href).href),
    gl: { module: new URL(engine.gl, location.href).href },
    sound,
    ...(net === null ? {} : { net }),
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

  // The last GL driver written among `roots`, the basenames the reader
  // selected, or null: a Mesa the reader selected, which the guest uses
  // over the site's. A Mesa that is only in a program's closure, as
  // mesa-demos 8.5.0 carries mesa-22.3.7-drivers, is not one.
  const ownGlDriver = (roots) =>
    glDrivers.filter((basename) => roots.includes(basename)).at(-1) ?? null;

  // Point /run/opengl-driver at a GL driver an addition brought. A
  // program already running keeps the driver it loaded.
  async function relinkGlDriver(basename) {
    const result = await sh(capabilityLinks({ glDriver: basename }));
    if (result.exitCode !== 0) {
      throw new Error(
        `could not link /run/opengl-driver: ${result.stderr.trim()}`,
      );
    }
    log(`gui: /run/opengl-driver is ${basename}`);
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
    sound: () => ({
      ...sound.stats(),
      sink: sound.state,
      muted: sound.muted,
    }),
  };
  attachDesktop({
    kernel,
    frame: consoleFrame({
      consoleElement,
      container: desktopElement,
      windowsButton,
      terminal: ui.terminal,
      focusTerminal: ui.focus,
    }),
  });

  return {
    terminal: ui.terminal,
    share,

    // Type at the guest's shell as the keyboard does: a link's run=
    // (app.js) arrives this way, echoed at the prompt like anything the
    // reader types.
    type: (text) => port.send(text),

    // Finish the share, mount it, and start the shell. `roots` are the
    // basenames the reader selected, in selection order. Resolves when
    // the guest is at its prompt.
    //
    // `store` is the closure (lazy.js): the guest sees every path of it
    // in its store, and a lookup inside one that has not arrived waits
    // for it. `x11Server` and `glDriver` are the basenames of the X
    // server and the site's GL driver (null for none), capabilities of
    // the store that the guest's fixed names point at from the boot.
    // `vulkanDriver` is the basename of the site's Vulkan driver (null
    // for none), a capability too, which the shells name with guest
    // Vulkan on.
    async run(roots, { store, x11Server, glDriver, vulkanDriver = null }) {
      // The GUI session's files download while the shell comes up, so
      // the relay listens soon after the prompt. A download that fails
      // here is tried again, and reported, by the session's start.
      session.prepare().catch(() => {});

      share.linkAll(share.known(), roots, Precedence.KEEP);
      lazyStore = store;
      FS.writeFile(
        MANIFEST_FILE,
        manifest({ caBundle: await caBundle, vulkan, vulkanDriver }),
      );

      // The share is read-only to the guest: a store is immutable, and
      // everything the page adds later arrives from this side.
      linkArrivals = true;
      FS.mkdir(STORE_DIR);
      await kernel.mount(
        SHARE_DIR,
        lazyFs(files, store, {
          storeDir: MEMORY_FS_STORE_DIR,
          shareDir: SHARE_DIR,
        }),
        {
          readOnly: true,
          requestTimeout: LAZY_REQUEST_TIMEOUT_MS,
        },
      );

      // Every nix binary names its loader and libraries by /nix/store
      // paths, so the guest needs the store at /nix as well as where
      // the share is mounted. The same command puts env where scripts
      // look for it, names localhost in /etc/hosts, and points the
      // guest's fixed names at the X server and the GL driver, a GL
      // driver the reader selected over the site's.
      const driver = ownGlDriver(roots) ?? glDriver;
      const links = capabilityLinks({ glDriver: driver, x11Server });
      const linked = await kernel.exec(SHELL, [
        "-c",
        `ln -s ${SHARE_DIR}/nix /nix && ${envLink()} && ${hostsFile()} && ${links}`,
      ]);
      if (linked.exitCode !== 0) {
        throw new Error(
          `could not link /nix, /usr/bin/env and /run or write /etc/hosts in the guest: ${linked.stderr.trim()}`,
        );
      }
      log(
        `gui: /run/opengl-driver is ${driver}, /run/x11-server is ${x11Server}`,
      );

      shells().catch((err) => log(`guest shell failed: ${err.message ?? err}`));

      // Read the programs ahead of the first command, as the qemu
      // guest's init does. A first run is slowed by its binary coming
      // in over 9p a piece at a time, and reading it once puts it in
      // the guest's page cache: measured on unkernel, a cold
      // `jj --version` went from 0.27 s to 0.19 s with the binary read
      // first. The read runs at the lowest priority and is not waited
      // for, so a command typed at once still goes ahead of it.
      //
      // While paths are still to come the farm also links their
      // programs, and reading one downloads its path, so only the
      // selected packages' own programs are read. Reading the whole farm
      // downloaded gcc for solitaire. A closure downloaded whole has
      // nothing left to fetch, and its whole farm is read.
      const readahead =
        store.pending().length === 0
          ? `${GUEST_BIN_DIR}/*`
          : share
              .programFiles(roots)
              .map((file) => `'${file.replaceAll("'", "'\\''")}'`)
              .join(" ");
      if (readahead !== "") {
        kernel
          .exec(SHELL, ["-c", `nice -n 19 cat ${readahead} > /dev/null 2>&1`])
          .catch(() => {});
      }

      // The shell is ready once it has sourced the manifest, taken the
      // handshake and redrawn its prompt on a cleared screen (see
      // HANDSHAKE for why that moment and no earlier one).
      await console_.waitFor(MOUNTED_MARKER);
      await console_.waitFor(REDRAWN);

      // The GUI session comes up behind the prompt, so the shell never
      // waits for it. A failure is logged rather than thrown: the shell
      // works without it, and the next addition tries again.
      const prompted = performance.now();
      session.start().then(
        () =>
          log(
            `gui: the relay listens ${Math.round(performance.now() - prompted)} ms after the prompt`,
          ),
        (err) => log(`gui: setup failed: ${err.message ?? err}`),
      );
    },

    // Let the X server draw with glamor, for a selection that may draw
    // with GLX (gui.js, enableGlamor). An X server already running
    // keeps what it started with.
    allowGlamor: () => enableGlamor(FS),

    // Add store paths to a guest that is already running. The share is
    // page-side memory the guest reads through 9p, so writing a path
    // here is enough: no remount, no reboot. Resolves once the guest
    // sees the new paths and the roots' programs (see visible), so
    // "added" is true by the time the page says so.
    //
    // `roots` are the basenames of the packages this addition selects,
    // which replace any link of the same name, so the package added
    // last wins; a package the guest already had stays as it was.
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

      // A GL driver the reader selected takes the guest's driver link,
      // and a session whose start failed is tried again. Either failing
      // is logged: the shell works without them.
      const steps = [session.start()];
      const ownDriver = ownGlDriver(roots);
      if (ownDriver !== null) {
        steps.push(relinkGlDriver(ownDriver));
      }
      await Promise.all(steps).catch((err) =>
        log(`gui: setup failed: ${err.message ?? err}`),
      );

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

    // Whether a process runs in the guest whose command line names
    // `program`, as a program file: the file itself, or nixpkgs'
    // .program-wrapped behind a wrapper script. A name that is not a
    // plain program name is taken to run, so the caller waits on.
    async isRunning(program) {
      if (!PROGRAM_NAME.test(program)) {
        return true;
      }
      const escaped = program.replaceAll(".", "\\.").replaceAll("+", "\\+");
      const pattern = `(^|/)\\.?${escaped}(-wrapped)?( |$)`;
      const found = await kernel.exec(SHELL, [
        "-c",
        `pgrep -f -- '${pattern}' > /dev/null`,
      ]);
      return found.exitCode === 0;
    },
  };
}
