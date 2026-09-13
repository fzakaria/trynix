package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestSOCKSOverWebSocket(t *testing.T) {
	upstream, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		c, err := upstream.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		io.Copy(c, c)
	}()
	host := httptest.NewServer(proxyHandler())
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://trynix.dev"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	c := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	// Split the greeting across messages: message boundaries are not records.
	for _, b := range []byte{5, 1, 0} {
		if _, err := c.Write([]byte{b}); err != nil {
			t.Fatal(err)
		}
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(c, reply); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reply, []byte{5, 0}) {
		t.Fatalf("greeting: %v", reply)
	}
	_, portString, _ := net.SplitHostPort(upstream.Addr().String())
	port, _ := strconv.Atoi(portString)
	request := append([]byte{5, 1, 0, 3, 9}, []byte("localhost")...)
	request = append(request, byte(port>>8), byte(port))
	if _, err := c.Write(request); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(c, header); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(header, []byte{5, 0, 0, 1}) {
		t.Fatalf("CONNECT: %v", header)
	}
	if _, err := io.CopyN(io.Discard, c, 6); err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte{0, 255, 1, 128}, 32768)
	writeErr := make(chan error, 1)
	go func() { _, err := c.Write(payload); writeErr <- err }()
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(c, got); err != nil {
		t.Fatal(err)
	}
	if err := <-writeErr; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("forwarded bytes differ")
	}
}

// An upstream EOF closes the tunnel and unblocks the client-to-upstream
// reader without turning our own cancellation into a SOCKS error.
func TestTunnelCloseWrite(t *testing.T) {
	result := make(chan error, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		defer ws.CloseNow()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		c := &tunnelConn{Conn: websocket.NetConn(ctx, ws, websocket.MessageBinary)}
		go c.CloseWrite()
		_, err = c.Read(make([]byte, 1))
		result <- err
	}))
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	ws.Read(ctx) // Process the server's normal close handshake.
	select {
	case err := <-result:
		if err != io.EOF {
			t.Fatalf("shutdown read: got %v, want EOF", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
