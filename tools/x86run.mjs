#!/usr/bin/env node
// Runs an x86-64 Linux binary from the host filesystem through the
// translator, with the host's files visible to it and stdio wired to
// this terminal. The development loop for site/js/x86:
//
//     nix run .#x86run -- [--trace] [--stats] <binary> [args...]
//
// --trace prints every syscall as strace would; --stats prints how
// long loading, translation and execution took and how much was
// translated.
import fs from "node:fs";
import process from "node:process";

import { Machine, GuestFault } from "../site/js/x86/machine.js";
import { Process } from "../site/js/x86/linux.js";
import { NodeFs } from "../site/js/x86/fs-node.js";

function usage() {
  console.error("usage: x86run [--trace] [--stats] [--blocks] <binary> [args...]");
  process.exit(2);
}

const args = process.argv.slice(2);
let trace = null;
let stats = false;
let traceBlocks = false;
while (args.length > 0 && args[0].startsWith("--")) {
  const flag = args.shift();
  if (flag === "--trace") {
    trace = (line) => fs.writeSync(2, `[sys] ${line}\n`);
  } else if (flag === "--stats") {
    stats = true;
  } else if (flag === "--blocks") {
    traceBlocks = true;
  } else {
    usage();
  }
}
if (args.length === 0) {
  usage();
}

// A stream over a host fd. Reads block, as the guest expects.
function hostStream(fd, canRead, canWrite) {
  const isatty = (() => {
    try {
      return fs.fstatSync(fd).isCharacterDevice();
    } catch {
      return false;
    }
  })();
  return {
    isatty,
    read: canRead
      ? (buf) => {
          try {
            return fs.readSync(fd, buf, 0, buf.length, null);
          } catch (e) {
            if (e.code === "EOF") {
              return 0;
            }
            if (e.code === "EAGAIN") {
              return 0;
            }
            throw e;
          }
        }
      : null,
    write: canWrite ? (buf) => fs.writeSync(fd, buf) : null,
    size: () => ({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 }),
  };
}

const t0 = performance.now();
const machine = new Machine({ pages: 16384 });
if (traceBlocks) {
  machine.translator.traceBlocks = true;
  machine.traceBlock = (rip) => fs.writeSync(2, `[blk] 0x${rip.toString(16)}\n`);
}
const proc = new Process({
  machine,
  fs: new NodeFs(),
  argv: args,
  envp: Object.entries(process.env).map(([k, v]) => `${k}=${v}`),
  cwd: process.cwd(),
  stdio: {
    stdin: hostStream(0, true, false),
    stdout: hostStream(1, false, true),
    stderr: hostStream(2, false, true),
  },
  trace,
});

let code = 0;
try {
  proc.load(args[0]);
  const t1 = performance.now();
  const exit = proc.run();
  const t2 = performance.now();
  if (exit.reason === "exit") {
    code = exit.code;
  } else {
    console.error(`guest stopped: ${exit.reason} at 0x${exit.rip.toString(16)}`);
    code = 1;
  }
  if (stats) {
    const tr = machine.translator;
    console.error(
      `[stats] load ${(t1 - t0).toFixed(1)} ms, run ${(t2 - t1).toFixed(1)} ms, ` +
        `${tr.regions} regions, ${machine.slots - 1} blocks, ${proc.syscalls} syscalls`,
    );
  }
} catch (e) {
  if (e instanceof GuestFault) {
    console.error(`guest fault: ${e.message} (rip 0x${machine.reg("rip").toString(16)})`);
    code = 139;
  } else {
    throw e;
  }
}
process.exit(code);
