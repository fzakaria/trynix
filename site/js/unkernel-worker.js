// The guest worker: where the unkernel machine (machine.js) runs on
// the page. unkernel.js starts it and talks to it with two kinds of
// message.
//
// A call, { id, op, args }, is answered with { id, ok, value } or
// { id, ok: false, error }. The ops are the methods of `ops` below.
//
// An event, { event }, is the machine's own (machine.js lists them):
// console output, keyframes, restores. Events and answers share the one
// channel, in the order they happened, which is what lets the page cut
// its record of the console at exactly the point each keyframe was
// taken.

import { startMachine } from "./machine.js";
import { indexedDbSpill } from "./spill.js";
import { Precedence } from "./store.js";

let machine = null;
let spill = null;

const post = (message, transfer = []) => self.postMessage(message, transfer);

function onEvent(event) {
  if (event.type === "output") {
    post({ event }, [event.bytes.buffer]);
    return;
  }
  post({ event });
}

const ops = {
  // Start the kernel. `sdk` and `kernel` are absolute URLs: the SDK's
  // browser entry and the kernel's wasm.
  async boot({ sdk: sdkUrl, kernel, memoryMiB, cols, rows }) {
    const sdk = await import(sdkUrl);
    spill = await indexedDbSpill();
    machine = await startMachine({
      sdk,
      kernel,
      memoryMiB,
      cols,
      rows,
      spill,
      onEvent,
      log: (message) => post({ event: { type: "log", message } }),
    });
  },

  // One parsed NAR into the share.
  write(basename, entries) {
    machine.share.write(basename, entries);
  },

  run: (roots) => machine.run(roots),

  // Link paths written to a running guest, the roots first.
  link(basenames, roots) {
    machine.share.linkAll(basenames, roots, Precedence.REPLACE);
  },

  input(data) {
    machine.write(data);
  },

  resize(cols, rows) {
    machine.resize(cols, rows);
  },

  async exec(file, args) {
    const { exitCode, stdout, stderr } = await machine.exec(file, args);
    return { exitCode, stdout, stderr };
  },

  keyframe: () => machine.keyframe(),
  restore: (id) => machine.restore(id),
  stats: () => machine.stats(),

  // The page is going away: delete the spilled keyframes.
  close() {
    spill?.destroy();
  },
};

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    const value = await ops[op](...args);
    post({ id, ok: true, value });
  } catch (err) {
    post({ id, ok: false, error: err?.message ?? String(err) });
  }
};
