// Tests the record of what a guest has printed, which both engines feed
// and the boot flow waits on. The recorder is fed strings and bytes by
// hand, the two forms a guest's output arrives in.
import { test } from "node:test";
import assert from "node:assert/strict";

import { consoleRecorder } from "../../site/js/console.js";

// Checks that strings and bytes both end up in the transcript as text,
// including a multi-byte character split across two pieces.
test("strings and bytes are heard as one transcript", () => {
  const recorder = consoleRecorder();
  recorder.hear("one ");
  recorder.hear(new TextEncoder().encode("two "));

  const snowman = new TextEncoder().encode("☃");
  recorder.hear(snowman.subarray(0, 1));
  recorder.hear(snowman.subarray(1));

  assert.equal(recorder.transcript(), "one two ☃");
});

// Checks that a wait for a marker resolves when the marker arrives,
// and at once when the marker was already heard.
test("a marker is waited for, and found if already heard", async () => {
  const recorder = consoleRecorder();
  let seen = false;
  const waiting = recorder.waitFor("ready").then(() => {
    seen = true;
  });

  recorder.hear("not yet\n");
  await Promise.resolve();
  assert.equal(seen, false);

  recorder.hear("ready\n");
  await waiting;
  assert.equal(seen, true);

  await recorder.waitFor("ready");
});

// Checks that the transcript keeps its tail and drops its head once it
// passes the limit.
test("the transcript is capped at its tail", () => {
  const recorder = consoleRecorder({ limit: 8 });
  recorder.hear("0123456789abcdef");
  assert.equal(recorder.transcript(), "89abcdef");
});
