#!/usr/bin/env node
// Runs an x86-64 Linux program from the host filesystem through the
// translator: the kernel on this thread, each process and thread of
// the program in a worker thread, the host's files visible to it, and
// this terminal as its terminal.
//
//     nix run .#x86run -- [--trace] [--stats] [--cache <dir>] <program> [args...]
//
// --trace logs every syscall of every process as strace would, --stats
// what each process translated, --cache <dir> keeps translated regions
// between runs.
import fs from "node:fs";
import process from "node:process";

import { Kernel } from "../site/js/x86/kernel.js";
import { NodeFs } from "../site/js/x86/fs-node.js";
import { spawnWorker } from "../site/js/x86/platform.js";

function usage() {
  console.error("usage: x86run [--trace] [--stats] [--cache <dir>] <program> [args...]");
  process.exit(2);
}

const args = process.argv.slice(2);
let trace = false;
let stats = false;
let cacheDir = null;
while (args.length > 0 && args[0].startsWith("--")) {
  const flag = args.shift();
  if (flag === "--trace") {
    trace = true;
  } else if (flag === "--stats") {
    stats = true;
  } else if (flag === "--cache") {
    cacheDir = args.shift();
  } else {
    usage();
  }
}
if (args.length === 0) {
  usage();
}

// The terminal: stdin gathered as it arrives, stdout and stderr
// written straight through, Ctrl-C as an interrupt.
const input = [];
let inputLength = 0;
let inputClosed = false;
let interrupted = false;
process.stdin.on("data", (chunk) => {
  input.push(new Uint8Array(chunk));
  inputLength += chunk.length;
});
process.stdin.on("end", () => {
  inputClosed = true;
});
if (process.stdin.isTTY) {
  process.stdin.setRawMode(false);
}
process.on("SIGINT", () => {
  interrupted = true;
});
const tty = {
  available: () => inputLength,
  closed: () => inputClosed,
  read: (out) => {
    let n = 0;
    while (n < out.length && input.length > 0) {
      const head = input[0];
      const take = Math.min(head.length, out.length - n);
      out.set(head.subarray(0, take), n);
      n += take;
      if (take === head.length) {
        input.shift();
      } else {
        input[0] = head.subarray(take);
      }
    }
    inputLength -= n;
    return n;
  },
  size: () => ({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 }),
  isTerminal: () => Boolean(process.stdin.isTTY),
  takeInterrupt: () => {
    const was = interrupted;
    interrupted = false;
    return was;
  },
  write: (stream, bytes) => fs.writeSync(stream === "stderr" ? 2 : 1, bytes),
  setTermios: () => {},
};

// A translation cache in a directory: one file per region.
function loadCacheDir(dir) {
  const map = new Map();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const data = fs.readFileSync(`${dir}/${name}`);
    const nl = data.indexOf(10);
    const header = JSON.parse(data.subarray(0, nl).toString());
    const bytes = new Uint8Array(new SharedArrayBuffer(data.length - nl - 1));
    bytes.set(data.subarray(nl + 1));
    map.set(header.key, {
      bytes,
      offsets: header.offsets.map((o) => BigInt(o)),
      unsupported: header.unsupported.map(([o, why]) => [BigInt(o), why]),
    });
  }
  return map;
}

function storeCacheEntry(dir, entry) {
  const header = JSON.stringify({
    key: entry.key,
    offsets: entry.offsets.map((o) => o.toString()),
    unsupported: entry.unsupported.map(([o, why]) => [o.toString(), why]),
  });
  const name = entry.key.replace(/[^A-Za-z0-9._@#-]/g, "_");
  fs.writeFileSync(`${dir}/${name}`, Buffer.concat([Buffer.from(`${header}\n`), Buffer.from(entry.bytes)]));
}

const translations = cacheDir !== null ? loadCacheDir(cacheDir) : new Map();
const workerUrl = new URL("../site/js/x86/process-worker.js", import.meta.url);

const kernel = new Kernel({
  fs: new NodeFs(),
  tty,
  spawn: (data) => spawnWorker(workerUrl, { ...data, trace, stats }),
  translations,
  onTranslation: cacheDir !== null ? (entry) => storeCacheEntry(cacheDir, entry) : null,
  log: (text) => fs.writeSync(2, `${text}\n`),
});

const status = await kernel.start({
  argv: args,
  envp: Object.entries(process.env).map(([k, v]) => `${k}=${v}`),
  cwd: process.cwd(),
});
process.exit(status);
