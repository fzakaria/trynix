//go:build js && wasm

package main

import (
	"context"
	"log"
	"net/http"
	"syscall/js"
	"time"

	"github.com/fzakaria/trynix/trynixnet"
)

func main() {
	n, err := trynixnet.NewNetwork([4]byte{192, 168, 2, 3}, [6]byte{2, 0, 0, 0, 2, 3})
	if err != nil {
		panic(err)
	}
	listener, err := n.Listen()
	if err != nil {
		panic(err)
	}
	url := js.Global().Get("trynixSOCKSURL").String()
	dial, err := trynixnet.SOCKSDialer(url)
	if err != nil {
		panic(err)
	}
	server := &http.Server{Handler: trynixnet.NewProxy(dial), ReadHeaderTimeout: 30 * time.Second}
	go func() {
		if err := server.Serve(listener); err != http.ErrServerClosed {
			log.Print(err)
		}
	}()
	receive := js.FuncOf(func(_ js.Value, args []js.Value) any {
		frame := make([]byte, args[0].Get("byteLength").Int())
		js.CopyBytesToGo(frame, args[0])
		n.Receive(frame)
		return nil
	})
	js.Global().Set("trynixReceiveEthernet", receive)
	go func() {
		for {
			frame := n.Send(context.Background())
			if frame == nil {
				return
			}
			data := js.Global().Get("Uint8Array").New(len(frame))
			js.CopyBytesToJS(data, frame)
			js.Global().Call("trynixSendEthernet", data)
		}
	}()
	js.Global().Call("trynixNetworkReady")
	select {}
}
