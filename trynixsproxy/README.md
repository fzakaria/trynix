# trynixsproxy

Host-side SOCKS5 server carried over WebSocket, using coder/websocket and
things-go/go-socks5. The SOCKS server runs in this process; no separate
SOCKS daemon is required. Destination DNS resolution happens on the host.

From this directory:

```sh
nix run path:.                          # ws://127.0.0.1:1080/socks5
nix run path:. -- -listen 127.0.0.1:9000
nix build path:.
nix flake check path:.
```

Use one WebSocket per SOCKS connection. Send the normal SOCKS5 no-auth
greeting and CONNECT request, followed by application bytes, in binary
messages. Message boundaries are ignored on reads. Hostnames, IPv4 and
IPv6 destinations are supported. BIND and UDP ASSOCIATE are disabled.
TLS bytes pass through unchanged. WebSocket closure ends the connection;
TCP half-close is not represented separately.

The listener defaults to loopback and deliberately accepts all browser
origins without authentication. Any page able to reach it can use it.
Changing `-listen` to a non-loopback address exposes the proxy to that network.

Development: `nix develop path:.`, then `go test -race ./...` or `go run .`.
