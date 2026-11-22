// Tests the page's record of what the console drew around each
// keyframe (site/js/screen.js). Each test plays the worker's events in
// order, output and keyframes and restores, and checks the bytes the
// terminal would be rebuilt from at a keyframe and at the live end.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ScreenLog } from "../../site/js/screen.js";

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

// Checks that a keyframe's screen is everything drawn before it was
// taken, and the live screen everything drawn since boot.
test("a keyframe's screen is what was drawn before it", () => {
  const log = new ScreenLog();
  log.append(encode("$ "));
  log.frame(1, null);
  log.append(encode("ls\r\nfile\r\n$ "));
  log.frame(2, 1);
  log.append(encode("pw"));

  assert.equal(decode(log.screenAt(1)), "$ ");
  assert.equal(decode(log.screenAt(2)), "$ ls\r\nfile\r\n$ ");
  assert.equal(decode(log.live()), "$ ls\r\nfile\r\n$ pw");
});

// Checks that after going back, new output continues the restored
// keyframe's screen, and a keyframe taken then is a branch whose
// screen does not contain the abandoned future, while the abandoned
// keyframe's screen is unchanged.
test("a branch's screen leaves the old future out", () => {
  const log = new ScreenLog();
  log.append(encode("$ "));
  log.frame(1, null);
  log.append(encode("one\r\n$ "));
  log.frame(2, 1);
  log.append(encode("half-typed"));

  log.restored(1);
  assert.equal(decode(log.live()), "$ ");
  log.append(encode("two\r\n$ "));
  log.frame(3, 1);

  assert.equal(decode(log.screenAt(3)), "$ two\r\n$ ");
  assert.equal(decode(log.screenAt(2)), "$ one\r\n$ ");
  assert.equal(decode(log.live()), "$ two\r\n$ ");
});

// Checks that a screen longer than the limit is cut to its last
// `limit` bytes, which is all a terminal with finite scrollback could
// show anyway.
test("a long screen keeps its end", () => {
  const log = new ScreenLog({ limit: 4 });
  log.append(encode("abc"));
  log.frame(1, null);
  log.append(encode("defg"));
  assert.equal(decode(log.live()), "defg");
  assert.equal(decode(log.screenAt(1)), "abc");
});
