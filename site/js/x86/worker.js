// The Worker a translated process runs in.
//
// The page sends one `start` message: the program and its arguments,
// the closure as store paths with their NAR entries, and the shared
// input ring. From then on the process runs to completion on this
// thread, its output posted back as it is written, its reads of
// standard input blocking on the ring. The page hears `exit` with the
// code and the translator's counters.
import { Machine, GuestFault } from "./machine.js";
import { Process } from "./linux.js";
import { MemoryFs } from "./fs-memory.js";
import { InputReader } from "./stdio-shared.js";

// 1 GiB of guest address space; the runtime's tables sit at its top.
const MEMORY_PAGES = 16384;

function post(type, payload) {
  self.postMessage({ type, ...payload });
}

// Output streams post bytes to the page, copying so the guest's
// memory is never shared with the message.
function outputStream(name) {
  return {
    isatty: true,
    write: (bytes) => {
      post("output", { stream: name, bytes: bytes.slice() });
      return bytes.length;
    },
    size: () => ({ rows: 24, cols: 80 }),
  };
}

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type !== "start") {
    return;
  }
  const t0 = performance.now();
  const fs = new MemoryFs();
  for (const { path, entries } of msg.storePaths) {
    fs.addStorePath(path, entries);
  }
  for (const [path, text] of Object.entries(msg.files ?? {})) {
    fs.writeFile(path, text);
  }

  const stdin = new InputReader(msg.stdin);
  const stdout = outputStream("stdout");
  const stderr = outputStream("stderr");
  // The terminal's size and its line discipline travel with stdin.
  stdout.size = () => stdin.size();
  stderr.size = () => stdin.size();
  const setTermios = (t) => post("termios", { termios: t });
  stdin.setTermios = setTermios;
  stdout.setTermios = setTermios;
  stderr.setTermios = setTermios;

  const machine = new Machine({ pages: MEMORY_PAGES });
  const proc = new Process({
    machine,
    fs,
    argv: msg.argv,
    envp: msg.envp,
    cwd: msg.cwd,
    stdio: { stdin, stdout, stderr },
    trace: msg.trace ? (line) => post("trace", { line }) : null,
  });

  let code = 0;
  try {
    proc.load(msg.argv[0]);
    const loaded = performance.now();
    const exit = proc.run();
    const finished = performance.now();
    if (exit.reason === "exit") {
      code = exit.code;
    } else {
      post("log", { text: `guest stopped: ${exit.reason} at 0x${exit.rip.toString(16)}` });
      code = 1;
    }
    const tr = machine.translator;
    post("exit", {
      code,
      stats: {
        loadMs: loaded - t0,
        runMs: finished - loaded,
        regions: tr.regions,
        blocks: tr.blocks,
        wasmBytes: tr.bytesEmitted,
        translateMs: tr.translateMs,
        syscalls: proc.syscalls,
      },
    });
  } catch (e) {
    const where = `rip 0x${machine.reg("rip").toString(16)}`;
    post("log", { text: `${e instanceof GuestFault ? "guest fault" : "error"}: ${e.message} (${where})` });
    post("exit", { code: 139, stats: null });
  }
};
