# Performance

Measured on 2026-09-05, in headless Chrome against the built site, on a
Ryzen 7 7840U. Every number here came from a run rather than an
argument, and the dead ends are recorded because each of them cost an
afternoon and looks just as plausible the second time.

## Where the time goes

Booting is not the slow part. A cold visit reaches a shell in about
3.5 s locally and 4 to 5 s from the deployed site, most of it fetching
the closure. Running a binary for the first time is the slow part.

`jj --version`, whose binary is 30.6 MB:

```
first run                17 s   (1.4 s user, 16 s system)
first run, closure read sequentially beforehand    8.5 s
second run               1.2 s
```

So roughly half of a first run is reading the closure. The other half is
not what it looks like. With the VM event counters on, the two runs
fault almost identically — 1732 pages against 1655 — while differing by
a factor of nearly fifty in time:

```
first run    1732 faults   15.2 s
second run   1655 faults    0.3 s
```

Faulting pages in is therefore not the expense, and neither is any
per-page work: the same pages are mapped both times. What the first run
does and the second does not is read the store and translate guest code
it has not seen. Chase those, not the fault path — and note that the
guest's own `time` charges emulator work to whatever the guest was
doing, so translation shows up as the guest's system time and looks
like kernel work when it is not.

A CPU profile of the vCPU worker during that first run:

|                                                       |      |
| ----------------------------------------------------- | ---- |
| `tcg_qemu_tb_exec`, the C dispatch loop               | 20%  |
| generated guest code                                  | ~26% |
| `helper_lookup_tb_ptr`, from inside generated code    | 8.9% |
| guest `rdtsc` → `cpu_get_ticks` → `performance.now()` | 8.2% |
| TCI interpreter                                       | 5%   |

The dispatcher and the lookup are one cost wearing two hats: generated
blocks never jump to each other, so every cross-block jump returns to C
and looks the next block up in a hash table. That is the largest single
item, and the interpreter is not — at 5%, the 1500-execution threshold
before a block is compiled is not what makes a first run slow.

## What would actually help

- **Chain generated blocks to each other.** Worth most of the 29% the
  dispatcher and lookup take between them. Needs the target's function
  index stored when a block is compiled and a `return_call_indirect` to
  reach it; a plain call would grow the wasm stack per jump, so it needs
  the tail-call proposal, and the pinned emsdk 3.1.50 may not emit it.
  Check that first.
- **Make the guest's `rdtsc` cheap.** Every one is a call out to
  JavaScript, about 30 million of them in that run. Caching or
  interpolating `cpu_get_host_ticks` under emscripten would take the 8%,
  at the risk of the guest's own clock drifting; it is what the guest
  measures time with, so be careful.
- **Map the store instead of copying it.** The cost that survives
  prewarming is per-page work: faulting a 30 MB binary into a process
  through a page cache. An emulated NVDIMM with a DAX filesystem would
  let the guest map store pages straight out of emulated memory, no page
  cache and no copies, and with huge pages a handful of faults instead
  of thousands. It is a redesign rather than a patch: it wants a
  filesystem image where there is now a 9p share, which is also how
  packages are added to a running VM.

Together the first two are worth roughly 1.5x. They are not worth 10x;
that figure was the gap to native TCG, and closing it means a different
wasm JIT (many blocks per module, chained), not tuning this one.

## Dead ends

Each of these was measured, and each was worse than or the same as
doing nothing.

- **A faster or custom virtio driver.** The transport is not the
  bottleneck: a cold sequential read of the 30 MB binary over the
  existing 9p mount runs at 46 MB/s. There is nothing there to win.
- **`tsc=unstable` on the guest command line**, to stop the kernel
  reading the TSC so often. 17.25 s against 14.95 s: worse.
- **Blaming the page-fault path.** The counters say a 15 s first run and
  a 0.3 s second run fault the same number of pages. Whatever costs the
  15 s, it is not faulting.
- **Prewarming just the binary.** Reading it sequentially first costs
  0.6 s and leaves the first run unchanged at 17 s. Reading the whole
  closure does help — 8.5 s — but see the next entry.
- **Prewarming in the background while the reader types.** There is one
  vCPU, so the prewarm takes the cycles the command wanted: system time
  falls from 16 s to 6.1 s and wall time stays at 17.4 s. It only pays
  if it finishes before anyone types, which cannot be arranged.
- **Compressing the snapshot.** GitHub Pages already serves it gzipped,
  30 MB down to 7.4 MB. zstd and xz save another megabyte and cost a
  decoder in the page.
- **Moving to a host that sets COOP/COEP headers**, to keep the
  browser's compiled-WebAssembly cache. Compiling the engine takes 56 ms
  warm or cold; the shim costs about half a second on a first-ever visit
  and nothing after. `site/_headers` is there if the move happens for
  other reasons.
- **Turning the JIT threshold down** so blocks compile sooner. Slower when
  measured (11.6 s against 10.0 s), and the profile above says why:
  interpretation is 5% of the problem.
- **`ioeventfd=off` on its own.** It buys nothing measurable by itself.
  It is in the machine definition only because the main loop now sleeps,
  and 9p has to be off that loop for the sleep to be safe.

## Measuring without fooling yourself

Four ways these measurements went wrong before they went right:

- **Kill the browser's process group**, not its parent. Leaked renderers
  keep running a guest; fifteen of them made a known-good build measure
  as 12 stalls out of 12.
- **Give every run its own debugging port.** Reusing one attaches to the
  previous, dying browser and reports stalls that are not there.
- **Check a harness against a build known to be good** before believing
  what it says about a build that might not be.
- **The profiler distorts what it measures.** Under it, a 0.6 s read
  took minutes. Use it for proportions, never for durations, and take
  durations from an unprofiled run.

`nix run .#boot-test` is the standing version of the first three: it
boots the site repeatedly in a fresh profile and fails if a guest does
not reach a shell. CI runs it on every push, because two hangs shipped
while `nix flake check` was green.
