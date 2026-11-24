// The guest's network.
//
// unkernel's SDK gives the guest a network device whose frames end in a
// small network stack on the page (the SDK's NetStack): the guest is
// 10.0.2.15 behind a gateway at 10.0.2.2, and its base userland takes
// the address by DHCP at boot. Each TCP connection a program opens goes
// over one WebSocket to a Wisp relay, which opens it on the guest's
// behalf. Wisp carries no DNS, so names resolve to stand-in addresses
// on the page and the relay looks up the real name when it connects.
//
// The relay is a server: it sees which hosts the guest connects to, and
// the bytes of anything not encrypted. The default is unkernel's own,
// at wisp.unkernel.dev, whose author lets trynix.dev use it. A link can
// turn the network on or off (url.js, `net`) and name another relay
// (`wisp`), and a choice made in the Settings lane goes into the link.
// A link that names a relay of its own says so in Settings and in the
// page's log, since that relay sees the reader's traffic.
//
// The guest's base userland has no CA certificates, so HTTPS from the
// guest could not check a server. With the network on, the page writes
// the CA bundle the site ships (nixpkgs' cacert, nix/site.nix) into the
// share, and the shell points TLS clients at it (caBundleShell).
//
// The qemu engine's guest has no network device.

import { Engine } from "./engine.js";

export const Network = Object.freeze({
  ON: "on",
  OFF: "off",
});

// unkernel's Wisp relay, which lets this site use it.
export const DEFAULT_RELAY = "wss://wisp.unkernel.dev:6680";

// The choice a page has when nothing says otherwise.
const DEFAULT_NETWORK = Network.ON;

// The schemes a Wisp relay is reached by.
const RELAY_PROTOCOLS = ["ws:", "wss:"];

// A choice as a link or storage holds it, or null when the value is
// not one.
export function networkOf(value) {
  return Object.values(Network).includes(value) ? value : null;
}

// A relay's URL as typed, or null when the text is not a ws: or wss:
// URL.
export function relayOf(text) {
  let url;
  try {
    url = new URL(String(text ?? "").trim());
  } catch {
    return null;
  }
  return RELAY_PROTOCOLS.includes(url.protocol) ? url.href : null;
}

// Whether this boot has a network and through which relay: the link's
// choice and relay, else the defaults, with why, for the log.
export function pickNetwork({ linked, linkedRelay, engine }) {
  const relay = relayOf(linkedRelay) ?? DEFAULT_RELAY;
  if (engine === Engine.QEMU) {
    return {
      mode: Network.OFF,
      relay,
      why: "the x86_64 guest has no network device",
    };
  }
  if (networkOf(linked) !== null) {
    return { mode: linked, relay, why: "the link asks for it" };
  }
  return { mode: DEFAULT_NETWORK, relay, why: "the default" };
}

// The network device for createKernel's `net` option, or null for none.
// A spec rather than a backend object, since the kernel runs in a
// worker and a spec is what crosses to it.
export function netSpec({ mode, relay }) {
  if (mode !== Network.ON) {
    return null;
  }
  return { kind: "net", backend: { kind: "wisp", servers: [relay] } };
}

// Where TLS clients find CA certificates by convention, for programs
// that read no variable.
const CONVENTIONAL_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

// The shell lines that point TLS clients at `bundle`, a CA bundle the
// guest can read: SSL_CERT_FILE for OpenSSL, Go and Python,
// NIX_SSL_CERT_FILE for nixpkgs' patched OpenSSL and curl, and the
// conventional path, linked once if nothing is there.
export function caBundleShell(bundle) {
  const directory = CONVENTIONAL_BUNDLE.slice(
    0,
    CONVENTIONAL_BUNDLE.lastIndexOf("/"),
  );
  return [
    `export SSL_CERT_FILE="${bundle}"`,
    `export NIX_SSL_CERT_FILE="${bundle}"`,
    `[ -e ${CONVENTIONAL_BUNDLE} ] || { mkdir -p ${directory} && ln -s ${bundle} ${CONVENTIONAL_BUNDLE}; } 2>/dev/null`,
  ];
}
