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
	"strconv"
	"time"

	"venuemap/bridge/internal/ingest"
	"venuemap/bridge/internal/stdb"
)

// Handler consumes decoded node messages.
type Handler struct {
	Batch  *ingest.Batcher
	Client *stdb.Client
	links  links
}

func (h *Handler) Handle(ctx context.Context, m Message) {
	h.handle(ctx, m, nil)
}

func (h *Handler) handle(ctx context.Context, m Message, w io.Writer) {
	switch m.T {
	case "hello":
		log.Printf("node %d hello fw=%s ch=%d", m.ID, m.FW, m.Ch)
		if w != nil {
			h.links.set(m.ID, w)
		}
	case "motion":
		h.Batch.Motion(ingest.Motion{NodeID: m.ID, Score: m.Score, State: m.State, PIR: m.PIR == 1, AnonCount: m.Anon})
	case "sight":
		items := make([]ingest.Sight, 0, len(m.Items))
		for _, it := range m.Items {
			mac, _ := it[0].(string)
			rssi := 0
			switch v := it[1].(type) {
			case float64:
				rssi = int(v)
			case string:
				rssi, _ = strconv.Atoi(v)
			}
			if mac != "" {
				items = append(items, ingest.Sight{MacHash: mac, RSSI: rssi})
			}
		}
		h.Batch.Sightings(m.ID, items)
	case "csi":
		if err := h.Client.Call(ctx, "push_csi", m.ID, m.Amps); err != nil {
			log.Printf("push_csi: %v", err)
		}
	}
}

// ReadLines decodes one JSON message per line until r ends. When r can also
// be written to, the node is registered for commands on its hello line.
func (h *Handler) ReadLines(ctx context.Context, r io.Reader) {
	w, _ := r.(io.Writer)
	if w != nil {
		defer h.links.drop(w)
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		var m Message
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			continue // boot noise on serial lines
		}
		h.handle(ctx, m, w)
	}
}

// ServeTCP accepts node connections (laptop or Pi sniffers) on addr.
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
			log.Printf("node connected from %s", conn.RemoteAddr())
			h.ReadLines(ctx, conn)
		}()
	}
}

// SerialBaud must match CONFIG_ESP_CONSOLE_UART_BAUDRATE in the firmware.
// 115200 cannot carry a full sight line (128 hashes) every second.
const SerialBaud = "921600"

// ReadSerial opens a UART at SerialBaud 8N1 and reads lines, reconnecting on loss.
func (h *Handler) ReadSerial(ctx context.Context, port string) {
	for ctx.Err() == nil {
		if err := exec.CommandContext(ctx, "stty", "-F", port, SerialBaud, "raw", "-echo").Run(); err != nil {
			log.Printf("stty %s: %v", port, err)
		}
		f, err := os.OpenFile(port, os.O_RDWR, 0)
		if err != nil {
			log.Printf("open %s: %v (retry in 3s)", port, err)
			time.Sleep(3 * time.Second)
			continue
		}
		log.Printf("serial %s open", port)
		h.ReadLines(ctx, f)
		f.Close()
		time.Sleep(time.Second)
	}
}
