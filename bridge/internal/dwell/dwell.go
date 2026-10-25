// Package dwell turns the persistence of a phone's hash into zone statistics.
// Android 10+ and iOS 14+ keep one randomised MAC per wifi network, so a phone
// joined to the venue wifi hashes to the same value all event. The tracker
// remembers each hash with the zone it is in and when it got there, and
// reports aggregates per zone (unique phones, returning phones, typical stay)
// plus one hash's own day for the device sheet. The state is saved to
// data/dwell.json so a restart keeps it; hashes are dropped after a day.
// Phones that only scan use a fresh MAC per burst and show up as one-off
// visits, so their stays are discarded as noise.
package dwell

import (
	"sort"
	"sync"
	"time"
)

const (
	// Not heard for this long: the phone has left its zone (and the venue).
	gone = 15 * time.Minute
	// Shorter stays are a pass-through or a scan-only phone, not a stay.
	minStay = 2 * time.Minute
	// Heard this recently counts as present now.
	present = time.Minute
	// A hash is forgotten after this long without a sighting.
	retain = 24 * time.Hour
)

type device struct {
	first, last time.Time
	zone        string
	enteredAt   time.Time
	visits      int
	closed      bool // the current stay was already counted
	// Zones where the phone stayed at least minStay, so a pass-through does
	// not count as a visitor.
	visited map[string]bool
	// Completed stays of at least minStay, oldest first, for the device sheet.
	stays []Stay
}

// Stay is one completed stay of a phone in a zone.
type Stay struct {
	Zone string    `json:"zone"`
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

type Tracker struct {
	mu      sync.Mutex
	devices map[string]*device
	stays   map[string][]time.Duration // zone -> completed stays in the last day
	since   time.Time
}

type ZoneStats struct {
	ZoneID string `json:"zoneId"`
	// Distinct phones heard in the zone in the last day and right now.
	Unique int `json:"unique"`
	Now    int `json:"now"`
	// Completed stays of at least two minutes, and their median in minutes.
	Stays         int     `json:"stays"`
	MedianStayMin float64 `json:"medianStayMin"`
}

type Report struct {
	Since time.Time `json:"since"`
	// Distinct phones heard anywhere in the last day, how many are here now,
	// and how many left for at least fifteen minutes and came back.
	Unique    int         `json:"unique"`
	Now       int         `json:"now"`
	Returning int         `json:"returning"`
	Zones     []ZoneStats `json:"zones"`
}

// Note records that a phone was placed in a zone. An empty zone means the
// phone was heard but is off every zone polygon; it still counts as present.
func (t *Tracker) Note(hash, zone string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.devices == nil {
		t.devices = map[string]*device{}
		t.stays = map[string][]time.Duration{}
		t.since = now
	}
	d := t.devices[hash]
	if d == nil {
		d = &device{first: now, zone: zone, enteredAt: now, visits: 1, visited: map[string]bool{}}
		t.devices[hash] = d
	} else {
		if now.Sub(d.last) > gone {
			t.closeStay(d, d.last)
			d.visits++
			d.zone, d.enteredAt, d.closed = zone, now, false
		} else if zone != d.zone {
			t.closeStay(d, now)
			d.zone, d.enteredAt, d.closed = zone, now, false
		}
	}
	d.last = now
	if d.zone != "" && now.Sub(d.enteredAt) >= minStay {
		d.visited[d.zone] = true
	}
}

// closeStay counts the current stay once, at the time the phone left.
func (t *Tracker) closeStay(d *device, left time.Time) {
	if d.closed || d.zone == "" {
		return
	}
	d.closed = true
	if stay := left.Sub(d.enteredAt); stay >= minStay {
		t.stays[d.zone] = append(t.stays[d.zone], stay)
		d.visited[d.zone] = true
		d.stays = append(d.stays, Stay{Zone: d.zone, From: d.enteredAt, To: left})
	}
}

// Sweep closes the stays of phones that left and forgets day-old hashes.
// Run it before Report, or on a timer.
func (t *Tracker) Sweep(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for hash, d := range t.devices {
		if now.Sub(d.last) > retain {
			delete(t.devices, hash)
			continue
		}
		if now.Sub(d.last) > gone {
			t.closeStay(d, d.last)
		}
	}
	// Stays carry no timestamp, so the list is cleared whole once a day.
	if !t.since.IsZero() && now.Sub(t.since) > retain {
		t.stays = map[string][]time.Duration{}
		t.since = now
	}
}

// Report aggregates the tracked phones. It never includes a hash.
func (t *Tracker) Report(now time.Time) Report {
	t.Sweep(now)
	t.mu.Lock()
	defer t.mu.Unlock()
	r := Report{Since: t.since}
	byZone := map[string]*ZoneStats{}
	zoneOf := func(id string) *ZoneStats {
		z := byZone[id]
		if z == nil {
			z = &ZoneStats{ZoneID: id}
			byZone[id] = z
		}
		return z
	}
	for _, d := range t.devices {
		r.Unique++
		if d.visits > 1 {
			r.Returning++
		}
		here := now.Sub(d.last) <= present
		if here {
			r.Now++
		}
		for id := range d.visited {
			zoneOf(id).Unique++
		}
		if here && d.zone != "" {
			z := zoneOf(d.zone)
			z.Now++
			if !d.visited[d.zone] {
				z.Unique++
			}
		}
	}
	for id, stays := range t.stays {
		z := zoneOf(id)
		z.Stays = len(stays)
		z.MedianStayMin = median(stays).Minutes()
	}
	for _, z := range byZone {
		r.Zones = append(r.Zones, *z)
	}
	sort.Slice(r.Zones, func(i, j int) bool { return r.Zones[i].ZoneID < r.Zones[j].ZoneID })
	if r.Zones == nil {
		r.Zones = []ZoneStats{}
	}
	return r
}

// Zone returns one zone's stats, zero-valued when nothing was heard there.
func (t *Tracker) Zone(zoneID string, now time.Time) ZoneStats {
	for _, z := range t.Report(now).Zones {
		if z.ZoneID == zoneID {
			return z
		}
	}
	return ZoneStats{ZoneID: zoneID}
}

// DeviceInfo is one phone's day as the tracker remembers it.
type DeviceInfo struct {
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
	// Zone the phone is in now ("" off every zone) and since when.
	Zone        string    `json:"zone"`
	EnteredAt   time.Time `json:"enteredAt"`
	Visits      int       `json:"visits"`
	ZonesStayed []string  `json:"zonesStayed"`
	Stays       []Stay    `json:"stays"`
}

// Device returns what is remembered about one hash, or nil if unknown.
func (t *Tracker) Device(hash string) *DeviceInfo {
	t.mu.Lock()
	defer t.mu.Unlock()
	d := t.devices[hash]
	if d == nil {
		return nil
	}
	info := &DeviceInfo{FirstSeen: d.first, LastSeen: d.last, Zone: d.zone, EnteredAt: d.enteredAt, Visits: d.visits, ZonesStayed: []string{}, Stays: append([]Stay{}, d.stays...)}
	for z := range d.visited {
		info.ZonesStayed = append(info.ZonesStayed, z)
	}
	sort.Strings(info.ZonesStayed)
	return info
}

func median(ds []time.Duration) time.Duration {
	if len(ds) == 0 {
		return 0
	}
	s := make([]time.Duration, len(ds))
	copy(s, ds)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	if n := len(s); n%2 == 1 {
		return s[n/2]
	} else {
		return (s[n/2-1] + s[n/2]) / 2
	}
}
