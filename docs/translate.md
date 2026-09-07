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

## The process model

There is no kernel inside the guest; there is one beside it. Each
process, and each thread, is a Worker running translated code on its
own thread of the browser, and what they share lives in a kernel
Worker (`kernel.js`) reached over a synchronous request channel in a
SharedArrayBuffer (`channel.js`): every process's file table, the
filesystem, pipes and the terminal, each process's address-space
allocator, the process tree with its zombies and waiters, signals,
and the store of translated regions. The kernel is an asynchronous
loop that waits on a bell every request rings, serves what is
pending, and parks what it cannot answer yet, a read on an empty
pipe, a wait for a child, a read from the terminal, until the write,
the exit or the keystroke that answers it arrives.

A worker keeps what is its own: the memory's contents, translation
and the block lookup, signal frames, futexes (the memory is shared,
so Atomics on it are the futex), and the clock. Because no guest
state lives on the wasm stack, a process is its memory plus a
register file, which is what makes the rest cheap:

- **fork** copies the parent's used ranges from its shared memory
  into a new one and resumes the register file with rax zero. The
  kernel duplicates the file table and parks the parent until the
  child reports it has copied.
- **exec** builds a fresh image in the same worker: a new memory, the
  ELF and its interpreter loaded through the kernel, close-on-exec
  descriptors closed, handlers reset.
- **threads** (`clone` with `CLONE_VM`) are workers on the same
  memory with their own register file and block lookup; `futex` is
  `Atomics.wait` and `Atomics.notify` on the memory itself.
- **signals** a process handles are delivered on the return of its
  next syscall, with an rt_sigframe the restorer comes back through
  and the alternate stack when the handler asked for it; a request the
  process is parked in returns EINTR first. A signal left to its
  default action ends the process in the kernel.

`busybox sh` runs pipelines, command substitution, an exec'd glibc
program and scripts from stdin, with the statuses `wait4` should
report, in node and in the browser. Go programs (age, fzf) start their
threads, park them on futexes and preempt with `SIGURG` through
`tgkill`.

Under node the same kernel runs on the main thread with worker threads
for the processes (`tools/x86run.mjs`), which is how all of this is
tested offline.

## Caching translations

Translated modules are position-independent: every address a block
needs is emitted as an offset from the load base of the file mapping
its region lies in, read from an immutable global each instance is
given, and a region never crosses out of its mapping. A module
translated from libpython at one address serves it at any other, so
it is keyed by store path, file and offset alone, and glibc's regions
are shared by everything that uses that glibc. The browser keeps them
in the Cache API, loads every entry for the closure's store paths
before the process starts, and stores what the kernel reports as
translated. The cache is per browser; a first run pays for
translation, a second does not. The same keys would serve from a
shared cache filled by a nightly node run of popular closures, and
nothing here needs one.

## Code that changes

A block translated from a writable mapping may be rewritten under it:
a JIT, or the CPU probe's self-modifying-code checks. Such a region is
never cached, and each of its blocks is entered through a wrapper
that checksums the block's bytes and, on a mismatch, throws the region
away and translates it afresh. Code in read-only file mappings, which
is all ordinary code, pays nothing. The CPU probe (`nix/probe`, built
`-march=haswell`, so AVX2, BMI and the rest) passes every check.

## From the VM's shell

With `fast=1` on the VM page, the bin farm's links for the selected
programs point at a static stub (`nix/exec-stub/stub.c`) the page
writes onto the 9p share, so the guest image and the snapshot are
untouched. A command typed at the guest's shell runs the stub, which
announces the request on the console as an OSC escape sequence the
page strips from the console stream before the terminal draws it. The
page runs the program through a kernel worker with the terminal
attached to it through a pty of its own, so keystrokes and output
never cross the emulated serial line, and when the program exits the
status goes back to the stub as a sequence typed into the guest, which
it reads in raw mode and exits with. A stdout that is not the terminal
is fed back the same way, base64 in frames, since the guest has to see
it; a piped stdin travels in the request.

The channel is the console because the share cannot be written from
the guest: the engine's 9p backend refuses every create with EPERM.
`python3 -c 'print(6*7)'` at the guest's prompt answers in 2.3 s with
the closure's translations cached, against about 15 s emulated.

## What this does not cover

- **x87 precision**: the x87 stack is kept in `f64`, so `long double`
  arithmetic is rounded to 53 bits; remainders are exact.
- **Fused multiply-add** is emulated with rounding to odd (Boldo and
  Melquiond), which agrees with the hardware on finite inputs; the
  sign of a NaN or an infinity a fused operation produces can differ.
- **AVX-512**: decoded to be stepped over, never run. The CPU
  presented has no AVX at all, so glibc picks its SSE2 routines; code
  compiled for a newer CPU still runs, since AVX and AVX2 are
  translated.
- **Signals at arbitrary instructions**: delivery waits for the next
  syscall, so a handler cannot interrupt a loop that makes none.
- **ptrace, io_uring, seccomp, namespaces, sockets, and the rest of
  the kernel surface a shell utility does not touch.**

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

| class                                                    | expectation                                      |
| -------------------------------------------------------- | ------------------------------------------------ |
| single-threaded C, C++ and Rust command-line tools       | runs                                             |
| interpreters without a JIT (python, ruby, lua, perl)     | runs                                             |
| tools that fork and exec other tools (git, make, shells) | runs once fork lands; not in the first milestone |
| threaded programs (Go, tokio, rayon at startup)          | runs once threads land; correctness risk is high |
| JITs                                                     | QEMU guest                                       |

Once the audit script exists, this section becomes the count over the
top few hundred packages and stops being a guess.

## Built so far, and measured

Everything above the "not covered" line is built: the translator, the
process model, the translation cache, AVX with FMA, self-modifying
code, and the lane from the VM's shell. What is not: signal delivery
between syscalls, sockets, and a shared cache of translations.

### The benchmark

`nix run .#x86-bench` runs a fixed suite (`nix/x86-bench.nix`) through
the node runner: one binary per thing the lane has to get right, each
run once against an empty translation cache and then three times
against the cache that run filled. The suite derivation runs every
program natively when it is built and records the output, so the
translated run is checked against the hardware, and CI fails on any
difference. It also fails when a run translates more blocks than the
baseline in `tests/fixtures/x86/bench-baseline.json` (coverage went
down, or the cache stopped hitting). Wall times are reported in the
job summary and not gated on: they are the machine's, and a runner is
not a laptop.

On this machine (node, 2026-09-07):

| program | covers            | cold  | hot   | blocks  | wasm    |
| ------- | ----------------- | ----- | ----- | ------- | ------- |
| hello   | C                 | 1.2 s | 0.4 s | 18,538  | 2.8 MB  |
| jq      | C, a filter       | 1.3 s | 0.5 s | 22,669  | 3.7 MB  |
| jj      | Rust              | 6.8 s | 2.1 s | 48,410  | 15.3 MB |
| age     | Go                | 2.9 s | 1.7 s | 42,357  | 5.9 MB  |
| fzf     | Go, threads       | 2.4 s | 1.5 s | 33,988  | 4.3 MB  |
| python  | interpreter       | 6.1 s | 2.3 s | 117,490 | 17.1 MB |
| ruby    | interpreter       | 7.6 s | 3.5 s | 115,020 | 16.8 MB |
| sh      | fork, exec, pipes | 2.6 s | 2.0 s | 23,289  | 3.3 MB  |

"Cold" is a first run: fetch nothing (node reads the store), translate
every block the program touches, compile, run. "Hot" is the same with
every region already in the cache, so what remains is instantiating
the cached modules and the program's own work. Where hot is still
seconds (jj, ruby) most of it is V8 compiling 15 MB of wasm on
instantiation; that is the next thing to cut, with fewer, larger
modules or the browser's compiled-code cache.

### Against the VM

The same programs in headless Chromium: the translated lane on
`run.html`, and the VM's shell with the same closure booted, timed by
busybox `time`. The VM's cold column is the first run after boot,
which pays the 9p reads and the emulator's own JIT; its warm column is
the second. The lane's cold column includes fetching the closure's
files into memory.

| program               | VM cold | VM warm | lane cold | lane hot |
| --------------------- | ------- | ------- | --------- | -------- |
| hello                 | 1.2 s   | 0.9 s   | 1.0 s     | 0.35 s   |
| jq --version          | 0.9 s   | 0.9 s   | 1.0 s     | 0.36 s   |
| jj --version (Rust)   | 2.9 s   | 1.4 s   | 7.1 s     | 2.1 s    |
| age (Go, 2020 build)  | 1.0 s   | 0.8 s   | 3.5 s     | 2.2 s    |
| python3 -c 'print(1)' | 4.3 s   | 3.1 s   | 5.2 s     | 2.0 s    |
| ruby -e 'puts 1'      | 12.4 s  | 9.9 s   | 7.4 s     | 3.7 s    |

Read it plainly. The lane wins on the interpreters, 2 to 3x hot and
already on a cold ruby, and on small C programs, where a hot run is
under half a second. It loses on large native binaries: QEMU's TCG
translates a block in microseconds and its cold jj and age beat the
lane's, and even hot the lane pays V8 for instantiating 500 cached
modules, which is the whole of age's 2.2 s. Cutting that, with fewer
and larger modules or by handing V8 a compiled-code cache, is the next
piece of work, and it moves the hot column only.

Two things went wrong on the way that are worth recording:

- V8 keeps a dispatch table per instance that imports a function
  table, sized to the whole table. One instance per region made that
  quadratic and ran node out of heap on python. Only the helpers
  module imports the table now; everything else tail-calls its
  `jump(slot)`.
- The first ruby and python runs tripped glibc's stack protector.
  One cause was an instruction bug the differential test found; the
  other was the `TCGETS` ioctl writing glibc's 60-byte termios where
  the kernel struct is 36 and glibc's `tcgetattr` keeps exactly that
  on its stack. A syscall layer can smash a stack as well as a JIT
  can.

The pieces:

- `site/js/x86/wasm.js`: the encoder. MVP, tail calls, sign extension,
  bulk memory, SIMD, saturating truncation, atomics.
- `site/js/x86/decode.js`: the decoder, table-driven from the Intel
  opcode maps, including x87, SSE through SSE4.2, BMI and the VEX and
  EVEX shapes. Checked against objdump over 12,635 encodings.
- `site/js/x86/translate.js`, `simd.js`, `x87.js`: the translator.
  Integer, SSE through SSE4.2, AVX2 and FMA on wasm SIMD, x87 on f64
  with the transcendentals in JavaScript. Checked against this
  machine's CPU over 2,557 instruction forms by `tools/x86-semantics`,
  which assembles each form, runs it natively from random states and
  records what the hardware left.
- `site/js/x86/helpers.js`, `machine.js`: the register file and the
  run loop.
- `site/js/x86/kernel.js`, `process.js`, `channel.js`: the kernel in
  its own worker, the process in its worker, and the channel between
  them; about 110 syscalls.
- `site/js/x86/elf.js`, `fs-node.js`, `fs-memory.js`: the loader and
  the filesystems, node's and the in-memory NAR tree the page uses.
- `site/js/run.js`, `fastlane.js`, `cache.js`: the page, the lane the
  VM's shell reaches, and the translation cache in the Cache API.
- `tools/x86run.mjs`: the runner, with `--trace` for an strace-like
  log, `--stats` and `--cache`; `tools/x86-bench.mjs`: the benchmark.

The page: `run.html?pkg=python3&exec=python3` fetches the closure the
way the VM's boot does, keeps it as an in-memory filesystem, and runs
the program with the terminal attached. Reads of standard input block
on a ring in a SharedArrayBuffer the page fills from the pty; the line
discipline stays on the page and hears the guest's termios changes, so
python's REPL gets its raw mode.
