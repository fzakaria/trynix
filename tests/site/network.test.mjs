// Tests the guest's network setting (site/js/network.js): on or off from
// the link, this browser's remembered choice, or the default (on), off
// on the qemu engine, which has no network device; which Wisp relay the
// guest's connections go through, the default or one chosen in
// Settings, and which strings count as a relay at all; and the device
// spec handed to unkernel's SDK. Each is a pure function of what it is
// handed, so the tests pass in each source rather than a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RELAY,
  caBundleShell,
  Network,
  netSpec,
  networkOf,
  pickNetwork,
  relayOf,
} from "../../site/js/network.js";
import { Engine } from "../../site/js/engine.js";

const pick = (overrides) =>
  pickNetwork({
    linked: null,
    remembered: null,
    rememberedRelay: null,
    engine: Engine.UNKERNEL,
    ...overrides,
  });

// Checks the default: on, through unkernel's relay.
test("the network is on by default, through the default relay", () => {
  const picked = pick({});
  assert.equal(picked.mode, Network.ON);
  assert.equal(picked.relay, DEFAULT_RELAY);
  assert.equal(DEFAULT_RELAY, "wss://wisp.unkernel.dev:6680");
});

// Checks the precedence: the link wins, then this browser's choice,
// then the default, and an unknown value is no choice.
test("the link wins, then the remembered choice, then the default", () => {
  assert.equal(
    pick({ linked: Network.OFF, remembered: Network.ON }).mode,
    Network.OFF,
  );
  assert.equal(pick({ remembered: Network.OFF }).mode, Network.OFF);
  assert.equal(networkOf("sometimes"), null);
  assert.equal(pick({ linked: networkOf("sometimes") }).mode, Network.ON);
});

// Checks that the qemu engine's guest has no network, whatever is asked.
test("the x86_64 guest has no network", () => {
  const picked = pick({ linked: Network.ON, engine: Engine.QEMU });
  assert.equal(picked.mode, Network.OFF);
});

// Checks that a relay chosen in Settings replaces the default, and that
// only a ws: or wss: URL counts as one.
test("a relay from Settings replaces the default", () => {
  const relay = "wss://relay.example.org/wisp/";
  assert.equal(pick({ rememberedRelay: relay }).relay, relay);
  assert.equal(relayOf(" wss://relay.example.org/wisp/ "), relay);
  assert.equal(relayOf("ws://localhost:6001/"), "ws://localhost:6001/");
  assert.equal(relayOf("https://relay.example.org/"), null);
  assert.equal(relayOf("relay.example.org"), null);
  assert.equal(relayOf(""), null);
});

// Checks the spec handed to the SDK: a Wisp network device on the
// chosen relay when on, and none when off.
test("the SDK gets a Wisp device spec, or none", () => {
  assert.deepEqual(netSpec({ mode: Network.ON, relay: DEFAULT_RELAY }), {
    kind: "net",
    backend: { kind: "wisp", servers: [DEFAULT_RELAY] },
  });
  assert.equal(netSpec({ mode: Network.OFF, relay: DEFAULT_RELAY }), null);
});

// Checks the shell lines that point TLS clients at the CA bundle the
// page writes into the share: the variables OpenSSL (and nixpkgs'
// patched OpenSSL) read, and the conventional path for programs that
// read only that, linked once.
test("the shell points TLS clients at the share's CA bundle", () => {
  const lines = caBundleShell("/share/certs/ca-bundle.crt");
  assert.ok(
    lines.includes('export SSL_CERT_FILE="/share/certs/ca-bundle.crt"'),
  );
  assert.ok(
    lines.includes('export NIX_SSL_CERT_FILE="/share/certs/ca-bundle.crt"'),
  );
  assert.ok(
    lines.some((line) =>
      line.includes(
        "ln -s /share/certs/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt",
      ),
    ),
  );
});
