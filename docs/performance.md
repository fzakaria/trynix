# Performance

Measured on 2026-09-05 in headless Chrome against the built site, on a
Ryzen 7 7840U. Every number came from a run rather than an argument, and
the dead ends are written down because each of them cost an afternoon
and will look just as plausible next time.

Read the section on measuring first if you are about to measure
anything. Three separate conclusions in this document were wrong once,
and each time the cause was the instrument rather than the engine.

## Where a first run's time went

Running a binary for the first time took about fifty seconds of real
time; running it again took one. Every explanation offered for that was
wrong — not the store reads, not page faults, not translation, not the
dynamic loader. `strace -cf jj --version` in the guest settled it:

```
                    cold      warm
getrandom (6 calls) 14.25 s   0.0005 s
153 other syscalls   0.039 s  0.045 s
```

The random pool was empty. The snapshot is taken while init parks on the
handshake, before the kernel has seeded its CRNG, and a resumed guest
sees almost no interrupts to credit entropy with, so the first caller of
`getrandom()` drove `try_to_generate_entropy` — the kernel's TSC-jitter
loop — and spun there. Reading one byte from `/dev/random` at the prompt
cost twelve seconds; afterwards a cold run took under a second.

The machine had no entropy to offer. `RANDOM_TRUST_CPU` was set but
`qemu64` has no RDRAND, `RANDOM_TRUST_BOOTLOADER` was set but QEMU 8.2
never writes a seed on an `-kernel` boot, and the kernel had no
virtio-rng driver. It now has `+rdrand` and a `virtio-rng-pci` device,
and init forces a reseed before anything can consume randomness
(nix/guest/reseed.c explains why that cannot be left to timing).

A cold `jj --version` is now about 2.5 s of real time and a warm one
about 1 s. What remains is roughly 0.1 s of store reads, and the rest is
emulator work: interpreting and translating code the guest has not run
before.

## The guest's clock was 3.3x slow

Every duration this document used to quote was inflated by that factor,
and a guest `sleep 10` took 33 seconds.

The snapshot is taken by a native binary, where `cpu_get_host_ticks()`
is a real `rdtsc`, so the kernel calibrated its TSC to the host's
3.29 GHz while booting. It then resumed in the browser, where wasm has
no cycle counter and QEMU falls back to the monotonic clock —
nanoseconds, so 1 GHz. QEMU's own comment on that fallback reads "This
will be totally wrong, but hopefully better than nothing."

`patches/0003` makes the snapshotting build count the same clock, and
`build-native-qemu.sh` defines it. Both ends of a migration have to
agree about the clock as much as about the devices. `sleep 10` now takes
10.15 s and the guest reports 1000 MHz, which is what it gets.

## What the profile actually says

Share of non-sleeping vCPU-worker time, on a healthy guest:

| | jj cold | jj warm | hot loop |
|---|---|---|---|
| TCI interpreter | 46.3% | 41.7% | 1.0% |
| translation, `tb_gen_code` | 25.9% | 0.3% | 0.0% |
| generated code | 10.4% | 25.1% | 56.3% |
| `ffi_call_js` | 7.1% | 7.2% | 0.1% |
| C dispatch loop | 6.6% | 12.7% | 29.7% |
| `helper_lookup_tb_ptr` | 4.5% | 7.0% | 10.3% |
| `_emscripten_get_now` | 0.17% | 0.14% | 0.05% |

Running a program once and running a hot loop are different regimes, and
that difference is most of this table. An earlier version of this
document carried the hot-loop column and called it a first run, because
it had been measured through the entropy jitter loop, which is a hot
loop. That is why it once reported the interpreter at 5% and the clock
at 8%.

For running a program once, the interpreter and the translator are the
cost. Whether the 1500-execution threshold before a block is compiled
(`tcg/wasm32.h`) is the right number is open.

## Page faults are not the cost

With the VM event counters on, a first run and a second fault almost
identically while differing by a factor of nearly fifty:

```
first run    1732 faults
second run   1655 faults
```

The same pages are mapped both times, so neither faulting nor any other
per-page work explains the difference. Chase reading and translating
instead. Note also that the guest's own `time` charges emulator work to
whatever the guest was doing, so translation appears as guest system
time and reads like kernel work when it is not.

## Memory, and how large a closure fits

The engine is built with `-sTOTAL_MEMORY=2300MB` and no growth flag, and
its memory is created as `new WebAssembly.Memory({initial: n, maximum:
n, shared: true})` with initial equal to maximum. So it is 2.41 GB of
wasm address space, fixed when the engine is built, and the browser has
to hand over all of it the moment the engine instantiates.

| | |
|---|---|
| linear memory | 2.41 GB |
| guest RAM | 512 MiB |
| TCG code buffer (`tb-size=500`) | 500 MiB |
| left for the unpacked closure | ~1.2 GB |

That budget is on the **unpacked** closure, not the download: NARs are
decompressed into the emscripten filesystem, so a 200 MB download can
cost 800 MB of it. The guest still sees only 492 MB of RAM either way,
because the closure lives in the emulator's memory beside the guest
rather than inside it. Confirmed by booting real closures: nodejs at
219 MB unpacked boots in 9 s, llvm at 739 MB in 17 s.

The budget does not vary by machine, but whether the page runs at all
does. Because the memory is shared and cannot grow, a device that cannot
grant the whole reservation does not get a smaller closure — it gets no
VM, because the engine fails to instantiate. A 2.41 GB reservation is a
lot to ask of a phone.

It can be raised. Chrome grants a shared wasm32 memory at every size up
to the 4 GiB ceiling that 32-bit pointers impose, verified by allocating
and touching both ends at 2300, 3072, 4032 and 4096 MB. Going to about
4000 MB would take the closure budget to roughly 2.9 GB, and the build
already handles pointers above 2 GB. But it worsens exactly the case
that matters most, since it asks every phone for more.

Two better moves than raising it:

- The 500 MiB code buffer is committed and zeroed at boot, so it is
  resident on every device. A smaller one frees closure budget *and*
  cuts real memory use, helping small devices instead of hurting them.
  The cost is more translation-cache flushes, visible as
  `tb_flush_count`.
- Two engine builds, small and large, chosen by `navigator.deviceMemory`.
  The snapshot carries guest RAM and device state, and `TOTAL_MEMORY` is
  the emulator's own heap, so one snapshot should serve both — that last
  part is reasoning and has not been tested.

## Dead ends

Each was measured, and each was worse than or the same as doing nothing.

- **A faster or custom virtio driver.** The transport is not the
  bottleneck: a cold sequential read of a 30 MB binary over the existing
  9p mount runs at 46 MB/s.
- **`tsc=unstable` on the guest command line.** Worse, not better.
- **Prewarming the binary.** Reading it first changes nothing. Reading
  the whole closure does help, but only if it finishes before anyone
  types: there is one vCPU, so a background prewarm takes the cycles the
  command wanted and wall time does not move.
- **Blaming the page-fault path.** The counters above.
- **Compressing the snapshot.** GitHub Pages already serves it gzipped,
  30 MB down to 7.4 MB.
- **Moving to a host that sets COOP/COEP headers** to keep the browser's
  compiled-WebAssembly cache. Compiling the engine takes 56 ms warm or
  cold; the shim costs about half a second on a first-ever visit and
  nothing after.
- **Inlining the jump-cache probe into generated code.** About 0.7% of a
  cold run and 2.0% of a warm one. Worth building only as part of block
  chaining, which subsumes it.
- **`ioeventfd=off` on its own.** Buys nothing by itself. It is in the
  machine definition only because the main loop now sleeps, and 9p has
  to be off that loop for the sleep to be safe.
- **Turning the JIT threshold down.** Recorded once as slower, but that
  was measured on the entropy-starved workload and is not to be trusted.
  The profile above puts the interpreter at 46% of a real first run, so
  this deserves a proper retest.

## Block chaining, the standing engine candidate

Generated blocks never jump to each other: every cross-block jump returns
to a C dispatch loop that looks the next block up. That loop plus the
lookup is 11% of a cold run, 20% warm and 40% of a hot loop.

Chaining them is feasible. The blocks are hand-assembled wasm bytes, so
the toolchain is irrelevant and emitting `return_call_indirect` is a
matter of writing an opcode; WebAssembly tail calls work today in Chrome
and Firefox with no flags, verified at ten million cross-instance calls
at constant stack where a plain call overflows at one million.
Slot-based chaining needs no invalidation work, because `tb_reset_jump`
already has an emscripten branch that writes zero.

The hazard is asyncify. Blocks are not instrumented; the fork hand-rolls
resumption, and today the dispatch loop re-invokes the exact block that
unwound. Chained, the head of the chain is re-invoked instead, and
replaying it would pop the wrong frames off the asyncify stack — silent
corruption rather than a trap. The fix is to record which block unwound
and have each block's prologue forward straight to it, touching nothing
instrumented on the way. That has not been built or tested.

Bound the expectation: chaining only applies when both blocks are
already compiled, so it speeds hot code and does little for a first run.

## Measuring without fooling yourself

- **Kill the browser's process group**, not its parent. Leaked renderers
  keep running a guest; fifteen of them made a known-good build measure
  as twelve stalls out of twelve.
- **Give every run its own debugging port.** Reusing one attaches to the
  previous, dying browser and reports stalls that are not there.
- **Check a harness against a build known to be good** before believing
  what it says about one that might not be.
- **The profiler distorts durations.** Under it a 0.6 s read took
  minutes. Use it for proportions and take durations from an unprofiled
  run.
- **Profile the workload you care about.** The entropy loop was a hot
  loop, so it profiled like one, and every conclusion drawn from it
  described a regime the site does not spend its time in.
- **Watch what the guest's clock is worth.** It was 3.3x slow for the
  life of this project until today, so guest-reported durations meant
  nothing on their own. Cross-check against the page's
  `performance.now()`.

`nix run .#boot-test` is the standing version of the first three: it
boots the site repeatedly in a fresh profile and fails if a guest does
not reach a shell. CI runs it on every push, because two hangs shipped
while `nix flake check` was green.
