// Package mock replays a plausible hackathon crowd through the venue so the
// whole stack runs with no hardware. Walkers wander the floorplan towards
// zones weighted by the time of day, taking the stairs between floors; each
// node hears walkers by a log-distance RSSI model, counts them, and reports a
// motion score from how many are nearby.
package mock

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"venuemap/bridge/internal/ingest"
	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/stdb"
	"venuemap/bridge/internal/venue"
)

const (
	walkerCount  = 40
	speedMPS     = 1.1
	hearFloorDbm = -85
	tickSeconds  = 1.0
)

type rhythm struct {
	Default map[string]float64            `json:"default"`
	Hours   map[string]map[string]float64 `json:"hours"`
}

type attendee struct {
	DisplayName string `json:"displayName"`
	Team        string `json:"team"`
	Color       string `json:"color"`
	Home        string `json:"home"`
}

type walker struct {
	x, y       float64 // floorplan pixels, same space as nodes and zones
	floor      int
	tx, ty     float64 // where the walker is heading
	nextFloor  int     // set while heading to a staircase; 0 otherwise
	nx, ny     float64 // target on nextFloor once the stairs are climbed
	dwellUntil time.Time
	macHash    string
	home       string // zone id for bound walkers, "" for anonymous
	personName string
}

type stair struct {
	Bottom venue.Point `json:"bottom"` // floor 1 end
	Top    venue.Point `json:"top"`    // floor 2 end
}

type Mock struct {
	stairs   []stair
	v        *venue.Venue
	client   *stdb.Client
	batch    *ingest.Batcher
	salt     string
	rng      *rand.Rand
	rhythm   rhythm
	walkers  []*walker
	people   bool
	csi      csiTemplates
	tokenDir string
	// Pairing demo: a phone that appears at a node once a session opens.
	phantom map[int64]*walker
	// attendees are the sample people's own clients, so their visibility
	// can follow the switch.
	attendees []*stdb.Client
	disabled  atomic.Bool
}

// Enabled reports whether the crowd is being replayed right now.
func (m *Mock) Enabled() bool { return !m.disabled.Load() }

// SetEnabled pauses or resumes the crowd for every viewer. Turning it off
// also removes what it already wrote and hides the sample attendees, so the
// map and Ask show only real nodes straight away.
func (m *Mock) SetEnabled(ctx context.Context, on bool) error {
	if on == m.Enabled() {
		return nil
	}
	m.disabled.Store(!on)
	for _, pc := range m.attendees {
		if err := pc.Call(ctx, "set_visible", on); err != nil {
			return fmt.Errorf("set_visible: %w", err)
		}
	}
	if on {
		return nil
	}
	return m.client.Call(ctx, "clear_mock")
}

// New builds the crowd. With people set, the attendees in mock_attendees.json
// are registered and bound to walkers so the map has named blips; without it
// every walker is anonymous and only real people appear by name.
func New(v *venue.Venue, c *stdb.Client, b *ingest.Batcher, salt, tokenDir string, people bool) (*Mock, error) {
	m := &Mock{v: v, client: c, batch: b, salt: salt, rng: rand.New(rand.NewSource(13)), tokenDir: tokenDir, phantom: map[int64]*walker{}, people: people}
	if err := readJSON(filepath.Join(v.Dir, "rhythm.json"), &m.rhythm); err != nil {
		return nil, err
	}
	if err := readJSON(filepath.Join(v.Dir, "wifall_mock.json"), &m.csi); err != nil {
		return nil, err
	}
	var lm struct {
		Stairs []stair `json:"stairs"`
	}
	if err := readJSON(filepath.Join(v.Dir, "landmarks.json"), &lm); err != nil {
		return nil, err
	}
	m.stairs = lm.Stairs
	return m, nil
}

func readJSON(path string, out any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

// Setup creates the mock attendees as real registered people with bound
// phones, so the demo has named blips from the first second.
func (m *Mock) Setup(ctx context.Context) error {
	var att []attendee
	if m.people {
		if err := readJSON(filepath.Join(m.v.Dir, "mock_attendees.json"), &att); err != nil {
			return err
		}
	}
	tokens := map[string]string{}
	tokPath := filepath.Join(m.tokenDir, "venuemap_mock_tokens.json")
	_ = readJSON(tokPath, &tokens)
	for _, a := range att {
		tok, ok := tokens[a.DisplayName]
		if !ok {
			_, t, err := stdb.Mint(ctx, m.client.URI)
			if err != nil {
				return err
			}
			tok = t
			tokens[a.DisplayName] = tok
		}
		pc := stdb.New(m.client.URI, m.client.DB, tok)
		if err := pc.Call(ctx, "upsert_person", a.DisplayName, a.Team, a.Color); err != nil {
			return fmt.Errorf("upsert_person %s: %w", a.DisplayName, err)
		}
		m.attendees = append(m.attendees, pc)
	}
	if b, err := json.Marshal(tokens); err == nil {
		_ = os.WriteFile(tokPath, b, 0o600)
	}
	rows, err := m.client.Sql(ctx, "SELECT person_id, display_name FROM person")
	if err != nil {
		return err
	}
	ids := map[string]int{}
	for _, r := range rows {
		ids[r.Str("display_name")] = int(r.Num("person_id"))
	}
	for i, a := range att {
		mac := fmt.Sprintf("02:00:00:00:00:%02x", i+1)
		h := node.HashMAC(m.salt, mac)
		if id, ok := ids[a.DisplayName]; ok {
			if err := m.client.Call(ctx, "bind_mac_for", id, h); err != nil {
				return fmt.Errorf("bind_mac_for %s: %w", a.DisplayName, err)
			}
		}
		w := m.newWalker(1)
		w.macHash = h
		w.home = a.Home
		w.personName = a.DisplayName
		if z := m.zoneByID(a.Home); z != nil {
			w.x, w.y = m.samplePoint(z)
			w.tx, w.ty = w.x, w.y
			w.floor = z.Floor
		}
		m.walkers = append(m.walkers, w)
	}
	for len(m.walkers) < walkerCount {
		floor := 1
		if m.rng.Float64() < 0.2 {
			floor = 2
		}
		w := m.newWalker(floor)
		w.macHash = node.HashMAC(m.salt, fmt.Sprintf("06:%02x:%02x:%02x:%02x:%02x", m.rng.Intn(256), m.rng.Intn(256), m.rng.Intn(256), m.rng.Intn(256), m.rng.Intn(256)))
		m.walkers = append(m.walkers, w)
	}
	return nil
}

// newWalker drops a walker inside a random zone on the floor.
func (m *Mock) newWalker(floor int) *walker {
	var cands []*venue.Zone
	for i := range m.v.Zones {
		if m.v.Zones[i].Floor == floor {
			cands = append(cands, &m.v.Zones[i])
		}
	}
	w := &walker{floor: floor}
	if len(cands) > 0 {
		w.x, w.y = m.samplePoint(cands[m.rng.Intn(len(cands))])
	}
	w.tx, w.ty = w.x, w.y
	return w
}

// samplePoint picks a uniform random point inside the zone polygon by
// rejection sampling over its bounding box, falling back to the centroid.
func (m *Mock) samplePoint(z *venue.Zone) (float64, float64) {
	minX, minY, maxX, maxY := z.Bounds()
	for i := 0; i < 64; i++ {
		p := venue.Point{minX + m.rng.Float64()*(maxX-minX), minY + m.rng.Float64()*(maxY-minY)}
		if z.Contains(p) {
			return p[0], p[1]
		}
	}
	c := z.Centroid()
	return c[0], c[1]
}

func (m *Mock) zoneByID(id string) *venue.Zone {
	for i := range m.v.Zones {
		if m.v.Zones[i].ZoneID == id {
			return &m.v.Zones[i]
		}
	}
	return nil
}

func (m *Mock) weights(now time.Time) map[string]float64 {
	w := map[string]float64{}
	for k, v := range m.rhythm.Default {
		w[k] = v
	}
	if h, ok := m.rhythm.Hours[fmt.Sprint(now.Hour())]; ok {
		for k, v := range h {
			w[k] = v
		}
	}
	return w
}

func (m *Mock) pickTarget(w *walker, now time.Time) {
	if w.home != "" && m.rng.Float64() < 0.6 {
		if z := m.zoneByID(w.home); z != nil {
			m.headTo(w, z)
			return
		}
	}
	// Mostly stay on this floor; now and then take the stairs.
	floor := w.floor
	if len(m.stairs) > 0 && m.rng.Float64() < 0.15 {
		floor = 3 - floor
	}
	weights := m.weights(now)
	total := 0.0
	var cands []*venue.Zone
	for i := range m.v.Zones {
		z := &m.v.Zones[i]
		if z.Floor != floor {
			continue
		}
		cands = append(cands, z)
		total += weights[z.ZoneID]
	}
	r := m.rng.Float64() * total
	for _, z := range cands {
		r -= weights[z.ZoneID]
		if r <= 0 {
			m.headTo(w, z)
			return
		}
	}
}

// headTo aims the walker at a point in the zone, via the nearest staircase
// when the zone is on the other floor.
func (m *Mock) headTo(w *walker, z *venue.Zone) {
	x, y := m.samplePoint(z)
	if z.Floor == w.floor || len(m.stairs) == 0 {
		w.tx, w.ty = x, y
		w.nextFloor = 0
		return
	}
	e := m.stairEnd(m.nearestStair(w), w.floor)
	w.tx, w.ty = e[0], e[1]
	w.nextFloor = z.Floor
	w.nx, w.ny = x, y
}

func (m *Mock) stairEnd(s stair, floor int) venue.Point {
	if floor == 2 {
		return s.Top
	}
	return s.Bottom
}

// nearestStair returns the staircase whose end on the walker's floor is
// closest to the walker.
func (m *Mock) nearestStair(w *walker) stair {
	best, bestD := m.stairs[0], math.Inf(1)
	for _, s := range m.stairs {
		e := m.stairEnd(s, w.floor)
		if d := math.Hypot(e[0]-w.x, e[1]-w.y); d < bestD {
			best, bestD = s, d
		}
	}
	return best
}

func (m *Mock) step(now time.Time) {
	stepUnits := speedMPS / m.v.MetersPerUnit * tickSeconds
	for _, w := range m.walkers {
		if now.Before(w.dwellUntil) {
			continue
		}
		dx, dy := w.tx-w.x, w.ty-w.y
		d := math.Hypot(dx, dy)
		if d <= stepUnits {
			w.x, w.y = w.tx, w.ty
			switch {
			case w.nextFloor != 0 && w.floor != w.nextFloor:
				// At the foot (or head) of the stairs: change floor and walk
				// the flight to its other end.
				s := m.nearestStair(w)
				w.floor = w.nextFloor
				e := m.stairEnd(s, w.floor)
				w.tx, w.ty = e[0], e[1]
			case w.nextFloor != 0:
				w.tx, w.ty = w.nx, w.ny
				w.nextFloor = 0
			default:
				w.dwellUntil = now.Add(time.Duration(20+m.rng.Intn(160)) * time.Second)
				m.pickTarget(w, now)
			}
			continue
		}
		// Straight line plus a little sideways wander so paths are not rails.
		w.x += dx/d*stepUnits + (m.rng.Float64()*2-1)*2
		w.y += dy/d*stepUnits + (m.rng.Float64()*2-1)*2
	}
}

// distance in metres from a walker to a node.
func (m *Mock) dist(w *walker, n *venue.Node) float64 {
	d := math.Hypot(w.x-n.X, w.y-n.Y) * m.v.MetersPerUnit
	if w.floor != n.Floor {
		d = math.Hypot(d, 4) * 1.8 // through a floor
	}
	return d
}

func (m *Mock) rssi(d float64) int {
	// Exponent 30 drops below the hearing floor at about 30 m, so a node
	// hears its own zone and not half the arc.
	return int(math.Round(-40 - 30*math.Log10(math.Max(d, 0.5)) + m.rng.NormFloat64()*3))
}

func (m *Mock) emit(now time.Time) {
	for i := range m.v.Nodes.Nodes {
		n := &m.v.Nodes.Nodes[i]
		if n.NodeID >= 100 {
			continue // reserved for real hardware
		}
		var items []ingest.Sight
		anon, near, veryNear := 0, 0, 0
		for _, w := range m.walkers {
			d := m.dist(w, n)
			r := m.rssi(d)
			if r < hearFloorDbm {
				continue
			}
			anon++
			items = append(items, ingest.Sight{MacHash: w.macHash, RSSI: r})
			if d < 3 && !now.Before(w.dwellUntil) {
				near++
			}
			if d < 2 {
				veryNear++
			}
		}
		for _, p := range m.phantom {
			if p.floor == n.Floor && math.Hypot(p.x-n.X, p.y-n.Y) < 1 {
				items = append(items, ingest.Sight{MacHash: p.macHash, RSSI: -44 + m.rng.Intn(5)})
			}
		}
		score := math.Min(1, 0.22*float64(near)+0.04*math.Abs(m.rng.NormFloat64()))
		state := "idle"
		if score > 0.15 {
			state = "motion"
		}
		m.batch.Motion(ingest.Motion{NodeID: n.NodeID, Score: round2(score), State: state, PIR: veryNear > 0, AnonCount: anon})
		m.batch.Sightings(n.NodeID, items)
	}
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }

// Run advances the crowd once a second and polls for pairing sessions and
// walk captures that need a fake phone or fake CSI frames.
func (m *Mock) Run(ctx context.Context) {
	now := time.Now()
	for _, w := range m.walkers {
		m.pickTarget(w, now)
	}
	t := time.NewTicker(time.Duration(tickSeconds * float64(time.Second)))
	defer t.Stop()
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			if !m.Enabled() {
				continue
			}
			m.step(now)
			m.emit(now)
		case <-poll.C:
			if !m.Enabled() {
				continue
			}
			m.servePairings(ctx)
			m.serveWalks(ctx)
		}
	}
}

// A pairing session opens: five seconds in, a new phone shows up at that
// node, loud. That is what a real phone does when you toggle airplane mode.
func (m *Mock) servePairings(ctx context.Context) {
	rows, err := m.client.Sql(ctx, "SELECT session_id, node_id, started_at FROM pairing_beacon")
	if err != nil {
		return
	}
	open := map[int64]bool{}
	for _, r := range rows {
		id := int64(r.Num("session_id"))
		open[id] = true
		if _, ok := m.phantom[id]; ok {
			continue
		}
		started := timestampMs(r["started_at"])
		if time.Since(time.UnixMilli(started)) < 5*time.Second {
			continue
		}
		var n *venue.Node
		for i := range m.v.Nodes.Nodes {
			if m.v.Nodes.Nodes[i].NodeID == int(r.Num("node_id")) {
				n = &m.v.Nodes.Nodes[i]
			}
		}
		if n == nil {
			continue
		}
		mac := fmt.Sprintf("0a:%02x:%02x:%02x:%02x:%02x", m.rng.Intn(256), m.rng.Intn(256), m.rng.Intn(256), m.rng.Intn(256), m.rng.Intn(256))
		p := &walker{x: n.X, y: n.Y, tx: n.X, ty: n.Y, floor: n.Floor, macHash: node.HashMAC(m.salt, mac)}
		m.phantom[id] = p
		log.Printf("mock: phone appears at node %d for pairing session %d", n.NodeID, id)
	}
	for id, p := range m.phantom {
		if !open[id] {
			// Session closed. The phone keeps walking as a bound attendee.
			m.walkers = append(m.walkers, p)
			delete(m.phantom, id)
		}
	}
}

type csiTemplates struct {
	Subcarriers int `json:"subcarriers"`
	Hz          int `json:"hz"`
	Templates   []struct {
		Label  string      `json:"label"`
		Frames [][]float64 `json:"frames"`
	} `json:"templates"`
}

// A walk capture is open: stream one gait template at it, picked by the
// person so the same person always gets the same gait.
func (m *Mock) serveWalks(ctx context.Context) {
	rows, err := m.client.Sql(ctx, "SELECT node_id, person_id, frame_count FROM walk_beacon")
	if err != nil || len(m.csi.Templates) == 0 {
		return
	}
	for _, r := range rows {
		// frame_count is the flat amplitude count so far, subcarriers x frames.
		frames := int(r.Num("frame_count"))
		if frames >= 30*m.csi.Subcarriers {
			continue
		}
		tpl := m.csi.Templates[int(r.Num("person_id"))%len(m.csi.Templates)]
		idx := frames / m.csi.Subcarriers
		for k := 0; k < 10 && idx+k < len(tpl.Frames); k++ {
			amps := make([]float64, m.csi.Subcarriers)
			for sc, v := range tpl.Frames[idx+k] {
				amps[sc] = v + m.rng.NormFloat64()*0.4
			}
			if err := m.client.Call(ctx, "push_csi", int(r.Num("node_id")), amps); err != nil {
				log.Printf("push_csi: %v", err)
				return
			}
		}
	}
}

// Timestamps come back over SQL as {"__timestamp_micros_since_unix_epoch__": n}.
func timestampMs(v any) int64 {
	if mobj, ok := v.(map[string]any); ok {
		if us, ok := mobj["__timestamp_micros_since_unix_epoch__"].(float64); ok {
			return int64(us / 1000)
		}
	}
	if arr, ok := v.([]any); ok && len(arr) == 1 {
		if us, ok := arr[0].(float64); ok {
			return int64(us / 1000)
		}
	}
	return 0
}
