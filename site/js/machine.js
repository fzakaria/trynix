// The unkernel guest as a machine that can be taken back in time.
//
// This is the half of the unkernel engine that runs where the kernel
// runs: in the guest worker (unkernel-worker.js) on the page, and in
// the node tests directly. unkernel.js is the other half, on the page:
// the terminal, the timeline, and the messages to the worker.
//
// The kernel runs inline in that worker, not in a worker of the SDK's
// own, because only an inline kernel can snapshot while host file
// systems are mounted, and the store share is one. The worker is what
// keeps a busy guest off the page's thread.
//
// The machine takes a keyframe (keyframes.js) at every shell prompt
// that follows a command, and every few seconds while a command runs.
// Going back to one restores the whole machine: the memory, the
// devices' host side and the console's unread input go into a fresh
// kernel instance, and the share is mounted into it again with its
// 9p sessions intact. What does not survive is every other vsock
// connection, which is why the shell is the one on the kernel's
// console (hvc0) rather than one spawned on a pty: a pty from spawn()
// is a vsock session, and a restore would hang it up.

import {
  GUEST_BIN_DIR,
  memoryFsCalls,
  SHARE_DIR,
  storeShare,
} from "./share.js";
import { Precedence } from "./store.js";
import { KeyframeStore } from "./keyframes.js";
import { PROMPT_HOOK, promptScanner } from "./prompt.js";

// The shell programs run through: busybox ash from unkernel's base
// system.
const SHELL = "/bin/sh";

// The file the guest's login shell sources (through /root/.profile,
// which run() links to it).
export const MANIFEST_FILE = `${SHARE_DIR}/manifest`;
const PROFILE_LINK = "/root/.profile";

// What the shell prints once the manifest is sourced, the same line the
// qemu guest's init prints, so the harnesses in tools/ wait for one
// thing whichever engine they are pointed at.
export const MOUNTED_MARKER = "trynix: welcome to the multiverse";

// What the machine types once a shell has printed that line: the
// newline the manifest's last `read` waits for, and Ctrl-L, which the
// line editor answers by clearing the screen and drawing its prompt.
//
// ash's line editor asks the terminal where the cursor is as it draws
// a prompt (ESC [ 6 n) and reads the answer as input, dropping
// whatever else arrived in the same read, so a command typed just
// behind the answer loses its first characters. The editor skips the
// question when input is already waiting: the newline ends the read
// and the Ctrl-L is waiting when the editor starts, so no question is
// asked, and the redraw is the moment the shell is ready and the
// screen holds a prompt and nothing else.
const HANDSHAKE = "\n\x0c";

// The kernel's messages stay off the console the shell is on: only
// emergencies (console_loglevel 1) are printed.
const PRINTK_LEVEL = 1;

// What happens to the kernel's console before the shell trynix wants
// is on it. The base system's own shell is already at a prompt there;
// `exit` ends it, init starts the next login shell, and that one reads
// /root/.profile.
const END_FIRST_SHELL = "exit\n";

export const KeyframeKind = Object.freeze({
  // At a shell prompt, after a command (or at the first prompt).
  PROMPT: "prompt",
  // While a command runs.
  RUNNING: "running",
  // Where the machine was when it went back to an earlier keyframe, so
  // that it can come back.
  DEPARTED: "departed",
});

// How long the console must be quiet after a prompt is drawn before the
// keyframe is taken, and how long that is waited for at most. The
// prompt is followed by the terminal's answer to the line editor's
// cursor question, and a keyframe that waits for it restores a shell
// that is not waiting for anything.
const PROMPT_QUIET_MS = 30;
const PROMPT_QUIET_LIMIT_MS = 300;

// How often a keyframe is taken while a command runs.
const RUNNING_PERIOD_MS = 5000;
const RUNNING_CHECK_MS = 500;

// A snapshot is refused while a 9p request or a vsock packet is in
// flight. A prompt's keyframe is tried again this often, this many
// times; a running command's is simply taken at the next period.
const RETRY_MS = 50;
const RETRY_LIMIT = 20;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The shell fragment the guest's login shell sources: PATH with the
// farm in front, the TERM and LANG the qemu guest gets (boot.js says
// why each is what it is), the prompt mark (prompt.js) in front of
// whatever prompt the base system set, and the handshake.
export function manifest() {
  return [
    `export PATH="${GUEST_BIN_DIR}:$PATH"`,
    "export TERM=xterm-256color",
    "export LANG=C.UTF-8",
    `PS1='${PROMPT_HOOK}'"$PS1"`,
    `echo "${MOUNTED_MARKER}"`,
    // Wait for the handshake (see HANDSHAKE).
    "read -r _handshake",
    "",
  ].join("\n");
}

// Text seen on the console, kept only as long as it takes to find the
// welcome line in it whichever way the line was split.
function welcomeWatcher() {
  const decoder = new TextDecoder();
  let carry = "";
  return (bytes) => {
    const text = carry + decoder.decode(bytes, { stream: true });
    const at = text.indexOf(MOUNTED_MARKER);
    carry = text.slice(-MOUNTED_MARKER.length);
    if (at === -1) {
      return false;
    }
    carry = "";
    return true;
  };
}

// Boot a machine.
//
// `sdk` is unkernel's module (createKernel, MemoryFs), `kernel` the
// kernel's URL or bytes. `onEvent` hears everything the page needs:
//
//   { type: "output", bytes }          console output, marks removed
//   { type: "frame", frame }           a keyframe was taken
//   { type: "frame-failed", id }       its snapshot did not complete
//   { type: "restored", id }           the machine went to keyframe id
//   { type: "exited", kind, reason }   the kernel stopped by itself
//
// Output before the shell's welcome line (the kernel's boot messages
// and the base system's own shell) is not passed on.
export async function startMachine({
  sdk,
  kernel,
  memoryMiB,
  cols,
  rows,
  spill = null,
  onEvent,
  log = () => {},
}) {
  const files = new sdk.MemoryFs();
  const FS = memoryFsCalls(files);
  const share = storeShare(FS);
  let size = { cols, rows };

  // What the console has said, as it arrives: the scanner removes the
  // prompt marks, the watcher finds each shell's welcome line.
  const scanner = promptScanner();
  const welcomed = welcomeWatcher();
  let shown = false;

  // The prompt the shell last drew, and when anything was last
  // printed or a line last typed.
  let lastPrompt = null;
  let lastOutputAt = 0;
  let commandRunning = false;
  // Whether anything was printed or typed since the last keyframe.
  let changed = false;

  let store = null;
  let lastKeyframeAt = 0;
  const frames = new Map();
  const timings = { restores: [] };

  // Operations that start or stop the kernel, or snapshot it, one at a
  // time.
  let serial = Promise.resolve();
  const queue = (work) => {
    const result = serial.then(work, work);
    serial = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  let vm = null;
  let module = null;

  // Which instance's output is heard: each instance gets a token of its
  // own when it is created, and output from an instance that has been
  // replaced is dropped.
  let listening = null;

  const hear = (token, bytes) => {
    if (token !== listening) {
      return;
    }
    lastOutputAt = performance.now();
    changed = true;

    // Each new shell (the first, and one started after an `exit`)
    // prints the welcome line and waits for the handshake.
    if (welcomed(bytes)) {
      if (!shown) {
        const text = new TextDecoder().decode(bytes);
        const at = text.indexOf(MOUNTED_MARKER);
        bytes = new TextEncoder().encode(text.slice(Math.max(0, at)));
      }
      shown = true;
      vm?.write(HANDSHAKE);
    }
    if (!shown) {
      return;
    }

    const { bytes: clean, marks } = scanner.feed(bytes);
    if (clean.length > 0) {
      onEvent({ type: "output", bytes: clean });
    }
    for (const mark of marks) {
      prompted(mark);
    }
  };

  // A prompt was drawn. A keyframe is taken there if a command ran
  // since the last one (its history entry differs), or if it is the
  // first prompt; an empty line adds nothing to the history and gets
  // none.
  let promptTimer = null;
  function prompted(mark) {
    const ran =
      lastPrompt === null ||
      mark.number !== lastPrompt.number ||
      mark.command !== lastPrompt.command;
    lastPrompt = mark;
    commandRunning = false;
    if (!ran) {
      return;
    }

    clearTimeout(promptTimer);
    const drawnAt = performance.now();
    const waitQuiet = () => {
      const now = performance.now();
      const quiet = now - lastOutputAt >= PROMPT_QUIET_MS;
      if (quiet || now - drawnAt >= PROMPT_QUIET_LIMIT_MS) {
        keyframe(KeyframeKind.PROMPT, mark).catch((err) =>
          log(`keyframe at a prompt failed: ${err.message}`),
        );
        return;
      }
      promptTimer = setTimeout(waitQuiet, PROMPT_QUIET_MS);
    };
    promptTimer = setTimeout(waitQuiet, PROMPT_QUIET_MS);
  }

  // A keyframe every RUNNING_PERIOD_MS while a command runs: a line
  // was typed since the last prompt, and no prompt has come back.
  const runningTimer = setInterval(() => {
    if (!commandRunning || vm === null) {
      return;
    }
    if (performance.now() - lastKeyframeAt < RUNNING_PERIOD_MS) {
      return;
    }
    keyframe(KeyframeKind.RUNNING, lastPrompt).catch((err) =>
      log(`keyframe while running failed: ${err.message}`),
    );
  }, RUNNING_CHECK_MS);

  async function createVm(restore) {
    const token = {};
    listening = token;
    const created = await sdk.createKernel({
      kernel: module ?? kernel,
      memoryMiB,
      worker: false,
      restore,
      mounts:
        restore === undefined
          ? undefined
          : { [SHARE_DIR]: { fs: files, readOnly: true } },
      onOutput: (bytes) => hear(token, bytes),
    });
    module ??= created.module;
    created.exited.then(({ kind, reason }) => {
      if (created === vm) {
        onEvent({ type: "exited", kind, reason });
      }
    });
    return created;
  }

  vm = await createVm(undefined);

  // Take one keyframe of the running machine, as a child of the
  // current one. Resolves to the keyframe, or null when the guest was
  // busy every time it was tried.
  function keyframe(kind, prompt) {
    return queue(() => keyframeNow(kind, prompt));
  }

  // The same, inside an operation already queued.
  async function keyframeNow(kind, prompt) {
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
      const frame = await snapshotOnce(kind, prompt);
      if (frame !== null || kind === KeyframeKind.RUNNING) {
        return frame;
      }
      await pause(RETRY_MS);
    }
    log(`no ${kind} keyframe: the guest stayed busy`);
    return null;
  }

  async function snapshotOnce(kind, prompt) {
    const startedAt = performance.now();
    let captured = null;
    const capture = (memory, free, freePages) => {
      const captureStart = performance.now();
      store ??= new KeyframeStore({ bytes: memory.byteLength, spill, log });
      const parent = store.current;
      const id = store.capture({ live: memory, free, freePages });
      const stored = store.frame(id);
      captured = {
        id,
        parent,
        kind,
        prompt,
        // Whether a command was running, which decides whether a
        // restored machine takes running keyframes.
        running: commandRunning,
        at: startedAt,
        pageCount: stored.pageCount,
        rawBytes: stored.rawBytes,
        captureMs: performance.now() - captureStart,
      };
      // Posted here, at the snapshot point, so that it lands between
      // the output from before the keyframe and the output after.
      onEvent({ type: "frame", frame: captured });
      return { freeBytes: stored.freeBytes };
    };

    try {
      const snapshot = await vm.snapshot({ capture });
      const { memory: _, ...meta } = snapshot;
      store.describe(captured.id, meta);
      captured.snapshotMs = performance.now() - startedAt;
      frames.set(captured.id, captured);
      lastKeyframeAt = performance.now();
      changed = false;
      return captured;
    } catch (err) {
      if (captured !== null) {
        onEvent({ type: "frame-failed", id: captured.id });
        log(`keyframe ${captured.id} failed after its capture: ${err.message}`);
      }
      return null;
    }
  }

  // Put the machine back at keyframe `id`: the old instance is stopped
  // and a fresh one resumes the keyframe's memory and devices, with the
  // share mounted again. Where the machine was is kept first, as a
  // keyframe of its own, unless nothing happened since the last one.
  function restore(id) {
    clearTimeout(promptTimer);
    return queue(async () => {
      if (changed) {
        await keyframeNow(KeyframeKind.DEPARTED, lastPrompt);
      }
      const startedAt = performance.now();
      const { memory, meta } = await store.moveTo(id);
      const movedAt = performance.now();

      const old = vm;
      vm = null;
      listening = null;
      old.stop({ reason: "replaced by a restore" });
      onEvent({ type: "restored", id });

      vm = await createVm({ ...meta, memory });
      vm.resize(size.cols, size.rows);
      const frame = frames.get(id);
      lastPrompt = frame.prompt;
      commandRunning = frame.running;
      lastKeyframeAt = performance.now();
      changed = false;
      timings.restores.push({
        id,
        moveMs: movedAt - startedAt,
        bootMs: performance.now() - movedAt,
      });
    });
  }

  return {
    files,
    share,

    // Mount the share, link /nix and the profile, and start the shell
    // trynix uses. `roots` are the selection's basenames, in order.
    async run(roots) {
      share.linkAll(share.written(), roots, Precedence.KEEP);
      FS.writeFile(MANIFEST_FILE, manifest());

      // The share is read-only to the guest: a store is immutable, and
      // everything the page adds later arrives from this side.
      await vm.mount(SHARE_DIR, files, { readOnly: true });

      // Every nix binary names its loader and libraries by /nix/store
      // paths, so the guest needs the store at /nix as well as where
      // the share is mounted.
      const setup = await vm.exec(SHELL, [
        "-c",
        [
          `ln -s ${SHARE_DIR}/nix /nix`,
          `ln -s ${MANIFEST_FILE} ${PROFILE_LINK}`,
          `echo ${PRINTK_LEVEL} > /proc/sys/kernel/printk`,
        ].join(" && "),
      ]);
      if (setup.exitCode !== 0) {
        throw new Error(`could not set the guest up: ${setup.stderr.trim()}`);
      }

      vm.resize(size.cols, size.rows);
      vm.write(END_FIRST_SHELL);

      // Read the programs ahead of the first command, as the qemu
      // guest's init does: a cold `jj --version` went from 0.27 s to
      // 0.19 s with the binary read first. Lowest priority, not
      // waited for.
      vm.exec(SHELL, [
        "-c",
        `nice -n 19 cat ${GUEST_BIN_DIR}/* > /dev/null 2>&1`,
      ]).catch(() => {});
    },

    // Typed input. A line typed while no prompt is up means a command
    // is running, which is when the periodic keyframes are taken.
    write(data) {
      if (/[\r\n]/.test(data)) {
        commandRunning = true;
      }
      changed = true;
      vm?.write(data);
    },

    resize(newCols, newRows) {
      size = { cols: newCols, rows: newRows };
      vm?.resize(newCols, newRows);
    },

    exec: (file, args, opts) => vm.exec(file, args, opts),

    keyframe: (kind = KeyframeKind.PROMPT) => keyframe(kind, lastPrompt),
    restore,

    // What the keyframes cost, for the measurements in docs/scrub.md.
    stats() {
      return {
        frames: [...frames.values()],
        store: store?.stats() ?? null,
        restores: timings.restores,
      };
    },

    async stop() {
      clearInterval(runningTimer);
      clearTimeout(promptTimer);
      await queue(async () => {
        await vm?.stop({ reason: "page closed" });
      });
      await store?.clear();
    },
  };
}
