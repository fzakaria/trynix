# trynixnet

Go/Wasm Ethernet endpoint and HTTP forward proxy for QEMU in the browser.
The proxy listens on **192.168.2.3:8080**, implemented with gVisor netstack
and `net/http`. Its SOCKS5 client uses `golang.org/x/net/proxy`, the public
wrapper around `golang.org/x/net/internal/socks`, over coder/websocket.

```
guest HTTP proxy client → Ethernet → gVisor → HTTP / CONNECT
  → SOCKS5 over WebSocket → trynixsproxy → destination TCP
```

HTTP requests stream through a Go HTTP transport with a custom SOCKS dialer
(not browser Fetch). CONNECT copies TLS bytes unchanged. Destination names
are resolved by the host SOCKS server. No guest DNS, default gateway, TLS
interception, or generated CA is involved. Guest applications still need
ordinary destination CA certificates to validate HTTPS servers.

## Run

From the repository root, start the host service and site in separate terminals:

```sh
nix run path:./trynixsproxy
nix run path:.#serve
```

Open `http://localhost:8137/?pkg=curl&boot=1`. The guest exports `http_proxy`,
`https_proxy`, `HTTP_PROXY` and `HTTPS_PROXY` pointing at the proxy. For example:

```sh
curl http://example.com/
curl https://example.com/
ip route  # only 192.168.2.0/24, no default route
```

The default host endpoint is `ws://127.0.0.1:1080/socks5`. Override it with
an encoded `socks` query parameter. `?network=off` disables the NIC and
browser stack and uses the original migration snapshot. Network-enabled
VMs cold-boot: the published snapshot has no NIC and cannot safely resume
with one added. The existing snapshot pins and baseline machine definition
remain valid for the non-networked mode.

VMs receive unique addresses from `.1` through `.254`, excluding `.3`.
Web Locks reserve the IP and corresponding MAC across tabs of the same
origin; closing a tab releases its lease. Each page has an isolated Ethernet
segment. Different origins do not share a segment or allocation namespace.
The proxy MAC is `02:00:00:00:02:03`.

## Transport and build

`site/js/network.js` intercepts only QEMU's `ws://localhost:8888/` socket
inside the page. This address never connects to the host. QEMU's socket
netdev framing (four-byte big-endian frame length, then Ethernet frame)
is passed to `network-worker.js`, which runs the Go Wasm module. All other
WebSockets, including the SOCKS connection in the worker, use the native API.
One host WebSocket carries one SOCKS5 connection; binary message boundaries
are not stream boundaries. UDP, SOCKS BIND, HTTP upgrades, and independent
TCP half-close are not implemented. Closing a CONNECT tunnel ends both
copy directions.

```sh
nix build path:./trynixnet
nix flake check path:./trynixnet
nix run path:.#network-test
cd trynixnet
go test -race ./...
GOOS=js GOARCH=wasm go build -o /tmp/trynixnet.wasm ./cmd/trynixnet
```

The Nix package includes `wasm_exec.js` from the same Go compiler as the
Wasm binary. The site versions the pair together. Go integration tests use
two Ethernet-connected gVisor stacks and a real WebSocket/SOCKS host to test
HTTP, HTTPS (with destination certificate verification), body forwarding,
hop headers, host DNS, and the lack of a default route. Node tests cover
address allocation and the QEMU transport adapter.

`network-test` starts Chromium, QEMU, the host SOCKS server, and local HTTP
and HTTPS fixtures. It downloads the curl closure for the VM, checks its
address and route table, and fetches both fixtures from the guest. HTTPS
is verified against the fixture's test CA, supplied explicitly to curl.
