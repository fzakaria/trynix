// The kernel's Worker in the page. The page sends `start` with the
// closure (store paths whose NAR entries are views into shared
// buffers), the program, and the input ring; the kernel spawns process
// workers from here, posts their output to the page, and reports the
// exit and every new translation.
import { Kernel } from "./kernel.js";
import { MemoryFs } from "./fs-memory.js";
import { InputReader } from "./stdio-shared.js";
import { spawnWorker } from "./platform.js";

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type !== "start") {
    return;
  }
  const fs = new MemoryFs();
  for (const { path, entries } of msg.storePaths) {
    fs.addStorePath(path, entries);
  }
  for (const [path, text] of Object.entries(msg.files ?? {})) {
    fs.writeFile(path, text);
  }

  const ring = new InputReader(msg.stdin);
  const tty = {
    available: () => ring.available(),
    closed: () => false,
    read: (out) => ring.read(out),
    size: () => ring.size(),
    takeInterrupt: () => ring.takeInterrupt(),
    write: (stream, bytes) =>
      self.postMessage({ type: "output", stream, bytes }),
    setTermios: (t) => self.postMessage({ type: "termios", termios: t }),
  };

  // Translations from the page's cache, made shareable once so every
  // worker sees the same bytes at no copy.
  const translations = new Map();
  for (const entry of msg.translations ?? []) {
    const bytes = new Uint8Array(new SharedArrayBuffer(entry.bytes.length));
    bytes.set(entry.bytes);
    translations.set(entry.key, {
      bytes,
      offsets: entry.offsets.map((o) => BigInt(o)),
      unsupported: entry.unsupported.map(([o, why]) => [BigInt(o), why]),
    });
  }

  const workerUrl = new URL("./process-worker.js", import.meta.url);
  const kernel = new Kernel({
    fs,
    tty,
    spawn: (data) =>
      spawnWorker(workerUrl, { ...data, trace: msg.trace, stats: true }),
    translations,
    onTranslation: (entry) =>
      self.postMessage({
        type: "translated",
        key: entry.key,
        bytes: entry.bytes.slice(),
        offsets: entry.offsets.map((o) => o.toString()),
        unsupported: entry.unsupported.map(([o, why]) => [o.toString(), why]),
      }),
    log: (text) => self.postMessage({ type: "log", text }),
  });
  const status = await kernel.start({
    argv: msg.argv,
    envp: msg.envp,
    cwd: msg.cwd,
  });
  self.postMessage({ type: "exit", code: status });
};
