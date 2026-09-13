# Networking

Status: proposal, written 2026-09-12. Nothing here is built.

The guest has no network. [`nix/guest/machine.json`](../nix/guest/machine.json)
starts QEMU with `-nic none`, and the kernel fragment drops every NIC
driver it can. People have asked for network access, and the tools they
run in the guest are ordinary nixpkgs builds (curl, git, pip) pointed
at ordinary hosts. This document is what the browser allows, what other
projects did, and the design proposed for trynix.

## What the browser allows

A page has three ways to move a guest's bytes off the machine, and each
has a different ceiling.

**`fetch()`.** The page terminates the guest's HTTP, replays it as a
browser request, and MITMs HTTPS with a CA the guest trusts. No server
is involved, but the browser's CORS rules decide what is reachable. A
probe with an `Origin` header on 2026-09-12:

| reachable (CORS allowed)  | blocked                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| api.github.com            | github.com `info/refs` (the first request of a `git clone`)                     |
| raw.githubusercontent.com | github.com archive tarballs (codeload allows only render.githubusercontent.com) |
| registry.npmjs.org        | gitlab.com raw files                                                            |
| pypi.org/simple           | index.crates.io, deb.debian.org                                                 |
| cache.nixos.org           | example.com, google.com, api.anthropic.com                                      |

github.com also answers the `git-upload-pack` preflight with 405, so
`git clone` over https cannot work this way at all. Beyond CORS, the
browser drops forbidden request headers, hides response headers that are
not safelisted, forces a preflight for non-simple requests, and blocks
`http://` from an `https://` page. This mode suits a handful of APIs and
registries, and the tools people run hit the blocked column.

**A WebSocket to localhost.** A relay on the user's machine receives the
guest's frames and does real networking. Browsers differ:

- Chrome allows `ws://127.0.0.1` from an https page, since loopback is
  exempt from mixed content, behind the
  [Local Network Access](https://developer.chrome.com/blog/local-network-access)
  permission prompt (Chrome 142, extended to WebSockets in 147).
- Firefox allows it with no prompt;
  [bug 1996551](https://bugzilla.mozilla.org/show_bug.cgi?id=1996551)
  records that WebSocket LNA checks are off on purpose.
- Safari blocks it. WebKit still treats loopback as mixed content,
  [bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934), open
  since 2017.

**A WebSocket to a public relay.** Works in every browser, since it is
plain `wss://` to a public host. Tailscale's DERP relays are one such
host: they carry WireGuard packets they cannot decrypt, and Tailscale
added WebSockets as a DERP transport for exactly this use in its
[SSH console](https://tailscale.com/blog/ssh-console).

## Prior art

**alpine.sh** runs 32-bit Alpine on v86, resumed from a 53 MB zstd state
image. Its NIC is v86's `fetch` backend: a JS network stack answers DHCP
and DNS, terminates TCP, and replays HTTP through `fetch()`, with
[mitm.js](https://github.com/basicer/mitm.js) (mbedtls in wasm)
terminating TLS. The CORS gap is covered by its own Cloudflare proxy for
an allowlist of eleven hosts, github.com among them. The app is not
open source; the v86 fork is.

**qemu-wasm's [networking example](https://github.com/ktock/qemu-wasm/blob/master/examples/networking/README.md)**
gives QEMU `-netdev socket` plus `virtio-net-pci`, and emscripten turns
that socket into a WebSocket. It has two modes:

- In-browser: Mock Service Worker intercepts the WebSocket and hands
  frames to `c2w-net-proxy.wasm`, gvisor-tap-vsock compiled to WASI. The
  guest must set `http_proxy`/`https_proxy` and `SSL_CERT_FILE`, bodies
  are buffered whole with `arrayBuffer()`, and the fetch limits above
  apply unchanged.
- Delegate: the WebSocket goes to `c2w-net` on a host, which runs the
  stack natively. Full TCP and UDP, at the cost of a process someone
  runs.

**WebVM** joins a tailnet from the page. Leaning Technologies
[modified Tailscale's tsconnect](https://labs.leaningtech.com/blog/webvm-virtual-machine-with-networking-via-tailscale)
to expose a TUN that trades IP packets over a MessageChannel, and wired
it to lwIP. The wasm is 16 MB and loads only on login. Reaching the
internet needs an exit node on the user's tailnet.

**[tailcat](https://github.com/tailscale/tailcat)** is Tailscale's data
plane without the account: `tailcat serve` prints an address carrying a
WireGuard public key, a pre-shared key and a DERP region, and a client
given that address connects over WireGuard, relayed through DERP. It
ships a browser build (`main.wasm.gz`, 6.56 MB) whose JS API is
`tailcatListen` and `tailcatDial`; the latter opens one TCP stream to a
port on the server. Browser traffic is DERP-only until
[tailcat#4](https://github.com/tailscale/tailcat/issues/4) adds WebRTC.

## Design

### The VM always has a NIC

`machine.json` gains a socket netdev and a `virtio-net-pci` device for
every boot, and the snapshot is retaken with them. The page owns the
other end of the socket and decides where frames go. Off means the page
drops them. One snapshot serves networked and offline boots alike, and
a transport can be attached or detached mid-session without restarting
QEMU, because QEMU's socket stays connected to the page's shim while the
transport behind it changes.

### Transports

The shim forwards QEMU's netdev bytes unchanged. QEMU's socket netdev
and gvproxy's `-listen-qemu` speak the same length-prefixed framing, so
nothing in the page parses a packet.

| transport     | page side                              | reaches the helper when                              |
| ------------- | -------------------------------------- | ---------------------------------------------------- |
| none          | drop frames                            | never                                                |
| localhost     | a browser `WebSocket`                  | the browser runs on the helper's machine; not Safari |
| tailcat       | one `tailcatDial` stream to the helper | any browser, any device                              |
| public tunnel | a browser `WebSocket` to `wss://`      | any browser, any device, through Cloudflare          |

### The helper

One command runs on any machine with network access:

```
$ nix run github:fzakaria/trynix#net
same machine: https://trynix.dev/#net=ws://127.0.0.1:41823/<token>
any device:   https://trynix.dev/#net=tc<address>
any device:   https://trynix.dev/#net=wss://<random>.trycloudflare.com/<token>   (with --tunnel)
```

It is `gvproxy -listen-qemu` behind up to three front doors: a WebSocket
listener on loopback, `tailcat serve` on a port forwarded to the same
gvproxy, and with `--tunnel` a Cloudflare quick tunnel onto the loopback
listener (see "Other ways to reach the helper"). gvproxy ([`gvproxy`](https://github.com/containers/gvisor-tap-vsock)
in nixpkgs) runs the network stack natively: DHCP, DNS, TCP and UDP,
dialled from the helper's machine. Printing a QR code for the tailcat
link lets a phone attach to a laptop's helper.

```
guest virtio-net
  -> QEMU socket netdev
  -> page shim
  -> ws://127.0.0.1  or  tailcat stream over DERP  or  wss:// quick tunnel
  -> helper: gvproxy
  -> the host being reached
```

### Why the stack lives on the helper

The alternative is a stock `tailcat serve exit-node` with the network
stack in the page: gvisor-tap-vsock in the tailcat wasm, terminating the
guest's TCP and dialling each connection through the exit node. That was
rejected:

- gvisor-tap-vsock's forwarders call `net.DialTimeout` and `net.Dial`
  directly ([`pkg/services/forwarder`](https://github.com/containers/gvisor-tap-vsock/tree/main/pkg/services/forwarder)),
  so tailcat as the dialer means patching it.
- tailcat's browser API has no call that dials an arbitrary host through
  an exit node, so trynix would carry its own tailcat wasm build.
- ARP, DHCP, DNS and UDP would run in wasm on the page's main thread.

With the stack on the helper, the page carries the shipped `tailcatDial`
and a byte pipe.

The cost is the guest's TCP riding inside tailcat's stream, inside
DERP's WebSocket: loss on the DERP link is retransmitted by the outer
layers and seen as delay by the guest, and every guest ACK makes the
relayed round trip. That is TCP over TCP, and it matters only on the
tailcat transport. A loopback WebSocket does not lose packets. Whether
it matters in practice is unmeasured; the emulated guest's own network
path and DERP's rate limits may bound throughput first.

### Other ways to reach the helper

Anything that gets bytes from any browser to the helper, started by the
same `nix run` and pasted the same way, is a candidate front door.
Surveyed on 2026-09-12:

| option                                                                  | page side                                         | encryption                                      | limits                                                                                                     | verdict                           |
| ----------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| tailcat                                                                 | 6.56 MB wasm, `tailcatDial`                       | WireGuard end to end                            | free DERP relays, rate-limited; DERP-only from a browser                                                   | kept                              |
| Cloudflare quick tunnel (`cloudflared tunnel --url`, nixpkgs 2025.11.1) | the localhost WebSocket code, pointed at `wss://` | TLS to Cloudflare's edge, which sees the frames | "testing and development only", no SLA, 200 in-flight requests, idle WebSockets closed, restarts drop them | kept, opt-in                      |
| localhost.run (`ssh -R`)                                                | same as above                                     | TLS to their edge                               | "a speed limit", rotating domain, WebSockets not documented                                                | fallback if Cloudflare fails      |
| iroh / dumbpipe (nixpkgs 0.27.0)                                        | iroh in wasm                                      | QUIC end to end                                 | browsers relay-only; "can't provide you with the full magic of iroh just yet"; no npm package              | same shape as tailcat, less ready |
| bore (`bore.pub`)                                                       | none possible                                     | none                                            | plain TCP, so an https page cannot open `ws://` to it                                                      | out                               |

**The quick tunnel** is the one that matches tailcat's reach with less
code in the page. The helper runs `cloudflared` against its own loopback
WebSocket listener, and the page uses the WebSocket path it already has
for localhost: no wasm, nothing lazy to load, and no Local Network
Access prompt, since `wss://` to a public host is ordinary. No Cloudflare
account is needed
([Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)).
It costs three things. Cloudflare terminates TLS on that hop and sees
the frames: the guest's own TLS stays opaque to it, its DNS and plain
HTTP do not. Cloudflare's terms call quick tunnels a testing tool, so
the default cannot be to route every reader through one. And
[Cloudflare closes idle WebSockets](https://developers.cloudflare.com/network/websockets/),
so the page sends a heartbeat. Whether a quick tunnel carries a
WebSocket at all is not stated in its documentation, and community
reports are mixed; that is the first thing to try.

The public URL makes the token and the `Origin` check mandatory rather
than defence in depth: anyone who guesses the subdomain reaches the
listener.

**Direct WebRTC** would beat all of these on throughput, since a data
channel can be unreliable and unordered and the guest's TCP would not
ride inside another reliable stream. It needs a signalling channel to
exchange offers, which none of the options above provides for free, and
it is what [tailcat#4](https://github.com/tailscale/tailcat/issues/4)
is adding. Later, not first.

### The guest

No network daemon runs by default. gvproxy's addresses are fixed unless
configured otherwise
([`cmd/gvproxy/config.go`](https://github.com/containers/gvisor-tap-vsock/blob/main/cmd/gvproxy/config.go)):
the gateway and its DNS at 192.168.127.1, the device at 192.168.127.2.
Init configures that address, the default route and `resolv.conf`
before it parks waiting for the share, so the snapshot carries the
configuration and a resumed guest pays nothing for it. Attaching a
transport mid-session needs no guest action; the page starts forwarding
frames to an interface that is already up.

Offline, a lookup goes to 192.168.127.1 and its frames are dropped, so
it times out rather than failing at once. `options timeout:1 attempts:1`
in `resolv.conf` brings "could not resolve host" down to about a second.

A daemon was the first idea and was dropped for cost, not CPU. busybox
`udhcpc -b` at its defaults (`-t 3 -T 3 -A 20`) wakes about four times
every 29 seconds without a lease, a few syscalls each, and with
`CONFIG_NO_HZ_IDLE=y` the guest is otherwise quiet; at about 3 µs per
guest syscall ([engine-execution.md](engine-execution.md)) that is far
below 0.1% of a vCPU. The cost that shows is starting it: one fork and
exec, about 30 ms ([design.md, "Speed"](design.md#speed)), on a path to
the prompt measured in seconds.

Detaching leaves the guest holding its address, and open connections
hang until they time out. Flipping virtio-net's link state with QMP
`set_link` would report it properly, but the page does not speak QMP
today.

### One VM per helper

Every tab resumes the same snapshot, and with it the same MAC and the
same static 192.168.127.2. Two tabs on one gvproxy look like one machine
claiming to be in two places: gvproxy delivers to whichever claimed
last, and both tabs' connections break. This does not depend on the
transport. tailcat, the loopback WebSocket and a quick tunnel all carry
frames without looking at whose they are.

The first version avoids it by rule: a helper serves one connection at
a time. A second tab is refused, the page says the helper is already in
use, and a second `nix run` gives a second link and a second gvproxy on
a network of its own. No guest change is needed. Whether gvproxy would
accept a second QEMU connection on one listener at all is unchecked, so
refusing it in the helper is the safer rule either way.

### Several VMs on one helper, later

Sharing a helper needs each VM to have its own identity, and only when
the page asks for it. The page writes `/share/manifest` before the guest
mounts the share, and init already sources it, so a boot started with a
`#net=` string adds one line:

```sh
TRYNIX_NET=dhcp
```

and init acts on it:

```sh
if [ "$TRYNIX_NET" = dhcp ]; then
  mac="02$(od -An -N5 -tx1 /dev/urandom | tr -d '\n' | tr ' ' ':')"
  ip link set eth0 down
  ip link set eth0 address "$mac"
  ip addr flush dev eth0
  ip link set eth0 up
  udhcpc -b -q -i eth0 -s /etc/udhcpc.script
fi
```

- The MAC is five random bytes behind `02`, the locally administered,
  unicast prefix, so it cannot collide with a vendor's. The randomness
  is per visitor: rdrand, and virtio-rng reseeding from the browser.
  The guest sets it through virtio-net's control queue and QEMU updates
  its receive filter to match (`VIRTIO_NET_CTRL_MAC_ADDR_SET`); that
  QEMU offers the feature by default is assumed, not checked in this
  build.
- `ip addr flush` drops the static address the snapshot carried.
- gvproxy leases addresses per MAC (`GetOrAssign` in
  [`pkg/services/dhcp`](https://github.com/containers/gvisor-tap-vsock/tree/main/pkg/services/dhcp)),
  so a new MAC gets a new address, with the gateway and DNS in the
  lease.
- `-b` backgrounds `udhcpc` while no lease arrives, as when the
  transport attaches after boot, so init is not blocked. `-q` exits once
  a lease is held, so nothing stays running.
- `-s` names the script that applies the lease (address, default route,
  `resolv.conf`) when busybox calls it with `bound` or `renew`. The
  initramfs has none today; it is about ten lines.

The block costs about six fork and execs, about 200 ms, and only on a
boot with the flag. Init can start it after the shell so the prompt does
not wait.

One case still collides: a tab booted offline keeps the static .2, and
if it attaches mid-session to a helper that already leased .2 to a DHCP
tab, the two share an address. Either the helper starts gvproxy's pool
above .2, keeping .2 for static guests (gvproxy's configuration has a
pool and static leases; that the pool skips a reserved address is
unchecked), or the one-connection rule stays in force for static guests.

### Attaching, from the reader's side

1. The helper prints a link. Opening it boots trynix as usual.
2. On load the page reads `#net=`, moves it to `sessionStorage`, and
   removes the fragment from the address bar. `writeUrl` already
   rewrites the URL with `replaceState`
   ([site/js/url.js](../site/js/url.js)); removal should be deliberate,
   not a side effect of that.
3. A Network control beside Boot takes the same string pasted by hand.
   The prefix picks the transport, `ws://` for localhost, `wss://` for
   a public tunnel and `tc` for tailcat, so there is no mode switch.
4. A status beside the terminal reads off, connecting, on (localhost),
   on (tailcat and the DERP region), or lost and retrying. For
   localhost in Chrome it warns that the browser will ask to reach this
   device before the prompt appears.

The default is `sessionStorage` because tailcat's default addresses are
ephemeral and die with the helper. A "remember on this device" option
backed by `localStorage` only makes sense for a helper started with a
saved key.

### What loads, and when

| case            | extra download                                                                        |
| --------------- | ------------------------------------------------------------------------------------- |
| no string       | none; the shim and status are a few KB and idle                                       |
| `ws://` string  | none                                                                                  |
| `wss://` string | none                                                                                  |
| `tc` string     | `wasm_exec.js` and `main.wasm.gz` (6.56 MB), by dynamic import, kept in the Cache API |

A boot with no network keeps the warm start described in
[design.md, "Start time"](design.md#start-time).

## Security

A WebSocket carries no CORS, so any site the reader visits can open
`ws://127.0.0.1:<port>`. Unchecked, the helper is a way into the reader's
LAN for every page in the browser. The loopback listener rejects any
`Origin` other than `https://trynix.dev` and requires the token the
helper printed. A local process can forge `Origin`, but a local process
already has the network.

The connection string is a credential and never enters the query
string. The query string is trynix's shareable link
([design.md, "The link"](design.md#the-link)), and a link carrying it
would hand the helper to whoever receives the link. The debug panel's
Copy report redacts it. If attaching becomes a WebMCP tool
([webmcp.md](webmcp.md)), the tool accepts the string and reports
status; it never returns the stored string.

A tailcat address is the server's WireGuard public key and pre-shared
key. The helper uses tailcat's default ephemeral keys, so an address is
dead once the helper exits.

gvproxy's defaults expose the helper's own loopback. With no NAT map
configured it maps 192.168.127.254 to the helper machine's 127.0.0.1
([`cmd/gvproxy/config.go`](https://github.com/containers/gvisor-tap-vsock/blob/main/cmd/gvproxy/config.go)),
so over the tailcat transport anyone holding the link reaches every
service listening on localhost there. The helper must replace that
mapping. What it cannot remove is the helper's LAN: the guest dials from
the helper's machine, so every host that machine reaches is reachable
from the guest. That is the point for a reader testing against their
own network, and the reason the link is a credential.

## Test first

In order, since each gates the next:

1. **Bytes out of QEMU.** emscripten routes the socket netdev through
   its WebSocket emulation. For localhost that is enough. For tailcat
   the page must catch those bytes, either with a Mock Service Worker
   style intercept as qemu-wasm's example does, or with a small netdev
   patch. Neither has been tried in the engine.
2. **The snapshot.** Retake it with the NIC, and find out what
   `-incoming` does when nothing answers the socket. If QEMU refuses to
   start, the offline boot breaks and the shim has to accept the socket
   itself from the start.
3. **The kernel.** The fragment sets `# CONFIG_ETHERNET is not set`.
   `VIRTIO_NET` does not depend on it and should survive `olddefconfig`,
   unchecked against a built config.
4. **Throughput through Go wasm.** tailcat runs on the page's main
   thread and QEMU in a pthread worker, with a postMessage hop between.
   Unmeasured.
5. **A static address on gvproxy.** Its DHCP server assigns addresses
   per MAC; that its switch forwards traffic from a 192.168.127.2 it
   never leased is assumed, not checked.
6. **The prompt.** Whether Chrome remembers the Local Network Access
   grant per origin was not found in its documentation.
7. **A WebSocket through a quick tunnel.** Cloudflare documents
   WebSockets on its network and quick tunnels separately, never
   together. An echo server behind `cloudflared tunnel --url` answers
   it in a minute.

## Later

**A tailnet login.** WebVM's route: the page becomes a node on the
reader's tailnet. It is the only option here that reaches LAN devices,
through a subnet router the reader advertises (`tailscale set
--advertise-routes`), and it reaches the internet through an exit node
the reader runs. It needs tsconnect rebuilt with a TUN, frames
translated to IP packets in the page, and about 16 MB loaded on login.
LAN reachability is layer 3 only: mDNS, SSDP and discovery broadcasts do
not cross the router.

**A public relay.** `wss://wisp.mercurywork.shop` is a throttled public
[wisp](https://github.com/MercuryWorkshop/wisp-protocol) server. Wisp
multiplexes TCP streams, not frames, so it needs a network stack in the
page, and all traffic would leave from someone else's IP under no terms
trynix can rely on. An opt-in string at most.

**Fetch-only.** The alpine.sh model with no helper at all. The CORS table
above is why it is not the default; it could back the none transport for
the reachable column if that proves worth the MITM CA and the stack in
the page.

## Not pursued

**VMs talking over BroadcastChannel.** Tabs of one origin in one browser
profile can post each other messages, so each tab could post QEMU's
frames to a shared channel and feed in what it hears, making a hub with
no helper. It was dropped for the confusion it brings. Every VM on the
hub needs a MAC and an address the snapshot does not give it, a
randomised MAC as under "Several VMs on one helper, later", and, with no
gvproxy to lease addresses, a link-local address from busybox `zcip`
with no names to reach VMs by. It reaches no further than one browser,
and every frame is cloned to every tab. A network of VMs is better
reached, if ever, through one helper and the DHCP path above.
