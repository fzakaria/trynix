// A pool of web workers, each doing one task at a time.
//
// The page decompresses NARs here rather than on its own thread
// (store.js says why). The pool knows nothing about decoding: a task is
// a message, a worker answers with a message carrying the same id, and
// an answer with an `error` field is a failure. `spawn` makes a worker,
// which is what lets the tests hand in stand-ins.

export function workerPool({ size, spawn }) {
  // Workers with nothing to do, tasks with no worker yet, and the task
  // each busy worker is holding.
  const idle = [];
  const waiting = [];
  const holding = new Map();
  let made = 0;
  let nextId = 0;

  // A worker for the next task: an idle one, or a new one while the
  // pool is below its size, or none.
  function take() {
    if (idle.length > 0) {
      return idle.pop();
    }
    if (made >= size) {
      return null;
    }

    made += 1;
    const worker = spawn();
    worker.onmessage = ({ data }) => settle(worker, data);
    worker.onerror = (event) => crashed(worker, event);
    return worker;
  }

  function give(worker, task) {
    holding.set(worker, task);
    worker.postMessage({ id: task.id, ...task.message }, task.transfer);
  }

  // The worker is free: the next waiting task, or back to idle.
  function release(worker) {
    holding.delete(worker);
    const next = waiting.shift();
    if (next === undefined) {
      idle.push(worker);
      return;
    }
    give(worker, next);
  }

  function settle(worker, data) {
    const task = holding.get(worker);
    if (task === undefined || data.id !== task.id) {
      return;
    }

    const { id, error, ...reply } = data;
    release(worker);
    if (error !== undefined) {
      task.reject(new Error(error));
      return;
    }
    task.resolve(reply);
  }

  // A worker that threw outside a task's own handling is not trusted
  // again: its task fails, the worker is ended, and the pool makes
  // another when one is next needed.
  function crashed(worker, event) {
    const task = holding.get(worker);
    holding.delete(worker);
    worker.terminate();
    made -= 1;
    // The failure is marked as the worker's own, which says nothing
    // about the task: a caller may want to do the work some other way.
    const failure = new Error(event.message ?? "the worker failed");
    failure.crashed = true;
    task?.reject(failure);

    // Tasks that were waiting on this worker still need one.
    const next = waiting.shift();
    if (next === undefined) {
      return;
    }
    const replacement = take();
    if (replacement === null) {
      waiting.unshift(next);
      return;
    }
    give(replacement, next);
  }

  return {
    // Run one task: `message` is posted with an id added, `transfer`
    // lists the buffers the worker takes over. Resolves with the
    // worker's answer, less the id.
    run(message, transfer = []) {
      return new Promise((resolve, reject) => {
        nextId += 1;
        const task = { id: nextId, message, transfer, resolve, reject };
        const worker = take();
        if (worker === null) {
          waiting.push(task);
          return;
        }
        give(worker, task);
      });
    },
  };
}
