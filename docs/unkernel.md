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
guest reloads the same selection on it, with the link's other settings
(memory, CPUs, downloads, network, relay, sound, the command to run)
kept. The QEMU guest ignores the ones it has no use for, and switching
back applies them again.

The guest side is unkernel's base system, with no distro image:

- the share is a MemoryFs the SDK serves over 9p on a vsock, mounted
  read-only at `/share`, with `/nix` linked into it, the same layout
  the qemu guest sees ([site/js/share.js](../site/js/share.js)). With
  downloads on first use, the default, the SDK serves it through a
  file system of the page's own that lists every path of the closure
  and holds a lookup until its path is in (below);
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

## Memory

The guest's memory is sized per boot ([site/js/memory.js](../site/js/memory.js)):

- 2 GiB on a computer, and 512 MiB on a touch screen, which is the
  same test that shows the phone key bar (`pointer: coarse`). Where the
  browser reports `navigator.deviceMemory` of 4 GB or less, the guest
  gets a quarter of it, never under 512 MiB.
- A link can ask for a size: `mem=2048`, in MiB, one of the sizes the
  Settings lane offers.
- The Settings lane offers 512 MiB, 1, 2 and 4 GiB. A choice there goes
  into the address bar's link, and nothing is kept in the browser: the
  link's size is used, else the default. The same goes for the CPUs,
  the downloads and the network below, and all four boxes are hidden on
  the x86_64 guest, which has none of them.
- When the browser cannot allocate the size, the SDK tries 1 GiB and
  then 512 MiB, and the Settings lane says what the guest booted with.

The guest was 512 MiB before, which firefox and other large programs
outgrow. unkernel allocates a page of the guest's memory when the
guest first touches it, so a large guest costs the host nothing it
does not use. Measured in headless Chromium on a laptop, 2026-11-23,
the browser's resident memory across all its processes with the guest
at its prompt:

| selection     | 512 MiB guest    | 2 GiB guest      |
| ------------- | ---------------- | ---------------- |
| hello         | 1,461, 1,412 MiB | 1,428, 1,482 MiB |
| foot, running | 1,609 MiB        | 1,604 MiB        |

The difference is inside the run-to-run noise. What a large guest
does cost is address space, which a phone may not have to give; that
is what the smaller default and the fallbacks are for.

## CPUs

The guest runs on several CPUs where the page can give them
([site/js/cpus.js](../site/js/cpus.js)). unkernel runs each guest CPU
in a Web Worker on one shared memory, with its SMP kernel, so this
needs the page cross-origin isolated (it is, on the deployed site and
under `nix run .#serve`) and the kernel in a worker, which is how the
page runs it there. A page that is not isolated runs the kernel on its
own thread, on one CPU.

- The default is unkernel's own page's: 4 in a desktop browser, 2 in
  Firefox and on a touch screen, and never more than half of
  `navigator.hardwareConcurrency`, since a guest CPU whose thread the
  host deschedules stalls the CPUs that wait for it.
- The most is one CPU per host thread, up to 16, the SMP kernel's
  `NR_CPUS` (unkernel's own page has the same limit). The Settings lane
  offers 1, 2, 4, 8 and 16, those the host has the threads for, a
  choice there going into the link. A link can ask for any count from
  1 to 16 with `cpus=`; asking for more than the host has threads boots
  one CPU per thread, and the Settings lane says so.
- unkernel's profile of its own page (Chrome, a 14-thread desktop) is
  why the default stays at 4: 8 CPUs gain only on work that is 8 wide,
  and each CPU past 4 costs 3-7% on single-threaded work, about 40 ms
  of boot and 9 MiB.
- The page reports the count the guest runs on (the kernel's
  `stats().cpus`), and says so under Settings when that is fewer than
  asked for.

Measured in headless Chromium on a laptop (16 threads, Radeon 780M),
2026-11-23, with a 2 GiB guest:

| program                         | 1 CPU         | 4 CPUs        |
| ------------------------------- | ------------- | ------------- |
| firefox, first start, to window | 37.3 s        | 28.9 s        |
| firefox, second start           | 32.7 s        | 23.7 s        |
| es2gears_wayland, first frame   | 2.9 s, 60 FPS | 3.0 s, 60 FPS |
| glmark2-es2-wayland score       | 766           | 730           |

A program with threads gains: firefox's parent and content processes
and their threads spread over the CPUs. A GL program does not; its
rendering is the page's, on one WebGL2 context. GUI programs, the
compositor's in-place reads of their buffers and the GL driver behave
the same on four CPUs as on one.

## Network

The guest has a network by default ([site/js/network.js](../site/js/network.js)).
unkernel's SDK gives it a network device whose frames end in a small
stack on the page (the SDK's `NetStack`): the guest is 10.0.2.15
behind a gateway at 10.0.2.2 with DNS at 10.0.2.3, and unkernel's base
userland takes that address by DHCP at boot. Each TCP connection goes
over one WebSocket to a Wisp relay, which opens it for the guest. Wisp
carries no DNS, so names resolve to stand-in addresses on the page and
the relay looks up the real name when it connects. There is no UDP
beyond DHCP and DNS, no IPv6, and nothing can connect in.

- The relay is unkernel's, `wss://wisp.unkernel.dev:6680`, whose
  author added trynix.dev to its allowed origins. It sees which hosts
  the guest connects to, and anything sent unencrypted.
- Settings can turn the network off or name another relay (a `ws:` or
  `wss:` URL that speaks Wisp v1 and accepts the page's origin), and
  both go into the link: `net=off`, `wisp=<url>`. A relay sees which
  hosts the guest connects to and anything sent unencrypted, so a link
  that names one says so in Settings and in the page's log.
- unkernel's base userland has no CA certificates. With the network
  on, the page writes nixpkgs' CA bundle, which the site ships
  (`certs.<hash>/ca-bundle.crt`, [nix/site.nix](../nix/site.nix)),
  into the share, and the shell sets `SSL_CERT_FILE` and
  `NIX_SSL_CERT_FILE` to it and links
  `/etc/ssl/certs/ca-certificates.crt`.
- The qemu engine's guest has no network device.

Measured in headless Chromium on a home connection, 2026-11-23: the
relay's handshake took 0.6 to 0.9 s, during the boot; `curl` to
`http://example.com/` 0.9 to 1.5 s and `https://example.com/` 1.1 s,
each a new connection through the relay.

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

The shell reaches its prompt the moment the closure is in, or with
downloads on first use the moment the selected packages are. The lane
used to wait for 0.4 s of console silence first, as the qemu lane
does; [site/js/unkernel.js](../site/js/unkernel.js) says what
replaced the wait and what the wait had been hiding.

## Downloads on first use

The page used to download a whole runtime closure before the shell
started, and a GUI program's closure holds far more than the program
opens. aisleriot's is 168 paths and 297 MiB compressed, and solitaire
never opens gcc (87 MiB, which guile references as its compiler).
firefox's is 322 paths and 450 MiB.

So on unkernel a boot now fetches the selected packages, and any Mesa
the guest may take as its GL driver, and starts the shell. Every other
path of the closure is listed in the guest's store from its narinfo,
its files are described from the cache's listing of the path, and its
NAR is fetched the first time the guest reads one of its files. Settings has
the choice as "Downloads"; a link names it as `fetch=lazy` (the
default) or `fetch=all`, which is the old behaviour. The qemu engine
always downloads everything first. Its share is read by QEMU's own 9p
code inside the engine, synchronously, and nothing there can wait for
a download.

[site/js/lazy.js](../site/js/lazy.js) does it in two pieces:

- `lazyStore` knows the closure and fetches a path once however many
  lookups wait on it: from the Cache API when the path is there,
  checked against its NarHash and unpacked into the MemoryFs, as a
  boot always did.
- `lazyFs` is what the SDK serves the guest: the MemoryFs, with
  `/nix/store` listing every path of the closure. A stat, a directory
  listing or a symlink inside a path that has not arrived is answered
  from the path's NAR listing (below); opening a regular file in it
  waits until the path is written.

A download that fails answers the lookup EIO, which the guest does not
cache, and the page's log says which path and why. The next lookup
tries again. The mount has no request timeout: the SDK's default of
30 s would fail a lookup that waits for a large NAR on a slow line.
The download has one of its own instead: one that goes 30 s without
a byte is abandoned and tried again, four attempts in all
([site/js/net.js](../site/js/net.js)), so a stalled connection cannot
hold a lookup forever, and a slow one that keeps moving still
finishes. Time the page itself was held up, as a tab in the background
or a page in a guest nested inside another guest is, does not count
toward the 30 s: a timer that fires late gets one more look before the
download is called stalled, so bytes that arrived meanwhile are read
first.

### NAR listings

A binary cache publishes a listing beside each narinfo, as
`<digest>.ls`: every file of the path with its type, size and
executable bit, as JSON ([site/js/listing.js](../site/js/listing.js)).
cache.nixos.org stores them zstd-compressed and serves them with
`Content-Encoding: zstd` whatever the request accepts, so the browser
decodes them; Chrome 123 and Firefox 126 do, and Safari has not been
tried. Each is fetched the moment the closure walk finds its path,
twenty at a time, and kept in the Cache API like a NAR.

For firefox the closure is 322 paths. The cache has listings for 319
of them (the other three are the site's GL driver and its closure,
whose cache publishes none), and they come to 362 kB compressed, 2.3
MB of JSON: one request per path beside the walk's one per narinfo. In
the page all 309 of firefox's own took 0.4 s twenty at a time, the
CDN's edge holding them. Fetched while the walk ran, every one was in
before the shell started, in every boot measured below.

From a listing the page answers what the NAR used to be fetched for
without needing its bytes:

- a name that is not there is ENOENT at once. A dynamic loader looks
  for each library in every directory of its search path in turn, and
  each of those looks used to download the directory's path;
- `ls -l`, `stat`, tab completion and `readlink` inside a path read
  nothing;
- the programs in every path's `bin/` go into `/share/bin` before the
  shell starts, behind the selected packages' programs, so `bash` from
  python3's closure is there at the first prompt. The boot waits up to
  2 s after the selected packages are in for listings still on their
  way; one that comes later is linked when it arrives.

The guest is told the same about a file before and after its path
arrives: type, mode and size come from the listing as the share will
write them, every file of the closure carries nix's one-second times,
and the share's own inode numbers and versions are left out, so the
9p server derives both from the path the same way both times. A path
whose listing cannot be had (a 404, a body the browser could not
decode, ten seconds without an answer) is downloaded whole the first
time the guest looks in it, as before listings.

A listing is not covered by the narinfo's signature; the NAR is,
through its NarHash. So when a path's NAR arrives, its listing is
checked against it: names, types, sizes, executable bits and symlink
targets. A listing still on its way then is checked when it lands, and
the NAR is written without waiting for it. A listing that differs is
named in the page's log and evicted from the Cache API, so no later
visit answers from it. The
answers it gave before the NAR arrived stand, and a name it hid stays
hidden from a path the guest never downloads. The farm is put right
when the NAR arrives, whether or not the listing differs: a program
link the listing made that the NAR does not back is removed, and
another path of the closure with a program of that name takes it, a
selected one before a dependency. Checked outside the page
on 2026-11-23, every one of the 319 listings in firefox's aarch64
closure matched its NAR on all five; ten of them, glibc's among them,
are an older format without `narOffset`, which the page does not read.

Fetching each listing only when the guest first looks in its path
instead costs a round trip at that first look, and then the farm cannot
list a path's programs before the guest has looked. Measured the same
way as the table below, the two came out level, to the shell and to
the first output, within 0.4 s on every row: solitaire 9.6 s on first
touch against 9.5 s fetched ahead, firefox 43.4 s against 43.8 s. So
the page fetches them all ahead, and the farm is what that buys.

### Whether a waiting lookup holds up the guest

It does not. unkernel's 9p server runs requests concurrently and
answers each as it finishes. Measured in Node against the pinned SDK,
with a file system whose answers for one directory wait 2 s: while a
process waited on it, a stat of an uncached sibling in the same
directory, a read from another directory of the mount and a command
that does not touch the mount took 5 to 8 ms each. The same in worker
mode, which is how the page runs the kernel when it is cross-origin
isolated.

The server runs at most 16 requests per mount at once. With 20
lookups waiting, a read of a file in another directory waited 3.5 s
for a slot. A program's start makes its lookups one at a time, so
reaching that takes 16 processes all stuck on downloads.

### Starting downloads before the guest asks

A program's first run makes its lookups one after another: the kernel
opens the program and its loader, the loader opens each library the
program needs, then each library each of those needs. Each first touch
of a path would be a round trip to the cache. Three things start paths
early:

- opening a file queues its ELF interpreter and the store paths in its
  RUNPATH or RPATH, in search order ([site/js/elf.js](../site/js/elf.js)).
- touching a path starts its narinfo references of 2 MiB or less in
  the background, which covers the icon themes, schemas and fonts no
  ELF header names. Only one level, or the whole closure would
  download the moment anything was touched;
- a selected package's references are all started at the boot.

When fewer than four downloads are running, the next slot goes to an
ELF prediction first. Each touched path's other references are queued
largest first. A download the guest is waiting on starts immediately,
even when all four slots are busy.

Starting paths early pays for itself. With all three turned off, so
that every path waits for the guest to ask, click to output at
18a0294a, before listings, in the setup the table below describes
(two cold runs each, against that build's own) went from 1.8 to
2.2 s for hello, 3.0 to 3.5 s for jj, 11.3 to 14.0 s for solitaire
and 49 to 61 s for firefox (50 and 72 s), and es2gears came out
level, 12.6 against 12.7 s. Reading only what is asked for saves
10 MB of solitaire's 98 and 40 MB of firefox's 253.

The first version started every reference of a touched path. In one
cold solitaire run that fetched 122 MiB the program never opened, gcc
and icu4c among it, and the downloads the first frame did wait on
queued behind them: the frame came 11.3 s after the command, with
204 MiB fetched. With the ELF headers and the size limit the same run
fetched 94 MiB and the frame came at 7.7 s. Largest first came from
firefox, whose wrapper references firefox itself (98 MiB) among thirty
smaller paths; listed in the narinfo's order, it started four seconds
after the others and was the download the first window waited on.

### What it costs and saves

Measured 2026-11-23 on a laptop (AMD Zen 4) over a home connection
that gave 10 to 17 MB/s from cache.nixos.org, headless Chromium 157,
before the guest had more than one CPU. Each boot is a link with
`boot=1`, the command typed the moment the shell is ready, and the
time to its output or to the program's first frame on the page. Cold
is a fresh browser profile, warm a second boot in the same one. After
one untimed boot of each, so that the CDN's edge held every NAR, each
row is the median of three runs, the variants taking turns. "Without
listings" is the page as of 73d5278a. The raw runs, with each path's
download and first lookup for some of them, are in
[experiments/lazy-downloads.json](../experiments/lazy-downloads.json).

Cold:

| program                    | downloads                      | shell  | to output | click to output | read by output | read in all |
| -------------------------- | ------------------------------ | ------ | --------- | --------------- | -------------- | ----------- |
| hello                      | all first                      | 2.0 s  | 0.09 s    | 2.1 s           | 11 MB          | 11 MB       |
|                            | on first use, without listings | 0.93 s | 0.87 s    | 1.8 s           | 10 MB          | 10 MB       |
|                            | on first use, with listings    | 1.0 s  | 0.85 s    | 1.9 s           | 10 MB          | 10 MB       |
| `jj --version`             | all first                      | 2.6 s  | 0.20 s    | 2.8 s           | 23 MB          | 23 MB       |
|                            | on first use, without listings | 2.2 s  | 0.43 s    | 2.6 s           | 22 MB          | 22 MB       |
|                            | on first use, with listings    | 2.2 s  | 0.48 s    | 2.7 s           | 22 MB          | 22 MB       |
| `python3 -c 'import json'` | all first                      | 6.9 s  | 0.74 s    | 7.6 s           | 86 MB          | 86 MB       |
|                            | on first use, without listings | 6.7 s  | 0.79 s    | 7.4 s           | 85 MB          | 85 MB       |
|                            | on first use, with listings    | 7.1 s  | 0.76 s    | 7.8 s           | 85 MB          | 85 MB       |
| sol, first frame           | all first                      | 20.9 s | 3.0 s     | 23.9 s          | 311 MB         | 311 MB      |
|                            | on first use, without listings | 2.7 s  | 7.2 s     | 10.0 s          | 98 MB          | 98 MB       |
|                            | on first use, with listings    | 2.7 s  | 6.7 s     | 9.5 s           | 98 MB          | 98 MB       |
| es2gears, first frame      | all first                      | 9.2 s  | 2.6 s     | 11.8 s          | 123 MB         | 123 MB      |
|                            | on first use, without listings | 3.1 s  | 6.9 s     | 10.1 s          | 91 MB          | 91 MB       |
|                            | on first use, with listings    | 3.1 s  | 6.6 s     | 9.8 s           | 91 MB          | 91 MB       |
| firefox, first window      | all first                      | 31.9 s | 25.5 s    | 57.8 s          | 472 MB         | 472 MB      |
|                            | on first use, without listings | 1.7 s  | 41.8 s    | 43.7 s          | 253 MB         | 253 MB      |
|                            | on first use, with listings    | 2.0 s  | 41.8 s    | 43.8 s          | 244 MB         | 244 MB      |

The listings' own bytes are not in "read": 14 kB for hello, 111 kB for
python3, 313 kB for solitaire, 362 kB for firefox.

Warm, everything read from the Cache API, measured the same way
before listings (medians of four runs downloading everything first,
two on first use, at 18a0294a):

| program                    | downloads    | shell  | to output | click to output |
| -------------------------- | ------------ | ------ | --------- | --------------- |
| hello                      | all first    | 0.64 s | 0.08 s    | 0.72 s          |
|                            | on first use | 0.61 s | 0.10 s    | 0.71 s          |
| `jj --version`             | all first    | 0.84 s | 0.24 s    | 1.1 s           |
|                            | on first use | 0.78 s | 0.24 s    | 1.0 s           |
| `python3 -c 'import json'` | all first    | 1.5 s  | 0.84 s    | 2.4 s           |
|                            | on first use | 1.4 s  | 0.79 s    | 2.2 s           |
| sol, first frame           | all first    | 4.7 s  | 3.3 s     | 8.0 s           |
|                            | on first use | 0.98 s | 4.3 s     | 5.2 s           |
| es2gears, first frame      | all first    | 2.7 s  | 2.8 s     | 5.5 s           |
|                            | on first use | 1.3 s  | 4.2 s     | 5.4 s           |
| firefox, first window      | all first    | 8.6 s  | 28.7 s    | 37.4 s          |
|                            | on first use | 1.2 s  | 33.4 s    | 34.6 s          |

"Read" is compressed bytes. A command-line package reads nearly its
whole closure either way, as the dropped attempt below found, so the
shell comes sooner and the first command later by about as much; jj's
cold total is the same and python3's NAR is most of its closure. The
GUI programs are where it pays: solitaire is on screen 14 s sooner
from a cold cache, having read a third of its closure, and firefox
14 s sooner, having read a little over half. A return visit costs
nothing more: the decompression the boot used to do before the shell
is now done as the program opens each path, and the totals come out
level or ahead.

Listings change what the guest can do without downloading, not how
fast a first run is: with them each row is within the runs' spread of
the row without, and firefox reads 9 MB less, the paths its loader
only searched. python3's shell came 0.4 s later in two runs of three
with listings, and level in the third; why is not known.

### What it changes

- A program's first run waits for what it opens. The shell is up
  earlier, and the time moves to the first command.
- A dependency's program on `PATH` downloads its path when it runs,
  and an interactive `ls` from coreutils in the closure is such a
  program.
- Opening a file starts the paths its ELF headers name, whether the
  loader ends up opening them or not. The GL case's site driver is
  built against an older glibc than mesa-demos and names that glibc in
  its RUNPATH; the loader finds every library it needs elsewhere, and
  no longer waits, but the 9.5 MiB glibc still downloads beside it.
- The page holds only what was fetched: a third of solitaire's
  closure, a little over half of firefox's.
- The boot's progress rows say what the boot waits for. "selected
  packages" fills before the shell starts, and "on first use" counts
  the whole closure as it arrives, before the shell and after it, and
  is done only if every path arrives.

## Measured and dropped

Each of these looked like a win and was measured on leviathan.

- **Fetching a store path only when the guest first touches it, for
  command-line packages.** A first command touches 85 to 97% of its
  closure's bytes: the package itself and glibc are nearly all of it,
  and a compressed NAR cannot be fetched in part. hello touches 2 of 5
  paths and 45 of 47 MiB. A GUI program's closure is another matter,
  and the page now does fetch on first use (above).
- **Showing the prompt before the closure is in.** The shell looks a
  command up in `/share/bin` first, and the links there cannot exist
  before the selected packages' own NARs have arrived, so every
  command would block where the prompt used to. Downloads on first use
  wait for exactly those NARs and no others.
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
- **Kernel features.** Since 0.2.0-261124 the kernel has ptrace
  register sets and seccomp filters (upstream 7fc4e1f and 0b65e72);
  `strace` from nixpkgs runs in the guest. A wasm trap in the kernel
  ends the session.
- **Maturity.** The project was eight days old when this was written,
  with one author and several releases a day. The version is pinned by
  hash in [nix/vendor.nix](../nix/vendor.nix).

Not tested yet: phones, Safari, and how
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
