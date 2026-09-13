# Wasm batch, chain and locals engine

`patches/0006-wasm32-batch-chain-locals.patch` rewrites the qemu-wasm TCG backend's execution
model. It applies after production patches 0001 through 0005 to the
pinned fork commit `0ef7b4e2`, builds with `tools/build-engine.sh`
unchanged, boots the pinned snapshot, and passes `nix run .#cpu-test`.
It shipped as `engine-20260909-1605`, and the follow-up patch 0007 as
`engine-20260909-1943`; every pin since carries that engine.

Measured against the pinned engine: `opencode --version` 408 s to 171 s
(2.4x); emubench 1.5x to 3.3x by instruction class. Full analysis in
[docs/engine-execution.md](../docs/engine-execution.md), raw numbers in
[wasm-batch-engine-results.json](./wasm-batch-engine-results.json).

## What it changes

- **Batches.** Up to 64 translated blocks compile into one
  WebAssembly module, each exported as its own function, instead of one
  module per block. The live cache is about 256000 blocks with explicit
  eviction; the finalizer-based accounting is gone.
- **Warm-up gating.** A block runs in the interpreter until it has run
  `WASM_WARMUP` (32) times, then joins the pending batch; the batch
  compiles when full or after a queued block has waited `WASM_HOT_WAIT`
  (384) more runs. Code that runs a handful of times is never compiled.
- **Per-block import tables.** Each block records the helpers its body
  calls and the positions of its call immediates (emitted as fixed
  5-byte LEBs). The assembler unions the tables of the blocks in a batch
  and rewrites every body's calls into the merged import space. This is
  what lets blocks translated at different times share a module, and it
  is the constraint that sank a shared-registry version of warm-up
  gating (the machine never booted).
- **Chaining.** `goto_tb` and `goto_ptr` tail-call a compiled successor
  through the imported main table (`return_call_indirect`) instead of
  returning to the C dispatcher. The prologue routes Asyncify rewinds to
  the block `ctx.tb_ptr` names, since the dispatcher rewinds into the
  function it originally called.
- **Registers in locals.** The guest register file and the block index
  are function locals, not instance globals. An unwind inside a helper
  leaves through one shared exit block that spills them to `ctx.save`;
  the rewind entry reloads them. Normal execution never touches the save
  area.
- **No periodic yield.** The stock dispatcher's `emscripten_sleep(0)`
  only fired under cache backpressure; there is no equivalent here, so
  the dispatcher never unwinds on a timer.

## Layout

Every block's entry in the code buffer starts with `struct wasm_tb_hdr`
(tcg/wasm32.h): the TCI code offset, a sequence number that a reused
address never repeats, the body and metadata offsets, and per-vCPU
function index, counter and state. Then the TCI bytecode, the wasm
function body, and the import table.

## Known limits

- The `opencode-segfault` race (`Segmentation fault at address 0x8`,
  see docs/opencode-startup.md) is unchanged: one of four runs hit it,
  the pinned engine hits it about one in three.
- The remaining opencode time is generated code spread over ~48000
  blocks with cache misses on every transition, the C dispatcher on
  exits (11%) and the TB lookup for indirect jumps (7%). Candidate
  follow-ups and their expected size are in docs/engine-execution.md.
- Tail calls need a browser with WebAssembly tail calls: Chrome 112,
  Firefox 121, Safari 18.2 and later. Older ones are detected at
  start-up and fall back to returning through the dispatcher, with a
  console warning; that path is verified and runs at about stage-1
  speed.

## Reproducing

Build with `nix run .#build-engine`, which applies every patch in patches/, overlay the three engine
files onto a built site's `qemu/`, and measure with the emubench binary
(`nix/emubench.nix`) served from a cache next to the page, the same way
`tools/cpu-test.py` serves the probe. Run the probe first; every stage
here was validated that way before it was timed.
