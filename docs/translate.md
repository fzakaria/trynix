# Translating store binaries to wasm in the page

An experiment, started 2026-09-07, in running nixpkgs' x86-64 binaries
without a CPU emulator: the page translates the machine code of a store
path into WebAssembly and runs it directly, with a Linux system-call
layer written in JavaScript standing in for the kernel. This document
is the design, what is built, what is not, and a guess at coverage. The
measurements it should eventually carry are marked as such.

## Why

A first run of a big binary in the QEMU guest costs about 2.5 s, of
which 1.5 s is the emulator meeting code it has never seen: 46% of the
vCPU's time is the TCI interpreter and 26% is translation
([performance.md](./performance.md)). Syscalls are noise. A warm run is
still 24x to 64x off native. The wasm TCG backend is a per-basic-block
JIT that cannot chain blocks and that keeps every register in memory;
the structural fixes to it are worth about 1.5x.

Not emulating at all is the other route. WebAssembly runs within a small
factor of native, and V8 compiles a function lazily on first call, so
the cost of translation moves to a one-time pass per file that runs in a
Worker on cores the single vCPU never uses. Store paths are immutable,
so the translated bytes can be cached next to the NAR and never
recomputed for that browser. Precomputing the popular set is an optional
cache layer, never a requirement: the multiverse is far too wide to
translate ahead of time, and the design does not need to.

## The shape

```
 ELF in the store        translate.js              V8
 ───────────────        ─────────────            ────────
 x86-64 bytes  ──►  decode.js ──► wasm bytes ──► Module ──► Table slot per block
                    (per basic block,            (lazy per-function compile)
                     regions of blocks
                     per module)
```

Guest state is small and lives outside the wasm stack:

- The guest's whole address space is one wasm linear memory. A guest
  virtual address is a wasm address. Guest pointers are 64-bit values
  whose top half is zero, so a memory access is `i32.wrap_i64` and a
  load. The loader keeps everything below 4 GiB, which it can because
  it is the one deciding where segments go; a PIE's base is ours to
  choose and the program never learns its absolute address matters.
- The 16 general registers, `rip`, the flag state, `fs_base`, the 16
  xmm registers and the x87 stack are mutable wasm globals, created in
  JavaScript and imported by every translated module. The syscall
  layer reads and writes them through `WebAssembly.Global.value`.
- Flags are lazy, the way QEMU does it: an arithmetic instruction
  records its operation and operands in `cc_op`, `cc_dst`, `cc_src`,
  and a conditional branch computes only the condition it needs from
  them. A `cmp` or `test` immediately followed by the branch that uses
  it is folded into one wasm comparison.

Each basic block becomes one wasm function of type `() -> ()`. A block
ends in a control transfer and never returns to its caller: a direct
jump is `return_call` to the target function when it is in the same
module, `return_call_indirect` through the shared table when it is in
an earlier one, and an indirect jump (`ret`, `call *reg`, a jump table)
looks the target address up in a two-level page table kept in the low
4 MiB of guest memory and tail-calls the slot it finds. Tail calls keep
the wasm stack flat across any depth of guest calls; ten million of
them run at constant stack (tests/x86/wasm.test.mjs). A lookup miss
sets `rip` and returns to the JavaScript run loop, which translates
from that address and re-enters. A `syscall` instruction is a plain
call to an imported JavaScript function; `exit_group` throws through
the wasm frames.

Translation is by region: from an entry address the translator follows
direct jumps, both arms of a conditional, call targets and the address
after a call, until it runs out of reachable code or hits a size cap,
and emits the whole region as one module so its internal jumps are
direct. Function boundaries are not needed for that, but `.eh_frame`
and the symbol table give them when a whole-file eager pass wants them
(libruby carries 13,861 function symbols). A jump into the middle of
an existing block gets its own block starting there; blocks are pure
functions of the bytes, so duplication is harmless.

The CPU presented by `cpuid` is a fixed baseline without AVX. glibc's
ifunc resolvers then pick the SSE2 string routines, and the AVX2 and
AVX-512 variants that make up 2.5% of libc's instructions are decoded
for their length and never run.

## The process model, and what it makes possible

There is no kernel. `linux.js` implements the system calls a program
makes, against a filesystem object with two backends: the real
filesystem in node, which makes `/nix/store` on the developer's machine
the test corpus, and the NAR-unpacked in-memory tree in the page, which
is what `site/js/nar.js` already builds for the 9p share.

Because no guest state is on the wasm stack, a process is its memory
plus a few dozen globals, and the process primitives that a CPU
emulator on emscripten finds hard are within reach:

- **exec** replaces the memory's mapped regions and loads a new ELF,
  keeping the file table. Nothing else to unwind.
- **fork** copies the memory into a new Worker and starts its run loop
  at the instruction after the `syscall` with `rax` set to zero. The
  copy is a `memory.copy` of the used range; a 64 MiB process forks in
  the time it takes to move 64 MiB. Pipes between processes are ring
  buffers in a SharedArrayBuffer with `Atomics.wait`; `waitpid` waits
  on a status cell the same way. The file table for descriptors shared
  across a fork lives with a kernel object on the main thread, reached
  by synchronous message the way emscripten proxies its filesystem.
- **threads** (`clone` with `CLONE_VM`) are Workers sharing one
  `SharedArrayBuffer` memory. Globals are per instance, so each thread
  instantiates the translated modules into its own table; `fs_base` is
  per thread; `futex` is `Atomics.wait` and `Atomics.notify`; the
  `lock` prefix maps to wasm atomics. New translations must reach
  every thread's table, by message.
- **signals** are delivered at syscall return, which covers `SIGCHLD`,
  `SIGALRM`, `SIGPIPE` and a terminal's `SIGINT`. Delivery at an
  arbitrary instruction, which Go's preemption and JITs that trap on
  `SIGSEGV` need, is not planned.
- **mmap** of a file copies bytes into memory; private mappings are
  copies anyway. `mprotect` is accepted and ignored.

The order of work is: static musl `hello`; static glibc `hello`, which
adds `cpuid`, TLS, `rep movs` and the SSE2 string routines; a dynamic
`hello`, which adds ld.so, relocations and `mmap` of shared objects;
then `jq`, `ruby -e 1` and `python3 -c 1`, timed against the QEMU guest
in the same browser; then `busybox sh -c 'echo hi | cat'`, which is
fork, pipe, exec and wait in one line; then a Go binary, which is the
threads milestone: the Go runtime is static and makes its own syscalls,
so it skips every libc question, but it starts several threads before
`main` runs, parks them on `futex`, and preempts with `SIGURG`. Without
signal delivery it falls back to cooperative preemption at function
prologues, which is enough for a command-line tool.

## What this does not cover

A program that does any of the following stays on the QEMU guest, and
the exec stub decides which lane at exec time:

- **JIT compilers and self-modifying code**: Bun, node, Java, LuaJIT,
  Ruby with YJIT enabled. Nothing invalidates a translated block when
  the bytes under it change.
- **Signals at arbitrary instructions**: Go's runtime, anything that
  catches `SIGSEGV` on purpose, `sigaltstack` tricks.
- **x87 precision**: the x87 stack is kept in `f64`, so `long double`
  arithmetic is rounded to 53 bits. musl's `printf` formats every
  float through `long double` and will print a wrong last digit in some
  cases until the 80-bit type is done properly.
- **ptrace, io_uring, seccomp, namespaces, and the rest of the kernel
  surface a shell utility does not touch.**

## Coverage, a guess to be replaced by a count

The instruction side is not where programs will fail. libruby has 277
distinct mnemonics across 1.08 million instructions and the top 60
cover 97.8%; libc has 325. The decoder already agrees with objdump on
every one of 12,635 distinct encodings harvested from hello, ld.so,
libc, libm and libruby (tests/x86/decode.test.mjs), and an instruction
the translator has no semantics for becomes a block that traps only if
it is reached.

Programs will fail on process semantics, and the audit for that is a
static one over the closure: imports of `pthread_create`, `fork`,
`clone`, `execve`, `sigaction` and `mprotect` with `PROT_EXEC`, plus
any writable-and-executable mapping. That audit has not been run yet.
The expectation from reading what is in nixpkgs:

| class                                                   | expectation |
| ------------------------------------------------------- | ----------- |
| single-threaded C, C++ and Rust command-line tools      | runs        |
| interpreters without a JIT (python, ruby, lua, perl)    | runs        |
| tools that fork and exec other tools (git, make, shells) | runs once fork lands; not in the first milestone |
| threaded programs (Go, tokio, rayon at startup)         | runs once threads land; correctness risk is high |
| JITs                                                    | QEMU guest  |

Once the audit script exists, this section becomes the count over the
top few hundred packages and stops being a guess.

## Built so far

- `site/js/x86/wasm.js`: the encoder. MVP, tail calls, sign extension,
  bulk memory, SIMD, saturating truncation, atomics.
- `site/js/x86/decode.js`: the decoder, table-driven from the Intel
  opcode maps, including x87, SSE through SSE4.2, BMI and the VEX and
  EVEX shapes.
- `tools/x86-oracle.py`: harvests the decoder's oracle from objdump.
- `tests/x86/`: the encoder and decoder tests.

Not yet built: the translator, the loader, the syscall layer, the run
loop, the browser Worker, the exec stub in the QEMU guest, and every
measurement this document is supposed to carry.
