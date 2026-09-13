package trynixnet

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/net/proxy"
)

type DialFunc func(context.Context, string, string) (net.Conn, error)

type websocketDialer struct{ URL string }

func (d websocketDialer) Dial(network, address string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, address)
}
func (d websocketDialer) DialContext(ctx context.Context, _, _ string) (net.Conn, error) {
	ws, _, err := websocket.Dial(ctx, d.URL, nil)
	if err != nil {
		return nil, err
	}
	// DialContext governs establishment, not the lifetime of a pooled connection.
	return websocket.NetConn(context.Background(), ws, websocket.MessageBinary), nil
}

func SOCKSDialer(url string) (DialFunc, error) {
	// This public API wraps x/net/internal/socks. The forward dialer replaces
	// only the connection to the SOCKS server; destination names stay intact.
	d, err := proxy.SOCKS5("tcp", "host-socks:1080", nil, websocketDialer{url})
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		return d.(proxy.ContextDialer).DialContext(ctx, network, address)
	}, nil
}

type ForwardProxy struct {
	dial      DialFunc
	transport *http.Transport
}

func NewProxy(dial DialFunc) *ForwardProxy {
	return &ForwardProxy{dial: dial, transport: &http.Transport{
		DialContext: dial, Proxy: nil, DisableCompression: true,
		ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 90 * time.Second,
	}}
}
func (p *ForwardProxy) Close() { p.transport.CloseIdleConnections() }

func stripHopHeaders(h http.Header) {
	for _, value := range h.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			h.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
		h.Del(name)
	}
}

func (p *ForwardProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.connect(w, r)
		return
	}
	if r.URL.Scheme != "http" || r.URL.Host == "" || r.URL.User != nil {
		http.Error(w, "expected an absolute http:// URL or CONNECT", http.StatusBadRequest)
		return
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	out.Host = out.URL.Host
	stripHopHeaders(out.Header)
	response, err := p.transport.RoundTrip(out)
	if err != nil {
		http.Error(w, "upstream: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	stripHopHeaders(response.Header)
	for k, values := range response.Header {
		for _, value := range values {
			w.Header().Add(k, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	io.Copy(w, response.Body)
}

func (p *ForwardProxy) connect(w http.ResponseWriter, r *http.Request) {
	if _, _, err := net.SplitHostPort(r.Host); err != nil {
		http.Error(w, "CONNECT requires host:port", 400)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	upstream, err := p.dial(ctx, "tcp", r.Host)
	cancel()
	if err != nil {
		http.Error(w, "upstream: "+err.Error(), 502)
		return
	}
	defer upstream.Close()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking unavailable", 500)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	if _, err = fmt.Fprint(buffered, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err = buffered.Flush(); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, buffered); done <- struct{}{} }()
	go func() { io.Copy(client, upstream); done <- struct{}{} }()
	<-done
	// WebSocket doesn't represent half-close. End both directions together.
	client.Close()
	upstream.Close()
	<-done
}
