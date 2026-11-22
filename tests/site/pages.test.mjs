// Tests the page diff a keyframe is made of (site/js/pages.js). Each
// test builds a small "live" memory and a shadow of it by hand, makes
// the changes a guest would, and checks which pages the diff reports,
// what it copied out, and that the shadow matches the live memory
// afterwards, as the next diff assumes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { capturePages, PAGE_SIZE, writePage } from "../../site/js/pages.js";

const PAGES = 16;

// A memory of PAGES pages, a shadow of the same size, and the shadow's
// record of which pages it has ever written.
function machine() {
  return {
    live: new Uint8Array(PAGES * PAGE_SIZE),
    shadow: new Uint8Array(PAGES * PAGE_SIZE),
    written: new Uint8Array(PAGES),
  };
}

// A free-page bitmap with the given pages marked free.
function freeMap(pages) {
  const map = new Uint8Array(Math.ceil(PAGES / 8));
  for (const page of pages) {
    map[page >> 3] |= 1 << (page & 7);
  }
  return map;
}

const pageOf = (memory, page) =>
  memory.subarray(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

// Checks that an empty shadow against a memory with two pages in use
// reports exactly those two pages, copies their bytes in order, and
// leaves the shadow equal to the memory.
test("a first diff reports every page in use", () => {
  const { live, shadow, written } = machine();
  pageOf(live, 3).fill(7);
  pageOf(live, 9)[100] = 1;

  const diff = capturePages({ live, shadow, written });

  assert.deepEqual([...diff.changed], [3, 9]);
  assert.deepEqual([...diff.zeroed], []);
  assert.equal(diff.data.length, 2 * PAGE_SIZE);
  assert.deepEqual(diff.data.subarray(0, PAGE_SIZE), pageOf(live, 3));
  assert.deepEqual(diff.data.subarray(PAGE_SIZE), pageOf(live, 9));
  assert.deepEqual(shadow, live);
});

// Checks that a second diff after one byte changes reports only that
// page: unchanged pages cost nothing.
test("a second diff reports only the page that changed", () => {
  const { live, shadow, written } = machine();
  pageOf(live, 3).fill(7);
  pageOf(live, 9).fill(8);
  capturePages({ live, shadow, written });

  pageOf(live, 9)[4095] = 0;
  const diff = capturePages({ live, shadow, written });

  assert.deepEqual([...diff.changed], [9]);
  assert.deepEqual(shadow, live);
});

// Checks that a page the kernel reports free counts as zero whatever
// garbage it still holds, so a page freed since the last diff is
// reported as zeroed (with no bytes copied) and a page that was free
// both times is not reported at all.
test("free pages count as zero", () => {
  const { live, shadow, written } = machine();
  pageOf(live, 2).fill(5);
  pageOf(live, 4).fill(6);
  capturePages({ live, shadow, written });

  // Page 2 is freed with its old bytes left in place; page 4 stays.
  const free = freeMap([2, 10]);
  pageOf(live, 10).fill(9);
  const diff = capturePages({ live, shadow, written, free, freePages: PAGES });

  assert.deepEqual([...diff.changed], []);
  assert.deepEqual([...diff.zeroed], [2]);
  assert.equal(diff.data.length, 0);
  assert.equal(diff.freeBytes, 2 * PAGE_SIZE);
  assert.ok(pageOf(shadow, 2).every((byte) => byte === 0));
  assert.ok(pageOf(shadow, 10).every((byte) => byte === 0));
  assert.deepEqual(pageOf(shadow, 4), pageOf(live, 4));
});

// Checks that pages past the end of the free bitmap are compared like
// any page in use: the kernel only describes the pages it manages.
test("pages the bitmap does not cover are compared", () => {
  const { live, shadow, written } = machine();
  pageOf(live, 15).fill(1);

  const diff = capturePages({
    live,
    shadow,
    written,
    free: freeMap([]),
    freePages: 8,
  });

  assert.deepEqual([...diff.changed], [15]);
});

// Checks that a change only in the sign of a zero is seen: comparing
// pages as floats would call +0 and -0 equal and miss it.
test("a change to the top bit of a word is seen", () => {
  const { live, shadow, written } = machine();
  capturePages({ live, shadow, written });

  live[5 * PAGE_SIZE + 7] = 0x80;
  const diff = capturePages({ live, shadow, written });

  assert.deepEqual([...diff.changed], [5]);
});

// Checks that writePage puts a page's bytes, or zeros, into the
// shadow and keeps the written record in step, which is how a restore
// moves the shadow to an earlier keyframe.
test("writePage moves a shadow page to given bytes or to zero", () => {
  const { live, shadow, written } = machine();
  const bytes = new Uint8Array(PAGE_SIZE).fill(3);

  writePage(shadow, written, 6, bytes);
  assert.deepEqual(pageOf(shadow, 6), bytes);
  assert.equal(written[6], 1);

  writePage(shadow, written, 6, null);
  assert.ok(pageOf(shadow, 6).every((byte) => byte === 0));
  assert.equal(written[6], 0);

  // A diff against a live memory that is all zero now reports nothing.
  assert.deepEqual([...capturePages({ live, shadow, written }).changed], []);
});
