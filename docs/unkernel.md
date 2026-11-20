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

The line under the Boot button says which engine is running and links
to the same selection on the other one.

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

## What it costs

- **Coverage.** Hydra has built aarch64-linux for fewer packages and
  for fewer years than x86_64-linux. In the two index shards checked
  (`ju`, `py`) aarch64 holds 87% and 93% of the versions x86_64 does.
  A version with no aarch64 build is shown struck through, as any
  unbuilt version is, and the switch link takes the reader to qemu.
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
nix run .#exec-bench -- --site "$site" --guest-engine unkernel
```

[unkernel]: https://github.com/pithings/unkernel
