# The timeline

On the unkernel engine the console has a strip under it with a mark for
every command typed at the shell. Dragging back along the strip and
letting go puts the whole guest back where it was at that prompt: its
memory, its devices' state, the shell's half-typed line, and the
terminal's screen. Typing from there carries on from that point. The
qemu engine has no timeline.

This document says how that works, what it costs, and what it does not
do. The code is [site/js/machine.js](../site/js/machine.js) (the guest
side, in the guest worker), [site/js/keyframes.js](../site/js/keyframes.js)
and [site/js/pages.js](../site/js/pages.js) (how keyframes are stored),
[site/js/screen.js](../site/js/screen.js) and
[site/js/timeline.js](../site/js/timeline.js) (the page side).

## Using it

- Drag along the strip: the terminal shows each keyframe's screen as
  the pointer passes it, and nothing happens to the guest. Letting go
  restores the guest there. The caption names the position: "before
  `make`" is the prompt `make` was typed at.
- With the strip focused, the arrow keys step through the marks and
  the guest goes to the one they stop on 0.6 s after the last key.
  Enter goes at once, Escape returns to where the guest is. Home and
  End jump to the ends. The strip is one `role="slider"`, so a screen
  reader reads the position's name.
- After going back, the marks after the current one are dimmed: that
  is the future that was left. Going to one of them goes forward
  again.
- A command typed after going back starts a branch, below.

From code, `window.trynix.scrub` has `frames()`, `current()`,
`go(id)` and `stats()`; [tools/scrub-bench.py](../tools/scrub-bench.py)
drives it.

## Keyframes

A keyframe is taken at every prompt that follows a command, at the
first prompt, every five seconds while a command runs, and just before
going somewhere else if anything was printed or typed since the last
one. That last kind is what makes "go back, look, come back" lose
nothing.

The prompt says when it is drawn. The manifest puts a mark in front of
PS1, an OSC sequence carrying the exit status and the shell's last
history line ([site/js/prompt.js](../site/js/prompt.js)); the worker
reads it out of the console stream and removes it before the terminal
sees the output. A new history number means a command ran. The number
stays the same after an empty line, and also after a command that
repeats the one before it, which busybox's line editor leaves out of
the history, so the worker also counts the lines typed into the
console: any key and then Enter, the up arrow included, is a line;
Enter alone, Ctrl-C and the terminal's cursor reports are not. A
repeat typed ahead, before the prompt it belongs to is drawn, shares
the earlier prompt's keyframe. A
keystroke that arrives while a prompt's keyframe is still waiting for
the console to go quiet takes the keyframe first and reaches the guest
after it, so a command typed the instant the prompt is back still
leaves the prompt's keyframe behind it.

The snapshot is unkernel's own: `Kernel.snapshot()` parks every task
(arch/wasm/kernel/park.c) so that all of the kernel's state is in its
linear memory, and saves the host side of each device beside it. It is
refused while a 9p request or a vsock packet is in flight; a prompt's
keyframe is tried again every 50 ms, twenty times.

### Pages, not memory

A guest of 512 MiB changes a few hundred to a few thousand 4 KiB pages
per command, so a keyframe is stored as the pages that differ from its
parent. The worker keeps a shadow, a copy of memory as of the current
keyframe. At the snapshot point the live memory is compared with the
shadow page by page, as 32-bit words, skipping pages the kernel reports
free; each page that differs is copied into the shadow and out into the
keyframe. The comparison is the guest's pause, and it reads only the
pages in use.

The SDK's snapshot copies all of memory into a freshly allocated buffer
at that point, and the allocation is most of its cost: 215 of 354 ms
with 220 MiB in use, under Node. trynix carries a patch,
[patches/unkernel/0001](../patches/unkernel/0001-let-snapshot-take-the-memory-through-a-callback.patch),
that lets snapshot() hand the memory to a callback instead of copying
it; the callback is the page diff.

A keyframe's pages are compressed with the browser's deflate
(CompressionStream) after the guest has resumed, in chunks of 256
pages. Compressed keyframes are held in memory up to 128 MiB; past
that the oldest chunks move to an IndexedDB database of the page's own
([site/js/spill.js](../site/js/spill.js)), deleted when the page goes
away.

### Going to a keyframe

Restoring a keyframe means moving the shadow to it and starting a fresh
kernel instance from the shadow. Only pages that some keyframe between
the two changed can differ, so those are the pages rewritten, each from
the nearest keyframe at or above the target that holds it. The cost of
going back three commands is three commands' pages, whatever the
session's length, and the chunks mean a page from a big keyframe costs
one chunk to inflate. After a 200 MiB download into tmpfs and four
small commands, going back two commands moved the shadow in 1749 ms
when each keyframe was one deflate stream, and in 122 ms with chunks.

The new instance is created with `createKernel({ restore })`, given the
same compiled kernel module and the share's MemoryFs again. The 9p
session of the share survives a restore: the guest's open files on it
are opened again by path. Every other vsock session is reset, which is
why the shell is the one on the kernel's console (hvc0) and not a pty
from spawn(), whose session would hang up.

### The screen

The terminal's screen is page state, not guest state. The page keeps
every byte the console sent, cut into one piece per keyframe: the
worker posts a keyframe's event from inside the snapshot point, on the
same channel as the output, so the cut falls exactly between the output
from before the keyframe and from after it. A keyframe's screen is the
pieces from the first keyframe down to it, fed to a reset ghostty. The
terminal's answers to queries in those bytes (the line editor's cursor
position question) are dropped. ghostty-web has no way to save and load
its state, so replaying is the only way to rebuild it.

## Branches

Going back and running a command keeps both futures. Keyframes form a
tree: the next keyframe's parent is the one gone back to, beside the
keyframes that came after it the first time. The strip shows one line
of the tree: the keyframes down to the current one, then on along the
newest child. After a command it follows the new branch, a ring marks
the keyframe another branch leaves from, and a list beside the caption
names every branch by its last command; choosing one goes to its end.

Branches are kept because dropping them would make one accidental Enter
after a look back destroy the session that was there. They cost only
storage, the cap above bounds what they hold in memory, and a branch's
pages are shared with its parent's up to the fork.

## What it costs

Measured in headless Chromium on a laptop (AMD, 2026-11-21) with
`nix run .#scrub-bench`: a 512 MiB guest, one CPU, the session each
package's entry in the tool types. The pause is the whole snapshot()
call; nearly all of it is the page diff. Sizes are the pages that
changed and their compressed size.

| keyframe                        | pages | stored  | pause  |
| ------------------------------- | ----- | ------- | ------ |
| hello, first prompt             | 5076  | 3.5 MiB | 40 ms  |
| `hello`                         | 1546  | 1.6 MiB | 11 ms  |
| `ls -la /share/bin`             | 828   | 727 KiB | 8 ms   |
| `sleep 6`, while running        | 569   | 467 KiB | 11 ms  |
| jujutsu, first prompt           | 12750 | 14 MiB  | 187 ms |
| `jj --version`                  | 2702  | 2.9 MiB | 36 ms  |
| `jj describe -m first; jj log`  | 2116  | 1.9 MiB | 34 ms  |
| python3, first prompt           | 5515  | 4.1 MiB | 153 ms |
| `python3 -c 'print(1)'`         | 4561  | 5.4 MiB | 47 ms  |
| a 30M-iteration `sum()` running | 117   | 77 KiB  | 25 ms  |

The first keyframe holds everything in use, including the page cache
the boot's read-ahead of the selected programs filled (jj's binary is
most of its 50 MiB). After that a command costs 0.5 to 3 MiB stored.
With 220 MiB of memory in use, after a 200 MiB download into tmpfs, an
`echo` paused the guest 44 to 47 ms: the comparison grows with what is
in use, and the SDK's own snapshot paused 354 ms at that size.

Going to a keyframe, from release to a restored shell, and the first
command after it:

| session                      | restore | moving the shadow | restored instance | `true` after |
| ---------------------------- | ------- | ----------------- | ----------------- | ------------ |
| hello, back to first command | 609 ms  | 177 ms            | 423 ms            | 51 ms        |
| hello, forward to the end    | 402 ms  | 114 ms            | 269 ms            | 50 ms        |
| jujutsu, back                | 769 ms  | 369 ms            | 351 ms            | 51 ms        |
| jujutsu, forward             | 455 ms  | 153 ms            | 288 ms            | 51 ms        |
| python3, back                | 998 ms  | 332 ms            | 610 ms            | 366 ms       |
| python3, forward             | 950 ms  | 462 ms            | 463 ms            | 264 ms       |

The restored instance's time is the SDK's restore: a new memory, the
512 MiB copied in, and the kernel's resume. A restored instance's JIT
starts cold, which is the python rows' slow first command.

The shadow costs as much memory as the guest uses, on top of the guest
itself.

## What it does not do

- Scrub inside a command. Keyframes taken while a command runs give
  five-second steps; anything finer needs replay, below.
- Take the share back. Packages added to a running guest stay in the
  share after going back to a keyframe from before they were added,
  and a link the farm replaced keeps its new target. The guest sees
  them within its one-second attribute timeout.
- Keep a screen's layout across a resize. The recorded bytes assumed
  the terminal's width when they were drawn, and a screen replayed at
  another width wraps where the guest did not.
- Rebuild more than the last 2 MiB of a screen. The page keeps at most
  that much of the console per keyframe, past the terminal's 5000
  lines of scrollback, so that a command flooding the console cannot
  fill the tab.
- Keep a nested shell's commands apart. Only the login shell's prompt
  carries the mark, so `sh` started at the prompt is one long command
  until it exits.
- Firefox, Safari, phones' memory: not tried. The shadow doubles the
  guest's memory use, which a phone may not have.

## Replaying inside a command

Scrubbing inside a command means starting from the keyframe before the
point and running the guest forward to it, the same way it ran the
first time. [experiments/determinism.mjs](../experiments/determinism.mjs)
tests whether it does, under Node 24 with the same kernel. Everything
that reaches unkernel.wasm from outside goes through its 47 imports
(`wasm-objdump -x -j Import unkernel.wasm`), plus one channel that is
not an import: the host sets interrupt bits in the kernel's memory. The
host's JavaScript can only run while the kernel is suspended inside an
import (sched_yield, poll_oneoff or a task switch), so that channel is
tied to import calls too.

The experiment restores one snapshot twice and pins the inputs: the
clock is virtual (one microsecond per clock_time_get, and an idle
poll_oneoff jumps it to its timer), random_get is seeded, and the
commands are typed at import call 2000. It logs every import call with
its arguments, its result and the interrupt word as it returns, and
hashes all of memory at a fixed call.

| run                                         | import calls | JIT compiles | logs               | memory |
| ------------------------------------------- | ------------ | ------------ | ------------------ | ------ |
| base shell, a 300k-round shell loop         | 55,275       | 377          | equal              | equal  |
| with a MemoryFs mounted over 9p, 20k rounds | 11,812       | 191          | equal              | equal  |
| inputs not pinned (`--real`)                |              |              | differ at call 372 | differ |

With the inputs pinned, nothing else leaked: no host timing reached the
guest through a JIT compile, a task switch or the 9p server, which
answers on the same thread and in an order the clock decides. Unpinned,
the runs part at call 372, where one reads the clock and the other
waits in poll_oneoff, because the clock had moved.

A virtual clock is not what the page wants, since it makes `sleep 6`
take no time. The other way to pin the inputs is to record them:
[experiments/replay.mjs](../experiments/replay.mjs) runs the guest on
its real clock, randomness and typing, and records what each of five
imports returned and wrote into memory: clock_time_get, random_get,
fd_read, poll_oneoff and sched_yield, with the interrupt word as each
returned. Every other import (task switches, JIT compiles, console
writes) depends only on what the kernel asks and runs for real on
replay. A replay restores the same snapshot, answers those five from
the record up to a chosen call, and then switches the instance to live
inputs, with the guest's clock carried on from its last recorded
reading.

The record run typed `cat /proc/uptime; date; echo $RANDOM; sleep 1`,
eight bytes of `/dev/urandom` and a 100k-round loop: 22,360 import
calls in 6.3 s, and about 424 KiB of record. Replayed to calls 4000,
8000, 12000, 16000 and 20000, memory was identical to the record run's
at each, and each replayed guest went on to answer a command typed
live. Replaying to call 20000 took 3.9 s, the `sleep` skipped and the
loop at the speed it ran at first, since a restored instance's JIT
starts cold.

So scrubbing inside a command can be built on this: record the five
imports continuously in the guest worker, keep each keyframe's record
up to the next one, and to show a point between two keyframes, restore
the earlier one and replay to it. It is not built. What is missing:
the vsock imports (vsock_rx_len and vsock_recv carry the share's 9p
replies, and the page writes a NAR into the share when a package is
added, which changes what a replayed read returns, so the record needs
the bytes read, not a re-read); the time a replay takes, which is the
command's CPU time and not the wall time; a way to find the import call
for a point the reader picked on the strip (the console output's
offset, recorded per call, would do); and the JIT's one dependency on
the host, a compile it refuses while V8 has not collected freed
modules, which a long session could hit and the record would then need
to carry.
