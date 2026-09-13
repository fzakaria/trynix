// Package trynixnet provides the browser's Ethernet endpoint and HTTP proxy.
package trynixnet

import (
	"context"
	"fmt"
	"net"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/link/ethernet"
	"gvisor.dev/gvisor/pkg/tcpip/network/arp"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

const ProxyIP = "192.168.2.3"
const ProxyPort = 8080

// Network has one Ethernet NIC and only a directly connected /24 route.
// It is an endpoint, never a router or a transparent TCP forwarder.
type Network struct {
	Stack *stack.Stack
	Link  *channel.Endpoint
}

func NewNetwork(ip [4]byte, mac [6]byte) (*Network, error) {
	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol, arp.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
	})
	link := channel.New(256, 1514, tcpip.LinkAddress(string(mac[:])))
	if err := s.CreateNIC(1, ethernet.New(link)); err != nil {
		s.Close()
		return nil, fmt.Errorf("create NIC: %s", err)
	}
	addr := tcpip.AddrFrom4(ip)
	if err := s.AddProtocolAddress(1, tcpip.ProtocolAddress{Protocol: ipv4.ProtocolNumber, AddressWithPrefix: tcpip.AddressWithPrefix{Address: addr, PrefixLen: 24}}, stack.AddressProperties{}); err != nil {
		s.Close()
		return nil, fmt.Errorf("add address: %s", err)
	}
	subnet := tcpip.AddressWithPrefix{Address: tcpip.AddrFrom4([4]byte{192, 168, 2, 0}), PrefixLen: 24}.Subnet()
	s.SetRouteTable([]tcpip.Route{{Destination: subnet, NIC: 1}})
	return &Network{Stack: s, Link: link}, nil
}

func (n *Network) Listen() (net.Listener, error) {
	return gonet.ListenTCP(n.Stack, tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFrom4([4]byte{192, 168, 2, 3}), Port: ProxyPort}, ipv4.ProtocolNumber)
}

func (n *Network) Receive(frame []byte) {
	if len(frame) < header.EthernetMinimumSize || len(frame) > 65535 {
		return
	}
	packet := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(frame)})
	defer packet.DecRef()
	n.Link.InjectInbound(0, packet)
}

func (n *Network) Send(ctx context.Context) []byte {
	packet := n.Link.ReadContext(ctx)
	if packet == nil {
		return nil
	}
	defer packet.DecRef()
	view := packet.ToView()
	defer view.Release()
	return append([]byte(nil), view.AsSlice()...)
}

func (n *Network) Close() { n.Stack.Close(); n.Link.Close(); n.Stack.Wait() }
