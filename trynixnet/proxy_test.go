package trynixnet

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/things-go/go-socks5"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
)

func TestEthernetHTTPAndHTTPS(t *testing.T) {
	// Real host sockets and host-side DNS, behind the same WebSocket/SOCKS
	// adapter as trynixsproxy. Application traffic uses a separate guest stack.
	socks := socks5.NewServer(socks5.WithRule(&socks5.PermitCommand{EnableConnect: true}))
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		socks.ServeConn(websocket.NetConn(r.Context(), ws, websocket.MessageBinary))
	}))
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	network, err := NewNetwork([4]byte{192, 168, 2, 3}, [6]byte{2, 0, 0, 0, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	defer network.Close()
	guest, err := NewNetwork([4]byte{192, 168, 2, 4}, [6]byte{2, 0, 0, 0, 2, 4})
	if err != nil {
		t.Fatal(err)
	}
	defer guest.Close()
	for _, pair := range [][2]*Network{{guest, network}, {network, guest}} {
		go func(a, b *Network) {
			for {
				frame := a.Send(ctx)
				if frame == nil {
					return
				}
				b.Receive(frame)
			}
		}(pair[0], pair[1])
	}
	dial, err := SOCKSDialer("ws" + strings.TrimPrefix(host.URL, "http"))
	if err != nil {
		t.Fatal(err)
	}
	handler := NewProxy(dial)
	defer handler.Close()
	listener, err := network.Listen()
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	defer server.Close()
	go server.Serve(listener)
	proxyURL, _ := url.Parse("http://192.168.2.3:8080")
	transport := &http.Transport{
		Proxy: http.ProxyURL(proxyURL),
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			if address != "192.168.2.3:8080" {
				t.Errorf("guest attempted direct access to %s", address)
			}
			return gonet.DialContextTCP(ctx, guest.Stack, tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFrom4([4]byte{192, 168, 2, 3}), Port: 8080}, ipv4.ProtocolNumber)
		},
		TLSClientConfig: &tls.Config{RootCAs: x509.NewCertPool(), ServerName: "example.com"},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	fixture := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" || r.Header.Get("X-Hop") != "" {
			t.Error("hop header leaked upstream")
		}
		w.Header().Set("Connection", "X-Response-Hop")
		w.Header().Set("X-Response-Hop", "remove-me")
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		w.WriteHeader(http.StatusCreated)
		w.Write(body)
	})
	plain := httptest.NewServer(fixture)
	defer plain.Close()
	secure := httptest.NewTLSServer(fixture)
	defer secure.Close()
	transport.TLSClientConfig.RootCAs.AddCert(secure.Certificate())
	for _, base := range []string{plain.URL, secure.URL} {
		t.Run(strings.Split(base, ":")[0], func(t *testing.T) {
			// A hostname rather than an IP exercises SOCKS-side resolution.
			base = strings.Replace(base, "127.0.0.1", "localhost", 1)
			payload := bytes.Repeat([]byte("\x00\xffstreaming body\n"), 8192)
			req, _ := http.NewRequestWithContext(ctx, "POST", base+"/echo", bytes.NewReader(payload))
			// For HTTPS these would be end-to-end application headers, so only
			// attach hop headers to the plain HTTP proxy request.
			if strings.HasPrefix(base, "http:") {
				req.Header.Set("Proxy-Authorization", "do-not-forward")
				req.Header.Set("Connection", "X-Hop")
				req.Header.Set("X-Hop", "do-not-forward")
			}
			response, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			got, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 201 || !bytes.Equal(got, payload) {
				t.Fatalf("bad response: status=%d bytes=%d", response.StatusCode, len(got))
			}
			if strings.HasPrefix(base, "http:") && response.Header.Get("X-Response-Hop") != "" {
				t.Error("hop header leaked to guest")
			}
		})
	}
	// An off-subnet address has no route in the guest.
	_, err = gonet.DialContextTCP(ctx, guest.Stack, tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFrom4([4]byte{1, 1, 1, 1}), Port: 80}, ipv4.ProtocolNumber)
	if err == nil {
		t.Fatal("guest unexpectedly has a default route")
	}
}

func TestProxyRejectsOriginForm(t *testing.T) {
	p := NewProxy(func(context.Context, string, string) (net.Conn, error) { t.Fatal("unexpected dial"); return nil, nil })
	defer p.Close()
	for _, request := range []*http.Request{
		httptest.NewRequest("GET", "/not-an-absolute-url", nil),
		httptest.NewRequest("CONNECT", "host-without-port", nil),
	} {
		w := httptest.NewRecorder()
		p.ServeHTTP(w, request)
		if w.Code != 400 {
			t.Fatalf("status %d", w.Code)
		}
	}
}
