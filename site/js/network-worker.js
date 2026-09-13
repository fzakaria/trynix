// A dedicated worker keeps gVisor and the Go scheduler off the UI thread.
importScripts("../net/wasm_exec.js");
let pending = new Uint8Array();
let ready = false;
self.trynixSendEthernet = (frame) => {
  const data = new Uint8Array(4 + frame.length);
  new DataView(data.buffer).setUint32(0, frame.length);
  data.set(frame, 4);
  postMessage({ type: "ethernet", data }, [data.buffer]);
};
self.trynixNetworkReady = () => {
  ready = true;
  postMessage({ type: "ready" });
};
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      self.trynixSOCKSURL = data.socksURL;
      const go = new Go();
      const response = await fetch("../net/trynixnet.wasm");
      if (!response.ok)
        throw new Error(`network wasm: HTTP ${response.status}`);
      const { instance } = await WebAssembly.instantiate(
        await response.arrayBuffer(),
        go.importObject,
      );
      go.run(instance).catch((err) =>
        postMessage({ type: "error", message: String(err) }),
      );
    } else if (data.type === "ethernet") {
      if (!ready) throw new Error("Ethernet before network startup");
      const joined = new Uint8Array(pending.length + data.data.length);
      joined.set(pending);
      joined.set(data.data, pending.length);
      pending = joined;
      while (pending.length >= 4) {
        const length = new DataView(
          pending.buffer,
          pending.byteOffset,
        ).getUint32(0);
        if (length < 14 || length > 65535)
          throw new Error(`Invalid Ethernet frame length ${length}`);
        if (pending.length < 4 + length) break;
        self.trynixReceiveEthernet(pending.slice(4, 4 + length));
        pending = pending.slice(4 + length);
      }
    }
  } catch (err) {
    postMessage({ type: "error", message: String(err) });
  }
};
