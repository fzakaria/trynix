// Is the unkernel guest deterministic from a snapshot, once every
// outside input is pinned down?
//
// The scrubber can go back only to keyframes. Scrubbing inside a
// command needs the guest to run the same way twice from a keyframe,
// so the span between two keyframes can be replayed to any point in it.
// Everything that reaches unkernel.wasm from outside goes through its
// 47 imports (`wasm-objdump -x -j Import unkernel.wasm`), plus one more
// channel: the host sets interrupt bits in the kernel's memory, which
// it can only do while the kernel is suspended inside an import.
//
// This runs the same commands twice from one snapshot, with the inputs
// pinned:
//
//   the clock is virtual: performance.now and Date.now return a time
//   that advances one microsecond per clock_time_get, and an idle wait
//   (poll_oneoff with a timer) jumps the clock to the timer instead of
//   waiting for it;
//
//   random_get draws from a seeded generator;
//
//   the commands are typed at a fixed import call rather than at a
//   host time;
//
// and logs every import call: its name, arguments and result, and the
// interrupt word as the call returns. It then compares the two logs and
// a hash of the whole memory at a fixed import call. The first entry
// that differs names the input that leaked.
//
// Usage (node 24 needs the flag for JSPI):
//
//   node --experimental-wasm-jspi experiments/determinism.mjs <dir>
//   node --experimental-wasm-jspi experiments/determinism.mjs <dir> --real
//
// <dir> holds the vendored SDK (web.mjs, _chunks/, unkernel.wasm), as
// site/vendor/unkernel does in a built site. --real leaves the clock,
// the randomness and the input timing alone, for comparison.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const dir = process.argv[2];
const REAL = process.argv.includes("--real");
// --share mounts a MemoryFs over 9p, as trynix's store share is, so
// the guest's reads from it are vsock packets from the host.
const SHARE = process.argv.includes("--share");
const sdk = await import(new URL(`file://${dir}/web.mjs`).href);
const module = await WebAssembly.compile(
  await readFile(`${dir}/unkernel.wasm`),
);

const MEMORY_MIB = 256;
// The shell loop runs long enough (--loop, default 300000 rounds, a
// few seconds) for kwemu's JIT to compile it, which is the other thing
// that could make two runs differ: compiled code replaces the
// interpreter mid-run.
const LOOP_ARG = process.argv.indexOf("--loop");
const LOOP = LOOP_ARG === -1 ? 300000 : Number(process.argv[LOOP_ARG + 1]);
const COMMANDS =
  (SHARE ? "cat /share/hello.txt ; ls -la /share ; " : "") +
  "ls / ; cat /proc/uptime ; date ; echo $RANDOM ; " +
  "head -c 16 /dev/urandom | od -x | head -n 1 ; " +
  `i=0; while [ $i -lt ${LOOP} ]; do i=$((i+1)); done; echo D''ONE\n`;
const DONE = "DONE";
// When the commands are typed, and how far past the end of their
// output the memory is hashed, both in import calls.
const TYPE_AT = 2000;
const HASH_AFTER = 5000;
const START_MS = 1_000_000;
const CLOCK_STEP_MS = 0.001;
const SEED = 0x2545f491;
const LIMIT_MS = 120000;

// ---------- pinned inputs ----------

const realNow = performance.now.bind(performance);
const realDateNow = Date.now;
let virtualMs = START_MS;

function pinClock() {
  virtualMs = START_MS;
  performance.now = () => virtualMs;
  Date.now = () => Math.floor(virtualMs);
}

function unpinClock() {
  performance.now = realNow;
  Date.now = realDateNow;
}

// xorshift32: a fixed sequence of bytes for random_get.
function seeded(seed) {
  let x = seed >>> 0;
  return (out) => {
    for (let i = 0; i < out.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      out[i] = x & 0xff;
    }
  };
}

// ---------- the import log ----------

const show = (value) =>
  typeof value === "bigint" ? `${value}n` : JSON.stringify(value);

// Wrap the kernel's imports for one run. `onCall(i, k)` is called at
// the start of every import call with its index and the kernel.
function instrument(run) {
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

    const irq = () =>
      k.irqAddr === undefined ? -1 : k.dv().getUint32(k.irqAddr, true);
    const random = seeded(SEED);

    for (const [space, table] of Object.entries(imports)) {
      for (const [name, value] of Object.entries(table)) {
        const label = `${space}.${name}`;
        const asyncFn = inner.get(value);
        const fn = asyncFn ?? value;
        if (typeof fn !== "function") {
          continue;
        }

        let body = fn;
        if (!REAL && name === "clock_time_get") {
          body = (...args) => {
            virtualMs += CLOCK_STEP_MS;
            return fn(...args);
          };
        }
        if (!REAL && name === "random_get") {
          body = (buf, len) => {
            random(k.u8().subarray(Number(buf), Number(buf) + Number(len)));
            return 0;
          };
        }
        if (!REAL && name === "poll_oneoff") {
          // An idle wait with a timer: jump the clock to the earliest
          // timer, so the wait ends at once and at a fixed guest time.
          body = (inp, out, nsubs, nevents) => {
            const subs = k.wasi.subscriptions(inp, nsubs);
            if (k.wasi.ready(subs).length === 0) {
              for (const sub of subs) {
                if (sub.deadline !== undefined) {
                  const ms = Number(sub.deadline) / 1e6 - k.wasi.monoOffset;
                  if (ms > virtualMs) {
                    virtualMs = ms;
                  }
                  break;
                }
              }
            }
            return fn(inp, out, nsubs, nevents);
          };
        }

        const logged = (...args) => {
          const i = run.calls++;
          run.onCall(i, k);
          const result = body(...args);
          const record = (value) => {
            run.log(
              i,
              `${label}(${args.map(show).join(",")}) -> ${show(value)} irq=${irq()}`,
            );
            return value;
          };
          return result instanceof Promise
            ? result.then(record)
            : record(result);
        };
        table[name] = asyncFn === undefined ? logged : new Suspending(logged);
      }
    }
    return imports;
  };
  return () => {
    sdk.Kernel.prototype.imports = original;
  };
}

// ---------- one run ----------

const files = new sdk.MemoryFs();
files.writeFile("/hello.txt", "from the share\n", { mode: 0o644 });
const SHARE_DIR = "/share";
const mounts = SHARE
  ? { [SHARE_DIR]: { fs: files, readOnly: true } }
  : undefined;

async function bootSnapshot() {
  const vm = await sdk.createKernel({
    kernel: module,
    memoryMiB: MEMORY_MIB,
    vsock: SHARE,
    worker: false,
  });
  if (SHARE) {
    await vm.mount(SHARE_DIR, files, { readOnly: true });
  }
  let out = "";
  vm.onOutput((bytes) => {
    out += new TextDecoder().decode(bytes);
  });
  vm.write("echo READ''Y\n");
  const deadline = realNow() + LIMIT_MS;
  while (!out.includes("READY") && realNow() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return vm.snapshot({ stop: true });
}

// Restore `snapshot`, type the commands, and run until HASH_AFTER
// calls past their output. `against` is an earlier run's log: the first
// entry that differs is kept.
async function runOnce(snapshot, { against = null, hashAt = Infinity } = {}) {
  const run = {
    calls: 0,
    entries: [],
    firstDifference: null,
    doneAt: null,
    hashAt,
    hash: null,
    finished: null,
    onCall(i, k) {
      if (!REAL && i === TYPE_AT) {
        k.sendInput(COMMANDS);
      }
      if (i === this.hashAt) {
        this.hash = createHash("sha256").update(k.u8()).digest("hex");
        this.finished?.();
      }
    },
    log(i, line) {
      this.entries[i] = line;
      if (
        against !== null &&
        this.firstDifference === null &&
        against[i] !== line
      ) {
        this.firstDifference = { index: i, expected: against[i], got: line };
      }
    },
  };

  if (!REAL) {
    pinClock();
  }
  const restoreImports = instrument(run);
  let output = "";
  const finished = new Promise((resolve) => {
    run.finished = resolve;
  });
  let vm;
  try {
    vm = await sdk.createKernel({
      kernel: module,
      restore: snapshot,
      vsock: SHARE,
      mounts,
      worker: false,
      onOutput: (bytes) => {
        output += new TextDecoder().decode(bytes);
        if (run.doneAt === null && output.includes(`${DONE}\r\n`)) {
          run.doneAt = run.calls;
          if (run.hashAt === Infinity) {
            run.hashAt = run.calls + HASH_AFTER;
          }
        }
      },
    });
    if (REAL) {
      vm.write(COMMANDS);
    }
    const timeout = new Promise((resolve) =>
      setTimeout(resolve, LIMIT_MS, "timeout"),
    );
    await Promise.race([finished, timeout]);
  } finally {
    restoreImports();
    unpinClock();
    await vm?.stop();
  }
  return { ...run, output };
}

// ---------- the experiment ----------

const snapshot = await bootSnapshot();
const first = await runOnce(snapshot);
const second = await runOnce(snapshot, {
  against: first.entries,
  hashAt: first.hashAt,
});

const tail = (text) => text.slice(text.lastIndexOf("ls /")).trim();
const jit = (run) =>
  run.entries.filter((e) => e.includes("jit_compile")).length;
console.log(`mode: ${REAL ? "real inputs" : "pinned inputs"}, loop ${LOOP}`);
console.log(`JIT compiles: ${jit(first)} and ${jit(second)}`);
console.log(`import calls: ${first.calls} and ${second.calls}`);
console.log(`commands done at call ${first.doneAt} and ${second.doneAt}`);
console.log(`memory at call ${first.hashAt}: ${first.hash}`);
console.log(`                         ${second.hash}`);
console.log(`same output: ${tail(first.output) === tail(second.output)}`);
if (second.firstDifference === null) {
  console.log("the import logs match");
} else {
  const { index, expected, got } = second.firstDifference;
  console.log(`first difference at import call ${index}:`);
  console.log(`  first run:  ${expected}`);
  console.log(`  second run: ${got}`);
  for (let i = Math.max(0, index - 5); i < index; i++) {
    console.log(`  before: ${first.entries[i]}`);
  }
}
console.log("--- first run's output ---");
console.log(tail(first.output));
process.exit(0);
