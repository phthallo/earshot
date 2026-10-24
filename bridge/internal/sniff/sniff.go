// Package sniff turns a Linux wifi card in monitor mode into a sensing node.
// It reads 802.11 frames, hashes the transmitter MAC with the salt, and emits
// the node line protocol: hello once, then one sight and one motion line per
// second. Raw MACs never leave this process.
//
// Needs root (or CAP_NET_RAW) and an interface already in monitor mode:
//
//	sudo ip link set wlan0 down
//	sudo iw wlan0 set monitor none
//	sudo ip link set wlan0 up
//	sudo iw wlan0 set channel 6
package sniff

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/afpacket"
	"github.com/google/gopacket/layers"

	"venuemap/bridge/internal/node"
)

type Options struct {
	Iface   string
	NodeID  int
	Connect string // bridge host:port; empty prints to stdout
	Salt    string
}

// Capture is one frame's transmitter and signal strength.
type Capture struct {
	MAC  string
	RSSI int
}

// Open starts reading frames from iface and sends captures on the returned
// channel until ctx ends. Frames without a signal field are dropped.
func Open(ctx context.Context, iface string) (<-chan Capture, error) {
	h, err := afpacket.NewTPacket(afpacket.OptInterface(iface), afpacket.OptFrameSize(4096), afpacket.OptPollTimeout(200*time.Millisecond))
	if err != nil {
		return nil, fmt.Errorf("open %s: %w (monitor mode? root?)", iface, err)
	}
	out := make(chan Capture, 1024)
	go func() {
		defer h.Close()
		defer close(out)
		var radio layers.RadioTap
		var dot11 layers.Dot11
		parser := gopacket.NewDecodingLayerParser(layers.LayerTypeRadioTap, &radio, &dot11)
		parser.IgnoreUnsupported = true
		decoded := []gopacket.LayerType{}
		for ctx.Err() == nil {
			data, _, err := h.ZeroCopyReadPacketData()
			if err != nil {
				if err == afpacket.ErrTimeout {
					continue
				}
				log.Printf("read: %v", err)
				return
			}
			if parser.DecodeLayers(data, &decoded) != nil {
				continue
			}
			if !radio.Present.DBMAntennaSignal() || len(dot11.Address2) != 6 {
				continue
			}
			select {
			case out <- Capture{MAC: dot11.Address2.String(), RSSI: int(radio.DBMAntennaSignal)}:
			default:
			}
		}
	}()
	return out, nil
}

// Window aggregates captures into per-second strongest RSSI per MAC and a
// rolling distinct-MAC count for the anonymous estimate.
type Window struct {
	mu       sync.Mutex
	best     map[string]int       // this second
	lastSeen map[string]time.Time // for the 10 s distinct count
}

func NewWindow() *Window {
	return &Window{best: map[string]int{}, lastSeen: map[string]time.Time{}}
}

func (w *Window) Add(c Capture, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if r, ok := w.best[c.MAC]; !ok || c.RSSI > r {
		w.best[c.MAC] = c.RSSI
	}
	w.lastSeen[c.MAC] = now
}

// Drain returns this second's MACs with their strongest RSSI and the number
// of distinct MACs heard in the last 10 s, then clears the per-second map.
func (w *Window) Drain(now time.Time) (best map[string]int, distinct int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	best = w.best
	w.best = map[string]int{}
	for mac, t := range w.lastSeen {
		if now.Sub(t) > 10*time.Second {
			delete(w.lastSeen, mac)
		}
	}
	return best, len(w.lastSeen)
}

// Run is node mode: sniff, aggregate, emit lines to the bridge.
func Run(ctx context.Context, o Options) error {
	caps, err := Open(ctx, o.Iface)
	if err != nil {
		return err
	}
	var out io.Writer = os.Stdout
	if o.Connect != "" {
		conn, err := dialRetry(ctx, o.Connect)
		if err != nil {
			return err
		}
		defer conn.Close()
		out = conn
	}
	enc := json.NewEncoder(out)
	if err := enc.Encode(node.Message{T: "hello", ID: o.NodeID, FW: "sniff-0.1"}); err != nil {
		return err
	}
	win := NewWindow()
	var prevDistinct int
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case c, ok := <-caps:
			if !ok {
				return fmt.Errorf("capture ended")
			}
			win.Add(c, time.Now())
		case now := <-t.C:
			best, distinct := win.Drain(now)
			items := make([][]any, 0, len(best))
			for mac, rssi := range best {
				items = append(items, []any{node.HashMAC(o.Salt, mac), rssi, mac})
			}
			// Motion from churn: how many phones arrived or left since last second.
			score := float64(abs(distinct-prevDistinct)) / 5
			if score > 1 {
				score = 1
			}
			state := "idle"
			if score > 0.15 {
				state = "motion"
			}
			prevDistinct = distinct
			ts := now.UnixMilli()
			if len(items) > 0 {
				if err := enc.Encode(node.Message{T: "sight", ID: o.NodeID, Ts: ts, Items: items}); err != nil {
					return err
				}
			}
			if err := enc.Encode(node.Message{T: "motion", ID: o.NodeID, Ts: ts, Score: score, State: state, Anon: distinct}); err != nil {
				return err
			}
		}
	}
}

func dialRetry(ctx context.Context, addr string) (net.Conn, error) {
	for {
		conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
		if err == nil {
			log.Printf("connected to bridge at %s", addr)
			return conn, nil
		}
		log.Printf("dial %s: %v (retry in 3s)", addr, err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// ReadZoneKeys reads one line at a time from r (the terminal in survey mode)
// and sends trimmed lines on the returned channel.
func ReadZoneKeys(ctx context.Context, r io.Reader) <-chan string {
	out := make(chan string)
	go func() {
		defer close(out)
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			select {
			case out <- sc.Text():
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}
