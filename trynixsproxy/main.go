// trynixsproxy serves SOCKS5 byte streams over binary WebSocket messages.
package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
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

func proxyHandler() http.Handler {
	server := socks5.NewServer(
		socks5.WithRule(&socks5.PermitCommand{EnableConnect: true}),
		socks5.WithDial((&net.Dialer{Timeout: 30 * time.Second}).DialContext),
	)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Cross-origin browser clients are the purpose of this local service.
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer ws.CloseNow()
		conn := &tunnelConn{Conn: websocket.NetConn(context.Background(), ws, websocket.MessageBinary)}
		defer conn.Close()
		if err := server.ServeConn(conn); err != nil {
			log.Printf("SOCKS connection from %s: %v", r.RemoteAddr, err)
		}
	})
}

func main() {
	listen := flag.String("listen", "127.0.0.1:1080", "WebSocket listen address")
	flag.Parse()
	mux := http.NewServeMux()
	mux.Handle("/socks5", proxyHandler())
	server := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("serving SOCKS5 over WebSocket at ws://%s/socks5", *listen)
	log.Fatal(server.ListenAndServe())
}
