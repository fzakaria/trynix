// Tests the page's log (site/js/log.js): a message the same as one of
// the last few lines is counted on the last line instead of taking a
// line of its own, so a message repeated several times a second, as a
// guest retrying a host the relay refuses does, or a few messages in
// any order, as a guest GL context the renderer gave up on logs,
// cannot push the rest of the log out of its 500 lines. log() is
// called directly and the lines are read back through logLines().
import { test } from "node:test";
import assert from "node:assert/strict";

import { log, logLines } from "../../site/js/log.js";

// More repeats of one message than the log keeps lines.
const FLOOD = 2000;

// How many rounds of a flooding pair pass between two of a third
// message's lines.
const THIRD_EVERY = 50;

const lastLines = (count) => logLines().split("\n").slice(-count);

// Checks that a message logged three times in a row is one line that
// says how many times and since when.
test("a repeated message is counted on one line", () => {
  log("before the repeats");
  log("repeated");
  log("repeated");
  log("repeated");

  const [before, repeated] = lastLines(2);
  assert.match(before, /before the repeats$/);
  assert.match(repeated, /\s\d+\.\ds {2}repeated \(3 times since \d+\.\ds\)$/);
});

// Checks that a message after a run of repeats takes a line of its own,
// and that the run's line keeps its count.
test("a different message after a repeat starts a line", () => {
  log("twice");
  log("twice");
  log("once");

  const [twice, once] = lastLines(2);
  assert.match(twice, /twice \(2 times since \d+\.\ds\)$/);
  assert.match(once, /\s\d+\.\ds {2}once$/);
});

// Checks that a flood of one message, many more times than the log has
// lines, leaves what came before it in the log.
test("a flood of one message keeps what came before it", () => {
  log("what came before the flood");
  for (let i = 0; i < FLOOD; i += 1) {
    log("the flood");
  }

  assert.match(logLines(), /what came before the flood/);
  assert.match(
    lastLines(1)[0],
    new RegExp(`the flood \\(${FLOOD} times since`),
  );
});

// Checks that two messages that alternate, as a guest GL context's
// refused draws and the kernel's failed submits do several times a
// second, are counted as one pair: the first time each came keeps a
// line, and so does what came before the flood.
test("two alternating messages are counted as a pair", () => {
  log("what came before the pair");
  for (let i = 0; i < FLOOD; i += 1) {
    log("first of the pair");
    log("second of the pair");
  }

  const [before, first, second] = lastLines(3);
  assert.match(before, /what came before the pair$/);
  assert.match(first, /\s\d+\.\ds {2}first of the pair$/);
  assert.match(
    second,
    new RegExp(
      `second of the pair \\(${2 * FLOOD - 2} more of these 2 lines since \\d+\\.\\ds\\)$`,
    ),
  );
});

// Checks that a third message that comes now and then among a flooding
// pair, as the guest GL context's once-a-second error report did, takes
// one line the first time and is counted with the pair after that,
// instead of breaking the pair's count into three new lines each time.
test("a third message among a flooding pair takes one line", () => {
  log("what came before the three");
  for (let i = 0; i < FLOOD; i += 1) {
    log("first of the three");
    log("second of the three");
    if (i % THIRD_EVERY === THIRD_EVERY - 1) {
      log("now and then");
    }
  }

  const [before, first, second, third] = lastLines(4);
  assert.match(before, /what came before the three$/);
  assert.match(first, /\s\d+\.\ds {2}first of the three$/);
  assert.match(second, /second of the three \(\d+ more of these 2 lines/);
  assert.match(
    third,
    /now and then \(\d+ more of these 3 lines since \d+\.\ds\)$/,
  );
});

// Checks that a message none of the run's lines has ends the run: it
// takes a line of its own, and the run's line keeps the run's count.
test("a new message after a pair starts a line", () => {
  log("start");
  log("one");
  log("two");
  log("one");
  log("two");
  log("one");
  log("three");

  const [start, one, two, three] = lastLines(4);
  assert.match(start, /\s\d+\.\ds {2}start$/);
  assert.match(one, /\s\d+\.\ds {2}one$/);
  assert.match(
    two,
    /\s\d+\.\ds {2}two \(3 more of these 2 lines since \d+\.\ds\)$/,
  );
  assert.match(three, /\s\d+\.\ds {2}three$/);
});

// Checks that a run that takes in an older line's message keeps the
// count of the run it follows on the same line, so no count is lost.
test("a run that grows keeps the count before it", () => {
  log("p");
  log("q");
  log("r");
  log("s");
  log("r");
  log("q");

  const [q, r, s] = lastLines(3);
  assert.match(q, /\s\d+\.\ds {2}q$/);
  assert.match(r, /\s\d+\.\ds {2}r$/);
  assert.match(
    s,
    /\s\d+\.\ds {2}s \(1 more of these 2 lines since \d+\.\ds\) \(1 more of these 3 lines since \d+\.\ds\)$/,
  );
});
