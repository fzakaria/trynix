# Where the emulator's time goes, and what moved it

This is the execution-speed counterpart to the startup investigation in
[opencode-startup.md](./opencode-startup.md). That work kept asking for
one thing it never had: an accounting of guest work that separates "the
browser runs more instructions" from "the browser runs the same
instructions slower." This measures the second directly, names the parts
of the gap, and reports what a rewritten backend did to each.

Short version. `opencode --version` took 408 seconds in the browser and
about 11 seconds on a native build of the same QEMU fork. A rewritten
wasm backend ([patches/0006-wasm32-batch-chain-locals.patch](../patches/0006-wasm32-batch-chain-locals.patch))
brings the browser to 171 seconds, 2.4x, and passes the full CPU probe.
On the microbenchmark it is 1.5x to 3.3x over the pinned engine
depending on instruction class, and its single hot block now runs faster
than the native backend's. A follow-up,
[patches/0007-wasm32-cached-chains-direct-calls-mul64.patch](../patches/0007-wasm32-cached-chains-direct-calls-mul64.patch),
trims the transition between blocks and takes multi-block loops another
1.5x to 2x ([below](#the-follow-up-patch-0007)). What is left is a
working-set problem: the remaining time is generated code spread over
tens of thousands of blocks, where instruction-cache misses dominate and
code shape no longer helps. The engine is not the path to subsecond
execution of a cold big binary; the native service in
[experiments/native-exec](../experiments/native-exec) already does that
in 0.65 seconds.

## The instrument

`nix/emubench` is a static binary, one store path, built like the CPU
probe. Each test is a fixed block of inline assembly with a known
translation-block shape, so a ratio between two engines names a
mechanism instead of a workload. Run it on the native fork and in the
browser guest against the same package and machine and diff the numbers.

- Native: resume the guest under `vendor/qemu-native/qemu-system-x86_64`
  with a share holding the emubench closure, then run `emubench all`.
- Browser: serve a site whose `qemu/` holds the engine under test, open
  `?path=<emubench store path>&cache=<url key>&boot=1`, and type
  `emubench all` at the shell. This is the serve-a-store-path-from-a-cache
  trick `tools/cpu-test.py` uses; the closure is one path so it needs no
  network.

Raw numbers, all engines, are in
[experiments/wasm-batch-engine-results.json](../experiments/wasm-batch-engine-results.json).

## The gap by mechanism, before and after

Millions of guest instructions per second, higher is better. "stock" is
the pinned engine; "final" is the patch as committed.

| test         | native | stock | final | final / stock | native / final | what it isolates                  |
| ------------ | -----: | ----: | ----: | ------------: | -------------: | --------------------------------- |
| alu          |    862 |   349 |  1163 |          3.3x |           0.7x | one compiled block, no boundary   |
| alu2         |    558 |   119 |   173 |          1.5x |           3.2x | two blocks per iteration          |
| alu4         |    461 |    98 |   182 |          1.9x |           2.5x | four blocks per iteration         |
| call         |    258 |    68 |   102 |          1.5x |           2.5x | call/ret through the TB lookup    |
| indirect     |    353 |   103 |   159 |          1.5x |           2.2x | computed jump, varying target     |
| mem          |   1274 |   450 |   550 |          1.2x |           2.3x | TLB fast path                     |
| syscall (ns) |    544 |  4378 |  3003 |          1.5x |           5.5x | guest syscall entry/exit          |
| cold50k p2   |    147 |    18 |    21 |          1.2x |           7.1x | run-a-few-times code: interpreter |
| cold2k p1600 |   2739 |    16 |    53 |          3.4x |            51x | 2000 compiled blocks, dispersed   |

Three readings.

The single block (alu) went from 2.5x behind native to 1.35x ahead of
it. That is generated-code quality: guest registers moved from instance
globals to function locals, so V8's baseline compiler stops reloading
the globals base for every access and keeps values in registers.

Multi-block loops (alu2, alu4, call, indirect) went from ~4.7x behind
native to ~2.5x. That is the block boundary: each compiled block used to
return to the C dispatcher, which looked up the successor and called it
through the table; now it tail-calls the successor directly.

Dispersed compiled code (cold2k p1600, two thousand distinct blocks
visited once per pass) improved 3.4x and is still 51x behind native.
This is the regime real programs live in. Bun's blocks have a median of
about 8 guest instructions, so a JS runtime's start-up touches tens of
thousands of them, and the browser's machine code for a block is about
1.7 KB against native TCG's ~150 bytes. That is an instruction-cache
working set an order of magnitude larger, and no per-block code shape
changes it.

## What the pinned engine spent its time on

CPU profile of the vCPU worker across the whole 408 s command, busy time
only (about 353 s; the rest is idle and proxied-syscall wait):

| part                            | share |
| ------------------------------- | ----: |
| TCI bytecode interpreter        |   33% |
| C dispatcher `tcg_qemu_tb_exec` |   15% |
| generated code                  |   22% |
| softmmu loads/stores            |    6% |
| compile and instantiate         |    4% |
| TB lookup helper                |    3% |

Compilation is 4%. That single number settles the direction the startup
investigation kept circling: making module construction cheaper works on
4% of the time and cannot win on its own. The interpreter is 33% because
the stock compile threshold is 1500 executions and the 15000-instance
cache evicts under churn, so most of Bun's moderately-hot code never
runs compiled.

## The rewritten backend, in three stages

Each stage boots the pinned snapshot and passes `nix run .#cpu-test`
(every instruction family, the signed and unsigned multiply regressions,
self-modifying code). Each was measured on emubench and on opencode.

**Stage 1: batches with per-block import tables.** Up to 64 blocks share
one WebAssembly module. A block runs in the interpreter until it has run
32 times, then joins the pending batch; the batch compiles when full, or
when a queued block has waited 384 more runs so a lone hot block does not
wait for company. Cold code is never compiled. The cache holds about
256000 blocks with explicit eviction instead of waiting on the garbage
collector.

The part that makes this correct is that each block carries its own
helper-import table next to its body, and the assembler unions those
tables and rewrites every body's call immediates into the merged
module's import space. Without that, a batch can only hold blocks
translated consecutively, because the translator's helper registry is
reset per batch and a body's call indices are only valid against the
registry state at its translation. The earlier chaining prototype and a
first version of this one both tripped on exactly that: gate compilation
by hotness with a shared registry and blocks link to the wrong helpers.
It shows up as a machine that never boots.

Result: interpreter share 33% to 0.1%. opencode 408 s to 163 s.

**Stage 2: tail-call chaining.** `goto_tb` and `goto_ptr` read the
successor's function index from its block header and `return_call_indirect`
through the main module's table, instead of returning to C. A block's
prologue routes Asyncify rewinds: the dispatcher rewinds into the
function it originally called, which may have tail-called on before the
unwind, so a re-entered function forwards to whichever block `ctx.tb_ptr`
names. The dispatcher's share fell from 27% to 8% of busy time, but the
transition cost moved into the generated code and the opencode wall time
did not move (168 s). On emubench it is worth 1.3x to 1.6x on every
multi-block case.

**Stage 3: registers in locals.** The sixteen guest registers and the
block index are wasm locals instead of 25 mutable i64 globals per
instance. TCG spills every global to env at block boundaries, so nothing
needs to outlive the function. The one case that does, an Asyncify unwind
inside a helper call, leaves through one shared exit block that spills
the locals to a save area in ctx, and the rewind path reloads them.
Single-block throughput went 686 to 1163 mips; syscalls and page faults
each about 1.5x. opencode 171 s, within noise of the other stages.

## What is left, and what it would take

The final engine's profile on opencode: generated code 63%, dispatcher
11%, TB lookup 7%, translation 4%, softmmu 4%. The generated-code time is
spread over about 48000 distinct compiled blocks; the top 1000 account
for 40% and the top 5000 for 62%. The hot blocks are already tiered up by
V8 and run near native speed. The long tail runs V8 baseline code with
cache misses on every transition: the successor's block header, its
table entry and its machine code.

What could still move it, with honest expectations, as written before
patch 0007 (what became of each is in the next section):

- Store the successor's function index in the source block's jump slot
  and back-patch predecessors through QEMU's jump lists when a block
  compiles or is evicted, removing one cache-missing load per transition.
  Perhaps 10-20% of the tail. _Done in 0007, lazily rather than by
  back-patching._
- A jump cache for `goto_ptr` in generated code, so returns and indirect
  calls skip `helper_lookup_tb_ptr` (7%) most of the time. _Not done: it
  means replicating the target's TB-state computation in generated
  code, and a cheaper last-target cache measured as a loss._
- Trim the per-block prologue and the block-index guard chain. Small.
  _The prologue's rewind check is gone from chained entries in 0007._
- Bigger translation units would cut transitions but QEMU ends a block
  at every branch, and a region compiler is the multi-week project the
  startup investigation already scoped. _0007's direct calls inside a
  batch get part of this without changing translation units._

None of these change the picture: the browser is a 2.5x-per-instruction
JIT target with a working-set penalty on top. Stacked, they are a further
1.2x to 1.5x at most.

## The follow-up: patch 0007

Four changes, each measured on emubench against the pinned 0006 engine
with interleaved rounds (median of three or four; single runs on this
machine vary by 10-20%, so anything under that is noise here).

**A cached successor index.** A `goto_tb` used to read the successor's
function index from the successor's block header: a load from a line
the source block has no other reason to touch. The index now lives in a
per-vCPU slot beside `jmp_target_addr` in the source block's own
`TranslationBlock`, which the jump reads anyway. An empty slot sends the
block back to the C dispatcher, which runs the successor and fills the
slot, ordered against a concurrent relink by another vCPU (store, full
barrier, reread the target); the slot is cleared whenever the jump is
set or reset, and when the successor's module is evicted, by walking the
evicted block's incoming-jump list under its lock. Keeping the miss path
in C keeps the generated code small: a jump misses once. On emubench
this measured flat, as expected: its blocks' headers are hot. It is
there for the dispersed regime, where the header is one of three or four
misses per transition.

**Direct calls inside a batch.** When a batch is assembled, each block's
jumps are already linked (a block runs 32 times in the interpreter
before it is queued, and every one of those runs returned through the
dispatcher, which links). So the assembler looks at each jump's current
target and, if that target is a block of the same batch, patches a
guarded `return_call` to it into the body: `if target == <that header>
then return_call <that function>`. The guard reads the live
`jmp_target_addr`, so an unlink or relink after assembly makes it fail
and the generic path runs; a batch is evicted whole, so the callee
cannot disappear before the caller. Any other jump gets a guard no
target can match. A direct call in V8 is a jump through the module's
own jump table: no dispatch-table load, no signature check, no indirect
branch prediction. This is where the multi-block numbers moved:

| test     | 0006 | 0007 | 0007 / 0006 |
| -------- | ---: | ---: | ----------: |
| alu2     |  199 |  302 |       1.52x |
| alu4     |  185 |  344 |       1.86x |
| call     |   99 |  120 |       1.21x |
| indirect |  159 |  175 |       1.10x |

(Medians of 13 runs of the pinned engine and 6 of the final 0007 build
across the afternoon's interleaved rounds; `alu`, `mem` and `memstride`
did not move.)

`call` and `indirect` gain less because their returns and computed
jumps go through `goto_ptr`, which still looks the target up.

**An entry mode.** A block function now takes `(ctx, mode)`. The
dispatcher passes one mode and sets `ctx.do_init` right before its
call, so a function can tell a fresh dispatcher entry from an Asyncify
rewind into it (the store is skipped on rewind, as all non-call code is).
A chained entry passes the other mode and skips that check and the
store behind it: a tail call is never a rewind. Two memory operations
and a branch per transition; within noise on emubench, kept because it
also removed a store from every jump.

**Inline 64-bit multiplies.** The backend declared no 64-bit `mulu2` or
`muls2`, so TCG called a helper for the high half, and x86 wants that
half for the overflow flag of every 64-bit `imul`. Both are now emitted
inline from four 32x32 products (about forty wasm instructions),
including in the interpreter, where the helper went through the libffi
trampoline. emubench's cold-code tests happen to have an `imul` per
block and show it directly: cold2k/p100 52 to 83 mips, cold2k/p1600 53
to 73, cold50k/p2 20 to 37. The probe gained checks for the signed product's high half
and the overflow flag; the stock engine passes them through the helper
and 0007 through the new code.

Tried and dropped: a thread-private last-target cache for `goto_ptr`,
validated by an eviction epoch, so a monomorphic return skips the
target's header. `indirect` lost 12% (a polymorphic site pays three
stores per miss) and `call` did not gain; the header is hot in both
tests. It may still pay in the dispersed regime, but that cannot be
measured here below the noise, and it is 40 bytes of wasm per block.

### Across sizes: the suite, 0006 against 0007

`exec-bench` on the same site, single runs, Chromium 152 on the same
16-core host as the table above; the pinned engine is 0006. Boot times
were within noise of each other (about 5 to 9 s).

| package  | exec | wall 0006 | wall 0007 | browser CPU 0006 | browser CPU 0007 | peak RSS 0006 | peak RSS 0007 |
| -------- | ---- | --------: | --------: | ---------------: | ---------------: | ------------: | ------------: |
| hello    | cold |    1.02 s |    1.28 s |           1.26 s |           1.60 s |      2690 MiB |      2693 MiB |
| hello    | warm |    0.77 s |    0.77 s |           0.87 s |           0.85 s |      2695 MiB |      2697 MiB |
| ripgrep  | cold |    1.02 s |    1.03 s |           1.24 s |           1.30 s |      2721 MiB |      2680 MiB |
| ripgrep  | warm |    0.52 s |    0.52 s |           0.62 s |           0.62 s |      2727 MiB |      2686 MiB |
| jujutsu  | cold |    2.55 s |    2.55 s |           3.68 s |           3.74 s |      2780 MiB |      2790 MiB |
| jujutsu  | warm |    1.02 s |    1.02 s |           1.61 s |           1.42 s |      2795 MiB |      2803 MiB |
| python   | cold |    4.07 s |    4.33 s |           5.96 s |           6.20 s |      2838 MiB |      2884 MiB |
| python   | warm |    2.55 s |    2.55 s |           3.65 s |           3.92 s |      2865 MiB |      2811 MiB |
| opencode | cold |  159.90 s |  158.16 s |         221.44 s |         222.70 s |      3550 MiB |      3564 MiB |
| opencode | warm |  153.56 s |  132.72 s |         211.13 s |         185.61 s |      3510 MiB |      3545 MiB |

The small and medium binaries do not move: their time is boot, paging
and translation, not compiled transitions, and the quarter-second
swings on `hello` are boot variance. opencode's warm run, the second
execution in the same guest with everything already translated and
compiled, is 1.16x faster; the cold run is within noise of 0006 here. A
second opencode-only round the same afternoon read 0006 at 157 s cold
and 149 s warm against 0007 at 143 s cold and 133 s warm, so over both
rounds the warm gain is a steady 1.14x (133 s both times) and the cold
gain somewhere between nothing and 1.1x, inside the cold run's own
spread. The cold run's extra time over warm is translation,
interpretation during warm-up and paging, none of which this patch
touches, and the 130 s the two share is the dispersed compiled code the
profile below describes. Memory is flat.

### What the profile says now

A CPU profile of the vCPU worker during `opencode --version` with the
direct calls in place (sampled at 500 us, whole command): generated code
60%, `tcg_qemu_tb_exec` 12% (which includes the inlined interpreter, so
this is warm-up and dispatch together), `helper_lookup_tb_ptr` 5% plus
2.5% of hash-table lookups behind it, `cpu_loop_exit`'s longjmp 3%,
softmmu 2%, translation 2%. Compared with the 0006 profile the
dispatcher's share is about the same and the lookup's is lower; the
generated code's share is where the transitions now are, and it is
still the dispersed working set the section above describes.

## Browsers without tail calls

The chaining stage needs WebAssembly tail calls: Chrome 112, Firefox
121, Safari 18.2 and later. The engine checks once at start-up whether
`WebAssembly.validate` accepts a `return_call`, and if not it emits every
block exit as a return to the dispatcher instead, logs one warning on the
console, and otherwise runs the same batches and locals. That path was
verified by forcing it in a test build: it boots, passes the CPU probe,
and measures at about stage-1 speed (alu2 132 mips, call 83; the pinned
engine 119 and 68). Nothing else in the engine or the page depends on a
newer browser than the pinned engine already did.

## Measuring a change

Two apps, both driving a headless browser the way `cpu-test` does:

- `nix run .#emubench -- --site <site> [--engine <dir>] [--json f]`
  prints the per-mechanism table above for the site's engine, or for a
  locally built engine overlaid on it. CI runs it as a smoke test after
  the CPU probe: every row has to print, the numbers go in the log.
- `nix run .#exec-bench -- --site <site> [--engine <dir>] --json new.json [--baseline old.json]`
  boots a fresh guest per package for a small suite (hello, ripgrep,
  jujutsu, python, opencode), runs each command cold then warm, and
  reports wall time, the guest's own user/sys time, and the browser
  process group's CPU and peak RSS; with a baseline it prints ratios.
  This is the regression check across sizes; run it before publishing an
  engine. It is too slow and too noisy for CI.

Run the CPU probe before either; a wrong engine can be fast.

- `nix run .#bench-history -- --site <site> --out site/bench/history.json`
  runs both of the above against every engine this repository has ever
  pinned, on one machine in one sitting: it builds the site at each
  commit that repinned, so nix verifies that engine, snapshot and guest
  image by hash, puts them under today's page, and records emubench
  (median of three, corrected by the guest's clock ratio) and exec-bench
  per release. The site's benchmark page, [site/bench/](../site/bench/),
  draws the file. Rerun it after publishing an engine; the tags are
  immutable, so the history can always be regenerated from scratch.

## Across sizes: the suite, pinned engine against patch 0006

`exec-bench` on the same site, single runs, Chromium 152 on a 16-core
host. Boot times were within noise of each other (about 5 to 9 s).

| package  | exec | wall stock | wall final | browser CPU stock | browser CPU final | peak RSS stock | peak RSS final |
| -------- | ---- | ---------: | ---------: | ----------------: | ----------------: | -------------: | -------------: |
| hello    | cold |     1.28 s |     1.28 s |            1.64 s |            1.77 s |       2644 MiB |       2691 MiB |
| hello    | warm |     0.77 s |     0.77 s |            0.90 s |            0.89 s |       2646 MiB |       2697 MiB |
| ripgrep  | cold |     1.28 s |     1.02 s |            1.54 s |            1.50 s |       2667 MiB |       2669 MiB |
| ripgrep  | warm |     0.52 s |     0.51 s |            0.62 s |            0.51 s |       2669 MiB |       2675 MiB |
| jujutsu  | cold |     3.05 s |     2.55 s |            4.25 s |            3.82 s |       2759 MiB |       2806 MiB |
| jujutsu  | warm |     1.27 s |     1.02 s |            1.75 s |            1.46 s |       2765 MiB |       2820 MiB |
| python   | cold |     5.33 s |     4.58 s |            7.32 s |            6.70 s |       2843 MiB |       2871 MiB |
| python   | warm |     3.30 s |     2.55 s |            4.43 s |            3.63 s |       2847 MiB |       2886 MiB |
| opencode | cold |   461.12 s |   157.45 s |          527.78 s |          219.04 s |       3037 MiB |       3528 MiB |
| opencode | warm |   453.36 s |   153.16 s |          488.65 s |          210.84 s |       3073 MiB |       3490 MiB |

Small and medium binaries gain 1.0x to 1.3x; nothing regresses in wall
time or CPU. opencode gains 2.9x cold and 3.0x warm here (the 2.4x quoted
above was against an earlier, cleaner stock run; the stock engine varies
run to run by tens of seconds on this command). The cost is memory on
the big binary: peak browser RSS on opencode is 14-16% higher, the
larger block cache and the machine code for the many more blocks that
now compile. On the small ones it is flat.

## Known problem carried over

One of four final-engine opencode runs died at 158 s with
`Segmentation fault at address 0x8` and the same bun.report hash as the
race recorded in the startup investigation, which the pinned engine hits
about one run in three. The rate is not obviously different; it is not
fixed. The new engine does not make the race worse on the evidence here,
and does not explain it.

## The product-level truth

| path                                     | opencode --version |
| ---------------------------------------- | -----------------: |
| native service (experiments/native-exec) |             0.65 s |
| native QEMU fork over 9p                 |               11 s |
| browser, patch 0007                      |       143 to 158 s |
| browser, patch 0006                      |              171 s |
| browser, engine before 0006              |              408 s |

For a CI product the browser is still the wrong place to run a big cold
binary; 2.4x does not change two orders of magnitude. The native service
already sandboxes the closure with bubblewrap and returns in under a
second. The browser engine is the zero-install demo, and this patch makes
that demo 2.4x faster on the workload that hurt most.

## Linux 7.2.5 comparison

On September 12, 2026, we measured `engine-20260910-0209` (Linux
6.1.187) and `engine-20260912-2220` (Linux 7.2.5) sequentially on
leviathan. Both used the same Wasm engine, Chromium 152.0.7977.75,
package paths, and browser page. The guest kernel and resume snapshot
changed. The new guest also disables 9p negative dentry caching so
packages added after boot become visible immediately.

Both runs used `numactl --physcpubind=88-91 --membind=5`: four physical
cores on socket 1, with local memory. CPU affinity restricts placement;
it does not reserve cores or isolate shared caches and memory bandwidth.
The baseline's SMT siblings (216-219) averaged below 0.3% busy each,
with no five-second sample above 1.2%. An earlier run overlapped a Rust
build and was discarded.

| Package | 6.1 cold | 7.2.5 cold | 6.1 warm | 7.2.5 warm |
| ------- | -------: | ---------: | -------: | ---------: |
| hello   |   1.35 s |     1.34 s |   0.55 s |     0.54 s |
| ripgrep |   1.08 s |     1.33 s |   0.54 s |     0.54 s |
| jujutsu |   3.20 s |     3.97 s |   1.34 s |     1.33 s |
| python  |   5.32 s |     5.84 s |   3.18 s |     3.19 s |

Each package has one cold and one warm sample. Warm times are within
0.01 seconds; cold jujutsu and Python took longer in this pair. The
runner polls every 0.25 seconds, which limits interpretation of small
wall-time differences. These samples do not establish the variance or
prove that the kernel causes a repeatable slowdown.

Instruction-class results are medians of three runs. Guest-clock ALU
and memory timings remain close, while page faults increase from
95.94 to 128.39 microseconds per iteration and syscalls decrease from
4.14 to 3.21 microseconds. Guest/host clock ratios differ (0.922 versus
0.880); use the recorded host-clock throughput when comparing browser
performance.

Opencode succeeded on Linux 7.2.5: 189.65 seconds cold and 171.39 seconds
warm. Both timings are included on the benchmark page. The baseline
exited with status 4 and 5, so its elapsed times cannot serve as
successful execution measurements. The known intermittent crash above remains unresolved;
we did not capture enough baseline output to identify these failures as
the same crash. Previous published opencode timings remain unchanged.

The [paired measurements](../experiments/linux-7.2.5-results.json)
retain the pinned baseline and candidate data. The benchmark page adds
the new kernel's five successful package results and instruction-class
measurements, and reports the CPU affinity in its method notes.

### Follow-up investigation

Three more alternating pairs on leviathan reproduce a smaller cold-exec
regression than the first pair. The host still runs Linux 6.18.44; the
6.1-to-7.2 change is inside the emulated guest. The tests use the same
Chromium binary, package paths, CPUs 88-91 and NUMA node 5. The two sites'
Wasm binaries have identical SHA-256 hashes. Medians of the new samples:

| Package | 6.1 cold | 7.2 cold | Change | 6.1 warm | 7.2 warm |
| ------- | -------: | -------: | -----: | -------: | -------: |
| jujutsu |   3.19 s |   3.72 s | +16.6% |   1.33 s |   1.33 s |
| python  |   5.30 s |   5.58 s |  +5.3% |   3.18 s |   3.19 s |

Browser CPU also increases: cold jujutsu goes from 4.24 to 4.83 seconds,
and Python from 6.80 to 7.20 seconds. The extra browser CPU confirms
added work beyond any polling delay. These tests do not establish an opencode
regression: the original baseline executions failed, and older successful
measurements used a different host or engine.

#### The effective configs differ from the fragment

Extracting the embedded config from each shipped `bzImage` exposes
settings that `olddefconfig` silently stopped honoring:

| Setting                        | Linux 6.1.187  | Linux 7.2.5                                   |
| ------------------------------ | -------------- | --------------------------------------------- |
| Preemption                     | `PREEMPT_NONE` | `PREEMPT_LAZY`, `PREEMPT_COUNT`, `PREEMPTION` |
| Compile-time page-table levels | 4              | 5                                             |
| `MICROCODE`                    | disabled       | enabled                                       |

Linux 7.0 restricted `PREEMPT_NONE` to architectures with
`ARCH_NO_PREEMPT`; x86 now defaults to lazy preemption. This is documented
in the [scheduler pull request](https://lkml.iu.edu/2602.1/00765.html).
Our `CONFIG_PREEMPT_NONE=y` line cannot select the old mode on stock 7.2.
`PREEMPT_DYNAMIC` remains disabled, so a boot-time preemption parameter
does not change this build.

`X86_5LEVEL` is no longer a selectable symbol in 7.2. Its x86 Kconfig
sets `PGTABLE_LEVELS=5` for x86-64. This does not mean the guest uses
five-level hardware page tables: `Haswell-v4` does not expose LA57, and
the kernel folds the extra level at runtime. `MICROCODE` is now a
default-enabled symbol without a prompt, so the fragment's disable line
also has no effect.

SMP, debug-preemption checks, memory cgroups, page-table checking and
allocation/free zeroing defaults are not enabled. The machine already
boots with `mitigations=off`.

#### Config differences are not proof of the cause

A diagnostic 7.2 build removes only the `ARCH_NO_PREEMPT` dependency on
`PREEMPT_NONE`, allowing the existing fragment to select it again.
The resulting config drops preemption counting and restores the inline
unlock paths. This is an experimental source patch, not an upstream
configuration option.

Three rounds compare that build with an unmodified 7.2 kernel and a
second experiment using `clearcpuid=erms,rep_good`. Each gets a fresh
snapshot made on nyx, the same initramfs, and the same Wasm engine.
The second round reverses the variant order. Medians:

| 7.2 variant                      | jujutsu cold | python cold | Anonymous-page probe, host wall |
| -------------------------------- | -----------: | ----------: | ------------------------------: |
| Stock, fresh snapshot            |       3.71 s |      5.57 s |                          2.81 s |
| Restored `PREEMPT_NONE`          |       3.72 s |      5.57 s |                          2.77 s |
| Disable kernel fast-string paths |       3.72 s |      5.58 s |                          2.41 s |

Restoring the old preemption mode does not recover the cold-exec loss.
Disabling fast-string paths helps the standalone anonymous-memory probe
by about 14%, but does not improve these package executions. The probe
includes `mmap`, touching 16,384 pages, and `munmap`; it is not a direct
measurement of a single page-fault handler. A gain on that probe is not
enough reason to change the published guest CPU configuration.

`CONFIG_SLUB_TINY=y` also fails to help. Three subsequent samples give
3.74 seconds cold for jujutsu and 5.85 seconds for Python, with browser
CPU increasing to 5.01 and 7.41 seconds respectively. Removing allocator
features and code does not by itself make this guest faster.

The experimental snapshots have different guest-clock calibration from
the published snapshots. All comparisons in this investigation therefore
use host wall time or browser CPU. Merely checking that the clocksource
is named `tsc` does not verify its scale after migration.

#### File caching explains part of the gap

For jujutsu, read either the executable or every regular file in its
closure before starting the execution timer. Each sample still starts a
fresh browser and guest, and runs jujutsu for the first time. Medians of
three samples per case:

| Before first execution  | 6.1 wall | 7.2 wall | 6.1 browser CPU | 7.2 browser CPU |
| ----------------------- | -------: | -------: | --------------: | --------------: |
| No prefetch             |   3.19 s |   3.72 s |          4.24 s |          4.83 s |
| `cat` the executable    |   2.92 s |   3.19 s |          3.70 s |          3.96 s |
| `cat` all closure files |   2.66 s |   2.91 s |          3.40 s |          3.59 s |

Prefetch cost is outside the timer, so these are diagnostic measurements,
not proposed end-to-end speedups. Prefetch warms both file contents and
the emulator's translations of the kernel paths that read them. The
extra cold CPU falls from 0.59 to 0.19 seconds after reading the closure.
Warm wall times converge to 1.33 seconds; warm browser CPU still differs
slightly. This localizes
much of the regression to first-use file-loading/kernel work, but does
not identify a particular 9p or MM commit. Guest system time also charges
the cost of translating kernel instructions, so it cannot distinguish
longer kernel paths from more expensive translation.

Removing `negtimeout=0` from the 7.2 initramfs and taking another snapshot
does not help: cold jujutsu is 3.73 seconds and browser CPU is 4.84 seconds,
again medians of three. Linux 6.1's
[`v9fs_cached_dentry_delete`](https://github.com/torvalds/linux/blob/v6.1/fs/9p/vfs_dentry.c)
already discards negative dentries. The explicit timeout preserves that
behavior and fixes package additions; restoring the 24-hour default
would reintroduce the visibility bug without recovering performance.

#### Linux 6.18 already has the slowdown

A final build uses Linux 6.18.49 from the pinned nixpkgs input, with the
same guest config fragment and GCC 15.3.0. Its initramfs omits
`negtimeout=0`, which that kernel does not support. The kernel retains
`PREEMPT_NONE` and passes the CPU probe. Three samples give:

| Package | 6.18 cold wall | 6.18 cold browser CPU |
| ------- | -------------: | --------------------: |
| jujutsu |         3.74 s |                4.90 s |
| python  |         5.83 s |                7.40 s |

The jujutsu regression is already present in 6.18. Switching from 7.2 to
this LTS kernel does not recover the old timings. Linux 6.18 also has
the [`elf_load()` interpreter handling](https://github.com/torvalds/linux/blob/v6.18/fs/binfmt_elf.c)
that motivated the upgrade, although this investigation did not repeat
the Fil-C application tests on that kernel.

The evidence points to accumulated first-use kernel/file-loading work
between 6.1 and 6.18, including emulator translation costs. The exact
kernel change remains unidentified; a guest-PC profile or a version
bisect in that interval would be needed to name it. Worker-profiler
attachment did not produce a usable profile here, and the instrumented
timings are excluded from the results. None of the measured config
changes justifies changing the published guest. In particular, keep
`negtimeout=0` on 7.2 and avoid carrying a preemption-reversion patch for
this regression.

The [raw follow-up samples](../experiments/linux-7.2.5-investigation.json)
record the effective config values, kernel hashes and experimental
changes. The experiment directories and drivers are under
`/tmp/trynix-kernel-investigation` on leviathan; kernel-build expressions
and the extracted configs are under the same path on nyx. Published
engine pins and guest settings are unchanged.

#### Where the kernel work went

A bisect was not needed. Booting each guest on the fork's native
`qemu-system-x86_64` and counting what the kernel does gives exact,
repeatable numbers in a minute per kernel, and the browser regression
is visible there. The harness types `sh -c 'jj --version'` into the
guest twice over a 9p share holding the jujutsu closure, reads
`/proc/stat` and `/proc/vmstat` before and after, traces every 9p
request the emulator serves, and queries `info jit` between commands.
A TCG plugin on nixpkgs' QEMU 11.1 attributes every executed guest
instruction to a `System.map` symbol (the guest config has
`CONFIG_KALLSYMS=n`, so both kernels were rebuilt with their symbol
tables kept) and dumps a table at every vCPU idle, so the cold run can
be windowed between two `sync` calls.

Both kernels read the same 22 MB for a cold `jj --version`. What
differs is how, and how much kernel code runs per page:

| Cold `jj --version`, native      |     6.1 |     7.2 | Change |
| -------------------------------- | ------: | ------: | -----: |
| 9p read requests                 |      65 |      96 |   +48% |
| Major faults                     |      51 |      83 |   +63% |
| Context switches                 |     448 |     950 |  +112% |
| Guest instructions               |  39.7 M |  44.2 M |   +11% |
| Kernel instructions              |   6.3 M |  10.8 M |   +71% |
| Translated blocks executed       |  4.17 M |  4.94 M |   +18% |
| Blocks translated (fork)         |  30.1 k |  31.4 k |    +4% |
| Wall, fork qemu (median of four) | 0.545 s | 0.586 s |    +7% |

Warm runs match on every counter. Translation volume is not the story:
the cold run translates the same 30 thousand blocks either way, almost
all of them jj's own code. The extra work is kernel execution, and the
plugin's per-function table spreads it over page-cache and xarray
insertion (+1.3 M instructions), the scheduler and workqueues
(+0.6 M), the page allocator (+0.5 M), LRU handling (+0.5 M), unmap and
rmap (+0.4 M), fault handling (+0.4 M) and the 9p transport (+0.2 M).
No single function dominates.

Two of those lines have a named upstream cause.

Linux 6.16 changed readahead for executable mappings
(`do_sync_mmap_readahead` in `mm/filemap.c`, "mm/filemap: Allow arch
to request folio size for exec memory"). The old code read a window
centred on the faulting page, half behind and half ahead; the new code
starts at the fault and reads forward within the VMA, with no async
window. jj's start-up touches its binary in a backward-leaning order,
so 7.2 issues 96 reads where 6.1 issued 65, many of them 4 to 52 KB
fragments where 6.1 sent 496 KB chunks, and takes 83 major faults
instead of 51. Disabling that branch in a diagnostic build restores 65
reads and 51 major faults exactly.

Linux 6.13 moved netfs read completion onto a work item ("netfs:
Change the read result collector to only use one work item"). 9p's
`v9fs_issue_read` still completes synchronously in the faulting task,
but `netfs_readahead` sets `NETFS_RREQ_OFFLOAD_COLLECTION`, so every
readahead now wakes a kworker to unlock its folios and the reader
sleeps until it does. That is the doubled context-switch count, and
each switch costs the emulator a TLB flush. A diagnostic build that
runs the collector inline when `in_task()` removes most of it.

| 7.2 diagnostic build   | 9p reads | Major faults | Context switches | Native cold |
| ---------------------- | -------: | -----------: | ---------------: | ----------: |
| Stock                  |       96 |           83 |              950 |     0.586 s |
| Centred exec readahead |       65 |           51 |              735 |     0.580 s |
| Inline collector       |       96 |           83 |              746 |     0.587 s |
| Both                   |       65 |           51 |              609 |     0.574 s |

In the browser, three alternating rounds on leviathan with fresh
snapshots from the same native qemu (CPUs 88-91, NUMA node 5) give
these medians. The runner polls every 0.25 seconds, and every cold jj
wall time landed on 3.72 seconds, so browser CPU is the usable number:

| Guest kernel                | jj cold CPU | python cold CPU |
| --------------------------- | ----------: | --------------: |
| 6.1                         |      4.27 s |          6.84 s |
| 6.12                        |      4.54 s |          7.09 s |
| 7.2                         |      4.92 s |          7.20 s |
| 7.2, centred exec readahead |      4.76 s |          7.07 s |
| 7.2, inline collector       |      4.82 s |          7.16 s |
| 7.2, both                   |      4.70 s |          6.99 s |

Opencode, the 190 MB Bun binary, barely notices. Two rounds of the
same A/B give cold browser CPU of 198.7 s on 6.1, 198.8 and 200.3 s on
6.12, and 201.1 and 205.7 s on 7.2, with warm runs between 182 and
188 s on every kernel; the second 6.1 sample exited with status 4, the
known intermittent crash, and is excluded. Its cold time is its own
JIT, so the kernel's share is a few percent.

The 6.1 rows come from a second A/B whose control measured 5.02 s;
its later rounds overlapped plugin runs on other cores, so the 6.1 and
6.12 figures carry about 0.1 s of noise. The two named changes account
for roughly a third of the gap. Linux 6.12, which has the `elf_load()`
interpreter handling that motivated the upgrade but predates both
changes, recovers about half of it and already executes 1.9 M more
kernel instructions than 6.1 in the cold run. The remainder is
per-page code growth across the folio conversions of 6.2 to 6.12, with
no configuration knob behind it: the hot areas are the page cache,
rmap, LRU and the allocator on a uniprocessor kernel with memcg already
off.

A census of instruction classes the wasm engine handles expensively
(`rdtsc`, `cpuid`, `xsave`, control-register writes, MSR access,
`syscall`, string operations) found only one that moved: `rep stos`
executions rise from about 15 thousand to 33 thousand. Almost all of the
growth is GCC zeroing an `xa_state` with `rep stosq` inside `xa_load`
and `__filemap_add_folio`, a few quadwords each. Page clears stay near
1.6 thousand in both kernels. Nothing else in that list changed by
more than a few percent.

One more configuration idea was measured and set aside. The guest
boots with `mitigations=off`, so building with `CONFIG_CPU_MITIGATIONS=n`
drops the retpoline, return-thunk and call-depth machinery and shrinks
the image by 400 KB. Three rounds against the stock build give cold jj
browser CPU of 4.82 s against 4.90 s and Python 7.09 s against 7.16 s,
with native counters unchanged: about 1.5%, consistent across rounds
but not enough to justify a guest change by itself.

This is not a regression upstream would recognise. On real hardware
the exec readahead change and the netfs collector are neutral or wins;
the guest pays for them because every context switch, TLB flush and
9p round trip runs under emulation, and the engine multiplies the
kernel's own growth. The forward-only exec readahead is the one piece
worth raising upstream, since it costs more requests and more major
faults for any high-latency filesystem. Neither diagnostic patch is
proposed for the published guest.

Two housekeeping items fell out of the work. The config fragment
still carried `CONFIG_PREEMPT_NONE=y`, `# CONFIG_X86_5LEVEL is not set`
and `# CONFIG_MICROCODE is not set`, none of which 7.2's Kconfig
honours; they are gone, and the resulting `.config` is byte-identical.
Verifying that exposed why rebuilding the kernel from an unchanged
config had been giving a different `bzImage` every time: stdenv links
everything with `-rpath $out/lib`, the vDSO included, and the vDSO is
embedded in the kernel's read-only data, so the image carried its own
store path and any edit to the derivation's inputs moved the pinned
hash. `NIX_NO_SELF_RPATH=1` in the kernel derivation removes it; two
trees differing only by a comment now build the same image, and no
store path remains inside it. The image differs from the published
one by exactly that string, so the pins need a fresh snapshot and
release when this lands.

The [raw data](../experiments/linux-7.2.5-kernel-profile.json) holds
the counters, the plugin's per-function tables, the class census and
every browser sample. The harness, plugin source and kernel
expressions are under `/tmp/trynix-k7` on leviathan.
