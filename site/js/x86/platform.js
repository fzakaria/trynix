// The few places the browser and node differ for the process model:
// spawning a worker, talking to it, and a worker talking to whoever
// spawned it. Both give the same shape:
//
//   spawnWorker(url, data) -> { postMessage, onMessage(cb), onError(cb), terminate }
//   workerPort()           -> { postMessage, onMessage(cb), data }   (inside a worker)
//
// `data` is what the spawner passed, delivered before any message.

const isNode = typeof process !== "undefined" && process.versions && process.versions.node && typeof self === "undefined";

export async function spawnWorker(url, data, transfer = []) {
  if (isNode) {
    const { Worker } = await import("node:worker_threads");
    const w = new Worker(url, { workerData: data, transferList: transfer });
    return {
      postMessage: (m, t = []) => w.postMessage(m, t),
      onMessage: (cb) => w.on("message", cb),
      onError: (cb) => {
        w.on("error", cb);
        w.on("exit", (code) => {
          if (code !== 0) {
            cb(new Error(`worker exited with ${code}`));
          }
        });
      },
      terminate: () => w.terminate(),
    };
  }
  const w = new Worker(url, { type: "module" });
  w.postMessage({ type: "__data", data }, transfer);
  return {
    postMessage: (m, t = []) => w.postMessage(m, t),
    onMessage: (cb) => {
      w.addEventListener("message", (e) => cb(e.data));
    },
    onError: (cb) => {
      w.addEventListener("error", (e) => cb(new Error(e.message ?? String(e))));
    },
    terminate: () => w.terminate(),
  };
}

// Inside a worker: the port to the spawner and the data it passed.
export async function workerPort() {
  if (isNode) {
    const { parentPort, workerData } = await import("node:worker_threads");
    return {
      data: workerData,
      postMessage: (m, t = []) => parentPort.postMessage(m, t),
      onMessage: (cb) => parentPort.on("message", cb),
    };
  }
  const data = await new Promise((resolve) => {
    const first = (e) => {
      if (e.data && e.data.type === "__data") {
        self.removeEventListener("message", first);
        resolve(e.data.data);
      }
    };
    self.addEventListener("message", first);
  });
  return {
    data,
    postMessage: (m, t = []) => self.postMessage(m, t),
    onMessage: (cb) => {
      self.addEventListener("message", (e) => {
        if (!(e.data && e.data.type === "__data")) {
          cb(e.data);
        }
      });
    },
  };
}

// Atomics.waitAsync where the engine has it, else a short poll.
export function waitAsync(i32, index, value, timeout = Infinity) {
  if (typeof Atomics.waitAsync === "function") {
    const r = Atomics.waitAsync(i32, index, value, timeout);
    return r.async ? r.value : Promise.resolve(r.value);
  }
  return new Promise((resolve) => {
    const deadline = performance.now() + timeout;
    const poll = () => {
      if (Atomics.load(i32, index) !== value) {
        resolve("ok");
      } else if (performance.now() >= deadline) {
        resolve("timed-out");
      } else {
        setTimeout(poll, 1);
      }
    };
    setTimeout(poll, 1);
  });
}

export { isNode };
