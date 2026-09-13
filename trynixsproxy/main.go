// trynixsproxy serves SOCKS5 byte streams over binary WebSocket messages.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/things-go/go-socks5"
)

// WebSocket has no half-close: an upstream EOF closes the whole tunnel.
type tunnelConn struct {
	net.Conn
	writeClosed atomic.Bool
}

func (c *tunnelConn) CloseWrite() error {
	c.writeClosed.Store(true)
	return c.Close()
}

func (c *tunnelConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	// Closing the WebSocket after upstream EOF cancels the other copy
	// goroutine's read. This is our own shutdown, not a transfer failure.
	if c.writeClosed.Load() && errors.Is(err, context.Canceled) {
		err = io.EOF
	}
	return n, err
}

const deployedOrigin = "https://trynix.dev"

func allowedOrigin(devOrigin string) (string, error) {
	if devOrigin == "" {
		return deployedOrigin, nil
	}
	u, err := url.Parse(devOrigin)
	if err != nil {
		return "", fmt.Errorf("invalid development origin: %w", err)
	}
	ip := net.ParseIP(u.Hostname())
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		devOrigin != u.Scheme+"://"+u.Host ||
		(u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) {
		return "", fmt.Errorf("development origin must be an exact http(s) origin on localhost or a loopback IP, without a path")
	}
	return devOrigin, nil
}

func proxyHandler(origin string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		logger := slog.With("client", r.RemoteAddr)
		// Check the entire origin, including scheme and port. Reject absent,
		// opaque and duplicate origins too; the library's same-host fallback
		// would otherwise allow requests outside this explicit policy.
		origins := r.Header.Values("Origin")
		if len(origins) != 1 || origins[0] != origin {
			logger.Warn("WebSocket origin rejected", "origin", origins, "status", http.StatusForbidden)
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		logger = logger.With("origin", origin)
		// The exact origin was checked above; skip the library's host matcher.
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			logger.Warn("WebSocket upgrade failed", "error", err)
			return
		}
		defer ws.CloseNow()
		started := time.Now()
		server := socks5.NewServer(
			socks5.WithRule(&socks5.PermitCommand{EnableConnect: true}),
			socks5.WithDialAndRequest(func(ctx context.Context, network, addr string, request *socks5.Request) (net.Conn, error) {
				destination := request.RawDestAddr.String()
				if request.RawDestAddr.FQDN != "" {
					destination = net.JoinHostPort(request.RawDestAddr.FQDN, strconv.Itoa(request.RawDestAddr.Port))
				}
				dialStarted := time.Now()
				conn, err := (&net.Dialer{Timeout: 30 * time.Second}).DialContext(ctx, network, addr)
				requestLogger := logger.With("destination", destination, "resolved", addr, "dial_duration", time.Since(dialStarted))
				if err != nil {
					requestLogger.WarnContext(ctx, "CONNECT", "status", "failed", "error", err)
				} else {
					requestLogger.InfoContext(ctx, "CONNECT", "status", "connected")
				}
				return conn, err
			}),
		)
		conn := &tunnelConn{Conn: websocket.NetConn(context.Background(), ws, websocket.MessageBinary)}
		defer conn.Close()
		if err := server.ServeConn(conn); err != nil {
			logger.Warn("SOCKS session ended", "status", "error", "duration", time.Since(started), "error", err)
		} else {
			logger.Info("SOCKS session ended", "status", "closed", "duration", time.Since(started))
		}
	})
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	listen := flag.String("listen", "127.0.0.1:1080", "WebSocket listen address")
	devOrigin := flag.String("dev-origin", "", "allow only this local development origin instead of https://trynix.dev (e.g. http://127.0.0.1:8137)")
	flag.Parse()
	origin, err := allowedOrigin(*devOrigin)
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	mux := http.NewServeMux()
	mux.Handle("/socks5", proxyHandler(origin))
	server := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("serving SOCKS5 over WebSocket", "url", "ws://"+*listen+"/socks5", "origin", origin)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("HTTP server failed", "error", err)
		os.Exit(1)
	}
}
