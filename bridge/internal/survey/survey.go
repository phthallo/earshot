// Package survey is the walk-through counting mode. The laptop sniffs in
// monitor mode while someone carries it through the venue. Typing a zone id
// and Enter starts counting for that zone; the next zone id (or "done")
// closes the previous one and writes its distinct phone count to the module
// as a survey count. Nothing about the phones is kept.
package survey

import (
	"context"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"venuemap/bridge/internal/sniff"
	"venuemap/bridge/internal/stdb"
	"venuemap/bridge/internal/venue"
)

// Phones heard weaker than this are probably in the next room.
const nearDbm = -75

func Run(ctx context.Context, client *stdb.Client, v *venue.Venue, iface string, keys io.Reader, out io.Writer) error {
	caps, err := sniff.Open(ctx, iface)
	if err != nil {
		return err
	}
	zones := map[string]bool{}
	for _, z := range v.Zones {
		zones[z.ZoneID] = true
	}
	fmt.Fprintf(out, "survey mode on %s. zones: %s\ntype a zone id and Enter when you walk into it, 'done' to finish.\n", iface, strings.Join(zoneIDs(v), " "))

	lines := sniff.ReadZoneKeys(ctx, keys)
	var current string
	var started time.Time
	seen := map[string]bool{}

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
		fmt.Fprintf(out, "%s: %d phones in %s, saved\n", current, n, time.Since(started).Round(time.Second))
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
			current, started, seen = line, time.Now(), map[string]bool{}
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
