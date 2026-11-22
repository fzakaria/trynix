// Tests the keyframe store (site/js/keyframes.js). Each test plays a
// guest by hand: it writes into a small "live" memory, captures a
// keyframe, and later asks the store to move its shadow to an earlier
// or a sibling keyframe, then compares the shadow with a copy of the
// memory taken when that keyframe was captured. The codec is the real
// one (CompressionStream, which Node has); spilling goes to a Map.
import { test } from "node:test";
import assert from "node:assert/strict";

import { KeyframeStore } from "../../site/js/keyframes.js";
import { PAGE_SIZE } from "../../site/js/pages.js";

const PAGES = 32;
const META = Object.freeze({ monotonicMs: 1 });

const pageOf = (memory, page) =>
  memory.subarray(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

// A store over a fresh memory, and a helper that captures a keyframe of
// the memory as it stands and remembers a copy of it.
function session(options = {}) {
  const live = new Uint8Array(PAGES * PAGE_SIZE);
  const store = new KeyframeStore({ bytes: live.byteLength, ...options });
  const copies = new Map();

  const keyframe = (meta = META) => {
    const id = store.capture({ live });
    store.describe(id, meta);
    copies.set(id, live.slice());
    return id;
  };

  return { live, store, copies, keyframe };
}

// A spill target that keeps what it is given in a Map.
function mapSpill() {
  const kept = new Map();
  return {
    kept,
    put: async (key, bytes) => void kept.set(key, bytes.slice()),
    get: async (key) => kept.get(key),
    delete: async (key) => void kept.delete(key),
  };
}

// Checks that going back one keyframe and forward again leaves the
// shadow equal to the memory each keyframe was captured from.
test("the shadow moves back and forward between keyframes", async () => {
  const { live, store, copies, keyframe } = session();
  pageOf(live, 1).fill(1);
  const first = keyframe();
  pageOf(live, 1).fill(2);
  pageOf(live, 7).fill(3);
  const second = keyframe();

  const back = await store.moveTo(first);
  assert.deepEqual(back.memory, copies.get(first));
  assert.equal(back.meta, META);
  assert.equal(store.current, first);

  const forward = await store.moveTo(second);
  assert.deepEqual(forward.memory, copies.get(second));
});

// Checks that a page the guest freed comes back with its old bytes
// when the shadow returns to a keyframe from before the free.
test("a page freed later is restored", async () => {
  const { live, store, copies, keyframe } = session();
  pageOf(live, 4).fill(9);
  const before = keyframe();

  const free = new Uint8Array(PAGES / 8);
  free[0] = 1 << 4;
  store.describe(store.capture({ live, free, freePages: PAGES }), META);

  const { memory } = await store.moveTo(before);
  assert.deepEqual(memory, copies.get(before));
});

// Checks that a keyframe captured after going back is a child of the
// keyframe gone back to, and that the old future is still reachable:
// branches are kept.
test("capturing after going back starts a branch", async () => {
  const { live, store, copies, keyframe } = session();
  pageOf(live, 2).fill(1);
  const root = keyframe();
  pageOf(live, 3).fill(2);
  const oldFuture = keyframe();

  await store.moveTo(root);
  live.set(copies.get(root));
  pageOf(live, 5).fill(4);
  const branch = keyframe();

  assert.equal(store.frame(branch).parent, root);
  assert.equal(store.frame(oldFuture).parent, root);

  assert.deepEqual(
    (await store.moveTo(oldFuture)).memory,
    copies.get(oldFuture),
  );
  assert.deepEqual((await store.moveTo(branch)).memory, copies.get(branch));
});

// Checks that a keyframe whose snapshot never completed cannot be gone
// to, while the keyframes on either side of it still can: its pages
// are still part of the shadow's history.
test("a keyframe without a snapshot is not a place to go", async () => {
  const { live, store, copies, keyframe } = session();
  pageOf(live, 1).fill(1);
  const first = keyframe();
  pageOf(live, 2).fill(2);
  const failed = store.capture({ live });
  pageOf(live, 3).fill(3);
  const third = keyframe();

  await assert.rejects(store.moveTo(failed), /no snapshot/);
  assert.deepEqual((await store.moveTo(first)).memory, copies.get(first));
  assert.deepEqual((await store.moveTo(third)).memory, copies.get(third));
});

// Checks that pages are stored compressed, and that a keyframe's size
// is what changed rather than the whole memory.
test("a keyframe stores the changed pages, compressed", async () => {
  const { live, store, keyframe } = session();
  for (let page = 0; page < 8; page++) {
    pageOf(live, page).fill(page + 1);
  }
  keyframe();
  pageOf(live, 3).fill(0x55);
  const second = keyframe();
  await store.settled();

  const frame = store.frame(second);
  assert.equal(frame.pageCount, 1);
  assert.ok(frame.storedBytes < PAGE_SIZE);
  const stats = store.stats();
  assert.equal(stats.rawBytes, 9 * PAGE_SIZE);
  assert.ok(stats.storedBytes < stats.rawBytes);
});

// Checks that past the memory cap the oldest keyframes' pages move to
// the spill target, and that going back still works from there.
test("past the cap, old keyframes spill and still restore", async () => {
  const spill = mapSpill();
  const { live, store, copies, keyframe } = session({ memoryCap: 1, spill });
  const ids = [];
  for (let step = 0; step < 4; step++) {
    // Random bytes, so compression cannot hide them under the cap.
    crypto.getRandomValues(pageOf(live, step));
    ids.push(keyframe());
  }
  await store.settled();

  assert.ok(spill.kept.size >= 3);
  assert.ok(store.stats().spilledBytes > 0);
  assert.deepEqual((await store.moveTo(ids[0])).memory, copies.get(ids[0]));
});

// Checks that clear() forgets every keyframe and empties the spill
// target, as a new boot of the page's guest needs.
test("clear forgets everything", async () => {
  const spill = mapSpill();
  const { live, store, keyframe } = session({ memoryCap: 1, spill });
  crypto.getRandomValues(pageOf(live, 0));
  keyframe();
  crypto.getRandomValues(pageOf(live, 1));
  keyframe();
  await store.settled();

  await store.clear();
  assert.equal(store.current, null);
  assert.equal(store.frames().length, 0);
  assert.equal(spill.kept.size, 0);
});
