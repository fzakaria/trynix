// Ethernet is local to this page. Only SOCKS byte streams leave over WebSocket.
export const PROXY_URL = "http://192.168.2.3:8080";
export const ETHERNET_URL = "ws://localhost:8888/";

export function networkEnabled() {
  return new URLSearchParams(location.search).get("network") !== "off";
}

// Web Locks make addresses unique across this origin's tabs and release them
// automatically on tab termination. There are 253 usable VM addresses.
export async function allocateAddress(locks = navigator.locks) {
  if (!locks) throw new Error("VM networking requires the Web Locks API");
  for (let host = 1; host <= 254; host++) {
    if (host === 3) continue;
    let report;
    const acquired = new Promise((resolve) => {
      report = resolve;
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const task = locks.request(
      `trynix-ip-192.168.2.${host}`,
      { ifAvailable: true },
      async (lock) => {
        report(Boolean(lock));
        if (lock) await held;
      },
    );
    task.catch((err) => report(Promise.reject(err)));
    if (await acquired)
      return {
        ip: `192.168.2.${host}`,
        mac: `02:00:00:00:02:${host.toString(16).padStart(2, "0")}`,
        release,
      };
  }
  throw new Error("All VM addresses in 192.168.2.0/24 are in use");
}

export function networkManifest(ip, mac) {
  return (
    [
      "ip link set lo up",
      // The snapshot has one fixed NIC identity; set this VM's MAC only
      // after resume, while eth0 is still down and has no address.
      `ip link set eth0 address ${mac}`,
      `ip addr replace ${ip}/24 dev eth0`,
      "ip link set eth0 up",
      // Only the connected /24 route is needed. No DNS or gateway is installed.
      `export http_proxy=${PROXY_URL}`,
      `export https_proxy=${PROXY_URL}`,
      `export HTTP_PROXY=${PROXY_URL}`,
      `export HTTPS_PROXY=${PROXY_URL}`,
    ].join("\n") + "\n"
  );
}

// Preserve the snapshot's NIC when networking is disabled, with an in-page
// sink for its socket backend. No worker or host connection is created.
export function disableNetwork() {
  const sink = new EventTarget();
  sink.postMessage = () => {};
  return installEthernetSocket(sink);
}

// QEMU uses its length-prefixed socket netdev. Emscripten implements that
// socket using WebSocket. Intercept just this URL; it never opens a real socket.
export function installEthernetSocket(worker, scope = globalThis) {
  const NativeWebSocket = scope.WebSocket;
  let socket;
  class EthernetSocket extends EventTarget {
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.binaryType = "arraybuffer";
      this.bufferedAmount = 0;
      this.protocol = "binary";
      this.extensions = "";
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.emit(new Event("open"));
      });
    }
    emit(event) {
      this.dispatchEvent(event);
      this[`on${event.type}`]?.(event);
    }
    send(data) {
      if (this.readyState !== 1) throw new Error("Ethernet socket is not open");
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const copy = bytes.slice();
      worker.postMessage({ type: "ethernet", data: copy }, [copy.buffer]);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit(new Event("close"));
    }
  }
  function WebSocket(url, protocols) {
    if (new URL(url).href !== ETHERNET_URL)
      return new NativeWebSocket(url, protocols);
    if (socket && socket.readyState !== 3)
      throw new Error("Duplicate QEMU Ethernet connection");
    socket = new EthernetSocket(url);
    return socket;
  }
  Object.setPrototypeOf(WebSocket, NativeWebSocket);
  WebSocket.prototype = NativeWebSocket.prototype;
  scope.WebSocket = WebSocket;
  const receive = ({ data }) => {
    if (data.type === "ethernet" && socket?.readyState === 1) {
      socket.emit(new MessageEvent("message", { data: data.data.buffer }));
    }
  };
  worker.addEventListener("message", receive);
  return () => {
    socket?.close();
    worker.removeEventListener("message", receive);
    scope.WebSocket = NativeWebSocket;
  };
}

export async function startNetwork() {
  const lease = await allocateAddress();
  const worker = new Worker(new URL("network-worker.js", import.meta.url));
  let restore;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Network Wasm startup timed out")),
        30000,
      );
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          clearTimeout(timeout);
          resolve();
        }
        if (data.type === "error") {
          clearTimeout(timeout);
          reject(new Error(data.message));
        }
      };
      const socksURL =
        new URLSearchParams(location.search).get("socks") ||
        "ws://127.0.0.1:1080/socks5";
      worker.postMessage({ type: "init", socksURL });
    });
    worker.onerror = (event) =>
      console.error("VM network worker:", event.message);
    worker.onmessage = ({ data }) => {
      if (data.type === "error")
        console.error("VM network worker:", data.message);
    };
    restore = installEthernetSocket(worker);
    return {
      ...lease,
      close() {
        restore();
        worker.terminate();
        lease.release();
      },
    };
  } catch (err) {
    restore?.();
    worker.terminate();
    lease.release();
    throw err;
  }
}
