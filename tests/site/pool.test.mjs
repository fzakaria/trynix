// Tests the pool that hands NAR decodes to web workers. The pool is
// given a function that makes a worker, so these tests hand it
// stand-ins that record what they were posted and answer when told to.
import { test } from "node:test";
import assert from "node:assert/strict";

import { workerPool } from "../../site/js/pool.js";

// A worker that keeps what it was posted and replies on demand.
function fakeWorker() {
  const worker = {
    posted: [],
    terminated: false,
    postMessage(message) {
      worker.posted.push(message);
    },
    terminate() {
      worker.terminated = true;
    },
    // Answer the task this worker is holding.
    reply(fields) {
      const { id } = worker.posted[worker.posted.length - 1];
      worker.onmessage({ data: { id, ...fields } });
    },
  };
  return worker;
}

function poolOf(size) {
  const workers = [];
  const pool = workerPool({
    size,
    spawn: () => {
      const worker = fakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { pool, workers };
}

// Checks that a task goes to a worker and resolves with what the worker
// answered, without the bookkeeping id.
test("a task resolves with the worker's reply", async () => {
  const { pool, workers } = poolOf(2);
  const result = pool.run({ value: 1 });
  workers[0].reply({ doubled: 2 });
  assert.deepEqual(await result, { doubled: 2 });
});

// Checks that workers are made only as tasks need them, never past the
// size, and that a task beyond the size waits for a worker to free up.
test("tasks beyond the pool's size wait their turn", async () => {
  const { pool, workers } = poolOf(2);
  const first = pool.run({ n: 1 });
  const second = pool.run({ n: 2 });
  const third = pool.run({ n: 3 });
  assert.equal(workers.length, 2);
  assert.equal(workers[0].posted.length, 1);
  assert.equal(workers[1].posted.length, 1);

  workers[0].reply({ done: 1 });
  await first;
  assert.equal(workers[0].posted.length, 2);
  assert.equal(workers[0].posted[1].n, 3);

  workers[1].reply({ done: 2 });
  workers[0].reply({ done: 3 });
  assert.deepEqual(await second, { done: 2 });
  assert.deepEqual(await third, { done: 3 });
});

// Checks that a reply carrying an error rejects the task with that
// message, and leaves the worker fit for the next one.
test("a reply with an error rejects the task", async () => {
  const { pool, workers } = poolOf(1);
  const failing = pool.run({ n: 1 });
  workers[0].reply({ error: "bad archive" });
  await assert.rejects(failing, /bad archive/);

  const next = pool.run({ n: 2 });
  workers[0].reply({ ok: true });
  assert.deepEqual(await next, { ok: true });
});

// Checks that a worker that dies takes its task down with it and is
// replaced, so one crash does not shrink the pool for good.
test("a worker that crashes rejects its task and is replaced", async () => {
  const { pool, workers } = poolOf(1);
  const doomed = pool.run({ n: 1 });
  workers[0].onerror({ message: "out of memory" });
  await assert.rejects(doomed, (err) => {
    // Marked, so a caller can tell a dead worker from a bad input.
    assert.match(err.message, /out of memory/);
    assert.equal(err.crashed, true);
    return true;
  });
  assert.equal(workers[0].terminated, true);

  const next = pool.run({ n: 2 });
  assert.equal(workers.length, 2);
  workers[1].reply({ ok: true });
  assert.deepEqual(await next, { ok: true });
});
