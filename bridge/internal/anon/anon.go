// Package anon places the unregistered phones the real nodes hear. The module
// keeps nothing about them beyond a per-zone count, so the bridge works out a
// spot for each one from the nodes' signal strengths and pushes only rounded
// points: no hash, no identifier, replaced every push.
package anon

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"sync"
	"time"

	"venuemap/bridge/internal/dwell"
	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/stdb"
	"venuemap/bridge/internal/venue"
)

const (
	// A phone counts while any node heard it this recently.
	window = 10 * time.Second
	// Dots are snapped to this many floorplan pixels, about 0.7 m.
	grid = 10.0
	// One node gives distance but no direction, so a phone heard by one node
	// sits on a ring around it at a radius from its signal strength. The ring
	// position comes from the hash so a phone stays put between pushes.
	nearDbm, farDbm = -35.0, -85.0
	nearM, farM     = 1.0, 10.0
	// Uploaded floor plans carry no scale; assume a 2000 px wide hall is about 60 m.
	defaultMetersPerUnit = 0.03
)

type Point struct {
	Floor int     `json:"floor"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	RSSI  int     `json:"rssi"`
	// A hash byte, so the client can give the dot a stable colour.
	Hue int `json:"hue"`
	// The phone's hash, so a click on the dot can ask the bridge about it.
	Hash string `json:"hash"`
	// A factory address, not one randomised for this network: the phone can
	// be followed across networks and days. False when no node sent the MAC.
	Stable bool `json:"stable"`
}

type obs struct {
	rssi int
	at   time.Time
}

// Device is what the bridge knows about one unregistered phone from its
// wifi frames alone. Served to the client when a dot is clicked.
type Device struct {
	Hash string `json:"hash"`
	// Raw MAC as the node heard it, "" from nodes that only send the hash.
	MAC string `json:"mac"`
	// Locally administered bit set: the phone made this address up for the
	// venue wifi (Android 10+, iOS 14+), so the vendor cannot be read from it.
	Randomised bool       `json:"randomised"`
	FirstSeen  time.Time  `json:"firstSeen"`
	LastSeen   time.Time  `json:"lastSeen"`
	Nodes      []NodeHear `json:"nodes"`
	// Where the dot has been, oldest first, ending at its current spot.
	Trail []Step `json:"trail"`
}

// Step is one past position of a dot. A step is kept when the dot moves to
// a different grid cell, so a phone sitting still is one step.
type Step struct {
	Floor int       `json:"floor"`
	X     float64   `json:"x"`
	Y     float64   `json:"y"`
	At    time.Time `json:"at"`
}

const (
	trailKeep = 30 * time.Minute
	trailMax  = 120
)

// NodeHear is the latest sighting of a device by one node.
type NodeHear struct {
	NodeID int    `json:"nodeId"`
	Label  string `json:"label"`
	ZoneID string `json:"zoneId"`
	RSSI   int    `json:"rssi"`
	// Seconds since that node last heard the phone.
	Ago float64 `json:"ago"`
}

type Tracker struct {
	// Venue geometry: node positions and zone polygons. Replace with SetVenue.
	Venue *venue.Venue
	// VenueID names the venue in the pushed rows; "" is the built-in one.
	VenueID string
	// Optional. Told which zone each hash was placed in, for dwell statistics.
	Dwell *dwell.Tracker

	mu    sync.Mutex
	seen  map[string]map[int]obs // hash -> node id -> latest observation
	macs  map[string]string      // hash -> raw MAC, when a node sent one
	first map[string]time.Time   // hash -> first sighting since the bridge started
	trail map[string][]Step      // hash -> past positions, oldest first
}

// Observe records one node's sightings. Only real nodes call it.
func (t *Tracker) Observe(nodeID int, sights []node.Sight) {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.seen == nil {
		t.seen = map[string]map[int]obs{}
		t.macs = map[string]string{}
		t.first = map[string]time.Time{}
		t.trail = map[string][]Step{}
	}
	for _, s := range sights {
		byNode := t.seen[s.MacHash]
		if byNode == nil {
			byNode = map[int]obs{}
			t.seen[s.MacHash] = byNode
			if _, ok := t.first[s.MacHash]; !ok {
				t.first[s.MacHash] = now
			}
		}
		byNode[nodeID] = obs{rssi: s.RSSI, at: now}
		if s.MAC != "" {
			t.macs[s.MacHash] = s.MAC
		}
	}
}

// Device describes one phone by hash: its current sightings, loudest first,
// or only its trail once it has gone quiet. Nil when the trail has expired too.
func (t *Tracker) Device(hash string, now time.Time) *Device {
	nodes := map[int]venue.Node{}
	for _, n := range t.Venue.Nodes.Nodes {
		nodes[n.NodeID] = n
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	byNode := t.seen[hash]
	d := &Device{Hash: hash, MAC: t.macs[hash], FirstSeen: t.first[hash], Randomised: randomised(t.macs[hash]), Nodes: []NodeHear{}, Trail: append([]Step{}, t.trail[hash]...)}
	for id, o := range byNode {
		if now.Sub(o.at) > window {
			continue
		}
		h := NodeHear{NodeID: id, RSSI: o.rssi, Ago: now.Sub(o.at).Seconds()}
		if n, ok := nodes[id]; ok {
			h.Label, h.ZoneID = n.Label, n.ZoneID
		}
		d.Nodes = append(d.Nodes, h)
		if o.at.After(d.LastSeen) {
			d.LastSeen = o.at
		}
	}
	if len(d.Nodes) == 0 {
		// Gone quiet, but its trail is still kept: answer from that.
		if n := len(d.Trail); n > 0 && now.Sub(d.Trail[n-1].At) <= trailKeep {
			d.LastSeen = d.Trail[n-1].At
			return d
		}
		return nil
	}
	sort.Slice(d.Nodes, func(i, j int) bool { return d.Nodes[i].RSSI > d.Nodes[j].RSSI })
	return d
}

// randomised reports the locally administered bit of a MAC's first octet.
func randomised(mac string) bool {
	if len(mac) < 2 {
		return false
	}
	var b byte
	for _, c := range mac[:2] {
		b <<= 4
		switch {
		case c >= '0' && c <= '9':
			b |= byte(c - '0')
		case c >= 'a' && c <= 'f':
			b |= byte(c-'a') + 10
		case c >= 'A' && c <= 'F':
			b |= byte(c-'A') + 10
		}
	}
	return b&0x02 != 0
}

// Stats says how many phones each node heard in the window and how many
// of them it heard loudest, so a silent or badly placed node shows up in the log.
func (t *Tracker) Stats(now time.Time) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	heard := map[int]int{}
	loudest := map[int]int{}
	total := 0
	for _, byNode := range t.seen {
		bestID, bestRSSI := 0, -200
		for id, o := range byNode {
			if now.Sub(o.at) > window {
				continue
			}
			heard[id]++
			if o.rssi > bestRSSI {
				bestID, bestRSSI = id, o.rssi
			}
		}
		if bestID != 0 {
			loudest[bestID]++
			total++
		}
	}
	ids := make([]int, 0, len(heard))
	for id := range heard {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	out := fmt.Sprintf("%d phones", total)
	for _, id := range ids {
		out += fmt.Sprintf(", node %d heard %d (loudest for %d)", id, heard[id], loudest[id])
	}
	return out
}

// SetVenue swaps the geometry, for venues whose nodes come from the database.
func (t *Tracker) SetVenue(v *venue.Venue) {
	t.mu.Lock()
	t.Venue = v
	t.mu.Unlock()
}

// Points places every phone heard inside the window and forgets older ones.
func (t *Tracker) Points(now time.Time) []Point {
	t.mu.Lock()
	defer t.mu.Unlock()
	nodes := map[int]venue.Node{}
	for _, n := range t.Venue.Nodes.Nodes {
		nodes[n.NodeID] = n
	}
	// Trails of phones that went quiet earlier expire on their own clock.
	for hash := range t.trail {
		if _, heard := t.seen[hash]; !heard {
			t.pruneQuiet(hash, now)
		}
	}
	var out []Point
	for hash, byNode := range t.seen {
		type heard struct {
			n    venue.Node
			rssi int
		}
		var hs []heard
		for id, o := range byNode {
			if now.Sub(o.at) > window {
				delete(byNode, id)
				continue
			}
			if n, ok := nodes[id]; ok {
				hs = append(hs, heard{n, o.rssi})
			}
		}
		if len(hs) == 0 {
			// The dot leaves the map, but its trail stays for trailKeep so a
			// tap on where it was still shows where it went.
			delete(t.seen, hash)
			t.pruneQuiet(hash, now)
			continue
		}
		sort.Slice(hs, func(i, j int) bool { return hs[i].rssi > hs[j].rssi })
		best := hs[0]
		// Centroid of the nodes on the strongest node's floor, weighted by
		// signal amplitude so 20 dB louder pulls the dot ten times harder.
		// A linear weight barely moves it off the midpoint.
		var sx, sy, sw float64
		for _, h := range hs {
			if h.n.Floor != best.n.Floor {
				continue
			}
			w := math.Pow(10, float64(h.rssi+100)/20)
			sx += h.n.X * w
			sy += h.n.Y * w
			sw += w
		}
		x, y := sx/sw, sy/sw
		// Spread: a full ring for one node, a small one when two or more nodes
		// already pulled the centroid between them.
		mpu := t.Venue.Nodes.MetersPerUnit
		if mpu <= 0 {
			mpu = defaultMetersPerUnit
		}
		radius := ringMetres(best.rssi) / mpu
		if len(hs) > 1 {
			radius /= 4
		}
		angle := float64(hashByte(hash, 0)) / 256 * 2 * math.Pi
		x += radius * math.Cos(angle)
		y += radius * math.Sin(angle)
		// The mezzanine is a balcony: a spot off every upstairs zone is over
		// the ground floor, and the boards can't tell floors apart, so the
		// phone is more likely down there than in mid-air.
		floor := best.n.Floor
		zone := t.zoneAt(floor, x, y)
		if floor > 1 && zone == "" {
			floor = 1
			zone = t.zoneAt(floor, x, y)
		}
		if t.Dwell != nil {
			t.Dwell.Note(hash, zone, now)
		}
		gx, gy := math.Round(x/grid)*grid, math.Round(y/grid)*grid
		t.step(hash, Step{Floor: floor, X: gx, Y: gy, At: now})
		out = append(out, Point{
			Floor:  floor,
			X:      gx,
			Y:      gy,
			RSSI:   best.rssi,
			Hue:    int(hashByte(hash, 1)),
			Hash:   hash,
			Stable: t.macs[hash] != "" && !randomised(t.macs[hash]),
		})
	}
	return out
}

// pruneQuiet forgets a phone no node hears once its last step is older than
// trailKeep. Caller holds t.mu.
func (t *Tracker) pruneQuiet(hash string, now time.Time) {
	tr := t.trail[hash]
	if len(tr) > 0 && now.Sub(tr[len(tr)-1].At) <= trailKeep {
		return
	}
	delete(t.macs, hash)
	delete(t.first, hash)
	delete(t.trail, hash)
}

// step records a position, skipping it when the dot has not left its cell,
// and drops steps older than trailKeep. Caller holds t.mu.
func (t *Tracker) step(hash string, s Step) {
	tr := t.trail[hash]
	if n := len(tr); n > 0 && tr[n-1].Floor == s.Floor && tr[n-1].X == s.X && tr[n-1].Y == s.Y {
		return
	}
	tr = append(tr, s)
	cut := 0
	for cut < len(tr)-1 && s.At.Sub(tr[cut].At) > trailKeep {
		cut++
	}
	if len(tr)-cut > trailMax {
		cut = len(tr) - trailMax
	}
	t.trail[hash] = tr[cut:]
}

func (t *Tracker) zoneAt(floor int, x, y float64) string {
	for i := range t.Venue.Zones {
		z := &t.Venue.Zones[i]
		if z.Floor == floor && z.Contains(venue.Point{x, y}) {
			return z.ZoneID
		}
	}
	return ""
}

func ringMetres(rssi int) float64 {
	f := (nearDbm - float64(rssi)) / (nearDbm - farDbm)
	f = math.Max(0, math.Min(1, f))
	return nearM + f*(farM-nearM)
}

// hashByte returns the i-th byte of a hex hash, or 0 when it is too short.
func hashByte(hash string, i int) byte {
	if len(hash) < 2*i+2 {
		return 0
	}
	var b byte
	for _, c := range hash[2*i : 2*i+2] {
		b <<= 4
		switch {
		case c >= '0' && c <= '9':
			b |= byte(c - '0')
		case c >= 'a' && c <= 'f':
			b |= byte(c-'a') + 10
		}
	}
	return b
}

// Run pushes the current points every interval until ctx ends.
func (t *Tracker) Run(ctx context.Context, client *stdb.Client, interval time.Duration) {
	tick := time.NewTicker(interval)
	defer tick.Stop()
	lastEmpty := false
	lastStats := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			pts := t.Points(now)
			if now.Sub(lastStats) >= 30*time.Second {
				lastStats = now
				log.Printf("anon %s: %s", t.VenueID, t.Stats(now))
			}
			if len(pts) == 0 && lastEmpty {
				continue // nothing to clear
			}
			lastEmpty = len(pts) == 0
			if pts == nil {
				pts = []Point{}
			}
			cctx, cancel := context.WithTimeout(ctx, 40*time.Second)
			err := client.Call(cctx, "push_anon_points", t.VenueID, pts)
			cancel()
			if err != nil {
				log.Printf("push_anon_points: %v", err)
			}
		}
	}
}
