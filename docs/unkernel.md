# The unkernel engine

trynix has two engines. This document is about the second one, why it
is the default, and what it cannot do. The first, qemu-wasm, is in
[engine.md](./engine.md) and [performance.md](./performance.md).

[unkernel] is Linux compiled to WebAssembly with a real MMU. The kernel
is compiled code: syscalls, page faults, the page cache, 9p and exec
run at wasm speed. Only user programs are emulated, as aarch64, by an
interpreter and a JIT that live inside the kernel. qemu-wasm emulates
a whole x86_64 PC, so the guest kernel runs through the same
translator as the program.

That difference lands exactly where trynix is slow. Running a binary
for the first time is mostly kernel work: fault the closure in over
9p, map it, relocate it. [performance.md](./performance.md) traces the
qemu engine's first run to translating and interpreting code the guest
has not run before, and a large part of that code is the guest kernel.

## What was measured

Same machine (leviathan, EPYC 7763, four pinned cores), same day
(2026-11-20), headless Chromium 152 for both. The qemu numbers are
`exec-bench` against engine-20260913-2056, guest `real` seconds. The
unkernel numbers are npm `unkernel@0.2.0-261119-040e142` in a page
that fills a MemoryFs with the closure and mounts it, which is what
[site/js/unkernel.js](../site/js/unkernel.js) does. Seconds, cold then
warm.

| command                      | qemu          | unkernel      |
| ---------------------------- | ------------- | ------------- |
| `hello`                      | 0.68 / 0.24   | 0.021 / 0.006 |
| `rg --version`               | 0.55 / 0.18   | 0.056 / 0.012 |
| `jj --version`               | 1.98 / 0.74   | 0.20 / 0.11   |
| `python3 -c 'print(1)'`      | 3.46 / 1.89   | 0.66 / 0.55   |
| python, 3M-iteration `sum()` | 28.8 / 27.2   | 8.7 / 8.5     |
| `opencode --version`         | 116.5 / 108.3 | 56 / 59       |

These were taken on cores with turbo boost on (3.5 GHz), which this
host's kernel started doing after the benchmark page's September
records. Both columns ran that way, so the ratios hold, but the
seconds are a third lower than the history's. The benchmark page
([site/bench/](../site/bench/)) carries the same suite at the
history's clock, 2.45 GHz with boost off, through the real page and
shell: cold `jj --version` 3.02 s against 0.35 s, python 5.21 s
against 1.09 s, opencode 184 s against 98 s.

The package versions differ slightly between the two columns. The
unkernel side ran the aarch64 builds from the nixpkgs revision this
flake locks (jj 0.44.0, python 3.14.7, opencode 1.18.25), the qemu side
whatever the index held newest (0.47.1, 3.14.10, 1.18.29).

The kernel boots to a program in 0.38 to 0.47 s, so there is no
snapshot. `boot-test` on a laptop, click to prompt with the closure
download included: 3.9 s on unkernel, 7.6 s on qemu.

opencode takes 33 to 44 s under Node 24 with the same kernel, against
56 to 61 s in Chromium, where the JIT compiles two to three times as
many modules. Why is not known.

The raw results and the harness are on leviathan under
`~/bench/unkernel-20261120/`.

## Tracking it

`nix run .#bench-history -- --site <site> --out history.json --unkernel`
measures the unkernel version the site carries and, in the same run,
the site's qemu engine, and adds a record named after the version to
the history the benchmark page draws. Run it on leviathan pinned to a
NUMA node with boost off (node 7 as of 2026-11-20:
`numactl --physcpubind=120-123 --membind=5`), from a copy of the tree,
and do it again whenever the version in
[nix/vendor.nix](../nix/vendor.nix) changes.

### 0.2.0-261119-040e142 to 0.2.0-261123-8f039c5

Measured on a laptop (Ryzen 7 7840U, headless Chromium 152) on
2026-11-23, not on leviathan, so the history has no record of it yet.
`exec-bench` on the unkernel engine, eight runs per version with the
two versions interleaved, page seconds, median (min to max):

| package    | cold, before        | cold, after         | warm, before        | warm, after         |
| ---------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `hello`    | 0.086 (0.077-0.331) | 0.085 (0.075-0.125) | 0.054 (0.045-0.239) | 0.053 (0.045-0.072) |
| `rg`       | 0.034 (0.033-0.165) | 0.040 (0.037-0.071) | 0.018 (0.013-0.071) | 0.017 (0.011-0.024) |
| `jj`       | 0.130 (0.111-0.476) | 0.138 (0.129-0.148) | 0.102 (0.091-0.459) | 0.103 (0.091-0.122) |
| `python3`  | 0.569 (0.538-0.686) | 0.547 (0.520-0.649) | 0.494 (0.470-0.598) | 0.471 (0.439-0.544) |
| `opencode` | 24.6 (23.1-49.0)    | 24.9 (22.4-27.6)    | 24.2 (22.6-32.7)    | 25.0 (22.0-47.9)    |

opencode takes 9% less browser CPU (39.3 s against 35.7 s cold). Both
versions sometimes take twice as long on it, 48 s instead of 24 s, cold
or warm. The kernel reaches its first program sooner: 197 ms against
306 ms under Node, inline, from `createKernel` to the end of the first
exec. In the page that gain is lost in the closure download, which
dominates the boot column (hello 2.35 s against 2.59 s, with a spread
of two seconds on either side).

The slower cold `rg` and `jj` are a regression in worker mode. The new
release puts vsock packets for the guest on the shared transport's ring
(unkernel 57249c5), and 9p rides vsock, so every read of the share goes
that way. With the page's prefetch turned off, the first `jj --version`
takes 188 ms against 170 ms before, and `rg --version` 54 ms against
42 ms. Passing `shared: false` to `createKernel` gives 176 ms and 42 ms.
Under Node the same split holds: inline is unchanged, worker mode is
16 ms slower on `jj`, and worker mode without the shared transport is
not. The prefetch in [site/js/unkernel.js](../site/js/unkernel.js)
hides most of the regression, which leaves the 6 to 8 ms in the table.

## Running x86_64 programs on unkernel

Not possible today. unkernel's emulator has one front end, for A64, and
its kernel has one user ABI, arm64's. The guest could run a
`qemu-x86_64` of its own, and that was measured: `jj --version` took
10.8 s and `python3 -c 'print(1)'` 13.8 s, several times slower than
the qemu engine, because QEMU's translator emits aarch64 code that
unkernel then has to emulate again. So x86_64 store paths run on the
qemu engine, and the page keeps both.

## How the page uses it

[site/js/engine.js](../site/js/engine.js) picks the engine once per
page load:

- `?engine=unkernel` or `?engine=qemu` in the link wins;
- a link with a `path=` and no engine runs on qemu, because every such
  link was written when qemu was the only engine and names an x86_64
  path;
- otherwise unkernel where the browser has JSPI, and qemu where it
  does not.

The engine decides the system, and the system decides which of the
multiverse's per-system indexes a package name resolves against
(`meta-aarch64-linux`, `outs-aarch64-linux`). A link of package names
therefore works on either engine. A store path does not, so the page
writes the engine into every link that carries one, and a boot that
meets a selected path built for the other system stops with a message
that names the engine to use (it reads the ELF header of the path's
programs).

The Settings tab has the choice, as one "Guest" setting: aarch64 on
unkernel or x86_64 on QEMU. Architecture and engine are not two
settings because each engine runs one architecture. Choosing the other
guest reloads the same selection on it.

The guest side is unkernel's base system, with no distro image:

- the share is a MemoryFs the SDK serves over 9p on a vsock, mounted
  read-only at `/share`, with `/nix` linked into it, the same layout
  the qemu guest sees ([site/js/share.js](../site/js/share.js));
- the shell is busybox ash on a real pty, started with `ENV` pointing
  at `/share/manifest`, which sets PATH, TERM and LANG. A resize is a
  call on the pty, so there is no `stty` loop;
- a package added to a running guest is written into the MemoryFs. The
  mount has a one-second attribute timeout that also covers names that
  did not exist, so the page waits until the guest reports the new
  paths before saying they were added.

The kernel runs in a worker when the page is cross-origin isolated and
on the page's thread when it is not. Unlike qemu it does not need
isolation to run at all.

## Where a boot's time goes now

The kernel is up 0.3 to 0.8 s after the click. Everything after that
is the closure: downloading the NARs and decompressing them. Measured
in headless Chromium on a laptop, 2026-11-20, click to prompt:

| package  | return visit, before | return visit, now |
| -------- | -------------------- | ----------------- |
| jujutsu  | 3.5 s                | 0.7 s             |
| python3  | 2.4 s                | 1.3 s             |
| opencode | 2.5 s                | 1.7 s             |

A return visit has the compressed NARs in the Cache API, so its boot
is decompression alone. That used to run on the page's thread, one
archive at a time, in a pure JavaScript zstd decoder, and it held up
the kernel's own start as well. It now runs in workers, several at
once ([site/js/store.js](../site/js/store.js)). A first visit is
bound by the network: at 4.5 MB/s the opencode NAR alone is 13 s.

The shell reaches its prompt the moment the closure is in. The lane
used to wait for 0.4 s of console silence first, as the qemu lane
does; [site/js/unkernel.js](../site/js/unkernel.js) says what
replaced the wait and what the wait had been hiding.

## Measured and dropped

Each of these looked like a win and was measured on leviathan.

- **Fetching a store path only when the guest first touches it.** A
  first command touches 85 to 97% of its closure's bytes: the package
  itself and glibc are nearly all of it, and a compressed NAR cannot
  be fetched in part. hello touches 2 of 5 paths and 45 of 47 MiB.
- **Showing the prompt before the closure is in.** The shell looks a
  command up in `/share/bin` first, and the links there cannot exist
  before the selected packages' own NARs have arrived, so every
  command would block where the prompt used to.
- **A longer attribute timeout on the store mount.** A round trip to
  the page's file system costs 0.1 to 0.2 ms and repeated lookups are
  cached, hits and misses alike. A warm python3 makes about 175, most
  of them opens that any cache mode would make: roughly 25 ms of 550.
- **Turning ASLR off in the guest**, hoping decoded code would be
  reused across processes: 10 to 15% on a loop of process starts,
  within noise on python3 and jj.
- **Dropping `LANG=C.UTF-8`.** It costs a C program that converts
  characters about 50 ms a start (hello: 5 ms without, 58 ms with),
  because nixpkgs' glibc ships no gconv cache and parses the
  2,000-line `gconv-modules` table in every such process. Setting
  only `LC_CTYPE` costs the same. Rust and Python programs do not pay
  it, the qemu guest pays it too, and without a UTF-8 locale line
  editing breaks on multibyte input and btop refuses to start. Kept.
- **Running x86_64 through `qemu-user` in the guest**: above.

What is left is inside unkernel. A warm `python3 -c 'print(1)'` is
0.55 s against 0.02 s native, and nearly all of it is the emulator
running code it has not compiled yet: each process decodes its
program again, and code that runs only a few times stays on the
interpreter. That is the first item on unkernel's own roadmap.

## What it costs

- **Coverage.** Hydra has built aarch64-linux for fewer packages and
  for fewer years than x86_64-linux. In the two index shards checked
  (`ju`, `py`) aarch64 holds 87% and 93% of the versions x86_64 does.
  A version with no aarch64 build is shown struck through, as any
  unbuilt version is, with a note that Settings has the x86_64 guest.
- **Browsers.** JSPI means Chrome 137, Firefox 153 or Safari 27. An
  older browser gets qemu without being asked.
- **Kernel features.** No seccomp and no ptrace register sets, so
  `strace` and `gdb` do not work. A wasm trap in the kernel ends the
  session.
- **Maturity.** The project was eight days old when this was written,
  with one author and several releases a day. The version is pinned by
  hash in [nix/vendor.nix](../nix/vendor.nix).

Not tested yet: phones, Firefox and Safari, memory footprint, and how
many nixpkgs binaries use an instruction the emulator does not
implement (that would show as SIGILL).

## Updating it

The npm package carries the kernel prebuilt, so there is nothing to
build out of band. Change the version and hash in
[nix/vendor.nix](../nix/vendor.nix), then:

```sh
site=$(nix build .#site --no-link --print-out-paths)
nix run .#boot-test -- --site "$site" --engine unkernel
nix run .#webmcp-test -- --site "$site"
nix run .#gui-test -- --site "$site"
nix run .#exec-bench -- --site "$site" --guest-engine unkernel
```

[unkernel]: https://github.com/pithings/unkernel
