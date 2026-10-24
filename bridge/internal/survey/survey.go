// Package survey is the walk-through counting mode. Someone carries a
// sniffer through the venue: the laptop's own card in monitor mode, or an
// ESP32 node on USB (the laptop then keeps its wifi). Typing a zone id and
// Enter starts counting for that zone; the next zone id (or "done") closes
// the previous one and writes its distinct phone count to the module as a
// survey count. Nothing about the phones is kept.
package survey

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"venuemap/bridge/internal/fp"
	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/sniff"
	"venuemap/bridge/internal/stdb"
	"venuemap/bridge/internal/venue"
)

// Phones heard weaker than this are probably in the next room.
const nearDbm = -75

// FromSerial reads an ESP32 node's lines from a UART. Sight lines become
// captures (the node already hashed the MAC; the survey only needs distinct
// values). Access point lists go to aps so the zone being walked can be
// fingerprinted at the same time.
func FromSerial(ctx context.Context, port string) (<-chan sniff.Capture, <-chan []fp.AP, error) {
	f, err := node.OpenSerial(ctx, port)
	if err != nil {
		return nil, nil, fmt.Errorf("open %s: %w (is the node plugged in?)", port, err)
	}
	caps := make(chan sniff.Capture, 1024)
	aps := make(chan []fp.AP, 8)
	go func() {
		defer close(caps)
		defer close(aps)
		defer f.Close()
		go func() { <-ctx.Done(); f.Close() }()
		parseLines(f, caps, aps)
	}()
	return caps, aps, nil
}

func parseLines(r io.Reader, caps chan<- sniff.Capture, aps chan<- []fp.AP) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		var m node.Message
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			continue // boot noise
		}
		switch m.T {
		case "sight":
			for _, s := range m.Sights() {
				select {
				case caps <- sniff.Capture{MAC: s.MacHash, RSSI: s.RSSI}:
				default:
				}
			}
		case "aps":
			scan := make([]fp.AP, 0, len(m.Items))
			for _, s := range m.Sights() {
				scan = append(scan, fp.AP{BSSID: s.MacHash, RSSI: s.RSSI})
			}
			select {
			case aps <- scan:
			default:
			}
		}
	}
}

// Options selects the sniffer and, with a node, where its fingerprints go.
type Options struct {
	Caps   <-chan sniff.Capture
	APs    <-chan []fp.AP // nil when the sniffer reports no access points
	Store  *fp.Store      // receives one sample per access point list while a zone is open
	Source string         // named in the banner
}

// Run counts distinct phones per zone until keys says "done".
func Run(ctx context.Context, client *stdb.Client, v *venue.Venue, o Options, keys io.Reader, out io.Writer) error {
	caps, source := o.Caps, o.Source
	zones := map[string]bool{}
	for _, z := range v.Zones {
		zones[z.ZoneID] = true
	}
	fmt.Fprintf(out, "survey mode on %s. zones: %s\ntype a zone id and Enter when you walk into it, 'done' to finish.\n", source, strings.Join(zoneIDs(v), " "))

	lines := sniff.ReadZoneKeys(ctx, keys)
	var current string
	var started time.Time
	seen := map[string]bool{}

	learned := 0

	flush := func() {
		if current == "" {
			return
		}
		n := len(seen)
		cctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := client.Call(cctx, "set_survey_count", current, n); err != nil {
			log.Printf("set_survey_count %s: %v", current, err)
			return
		}
		fmt.Fprintf(out, "%s: %d phones in %s, saved", current, n, time.Since(started).Round(time.Second))
		if o.Store != nil && o.APs != nil {
			fmt.Fprintf(out, ", %d fingerprints", learned)
		}
		fmt.Fprintln(out)
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return nil
		case c, ok := <-caps:
			if !ok {
				flush()
				return fmt.Errorf("capture ended")
			}
			if current != "" && c.RSSI >= nearDbm {
				seen[c.MAC] = true
			}
		case scan, ok := <-o.APs:
			if !ok {
				o.APs = nil // sniffer closed; the caps channel reports the end
				continue
			}
			if current == "" || o.Store == nil {
				continue
			}
			if err := o.Store.Learn(current, scan); err != nil {
				log.Printf("learn %s: %v", current, err)
				continue
			}
			learned++
		case line, ok := <-lines:
			if !ok {
				flush()
				return nil
			}
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			flush()
			if line == "done" || line == "q" {
				return nil
			}
			if !zones[line] {
				fmt.Fprintf(out, "unknown zone %q\n", line)
				current = ""
				continue
			}
			current, started, seen, learned = line, time.Now(), map[string]bool{}, 0
			fmt.Fprintf(out, "counting %s...\n", current)
		}
	}
}

func zoneIDs(v *venue.Venue) []string {
	out := make([]string, 0, len(v.Zones))
	for _, z := range v.Zones {
		out = append(out, z.ZoneID)
	}
	return out
}
