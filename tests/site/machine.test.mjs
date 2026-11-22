// Tests the unkernel machine that the scrubber takes back in time
// (site/js/machine.js), against the real kernel: the vendored SDK,
// patched (patches/unkernel/), booted inline under node. A session
// types commands on the guest's console, waits for the keyframes the
// prompts produce, restores earlier ones and checks the guest's files
// and the console against what each keyframe saw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { KeyframeKind, startMachine } from "../../site/js/machine.js";

const VENDOR = new URL("../../site/vendor/unkernel/", import.meta.url);
const MEMORY_MIB = 256;
const WAIT_MS = 20000;

// A machine and what it has said, with ways to wait on both.
async function session() {
  const sdk = await import(new URL("web.mjs", VENDOR));
  const kernel = await readFile(new URL("unkernel.wasm", VENDOR));

  let output = "";
  const frames = [];
  const events = [];
  const decoder = new TextDecoder();
  const machine = await startMachine({
    sdk,
    kernel,
    memoryMiB: MEMORY_MIB,
    cols: 80,
    rows: 24,
    onEvent(event) {
      events.push(event);
      if (event.type === "output") {
        output += decoder.decode(event.bytes, { stream: true });
      }
      if (event.type === "frame") {
        frames.push(event.frame);
      }
    },
  });

  // Resolves once `check` holds, polling; fails the test after WAIT_MS.
  async function until(check, what) {
    const deadline = Date.now() + WAIT_MS;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what}; output: ${output.slice(-500)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // Type a command and wait for the keyframe at the prompt after it.
  async function run(command) {
    const before = frames.length;
    machine.write(`${command}\n`);
    await until(
      () => frames.slice(before).some((f) => f.kind === KeyframeKind.PROMPT),
      `the prompt after ${command}`,
    );
    await machine.stats();
    return frames.at(-1);
  }

  return {
    machine,
    frames,
    events,
    output: () => output,
    until,
    run,
  };
}

// Checks the whole loop on a real guest: the first prompt and every
// prompt after a command get a keyframe labelled with that command,
// the shell's prompt marks never reach the output, restoring an older
// keyframe brings back the files and the shell as they were, the
// next keyframe after a restore is a branch off the restored one, and
// the share and exec() keep working in a restored machine.
test("keyframes at prompts restore the guest as it was", async () => {
  const s = await session();
  try {
    s.machine.files.writeFile("/hello.txt", "from the share\n", {
      mode: 0o644,
    });
    await s.machine.run([]);
    await s.until(() => s.frames.length >= 1, "the first keyframe");
    const start = s.frames[0];
    assert.equal(start.kind, KeyframeKind.PROMPT);
    assert.equal(start.parent, null);

    const one = await s.run("echo one > /tmp/a");
    assert.equal(one.prompt.command, "echo one > /tmp/a");
    assert.equal(one.parent, start.id);
    const two = await s.run("echo two > /tmp/a");
    assert.equal(two.parent, one.id);
    assert.doesNotMatch(s.output(), /\x1b\]7701/);

    // Back to the prompt after "one": the file says one again, and the
    // next keyframe hangs off the restored one.
    await s.machine.restore(one.id);
    const branch = await s.run("cat /tmp/a /share/hello.txt");
    assert.equal(branch.parent, one.id);
    assert.match(s.output(), /one\r?\nfrom the share/);
    const read = await s.machine.exec("/bin/cat", ["/tmp/a"]);
    assert.equal(read.stdout, "one\n");

    // And over to the other branch.
    await s.machine.restore(two.id);
    const after = s.output().length;
    await s.run("cat /tmp/a");
    assert.match(s.output().slice(after), /two/);
  } finally {
    await s.machine.stop();
  }
});

// Checks that an empty line at the prompt takes no keyframe: nothing
// ran, so there is nothing new to go back to.
test("an empty line takes no keyframe", async () => {
  const s = await session();
  try {
    await s.machine.run([]);
    await s.until(() => s.frames.length >= 1, "the first keyframe");
    await s.run("true");
    const count = s.frames.length;
    s.machine.write("\n");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(s.frames.length, count);
  } finally {
    await s.machine.stop();
  }
});
