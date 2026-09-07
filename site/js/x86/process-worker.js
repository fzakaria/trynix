// The entry of every process and thread worker.
//
// The kernel spawns it with one of three kinds of start: `exec`, a
// program to load into a fresh memory; `fork`, a copy of the parent's
// memory and register file to resume; `thread`, the process's own
// memory to share with a register file of its own. From then on the
// worker runs translated code, makes requests over its channel, and
// handles execve by building a fresh image in place.
import { Channel } from "./channel.js";
import { Machine, ProcessExit, GuestFault } from "./machine.js";
import { ExecRequest, Process } from "./process.js";
import { OP } from "./ops.js";
import { workerPort } from "./platform.js";

const port = await workerPort();
const d = port.data;
const channel = new Channel(d.channel, new Int32Array(d.bell));
const log = (text) =>
  channel.call(OP.LOG, [], new TextEncoder().encode(`${text}\0`));
const trace = d.trace
  ? (line) => port.postMessage({ type: "log", text: `[sys ${d.pid}] ${line}` })
  : null;

function newMachine(memory = null, lookupBase = Number(d.lookupBase)) {
  return new Machine({
    pages: d.memoryPages,
    shared: true,
    memory,
    lookupBase,
  });
}

function newProcess(machine) {
  const proc = new Process({
    machine,
    channel,
    pid: d.pid,
    tid: d.tid,
    ppid: d.ppid,
    trace,
  });
  proc.seedTranslations(d.translations);
  if (d.stats) {
    const started = performance.now();
    proc.beforeExit = () => {
      const tr = machine.translator;
      log(
        `[stats] ${((performance.now() - started) / 1000).toFixed(2)} s, ${tr.regions} regions translated (${tr.blocks} blocks), ` +
          `${tr.cachedRegions} from cache (${tr.cachedBlocks} blocks), ${(tr.bytesEmitted / 1048576).toFixed(1)} MB of wasm, ` +
          `${tr.translateMs.toFixed(0)} ms translating, ${proc.syscalls} syscalls`,
      );
    };
  }
  return proc;
}

let machine;
let proc;
let entry;

try {
  if (d.kind === "exec") {
    machine = newMachine();
    port.postMessage({ type: "ready", memory: machine.memory });
    proc = newProcess(machine);
    entry = proc.load(d.argv[0], d.argv, d.envp);
  } else if (d.kind === "fork") {
    machine = newMachine();
    const parent = new Uint8Array(d.parentMemory.buffer);
    if (parent.length > machine.size) {
      machine.grow((parent.length - machine.size) / 65536);
    }
    for (const [lo, hi] of d.ranges) {
      const a = Number(BigInt(lo));
      const b = Math.min(Number(BigInt(hi)), parent.length);
      machine.u8.set(parent.subarray(a, b), a);
    }
    port.postMessage({ type: "ready", memory: machine.memory });
    proc = newProcess(machine);
    proc.restore(JSON.parse(d.state));
    // The lookup copied from the parent names its table, not ours.
    machine.u8.fill(
      0,
      machine.lookupBase,
      machine.lookupBase + 16 * 1024 * 1024,
    );
    channel.call(OP.SPAWNED, []);
    entry = machine.reg("rip");
  } else if (d.kind === "thread") {
    machine = newMachine(d.memory);
    proc = newProcess(machine);
    const state = JSON.parse(d.state);
    proc.restore(state);
    proc.clearTid = BigInt(state.clearTid);
    if (state.setTid !== "0") {
      machine.write32(BigInt(state.setTid), d.tid);
    }
    channel.call(OP.SPAWNED, []);
    entry = machine.reg("rip");
  } else {
    throw new Error(`unknown start ${d.kind}`);
  }

  for (;;) {
    try {
      proc.entry = entry;
      const exit = proc.run();
      log(`guest stopped: ${exit.reason} at 0x${exit.rip.toString(16)}`);
      channel.call(OP.EXIT_GROUP, [1]);
      break;
    } catch (e) {
      if (e instanceof ProcessExit) {
        break;
      }
      if (e instanceof ExecRequest) {
        channel.call(OP.EXECVE, [], new TextEncoder().encode(`${e.path}\0`));
        const fresh = newMachine();
        port.postMessage({ type: "ready", memory: fresh.memory });
        const next = newProcess(fresh);
        next.localTranslations = proc.localTranslations;
        next.sigmask = proc.sigmask;
        // Ignored dispositions survive an exec; handlers do not.
        next.sigactions = proc.sigactions.map((a) =>
          a !== null && a.handler === 1n ? a : null,
        );
        machine = fresh;
        proc = next;
        entry = proc.load(e.path, e.argv, e.envp);
        continue;
      }
      throw e;
    }
  }
} catch (e) {
  const where = machine ? ` (rip 0x${machine.reg("rip").toString(16)})` : "";
  log(
    `${e instanceof GuestFault ? "guest fault" : "error"}: ${e.message}${where}`,
  );
  if (!(e instanceof GuestFault)) {
    log(e.stack ?? "");
  }
  channel.call(OP.EXIT_GROUP, [139]);
}
