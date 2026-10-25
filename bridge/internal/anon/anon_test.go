package anon

import (
	"math"
	"testing"
	"time"

	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/venue"
)

func testVenue() *venue.Venue {
	v := &venue.Venue{}
	v.Nodes.MetersPerUnit = 0.072
	v.Nodes.Nodes = []venue.Node{
		{NodeID: 103, Floor: 1, X: 1000, Y: 500},
		{NodeID: 104, Floor: 1, X: 1400, Y: 500},
	}
	return v
}

func TestOffZoneUpstairsDotsFallToTheGroundFloor(t *testing.T) {
	v := testVenue()
	v.Nodes.Nodes = []venue.Node{{NodeID: 103, Floor: 2, X: 1000, Y: 500}}
	v.Zones = []venue.Zone{{ZoneID: "mezz", Floor: 2, Poly: []venue.Point{{900, 400}, {1100, 400}, {1100, 600}, {900, 600}}}}
	tr := &Tracker{Venue: v}
	// Hash 00 points east: -40 dBm is 1.9 m, inside the zone; -85 dBm is 10 m, off its edge.
	tr.Observe(103, []node.Sight{{MacHash: "00aa", RSSI: -40}, {MacHash: "00bb", RSSI: -85}})
	for _, p := range tr.Points(time.Now()) {
		want := 2
		if p.RSSI == -85 {
			want = 1
		}
		if p.Floor != want {
			t.Errorf("rssi %d dot on floor %d, want %d", p.RSSI, p.Floor, want)
		}
	}
}

func TestTwoNodesPullTowardTheLouderOne(t *testing.T) {
	tr := &Tracker{Venue: testVenue()}
	tr.Observe(103, []node.Sight{{MacHash: "00ab", RSSI: -45}})
	tr.Observe(104, []node.Sight{{MacHash: "00ab", RSSI: -75}})
	pts := tr.Points(time.Now())
	if len(pts) != 1 {
		t.Fatalf("got %d points", len(pts))
	}
	// Amplitude weights 562 and 18: centroid at 1000 + 400*18/580 = 1012, plus a small ring.
	if math.Abs(pts[0].X-1012) > 40 || math.Abs(pts[0].Y-500) > 40 {
		t.Errorf("point at %v,%v, want near 1012,500", pts[0].X, pts[0].Y)
	}
	if pts[0].RSSI != -45 || pts[0].Floor != 1 {
		t.Errorf("rssi %d floor %d", pts[0].RSSI, pts[0].Floor)
	}
}

func TestStableOnlyForFactoryAddresses(t *testing.T) {
	tr := &Tracker{Venue: testVenue()}
	tr.Observe(103, []node.Sight{
		{MacHash: "0001", RSSI: -50, MAC: "a4:83:e7:12:34:56"}, // factory
		{MacHash: "0002", RSSI: -50, MAC: "da:83:e7:12:34:56"}, // locally administered
		{MacHash: "0003", RSSI: -50},                           // old firmware, hash only
	})
	want := map[string]bool{"0001": true, "0002": false, "0003": false}
	for _, p := range tr.Points(time.Now()) {
		if p.Stable != want[p.Hash] {
			t.Errorf("hash %s stable=%v, want %v", p.Hash, p.Stable, want[p.Hash])
		}
	}
}

func TestTrailKeepsOnlyMoves(t *testing.T) {
	tr := &Tracker{Venue: testVenue()}
	now := time.Now()
	tr.Observe(103, []node.Sight{{MacHash: "00ab", RSSI: -45}})
	tr.Points(now)
	tr.Points(now.Add(2 * time.Second)) // same cell, no new step
	tr.Observe(104, []node.Sight{{MacHash: "00ab", RSSI: -40}})
	tr.Points(now.Add(4 * time.Second)) // pulled east, one new step
	d := tr.Device("00ab", now.Add(5*time.Second))
	if len(d.Trail) != 2 {
		t.Fatalf("trail has %d steps, want 2: %v", len(d.Trail), d.Trail)
	}
	if d.Trail[1].X <= d.Trail[0].X {
		t.Errorf("second step %v not east of first %v", d.Trail[1], d.Trail[0])
	}
	// Steps older than the window drop off once a newer one arrives.
	tr.step("00ab", Step{Floor: 1, X: 1, Y: 1, At: now.Add(trailKeep + time.Minute)})
	if got := tr.trail["00ab"]; len(got) != 1 || got[0].X != 1 {
		t.Errorf("old steps kept: %v", got)
	}
}

func TestOneNodeGivesARingAndOldSightingsExpire(t *testing.T) {
	tr := &Tracker{Venue: testVenue()}
	tr.Observe(103, []node.Sight{{MacHash: "80ab", RSSI: -85}, {MacHash: "ffff", RSSI: -40}})
	pts := tr.Points(time.Now())
	if len(pts) != 2 {
		t.Fatalf("got %d points", len(pts))
	}
	for _, p := range pts {
		d := math.Hypot(p.X-1000, p.Y-500) * 0.072
		if p.RSSI == -85 && (d < 8 || d > 12) {
			t.Errorf("weak phone %.1f m from the node, want about 10", d)
		}
		// -40 dBm is 1.9 m on the ring, plus up to half a grid cell of rounding.
		if p.RSSI == -40 && (d < 1 || d > 3) {
			t.Errorf("strong phone %.1f m from the node, want about 1.9", d)
		}
	}
	if got := tr.Points(time.Now().Add(window + time.Second)); len(got) != 0 {
		t.Errorf("stale sightings still placed: %v", got)
	}
}

func TestQuietPhoneKeepsItsTrailForAWhile(t *testing.T) {
	tr := &Tracker{Venue: testVenue()}
	tr.Observe(103, []node.Sight{{MacHash: "80ab", RSSI: -60}})
	now := time.Now()
	first := tr.first["80ab"]
	tr.Points(now)
	quiet := now.Add(window + time.Second)
	if got := tr.Points(quiet); len(got) != 0 {
		t.Fatalf("dot still placed after the window: %v", got)
	}
	d := tr.Device("80ab", quiet)
	if d == nil || len(d.Trail) != 1 || len(d.Nodes) != 0 {
		t.Fatalf("quiet phone should answer from its trail, got %+v", d)
	}
	if !d.LastSeen.Equal(d.Trail[0].At) {
		t.Errorf("last seen %v, want the last step %v", d.LastSeen, d.Trail[0].At)
	}
	// Heard again before the trail expires: still the same first sighting.
	tr.Observe(103, []node.Sight{{MacHash: "80ab", RSSI: -60}})
	if d := tr.Device("80ab", time.Now()); d == nil || !d.FirstSeen.Equal(first) {
		t.Errorf("returning phone lost its first sighting: %+v", d)
	}
	expired := now.Add(trailKeep + time.Minute)
	tr.Points(expired)
	tr.Points(expired)
	if d := tr.Device("80ab", expired); d != nil {
		t.Errorf("trail should be forgotten after trailKeep, got %+v", d)
	}
	if len(tr.trail) != 0 || len(tr.first) != 0 || len(tr.macs) != 0 {
		t.Errorf("quiet phone still remembered: trail %d first %d macs %d", len(tr.trail), len(tr.first), len(tr.macs))
	}
}
