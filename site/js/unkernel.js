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
//   the kernel runs in a worker of the page's own, the guest worker
//   (unkernel-worker.js, machine.js), with the share's file system
//   beside it, so nothing is copied into an emulator's heap and a busy
//   guest leaves this thread alone;
//
//   the guest can be taken back in time. The worker keeps keyframes of
//   the whole machine (keyframes.js), and the timeline under the
//   terminal (timeline.js) goes back to one. This side keeps what the
//   console drew between keyframes (screen.js), because the terminal's
//   screen is page state that no snapshot of the guest holds.
//
// startUnkernel returns the same handle boot.js's startVM does, and
// app.js drives either one without knowing which engine made the
// handle.

import { GUEST_BIN_DIR, GUEST_STORE_DIR } from "./share.js";
import { programsOf } from "./store.js";
import { openTerminal } from "./terminal.js";
import { guestDriver } from "./agent.js";
import { consoleRecorder, pause } from "./console.js";
import { UNKERNEL_MEMORY_MIB } from "./config.js";
import { log } from "./log.js";
import { MOUNTED_MARKER } from "./machine.js";
import { ScreenLog } from "./screen.js";
import { LIVE, Timeline } from "./timeline.js";

// The shell programs run through.
const SHELL = "/bin/sh";

// What the line editor prints for the handshake's Ctrl-L before the
// prompt (machine.js, HANDSHAKE): cursor home, erase to the end of the
// screen. The shell is ready once this follows the welcome line.
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

// The guest worker, as calls that resolve with its answers and a
// stream of its events (unkernel-worker.js describes both).
function guestWorker() {
  const worker = new Worker(new URL("./unkernel-worker.js", import.meta.url), {
    type: "module",
  });
  const waiting = new Map();
  let next = 0;
  let onEvent = () => {};

  worker.onmessage = ({ data }) => {
    if (data.event !== undefined) {
      onEvent(data.event);
      return;
    }
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.ok) {
      call.resolve(data.value);
    } else {
      call.reject(new Error(data.error));
    }
  };
  worker.onerror = (event) => log(`guest worker: ${event.message}`);

  return {
    call(op, args = [], transfer = []) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, op, args }, transfer);
      });
    },
    listen(callback) {
      onEvent = callback;
    },
  };
}

// The buffers behind a NAR's file contents, each once, to hand to the
// worker rather than copy: the page drops the entries once they are
// written.
function buffersOf(entries) {
  const buffers = new Set();
  for (const entry of entries) {
    const buffer = entry.data?.buffer;
    if (buffer instanceof ArrayBuffer) {
      buffers.add(buffer);
    }
  }
  return [...buffers];
}

// engine: { main, kernel }, the versioned URLs of the SDK's browser
// entry and of the kernel. timelineElement holds the timeline
// (index.html).
//
// Resolves once the kernel is running and the share is writable. The
// share lives in the worker, so the closure streams into it whether or
// not the guest has mounted anything yet.
export async function startUnkernel({
  terminalElement,
  keyBarElement,
  timelineElement,
  engine,
}) {
  const ui = await openTerminal(terminalElement, keyBarElement);
  const terminal = ui.terminal;
  const guest = guestWorker();
  const console_ = consoleRecorder();
  const screen = new ScreenLog();

  // While the terminal shows a keyframe's screen rather than the live
  // one (a preview while dragging, or a restore under way), live output
  // is recorded but not drawn and nothing typed reaches the guest.
  let previewing = false;
  // While the terminal is being rebuilt from recorded bytes it answers
  // the queries in them (the line editor's cursor question), and those
  // answers belong to a guest long gone.
  let replaying = false;

  let draw = () => {};
  const port = {
    send(data) {
      if (previewing || replaying) {
        return;
      }
      guest.call("input", [data]).catch(() => {});
    },
    onOutput(callback) {
      draw = callback;
    },
    resize(rows, cols) {
      guest.call("resize", [cols, rows]).catch(() => {});
    },
  };
  ui.attach(port);

  // Rebuild the screen from bytes the console drew.
  function redraw(bytes) {
    replaying = true;
    try {
      terminal.reset();
      terminal.write(bytes);
    } finally {
      replaying = false;
    }
  }

  // The keyframe tree as the page knows it, and the keyframe the live
  // machine continues from.
  const frames = new Map();
  let current = null;

  // Show position `id` (a keyframe, or LIVE) without moving the
  // machine.
  function preview(id) {
    if (id === LIVE) {
      previewing = false;
      redraw(screen.live());
      return;
    }
    previewing = true;
    redraw(screen.screenAt(id));
  }

  // Move the machine to keyframe `id`. The terminal keeps showing the
  // keyframe's screen while the restore runs; the restored kernel's
  // first output is drawn on it.
  async function go(id) {
    if (id === LIVE) {
      preview(LIVE);
      return;
    }
    preview(id);
    timeline.setBusy(true);
    const startedAt = performance.now();
    try {
      await guest.call("restore", [id]);
      log(
        `went to keyframe ${id} in ${Math.round(performance.now() - startedAt)} ms`,
      );
    } catch (err) {
      log(`could not go to keyframe ${id}: ${err.message}`);
      preview(LIVE);
    } finally {
      timeline.setBusy(false);
      timeline.update(frames, current);
      terminal.focus();
    }
  }

  const timeline = new Timeline(timelineElement, { preview, go });

  guest.listen((event) => {
    switch (event.type) {
      case "output":
        console_.hear(event.bytes);
        screen.append(event.bytes);
        if (!previewing) {
          draw(event.bytes);
        }
        return;
      case "frame":
        screen.frame(event.frame.id, event.frame.parent);
        frames.set(event.frame.id, { ...event.frame, failed: false });
        current = event.frame.id;
        timeline.update(frames, current);
        return;
      case "frame-failed":
        frames.get(event.id).failed = true;
        timeline.update(frames, current);
        return;
      case "restored":
        // Sent before the restored kernel says anything, so what it
        // says next is drawn on the keyframe's screen.
        screen.restored(event.id);
        current = event.id;
        previewing = false;
        redraw(screen.screenAt(event.id));
        return;
      case "exited":
        log(
          `unkernel exited: ${event.kind}${event.reason ? ` (${event.reason})` : ""}`,
        );
        return;
      case "log":
        log(event.message);
    }
  });

  await guest.call("boot", [
    {
      sdk: new URL(engine.main, location.href).href,
      kernel: new URL(engine.kernel, location.href).href,
      memoryMiB: UNKERNEL_MEMORY_MIB,
      cols: terminal.cols,
      rows: terminal.rows,
    },
  ]);
  addEventListener("pagehide", () => guest.call("close").catch(() => {}));

  // Wait until the guest can see every path in `paths`, or the limit
  // passes. Asking is what makes the answer fresh: each lookup past the
  // timeout goes back to the page's file system.
  async function visible(paths) {
    const deadline = Date.now() + VISIBLE_LIMIT_MS;
    for (;;) {
      const seen = await guest.call("exec", [
        SHELL,
        ["-c", ALL_EXIST, SHELL, ...paths],
      ]);
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

  // The share as app.js writes it: each parsed NAR goes to the worker,
  // and the programs it offers are noted here, where app.js asks.
  const programs = new Map();
  const share = {
    write(basename, entries) {
      if (programs.has(basename)) {
        return;
      }
      programs.set(basename, programsOf(entries));
      guest
        .call("write", [basename, entries], buffersOf(entries))
        .catch((err) => log(`could not write ${basename}: ${err.message}`));
    },
  };

  // The handle everything outside the page reaches the guest through
  // (boot.js says who uses it). `scrub` is the timeline from code: the
  // keyframes, where the machine is, going to one, and what keyframes
  // and restores have cost.
  window.trynix = {
    ...guestDriver({
      send: (data) => port.send(data),
      transcript: console_.transcript,
    }),
    terminal,
    scrub: {
      frames: () => [...frames.values()],
      current: () => current,
      go,
      stats: () => guest.call("stats"),
    },
  };

  return {
    terminal,
    share,

    // Finish the share, mount it, and start the shell. `roots` are the
    // basenames the reader selected, in selection order. Resolves when
    // the guest is at its prompt.
    async run(roots) {
      await guest.call("run", [roots]);

      // The shell is ready once it has sourced the manifest, taken the
      // handshake and redrawn its prompt on a cleared screen
      // (machine.js, HANDSHAKE).
      await console_.waitFor(MOUNTED_MARKER);
      await console_.waitFor(REDRAWN);
    },

    // Add store paths to a guest that is already running. The share is
    // memory the guest reads through 9p, so writing a path is enough:
    // no remount, no reboot. Resolves once the guest sees the new paths
    // and the roots' programs (see visible), so "added" is true by the
    // time the page says so.
    async add(unpacked, roots) {
      const basenames = [];
      while (unpacked.length > 0) {
        const { basename, entries } = unpacked.shift();
        share.write(basename, entries);
        basenames.push(basename);
      }
      await guest.call("link", [basenames, roots]);

      const added = roots.filter((basename) => basenames.includes(basename));
      await visible([
        ...basenames.map((basename) => `${GUEST_STORE_DIR}/${basename}`),
        ...added.flatMap((basename) =>
          (programs.get(basename) ?? []).map(
            (name) => `${GUEST_BIN_DIR}/${name}`,
          ),
        ),
      ]);
    },

    // The programs a written path offers, by basename.
    programsOf: (basename) => programs.get(basename) ?? [],
  };
}
