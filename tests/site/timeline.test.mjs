// Tests the timeline's model (site/js/timeline.js): which keyframes
// the strip under the terminal shows, how each is labelled, where the
// reader is, and which other branches there are. Each test builds a
// keyframe tree the way the machine's events would and reads the
// positions back.
import { test } from "node:test";
import assert from "node:assert/strict";

import { branchesOf, LIVE, positionsOf } from "../../site/js/timeline.js";

// A tree from [id, parent, kind, command, at] rows. A prompt keyframe
// carries the command that ran before it, as the machine reports it.
function tree(rows) {
  const frames = new Map();
  for (const [id, parent, kind, command = "", at = id * 1000] of rows) {
    frames.set(id, {
      id,
      parent,
      kind,
      prompt: { status: 0, number: id, command },
      at,
      failed: false,
    });
  }
  return frames;
}

const P = "prompt";
const R = "running";
const D = "departed";

const brief = (positions) =>
  positions.map((p) => [p.id, p.command, p.future, p.here]);

// Checks the plain case: every prompt is labelled with the command
// typed at it, the newest has none yet, and the reader is at the live
// end after it.
test("a straight session ends at the live machine", () => {
  const frames = tree([
    [1, null, P],
    [2, 1, P, "ls"],
    [3, 2, P, "make"],
  ]);
  assert.deepEqual(brief(positionsOf(frames, 3)), [
    [1, "ls", false, false],
    [2, "make", false, false],
    [3, null, false, false],
    [LIVE, null, false, true],
  ]);
});

// Checks a session gone back to its first prompt: the keyframes after
// it, including the one kept of where the reader left, are the future,
// and there is no live end apart from the restored keyframe.
test("after going back, the later keyframes are the future", () => {
  const frames = tree([
    [1, null, P],
    [2, 1, P, "ls"],
    [3, 2, D],
  ]);
  assert.deepEqual(brief(positionsOf(frames, 1)), [
    [1, "ls", false, true],
    [2, null, true, false],
    [3, null, true, false],
  ]);
});

// Checks a fork: a command run after going back starts a branch, the
// strip follows the new branch, the fork point says so, and the old
// future is listed as another branch named by its last command.
test("a command after going back starts a branch", () => {
  const frames = tree([
    [1, null, P],
    [2, 1, P, "ls"],
    [3, 2, P, "rm -rf build"],
    [4, 3, D],
    [5, 1, P, "make"],
  ]);
  const positions = positionsOf(frames, 5);
  assert.deepEqual(brief(positions), [
    [1, "make", false, false],
    [5, null, false, false],
    [LIVE, null, false, true],
  ]);
  assert.equal(positions[0].forks, true);
  assert.deepEqual(branchesOf(frames, 5), [
    { tip: 4, command: "rm -rf build", current: false },
    { tip: 5, command: "make", current: true },
  ]);
});

// Checks that keyframes taken while a command ran are minor marks
// labelled with that command and how far into it they were.
test("running keyframes are labelled by their command", () => {
  const frames = tree([
    [1, null, P, "", 0],
    [2, 1, R, "", 5000],
    [3, 2, R, "", 10000],
    [4, 3, P, "make", 12000],
  ]);
  const positions = positionsOf(frames, 4);
  assert.deepEqual(
    positions.map((p) => [p.id, p.minor, p.command, p.seconds]),
    [
      [1, false, "make", null],
      [2, true, "make", 5],
      [3, true, "make", 10],
      [4, false, null, null],
      [LIVE, false, null, null],
    ],
  );
});

// Checks that a keyframe whose snapshot failed is not offered, while
// the keyframes around it are.
test("a failed keyframe is left out", () => {
  const frames = tree([
    [1, null, P],
    [2, 1, P, "ls"],
    [3, 2, P, "pwd"],
  ]);
  frames.get(2).failed = true;
  assert.deepEqual(
    positionsOf(frames, 3).map((p) => p.id),
    [1, 3, LIVE],
  );
});
