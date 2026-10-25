package node

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"time"

	"venuemap/bridge/internal/ingest"
	"venuemap/bridge/internal/stdb"
)

// Handler consumes decoded node messages.
type Handler struct {
	Batch  *ingest.Batcher
	Client *stdb.Client
	// LocalVenue is the venue of nodes on this machine's serial ports and of
	// loopback TCP peers, which need no key.
	LocalVenue string
	// Auth maps a relay key to its venue. Nil accepts no remote relays.
	Auth func(ctx context.Context, key string) (venueID string, ok bool)
	// Allow says whether node nodeID belongs to venueID. Applied to relayed
	// lines only; a board on the local machine is trusted by being plugged in.
	Allow func(ctx context.Context, venueID string, nodeID int) bool
	// Locate receives the access points a node heard (BSSID in MacHash, RSSI),
	// so a moving node can be placed. Nil when no fingerprints are loaded.
	Locate func(nodeID int, aps []Sight)
	// Observe receives every sighting from a real node so unregistered phones
	// can be drawn as anonymous dots. Nil disables the dots.
	Observe func(venueID string, nodeID int, sights []Sight)
	links   links
}

// link is one connection's state.
type link struct {
	w     io.Writer
	venue string
	// remote links must send an auth line before anything else
	remote, authed bool
	denied         map[int]bool
}

func (h *Handler) Handle(ctx context.Context, m Message) {
	h.handle(ctx, m, &link{venue: h.LocalVenue, authed: true})
}

// handle processes one line. It returns false when the link must close.
func (h *Handler) handle(ctx context.Context, m Message, l *link) bool {
	if m.T == "auth" {
		if h.Auth == nil {
			log.Printf("relay from %s: no relay auth configured", l.venue)
			return false
		}
		venue, ok := h.Auth(ctx, m.Key)
		if !ok {
			h.reply(l, map[string]any{"t": "auth", "ok": false, "msg": "unknown relay key"})
			return false
		}
		l.venue, l.authed = venue, true
		h.reply(l, map[string]any{"t": "auth", "ok": true, "venue": venue})
		log.Printf("relay authenticated for venue %s", venue)
		return true
	}
	if !l.authed {
		h.reply(l, map[string]any{"t": "auth", "ok": false, "msg": "send the auth line first"})
		return false
	}
	if l.remote && h.Allow != nil && m.ID != 0 && !h.Allow(ctx, l.venue, m.ID) {
		if !l.denied[m.ID] {
			log.Printf("venue %s relay sent node %d, which is not placed in that venue: dropped", l.venue, m.ID)
			l.denied[m.ID] = true
		}
		return true
	}
	switch m.T {
	case "hello":
		log.Printf("node %d hello fw=%s ch=%d venue=%s", m.ID, m.FW, m.Ch, l.venue)
		if l.w != nil {
			h.links.set(m.ID, l.w)
		}
	case "motion":
		h.Batch.Motion(ingest.Motion{NodeID: m.ID, Score: m.Score, State: m.State, PIR: m.PIR == 1, AnonCount: m.Anon})
	case "sight":
		sights := m.Sights()
		items := make([]ingest.Sight, 0, len(sights))
		for _, s := range sights {
			items = append(items, ingest.Sight{MacHash: s.MacHash, RSSI: s.RSSI})
		}
		h.Batch.Sightings(m.ID, items)
		if h.Observe != nil && m.ID >= 100 {
			h.Observe(l.venue, m.ID, sights)
		}
	case "aps":
		if h.Locate != nil {
			h.Locate(m.ID, m.Sights())
		}
	case "csi":
		if err := h.Client.Call(ctx, "push_csi", m.ID, m.Amps); err != nil {
			log.Printf("push_csi: %v", err)
		}
	}
	return true
}

func (h *Handler) reply(l *link, v any) {
	if l.w == nil {
		return
	}
	b, _ := json.Marshal(v)
	_, _ = l.w.Write(append(b, '\n'))
}

// ReadLines decodes one JSON message per line until r ends. When r can also
// be written to, the node is registered for commands on its hello line.
// remote links must authenticate; local ones belong to LocalVenue.
func (h *Handler) ReadLines(ctx context.Context, r io.Reader, remote bool) {
	l := &link{venue: h.LocalVenue, remote: remote, authed: !remote, denied: map[int]bool{}}
	l.w, _ = r.(io.Writer)
	if l.w != nil {
		defer h.links.drop(l.w)
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		var m Message
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			continue // boot noise on serial lines
		}
		if !h.handle(ctx, m, l) {
			return
		}
	}
}

// ServeTCP accepts relay connections on addr. Loopback peers are local nodes;
// anyone else must start with an auth line.
func (h *Handler) ServeTCP(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func() {
			defer conn.Close()
			remote := true
			if a, ok := conn.RemoteAddr().(*net.TCPAddr); ok && a.IP.IsLoopback() {
				remote = false
			}
			log.Printf("node connected from %s (remote=%v)", conn.RemoteAddr(), remote)
			h.ReadLines(ctx, conn, remote)
		}()
	}
}

// SerialBaud must match CONFIG_ESP_CONSOLE_UART_BAUDRATE in the firmware.
// 115200 cannot carry a full sight line (128 hashes) every second.
const SerialBaud = "921600"

// OpenSerial configures port for SerialBaud 8N1 raw and opens it.
func OpenSerial(ctx context.Context, port string) (*os.File, error) {
	if err := exec.CommandContext(ctx, "stty", "-F", port, SerialBaud, "raw", "-echo").Run(); err != nil {
		log.Printf("stty %s: %v", port, err)
	}
	return os.OpenFile(port, os.O_RDWR, 0)
}

// ReadSerial reads lines from a UART, reconnecting on loss.
func (h *Handler) ReadSerial(ctx context.Context, port string) {
	for ctx.Err() == nil {
		f, err := OpenSerial(ctx, port)
		if err != nil {
			log.Printf("open %s: %v (retry in 3s)", port, err)
			time.Sleep(3 * time.Second)
			continue
		}
		log.Printf("serial %s open", port)
		h.ReadLines(ctx, f, false)
		f.Close()
		time.Sleep(time.Second)
	}
}
