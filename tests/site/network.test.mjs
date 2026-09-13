import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateAddress,
  networkArgs,
  networkManifest,
  installEthernetSocket,
} from "../../site/js/network.js";

test("VMs reserve distinct IPs and skip the proxy; release permits reuse", async () => {
  const held = new Set();
  const locks = {
    async request(name, options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  const leases = await Promise.all(
    Array.from({ length: 4 }, () => allocateAddress(locks)),
  );
  assert.equal(new Set(leases.map((l) => l.ip)).size, 4);
  assert.ok(leases.every((l) => l.ip !== "192.168.2.3"));
  const first = leases[0].ip;
  leases[0].release();
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = await allocateAddress(locks);
  assert.equal(replacement.ip, first);
  replacement.release();
  leases.forEach((l) => l.release());
});

test("VM has a connected subnet and explicit proxy, with no default route", () => {
  const script = networkManifest("192.168.2.4");
  assert.match(script, /192\.168\.2\.4\/24 dev eth0/);
  assert.match(script, /https_proxy=http:\/\/192\.168\.2\.3:8080/);
  assert.doesNotMatch(script, /default|gateway|resolv/);
  const args = networkArgs(["-nic", "none", "-m", "512M"], "02:00:00:00:02:04");
  assert.ok(!args.includes("none"));
  assert.ok(args.includes("socket,id=trynixnet,connect=localhost:8888"));
});

test("only QEMU Ethernet is intercepted; host WebSockets remain native", async () => {
  class Native {
    constructor(url) {
      this.url = url;
    }
  }
  const scope = { WebSocket: Native };
  const worker = new EventTarget();
  const sent = [];
  worker.postMessage = (message) => sent.push(message);
  const restore = installEthernetSocket(worker, scope);
  const remote = new scope.WebSocket("ws://127.0.0.1:1080/socks5");
  assert.ok(remote instanceof Native);
  const qemu = new scope.WebSocket("ws://localhost:8888");
  await new Promise((resolve) => qemu.addEventListener("open", resolve));
  // Emscripten's poll implementation reads constants from the instance.
  assert.equal(qemu.readyState, qemu.OPEN);
  qemu.send(new Uint8Array([0, 0, 0, 14]));
  assert.deepEqual(sent[0].data, new Uint8Array([0, 0, 0, 14]));
  let received;
  qemu.onmessage = (event) => {
    received = new Uint8Array(event.data);
  };
  worker.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "ethernet", data: new Uint8Array([1, 2, 3]) },
    }),
  );
  assert.deepEqual(received, new Uint8Array([1, 2, 3]));
  restore();
  assert.equal(scope.WebSocket, Native);
});
