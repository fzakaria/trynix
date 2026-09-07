// The page's end of the translated lane inside the VM.
//
// With fast=1, the bin farm's links for the selected programs point at
// nix/exec-stub/stub.c instead of the binaries. A command typed at the
// guest's shell then announces itself as a frame on the console, an
// OSC sequence this module strips from the console stream before the
// terminal draws it, and waits. The page runs the program through a
// kernel worker (site/js/x86/kernel-worker.js) over the closure's
// shared buffers with the terminal attached to it through a pty of
// its own, so keystrokes and output never cross the emulated serial
// line; when the program exits, the status goes back to the stub as
// a frame typed into the guest. Output for a stdout that is not the
// terminal goes back the same way, since the guest has to see it.
//
// A frame is ESC ] trynix ; kind ; payload BEL.
/* global openpty */

import { log } from "./log.js";
import { createInputRing, InputWriter } from "./x86/stdio-shared.js";
import {
  loadTranslations,
  openTranslationCache,
  storeTranslation,
} from "./x86/cache.js";

const EXEC_DIR = "/share/exec";
const STUB_PATH = `${EXEC_DIR}/trynix-exec`;
const STUB_URL = "exec/trynix-exec";
const FRAME_START = "\x1b]trynix;";
const FRAME_END = "\x07";

// The lane's own view of the environment: the guest's PATH names the
// farm, which the lane does not have, so the closure's bin directories
// take its place.
function laneEnvironment(guestEnv, binDirs) {
  const env = guestEnv.filter((e) => !e.startsWith("PATH="));
  env.push(`PATH=${binDirs.join(":")}`);
  if (!env.some((e) => e.startsWith("HOME="))) {
    env.push("HOME=/home/user");
  }
  env.push("TRYNIX_LANE=translated");
  return env;
}

const decodeBase64 = (text) =>
  Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
const encodeBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

// Splits a console stream into what the terminal should see and the
// frames in it, across chunk boundaries.
class FrameScanner {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.pending = "";
    this.decoder = new TextDecoder();
  }

  // Returns the text to show.
  feed(data) {
    const text =
      typeof data === "string"
        ? data
        : this.decoder.decode(data, { stream: true });
    let input = this.pending + text;
    this.pending = "";
    let out = "";
    for (;;) {
      const start = input.indexOf(FRAME_START);
      if (start === -1) {
        // Keep a possible frame start that is still arriving.
        const tail = input.lastIndexOf("\x1b");
        if (tail !== -1 && FRAME_START.startsWith(input.slice(tail))) {
          out += input.slice(0, tail);
          this.pending = input.slice(tail);
        } else {
          out += input;
        }
        return out;
      }
      out += input.slice(0, start);
      const end = input.indexOf(FRAME_END, start);
      if (end === -1) {
        this.pending = input.slice(start);
        return out;
      }
      const body = input.slice(start + FRAME_START.length, end);
      const at = body.indexOf(";");
      this.onFrame(body.slice(0, at), body.slice(at + 1));
      input = input.slice(end + 1);
    }
  }
}

export class FastLane {
  constructor() {
    this.storePaths = null;
    this.binDirs = [];
    this.translations = [];
    this.cache = null;
    this.writers = [];
    this.guest = null;
    this.active = null;
    this.scanner = new FrameScanner((kind, payload) =>
      this.onFrame(kind, payload),
    );
  }

  // The pty master the terminal is attached to instead of the guest's:
  // the guest's output minus frames, and keystrokes to the guest or to
  // the running lane program.
  wrap(master) {
    this.guest = master;
    master.onWrite(([data, callback]) => {
      const shown = this.scanner.feed(data);
      if (shown.length === 0) {
        callback();
        return;
      }
      this.show(shown, callback);
    });
    return {
      onWrite: (cb) => {
        this.writers.push(cb);
      },
      ldisc: {
        writeFromLower: (data) => {
          if (this.active !== null) {
            this.active.master.ldisc.writeFromLower(data);
          } else {
            master.ldisc.writeFromLower(data);
          }
        },
      },
      notifyResize: (rows, cols) => {
        master.notifyResize(rows, cols);
        if (this.active !== null) {
          this.active.master.notifyResize(rows, cols);
        }
      },
    };
  }

  show(data, callback = () => {}) {
    let remaining = this.writers.length;
    if (remaining === 0) {
      callback();
      return;
    }
    for (const cb of this.writers) {
      cb([
        data,
        () => {
          if (--remaining === 0) {
            callback();
          }
        },
      ]);
    }
  }

  // The closure, once fetched: entries over shared buffers, and the
  // bin directories the lane searches.
  async setClosure(storePaths, binDirs) {
    this.storePaths = storePaths;
    this.binDirs = binDirs;
    this.cache = await openTranslationCache();
    this.translations = await loadTranslations(
      this.cache,
      storePaths.map((s) => s.path),
    );
    log(
      `fast lane: ${this.translations.length} cached regions for the closure`,
    );
  }

  // Puts the stub on the share and points the farm's links for
  // `programs` at it.
  async install(FS, programs) {
    const response = await fetch(STUB_URL);
    if (!response.ok) {
      throw new Error(`no exec stub at ${STUB_URL}`);
    }
    const stub = new Uint8Array(await response.arrayBuffer());
    try {
      FS.mkdir(EXEC_DIR);
    } catch {
      // exists
    }
    FS.writeFile(STUB_PATH, stub);
    FS.chmod(STUB_PATH, 0o755);
    for (const name of programs) {
      const link = `/share/bin/${name}`;
      try {
        FS.unlink(link);
      } catch {
        // none yet
      }
      FS.symlink(STUB_PATH, link);
    }
    log(`fast lane: ${programs.length} programs linked to the stub`);
  }

  sendToGuest(kind, payload) {
    this.guest.ldisc.writeFromLower(
      `${FRAME_START}${kind};${payload}${FRAME_END}`,
    );
  }

  onFrame(kind, payload) {
    if (kind !== "start") {
      return;
    }
    if (this.active !== null) {
      this.sendToGuest("exit", "126");
      return;
    }
    if (this.storePaths === null) {
      this.show("trynix: the lane is not ready yet\r\n");
      this.sendToGuest("exit", "127");
      return;
    }
    try {
      this.start(decodeBase64(payload));
    } catch (err) {
      log(`fast lane: ${err.message}`);
      this.sendToGuest("exit", "127");
    }
  }

  // One request: a kernel worker for the program, a pty of its own for
  // the terminal, and the exit status back to the stub.
  start(request) {
    const fields = new TextDecoder().decode(request).split("\0");
    let i = 0;
    const program = fields[i++];
    const argv = [program];
    while (fields[i] !== "") {
      argv.push(fields[i++]);
    }
    i++;
    const env = [];
    while (fields[i] !== "") {
      env.push(fields[i++]);
    }
    i++;
    const cwd = fields[i++];
    const [rows, cols] = (fields[i++] ?? "24 80").split(" ").map(Number);
    const stdinIsTty = fields[i++] === "tty";
    const stdoutIsTty = fields[i++] === "tty";
    // Piped stdin follows as raw bytes: find its offset in the request.
    let piped = null;
    if (!stdinIsTty) {
      let offset = 0;
      for (let k = 0; k < i; k++) {
        offset = request.indexOf(0, offset) + 1;
      }
      piped = request.subarray(offset, request.length - 1);
    }

    const target = this.resolve(program);
    if (target === null) {
      this.show(`trynix: no ${program} in the closure\r\n`);
      this.sendToGuest("exit", "127");
      return;
    }
    argv[0] = target;
    log(`fast lane: ${argv.join(" ")}`);

    const { master, slave } = openpty();
    const ring = createInputRing();
    const input = new InputWriter(ring);
    input.setSize(rows, cols);
    slave.onReadable(() => input.push(Uint8Array.from(slave.read())));
    slave.onSignal((sig) => {
      if (sig === "SIGINT") {
        input.interrupt();
      }
    });
    master.onWrite(([data, callback]) => this.show(data, callback));
    if (piped !== null) {
      input.push(piped);
      input.close();
    }

    const started = performance.now();
    const worker = new Worker(
      new URL("./x86/kernel-worker.js", import.meta.url),
      { type: "module" },
    );
    this.active = { master, worker };
    const finish = (code) => {
      this.active = null;
      worker.terminate();
      this.sendToGuest("exit", String(code));
      log(
        `fast lane: ${program} exited ${code} after ${((performance.now() - started) / 1000).toFixed(1)} s`,
      );
    };
    worker.onmessage = (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "output":
          if (stdoutIsTty || msg.stream === "stderr") {
            slave.write(Array.from(msg.bytes));
          } else {
            this.sendToGuest("out", encodeBase64(msg.bytes));
          }
          break;
        case "termios":
          slave.ioctl("TCSETS", msg.termios);
          break;
        case "translated":
          storeTranslation(this.cache, msg).catch(() => {});
          break;
        case "log":
          log(`[lane] ${msg.text}`);
          break;
        case "exit":
          finish(msg.code);
          break;
        default:
          break;
      }
    };
    worker.onerror = (e) => {
      log(`fast lane: worker error: ${e.message}`);
      finish(139);
    };
    worker.postMessage({
      type: "start",
      argv,
      envp: laneEnvironment(env, this.binDirs),
      cwd: cwd.startsWith("/nix/store") ? cwd : "/home/user",
      storePaths: this.storePaths,
      stdin: ring,
      trace: false,
      translations: this.translations,
      files: {
        "/etc/passwd":
          "root:x:0:0:root:/root:/bin/sh\nuser:x:1000:100:user:/home/user:/bin/sh\n",
        "/etc/group": "root:x:0:\nusers:x:100:\n",
      },
    });
  }

  // The store path's program a name refers to, searching the closure's
  // bin directories in order.
  resolve(name) {
    for (const dir of this.binDirs) {
      const storePath = dir.slice(0, -"/bin".length);
      const sp = this.storePaths.find((s) => s.path === storePath);
      if (sp === undefined) {
        continue;
      }
      if (sp.entries.some((e) => e.path === `bin/${name}`)) {
        return `${dir}/${name}`;
      }
    }
    return null;
  }
}

// The entries of one NAR as views into a SharedArrayBuffer, so the
// share, the kernel and every process worker read the same bytes.
export function shareEntries(entries) {
  const shared = new Map();
  return entries.map((entry) => {
    if (entry.data === undefined) {
      return entry;
    }
    let buffer = shared.get(entry.data.buffer);
    if (buffer === undefined) {
      buffer = new SharedArrayBuffer(entry.data.buffer.byteLength);
      new Uint8Array(buffer).set(new Uint8Array(entry.data.buffer));
      shared.set(entry.data.buffer, buffer);
    }
    return {
      ...entry,
      data: new Uint8Array(
        buffer,
        entry.data.byteOffset,
        entry.data.byteLength,
      ),
    };
  });
}
