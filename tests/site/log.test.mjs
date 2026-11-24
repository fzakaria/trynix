// Tests the page's log (site/js/log.js): a message the same as the one
// before it, or a pair of messages that alternate, is counted on the
// last line of its first time instead of taking lines of its own, so a
// message repeated several times a second, as a guest retrying a host
// the relay refuses does, or a pair, as a guest GL context the
// renderer gave up on logs, cannot push the rest of the log out of its
// 500 lines. log() is called directly and the lines are read back
// through logLines().
import { test } from "node:test";
import assert from "node:assert/strict";

import { log, logLines } from "../../site/js/log.js";

// More repeats of one message than the log keeps lines.
const FLOOD = 2000;

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
      `second of the pair \\(these 2 lines ${FLOOD} times since \\d+\\.\\ds\\)$`,
    ),
  );
});

// Checks that a pair that stops repeating partway loses no message:
// the one that began another round before a third message came still
// takes a line of its own, in the order the messages came.
test("a pair broken partway keeps every message", () => {
  log("start");
  log("one");
  log("two");
  log("one");
  log("two");
  log("one");
  log("three");

  const [start, one, two, again, three] = lastLines(5);
  assert.match(start, /\s\d+\.\ds {2}start$/);
  assert.match(one, /\s\d+\.\ds {2}one$/);
  assert.match(
    two,
    /\s\d+\.\ds {2}two \(these 2 lines 2 times since \d+\.\ds\)$/,
  );
  assert.match(again, /\s\d+\.\ds {2}one$/);
  assert.match(three, /\s\d+\.\ds {2}three$/);
});
