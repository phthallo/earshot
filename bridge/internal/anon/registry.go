package anon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"strings"
	"sync"
	"time"

	"venuemap/bridge/internal/dwell"
	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/stdb"
	"venuemap/bridge/internal/venue"
)

// Registry holds one Tracker per venue. The built-in venue's geometry comes
// from the data directory; every other venue's nodes are the rows the admin
// page placed, re-read from the database every refresh.
type Registry struct {
	Client   *stdb.Client
	Local    string // venue id of Tracker Built
	Built    *Tracker
	Interval time.Duration // push interval for trackers made here

	mu       sync.Mutex
	trackers map[string]*Tracker
	nodes    map[string]map[int]bool // venue -> node ids placed in it
	loaded   map[string]time.Time
	ctx      context.Context
}

const nodesRefresh = 20 * time.Second

// Run keeps the venue node sets fresh until ctx ends. Call before Observe.
func (r *Registry) Run(ctx context.Context) {
	r.mu.Lock()
	r.ctx = ctx
	r.mu.Unlock()
	t := time.NewTicker(nodesRefresh)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.mu.Lock()
			ids := make([]string, 0, len(r.trackers))
			for id := range r.trackers {
				ids = append(ids, id)
			}
			r.mu.Unlock()
			for _, id := range ids {
				r.Refresh(ctx, id)
			}
		}
	}
}

// Auth answers which venue a relay key belongs to.
func (r *Registry) Auth(ctx context.Context, key string) (string, bool) {
	key = strings.TrimSpace(key)
	if key == "" {
		return "", false
	}
	sum := sha256.Sum256([]byte(key))
	rows, err := r.Client.Sql(ctx, "SELECT * FROM venue WHERE ingest_key_hash = '"+hex.EncodeToString(sum[:])+"'")
	if err != nil {
		log.Printf("relay auth: %v", err)
		return "", false
	}
	if len(rows) != 1 {
		return "", false
	}
	return rows[0].Str("venue_id"), true
}

// Allow says whether nodeID is placed in venueID, re-reading the venue once
// per refresh interval when the id is unknown.
func (r *Registry) Allow(ctx context.Context, venueID string, nodeID int) bool {
	r.mu.Lock()
	ids, ok := r.nodes[venueID]
	stale := time.Since(r.loaded[venueID]) > nodesRefresh
	r.mu.Unlock()
	if ok && ids[nodeID] {
		return true
	}
	if !ok || stale {
		r.Refresh(ctx, venueID)
		r.mu.Lock()
		ids = r.nodes[venueID]
		r.mu.Unlock()
	}
	return ids[nodeID]
}

// Observe routes a node's sightings to its venue's tracker.
func (r *Registry) Observe(venueID string, nodeID int, sights []node.Sight) {
	if t := r.tracker(venueID); t != nil {
		t.Observe(nodeID, sights)
	}
}

func (r *Registry) tracker(venueID string) *Tracker {
	if venueID == r.Local || venueID == "" {
		return r.Built
	}
	r.mu.Lock()
	t, ok := r.trackers[venueID]
	ctx := r.ctx
	r.mu.Unlock()
	if ok {
		return t
	}
	if ctx == nil {
		return nil
	}
	t = &Tracker{Venue: &venue.Venue{}, VenueID: venueID, Dwell: &dwell.Tracker{}}
	r.mu.Lock()
	if r.trackers == nil {
		r.trackers = map[string]*Tracker{}
	}
	if cur, ok := r.trackers[venueID]; ok {
		r.mu.Unlock()
		return cur
	}
	r.trackers[venueID] = t
	r.mu.Unlock()
	r.Refresh(ctx, venueID)
	go t.Run(ctx, r.Client, r.Interval)
	log.Printf("anon: tracking venue %s", venueID)
	return t
}

// Refresh re-reads which nodes are placed in venueID and where.
func (r *Registry) Refresh(ctx context.Context, venueID string) {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	links, err := r.Client.Sql(cctx, "SELECT * FROM venue_node WHERE venue_id = '"+strings.ReplaceAll(venueID, "'", "")+"'")
	if err != nil {
		log.Printf("venue %s nodes: %v", venueID, err)
		return
	}
	ids := map[int]bool{}
	for _, l := range links {
		ids[int(l.Num("node_id"))] = true
	}
	var nodes []venue.Node
	if len(ids) > 0 {
		rows, err := r.Client.Sql(cctx, "SELECT * FROM node")
		if err != nil {
			log.Printf("venue %s nodes: %v", venueID, err)
			return
		}
		for _, row := range rows {
			id := int(row.Num("node_id"))
			if ids[id] {
				nodes = append(nodes, venue.Node{NodeID: id, ZoneID: row.Str("zone_id"), Floor: int(row.Num("floor")), Label: row.Str("label"), X: row.Num("x"), Y: row.Num("y")})
			}
		}
	}
	r.mu.Lock()
	if r.nodes == nil {
		r.nodes = map[string]map[int]bool{}
		r.loaded = map[string]time.Time{}
	}
	r.nodes[venueID] = ids
	r.loaded[venueID] = time.Now()
	t := r.trackers[venueID]
	r.mu.Unlock()
	if t != nil {
		t.SetVenue(&venue.Venue{Nodes: venue.Nodes{Nodes: nodes}})
	}
}
