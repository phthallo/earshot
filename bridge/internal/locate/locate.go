// Package locate moves a real node around the map from the access points it
// hears, using the same zone fingerprints the Android app is matched against.
// A node that is carried through the venue then reports its counts, and the
// phones it hears, from the zone it is actually in.
package locate

import (
	"context"
	"log"
	"sync"
	"time"

	"venuemap/bridge/internal/fp"
	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/stdb"
	"venuemap/bridge/internal/venue"
)

const (
	// Matches weaker than this leave the node where it was.
	minConfidence = 0.3
	// A node is re-seeded at least this often even when its zone has not changed,
	// so a restart of the module picks it up again.
	refresh = 60 * time.Second
)

type Locator struct {
	Store  *fp.Store
	Venue  *venue.Venue
	Client *stdb.Client

	mu   sync.Mutex
	last map[int]placement
}

type placement struct {
	zone string
	at   time.Time
}

// Handle is wired into node.Handler.Locate.
func (l *Locator) Handle(nodeID int, aps []node.Sight) {
	scan := make([]fp.AP, 0, len(aps))
	for _, a := range aps {
		scan = append(scan, fp.AP{BSSID: a.MacHash, RSSI: a.RSSI})
	}
	m, err := l.Store.Locate(scan)
	if err != nil {
		return // no fingerprints yet, or too few access points in this scan
	}
	if m.Confidence < minConfidence {
		return
	}
	l.mu.Lock()
	if l.last == nil {
		l.last = map[int]placement{}
	}
	prev := l.last[nodeID]
	if prev.zone == m.ZoneID && time.Since(prev.at) < refresh {
		l.mu.Unlock()
		return
	}
	l.last[nodeID] = placement{zone: m.ZoneID, at: time.Now()}
	l.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := l.Venue.MoveNode(ctx, l.Client, nodeID, m.ZoneID); err != nil {
		log.Printf("move node %d: %v", nodeID, err)
		return
	}
	if prev.zone != m.ZoneID {
		log.Printf("node %d is in %s (confidence %.2f)", nodeID, m.ZoneID, m.Confidence)
	}
}
