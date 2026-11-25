// Tests the page's log (site/js/log.js): a message the same as the one
// before it is counted on that one's line instead of taking a line of
// its own, so a message repeated several times a second, as a guest
// retrying a host the relay refuses does, cannot push the rest of the
// log out of its 500 lines. log() is called directly and the lines are
// read back through logLines().
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
