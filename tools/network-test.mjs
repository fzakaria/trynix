// Real Chromium + QEMU test. The site and curl closure must be available.
// Usage: node tools/network-test.mjs /path/to/built/site
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const site = process.argv[2];
if (!site) throw new Error("usage: network-test.mjs /path/to/built/site");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "trynix-network-test-"));
const fixture = "TRYNIX_NETWORK_OK";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};
const mime = {
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".html": "text/html",
  ".css": "text/css",
  ".json": "application/json",
};
const server = http.createServer((req, res) => {
  if (req.url === "/fixture") {
    res.end(fixture);
    return;
  }
  if (req.url === "/fixture-ca.pem") {
    res.end(fs.readFileSync(path.join(work, "cert.pem")));
    return;
  }
  const pathname = new URL(req.url, "http://local").pathname;
  const filename = path.join(site, pathname === "/" ? "index.html" : pathname);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Type",
    mime[path.extname(filename)] || "application/octet-stream",
  );
  fs.createReadStream(filename)
    .on("error", () => {
      res.statusCode = 404;
      res.end("not found");
    })
    .pipe(res);
});
let secure, host, browser, socket;
let transcript = "";
try {
  const cert = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(work, "key.pem"),
    "-out",
    path.join(work, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ]);
  if (cert.status !== 0) throw new Error(`openssl: ${cert.stderr}`);
  const port = await listen(server);
  secure = https.createServer(
    {
      key: fs.readFileSync(path.join(work, "key.pem")),
      cert: fs.readFileSync(path.join(work, "cert.pem")),
    },
    (_req, res) => res.end(fixture),
  );
  const tlsPort = await listen(secure);
  const reservation = http.createServer();
  const socksPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  host = spawn(
    process.env.TRYNIX_SPROXY || "trynixsproxy",
    ["-listen", `127.0.0.1:${socksPort}`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  host.on("error", (err) => console.error(err));
  host.stderr.on("data", (bytes) => process.stderr.write(bytes));
  for (let i = 0; ; i++) {
    try {
      await fetch(`http://127.0.0.1:${socksPort}/socks5`);
      break;
    } catch (err) {
      if (i === 100 || host.exitCode !== null) throw err;
      await delay(100);
    }
  }
  const profile = path.join(work, "chrome");
  browser = spawn(
    "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let browserErrors = "";
  browser.stderr.on("data", (b) => {
    browserErrors += b;
  });
  let debugPort;
  for (let i = 0; i < 120; i++) {
    try {
      debugPort = fs
        .readFileSync(path.join(profile, "DevToolsActivePort"), "utf8")
        .split("\n")[0];
      break;
    } catch {
      await delay(250);
    }
  }
  if (!debugPort) throw new Error(`Chromium failed to start: ${browserErrors}`);
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  socket = new WebSocket(
    tabs.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const waiting = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    } else if (message.method === "Runtime.exceptionThrown")
      console.error(JSON.stringify(message.params));
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestID = ++id;
      const timer = setTimeout(() => {
        waiting.delete(requestID);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      waiting.set(requestID, (reply) => {
        clearTimeout(timer);
        if (reply.error) reject(new Error(JSON.stringify(reply.error)));
        else resolve(reply.result);
      });
      socket.send(JSON.stringify({ id: requestID, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (reply.exceptionDetails)
      throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  const socks = encodeURIComponent(`ws://127.0.0.1:${socksPort}/socks5`);
  await send("Page.navigate", {
    url: `http://127.0.0.1:${port}/?pkg=curl&boot=1&socks=${socks}`,
  });
  for (let i = 0; i < 600; i++) {
    await delay(500);
    transcript = await evaluate('window.trynix?.transcript() || ""');
    if (transcript.includes("welcome to the multiverse")) break;
    if (i % 60 === 0) console.log("Waiting for guest boot…");
  }
  assert.match(transcript, /welcome to the multiverse/, "guest did not boot");
  await delay(1000);
  const command = [
    "ip -4 addr show eth0",
    "ip route",
    "echo PROXY=$https_proxy",
    `curl -fsS --max-time 25 http://localhost:${port}/fixture`,
    "echo",
    `curl -fsS --max-time 25 http://localhost:${port}/fixture-ca.pem -o /tmp/test-ca.pem`,
    `curl -fsS --max-time 25 --cacert /tmp/test-ca.pem https://localhost:${tlsPort}/fixture`,
    "echo",
    "echo NETWORK_TEST_DONE\n",
  ].join("; ");
  await evaluate(
    `window.trynix.master.ldisc.writeFromLower(Array.from(new TextEncoder().encode(${JSON.stringify(command)})))`,
  );
  for (let i = 0; i < 200; i++) {
    await delay(500);
    transcript = (await evaluate("window.trynix.transcript()")).replaceAll(
      "\r",
      "",
    );
    if (transcript.includes("\nNETWORK_TEST_DONE\n")) break;
  }
  console.log(transcript.slice(-6000));
  assert.equal(
    (transcript.match(/TRYNIX_NETWORK_OK/g) || []).length,
    2,
    "HTTP and HTTPS must both succeed",
  );
  assert.match(transcript, /inet 192\.168\.2\.(?!3\/)[0-9]+\/24/);
  assert.match(transcript, /192\.168\.2\.0\/24 dev eth0/);
  assert.doesNotMatch(transcript, /default via/);
  assert.match(transcript, /PROXY=http:\/\/192\.168\.2\.3:8080/);
  console.log(
    "PASS: QEMU → browser Wasm HTTP/CONNECT → WebSocket SOCKS → host HTTP/TLS fixtures",
  );
} catch (err) {
  console.error(transcript.slice(-6000));
  throw err;
} finally {
  socket?.close();
  browser?.kill("SIGTERM");
  host?.kill("SIGTERM");
  server.closeAllConnections();
  server.close();
  secure?.closeAllConnections();
  secure?.close();
  // Keep the temporary profile/certificate when debugging a failure.
  console.log(`Test artifacts: ${work}`);
}
