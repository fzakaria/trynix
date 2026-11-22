// Record a run of the unkernel guest with its real inputs, then replay
// it from the same snapshot to points inside it.
//
// determinism.mjs showed that two runs from one snapshot are the same
// when the clock, the randomness and the input timing are pinned. A
// pinned clock is no use to the page: it makes `sleep` take no time.
// This is the other way to pin them, the one the timeline would use to
// scrub inside a command: let the guest run on real inputs, record what
// every import call returned and wrote into the kernel's memory, and
// on replay hand back the recorded values instead of asking the host.
//
// The record run types commands that read the clock, the randomness and
// the console, sleep, and loop. The replay restores the same snapshot
// and replays up to each of several checkpoints, comparing a hash of
// all of memory there with the one the record run took at the same
// import call, then switches the guest to live inputs and checks that
// it answers.
//
//   node --experimental-wasm-jspi experiments/replay.mjs <dir>
//
// <dir> is a vendored SDK, as in determinism.mjs.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const dir = process.argv[2];
const sdk = await import(new URL(`file://${dir}/web.mjs`).href);
const module = await WebAssembly.compile(
  await readFile(`${dir}/unkernel.wasm`),
);

const MEMORY_MIB = 256;
const COMMANDS =
  "cat /proc/uptime ; date ; echo $RANDOM ; sleep 1 ; " +
  "head -c 8 /dev/urandom | od -x | head -n 1 ; " +
  "i=0; while [ $i -lt 100000 ]; do i=$((i+1)); done; echo D''ONE\n";
const DONE = "DONE\r\n";
// Where the record run hashes memory: every this many import calls.
const CHECK_EVERY = 4000;
const LIMIT_MS = 120000;
const POINTER_BYTES = 4;
const CLOCK_BYTES = 8;
const EVENT_BYTES = 32;

// The imports whose results come from outside the kernel; every other
// import (task switches, JIT compiles, console writes) runs for real on
// replay too, since it depends only on what the kernel asks.
const RECORDED = new Set([
  "clock_time_get",
  "random_get",
  "fd_read",
  "poll_oneoff",
  "sched_yield",
]);

const hashOf = (k) => createHash("sha256").update(k.u8()).digest("hex");

// What an import call wrote into memory, by import: [address, length]
// pairs read after the call, from its arguments as they were before.
function writesOf(name, k, args, result) {
  const n = (value) => Number(value);
  const dv = k.dv();
  switch (name) {
    case "clock_time_get":
      return [[n(args[2]), CLOCK_BYTES]];
    case "random_get":
      return [[n(args[0]), n(args[1])]];
    case "fd_read": {
      if (result !== 0) {
        return [];
      }
      const total = dv.getUint32(n(args[3]), true);
      const regions = [[n(args[3]), POINTER_BYTES]];
      let left = total;
      for (const [at, length] of k.wasi.iovecs(n(args[1]), n(args[2]))) {
        if (left === 0) {
          break;
        }
        regions.push([at, Math.min(length, left)]);
        left -= Math.min(length, left);
      }
      return regions;
    }
    case "poll_oneoff": {
      const count = dv.getUint32(n(args[3]), true);
      return [
        [n(args[3]), POINTER_BYTES],
        [n(args[1]), count * EVENT_BYTES],
      ];
    }
    default:
      return [];
  }
}

// Wrap the imports of the next kernel created. `mode.call(i, k)` runs
// at the start of each call; `mode.replaying(i)` says whether call i is
// answered from the record.
function instrument(mode) {
  const original = sdk.Kernel.prototype.imports;
  sdk.Kernel.prototype.imports = function () {
    const k = this;
    const Suspending = WebAssembly.Suspending;
    const inner = new Map();
    WebAssembly.Suspending = function (fn) {
      const wrapped = new Suspending(fn);
      inner.set(wrapped, fn);
      return wrapped;
    };
    let imports;
    try {
      imports = original.call(this);
    } finally {
      WebAssembly.Suspending = Suspending;
    }
    const irq = () => k.dv().getUint32(k.irqAddr, true);

    for (const table of Object.values(imports)) {
      for (const [name, value] of Object.entries(table)) {
        const asyncFn = inner.get(value);
        const fn = asyncFn ?? value;
        if (typeof fn !== "function") {
          continue;
        }
        const wrapped = (...args) => {
          const i = mode.calls++;
          mode.call(i, k);

          // Replay: the recorded result and writes, and the interrupt
          // word as it was when the call returned.
          if (RECORDED.has(name) && mode.replaying(i)) {
            const entry = mode.record[i];
            if (entry.name !== name) {
              throw new Error(
                `call ${i}: recorded ${entry.name}, replay asked ${name}`,
              );
            }
            for (const [at, bytes] of entry.writes) {
              k.u8().set(bytes, at);
            }
            k.dv().setUint32(k.irqAddr, entry.irq, true);
            return entry.result;
          }

          const result = fn(...args);
          const keep = (value) => {
            if (mode.recording) {
              const writes = RECORDED.has(name)
                ? writesOf(name, k, args, value).map(([at, length]) => [
                    at,
                    k.u8().slice(at, at + length),
                  ])
                : [];
              mode.record[i] = { name, result: value, writes, irq: irq() };
            }
            return value;
          };
          return result instanceof Promise ? result.then(keep) : keep(result);
        };
        table[name] = asyncFn === undefined ? wrapped : new Suspending(wrapped);
      }
    }
    return imports;
  };
  return () => {
    sdk.Kernel.prototype.imports = original;
  };
}

async function until(check, what) {
  const deadline = Date.now() + LIMIT_MS;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function bootSnapshot() {
  const vm = await sdk.createKernel({
    kernel: module,
    memoryMiB: MEMORY_MIB,
    vsock: false,
    worker: false,
  });
  let out = "";
  vm.onOutput((bytes) => {
    out += new TextDecoder().decode(bytes);
  });
  vm.write("echo READ''Y\n");
  await until(() => out.includes("READY"), "the first prompt");
  return vm.snapshot({ stop: true });
}

// The record run: real inputs, typed at host time.
async function record(snapshot) {
  const mode = {
    calls: 0,
    recording: true,
    record: [],
    hashes: new Map(),
    replaying: () => false,
    call(i, k) {
      if (i % CHECK_EVERY === 0) {
        this.hashes.set(i, hashOf(k));
      }
    },
  };
  const undo = instrument(mode);
  let output = "";
  const started = performance.now();
  const vm = await sdk.createKernel({
    kernel: module,
    restore: snapshot,
    vsock: false,
    worker: false,
    onOutput: (bytes) => {
      output += new TextDecoder().decode(bytes);
    },
  });
  undo();
  await new Promise((resolve) => setTimeout(resolve, 200));
  vm.write(COMMANDS);
  await until(() => output.includes(DONE), "the commands");
  const ms = performance.now() - started;
  await vm.stop();
  return { ...mode, output, ms };
}

// Replay to import call `to`, compare memory there, then go live and
// type one more command.
async function replayTo(snapshot, recorded, to) {
  const mode = {
    calls: 0,
    recording: false,
    record: recorded.record,
    hash: null,
    replaying: (i) => i < to,
    call(i, k) {
      if (i === to) {
        this.hash = hashOf(k);
        this.at = performance.now();
        // Live from here: the guest's clock continues from the last
        // reading it was given rather than jumping to the host's.
        const lastClock = [...recorded.record.slice(0, to)]
          .reverse()
          .find((entry) => entry?.name === "clock_time_get");
        if (lastClock !== undefined) {
          const bytes = lastClock.writes[0][1];
          const ns = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(
            0,
            true,
          );
          k.wasi.monoOffset = Number(ns) / 1e6 - performance.now();
        }
      }
    },
  };
  const undo = instrument(mode);
  let output = "";
  const started = performance.now();
  const vm = await sdk.createKernel({
    kernel: module,
    restore: snapshot,
    vsock: false,
    worker: false,
    onOutput: (bytes) => {
      output += new TextDecoder().decode(bytes);
    },
  });
  undo();
  await until(() => mode.hash !== null, `call ${to}`);
  const replayMs = mode.at - started;
  vm.write("echo ALI''VE\n");
  await until(() => output.includes("ALIVE\r\n"), "the live guest's answer");
  await vm.stop();
  return { hash: mode.hash, replayMs };
}

const snapshot = await bootSnapshot();
const recorded = await record(snapshot);
// What the record would cost to keep: the bytes the recorded imports
// wrote, and a few bytes per call for the call's result and the
// interrupt word.
const ENTRY_BYTES = 12;
const written = recorded.record
  .filter((entry) => entry !== undefined && RECORDED.has(entry.name))
  .reduce(
    (sum, entry) =>
      sum +
      ENTRY_BYTES +
      entry.writes.reduce((n, [, bytes]) => n + bytes.length, 0),
    0,
  );
console.log(
  `recorded ${recorded.calls} import calls in ${Math.round(recorded.ms)} ms, ` +
    `about ${Math.round(written / 1024)} KiB of record`,
);
console.log(recorded.output.slice(recorded.output.indexOf("cat /proc")).trim());

for (const [at, expected] of recorded.hashes) {
  if (at === 0 || at >= recorded.record.length) {
    continue;
  }
  const { hash, replayMs } = await replayTo(snapshot, recorded, at);
  console.log(
    `call ${at}: ${hash === expected ? "same memory" : "DIFFERENT memory"}, ` +
      `replayed in ${Math.round(replayMs)} ms, then live and answering`,
  );
}
process.exit(0);
