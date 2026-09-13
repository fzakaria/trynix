# trynixsproxy

Host-side SOCKS5 server carried over WebSocket, using coder/websocket and
things-go/go-socks5. The SOCKS server runs in this process; no separate
SOCKS daemon is required. Destination DNS resolution happens on the host.

From this directory:

```sh
nix run path:.                          # ws://127.0.0.1:1080/socks5
nix run path:. -- -listen 127.0.0.1:9000
nix run path:. -- -dev-origin http://127.0.0.1:8137  # local nix run .#serve
nix build path:.
nix flake check path:.
```

Use one WebSocket per SOCKS connection. Send the normal SOCKS5 no-auth
greeting and CONNECT request, followed by application bytes, in binary
messages. Message boundaries are ignored on reads. Hostnames, IPv4 and
IPv6 destinations are supported. BIND and UDP ASSOCIATE are disabled.
TLS bytes pass through unchanged. WebSocket closure ends the connection;
TCP half-close is not represented separately.

Requests use `log/slog` with a text handler on stderr: timestamps, levels,
and structured fields for client address, page origin,
destination hostname and port, resolved address, and connection outcome.
Session completion includes its duration; DNS and protocol failures and
rejected WebSocket origins are logged too. Text fields are quoted to escape
control characters. These are SOCKS connection logs: HTTPS paths, HTTP
status codes, and request bodies are not inspected.

The listener defaults to loopback and accepts only the deployed page's
exact origin, `https://trynix.dev`. For local development, `-dev-origin`
replaces that origin with one explicit HTTP or HTTPS localhost/loopback
origin. Include the port and omit paths and trailing slashes. The default
site server uses `http://127.0.0.1:8137`; if you open it as `localhost`, use
`-dev-origin http://localhost:8137` instead. Other ports and hostnames are
not implicitly trusted. Missing, opaque (`null`), and duplicate origins
are rejected before the WebSocket upgrade.

Origin checks protect against unrelated browser pages; they are not client
authentication. Non-browser clients can forge Origin, and code executing
on the allowed origin can use the proxy. There is no authentication token
or destination restriction. Changing `-listen` to a non-loopback address
exposes the proxy to clients on that network.

Development: `nix develop path:.`, then `go test -race ./...` or `go run .`.
