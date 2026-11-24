// Tests the console's resize grip (site/js/grip.js): the terminal's
// height a drag or a key asks for, held between the shortest terminal
// worth having and nearly the viewport's height. Pure functions of what
// they are handed, so no page is needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { GripKey, clampHeight, keyedHeight } from "../../site/js/grip.js";

const BOUNDS = { min: 192, max: 900 };

// Checks that a dragged height stays between the bounds.
test("a dragged height stays between the shortest and the tallest", () => {
  assert.equal(clampHeight(500, BOUNDS), 500);
  assert.equal(clampHeight(50, BOUNDS), BOUNDS.min);
  assert.equal(clampHeight(5000, BOUNDS), BOUNDS.max);
});

// Checks the keys a focused grip takes: up makes the terminal shorter
// and down taller by a step, Home and End go to the bounds, and any
// other key is not the grip's.
test("the grip's keys move the height by a step or to a bound", () => {
  const step = 32;
  assert.equal(keyedHeight(500, GripKey.UP, { ...BOUNDS, step }), 468);
  assert.equal(keyedHeight(500, GripKey.DOWN, { ...BOUNDS, step }), 532);
  assert.equal(keyedHeight(200, GripKey.UP, { ...BOUNDS, step }), BOUNDS.min);
  assert.equal(keyedHeight(500, GripKey.HOME, { ...BOUNDS, step }), BOUNDS.min);
  assert.equal(keyedHeight(500, GripKey.END, { ...BOUNDS, step }), BOUNDS.max);
  assert.equal(keyedHeight(500, "a", { ...BOUNDS, step }), null);
});
