// Tests the record of the roots selected into a running guest
// (site/js/roots.js): which roots an addition brings, whose programs
// take their names from packages already in the guest. Each test drives
// a record the way app.js does, a boot and then additions that finish
// or fail, with made-up digests.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rootRecord } from "../../site/js/roots.js";

const BOOTED = "b0000000000000000000000000000000";
const ADDED = "a0000000000000000000000000000000";
const LATER = "c0000000000000000000000000000000";

// Checks that an addition brings only the roots the guest lacks: the
// booted root is selected again with the new one, as app.js passes the
// whole selection, and only the new one takes its names.
test("an addition brings only the roots the guest lacks", () => {
  const record = rootRecord();
  record.booted([BOOTED]);

  const addition = record.adding([BOOTED, ADDED]);
  assert.deepEqual(addition.roots, [ADDED]);
});

// Checks that a finished addition's roots are the guest's: a later
// addition of the same selection and one more package brings the new
// package alone.
test("a finished addition's roots are the guest's", () => {
  const record = rootRecord();
  record.booted([BOOTED]);
  record.adding([BOOTED, ADDED]).done();

  const later = record.adding([BOOTED, ADDED, LATER]);
  assert.deepEqual(later.roots, [LATER]);
  assert.deepEqual(record.all(), [BOOTED, ADDED]);
});

// Checks that a failed addition, one never done, leaves its roots new,
// so the retry relinks them. An addition whose download failed used to
// record its roots anyway, and the retry linked nothing: hello 2.12.2
// added after a failed first try left hello --version saying 2.10.
test("a failed addition's roots are new to the retry", () => {
  const record = rootRecord();
  record.booted([BOOTED]);
  record.adding([BOOTED, ADDED]);
  assert.deepEqual(record.all(), [BOOTED]);

  const retry = record.adding([BOOTED, ADDED]);
  assert.deepEqual(retry.roots, [ADDED]);
  retry.done();
  assert.deepEqual(record.all(), [BOOTED, ADDED]);
});

// Checks that two additions of one root in flight at once, as two
// calls of the boot tool can start, each bring the root, and that the
// root is recorded once when both are done.
test("additions in flight together record a root once", () => {
  const record = rootRecord();
  record.booted([BOOTED]);
  const first = record.adding([ADDED]);
  const second = record.adding([ADDED]);
  assert.deepEqual(second.roots, [ADDED]);

  first.done();
  second.done();
  assert.deepEqual(record.all(), [BOOTED, ADDED]);
});
