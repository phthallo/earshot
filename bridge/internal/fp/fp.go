// Package fp is the wifi fingerprint classifier behind the phone app.
// A phone scans the access points around it and sends BSSID/RSSI pairs. In
// learn mode the pair is stored with a zone label. In locate mode the scan
// is matched against stored samples with k nearest neighbours.
//
// Features are RSSI relative to the strongest AP in the same scan, so a
// phone that reads 8 dB low across the board still matches a phone that
// does not. Access points missing from a scan count as the floor.
package fp

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"sort"
	"sync"
	"time"
)

const (
	k         = 3
	floorDbm  = -100.0
	MinScanAP = 2
)

type AP struct {
	BSSID string `json:"bssid"`
	RSSI  int    `json:"rssi"`
}

type Sample struct {
	ZoneID string  `json:"zoneId"`
	APs    []AP    `json:"aps"`
	At     string  `json:"at"`
	rel    map[string]float64
}

type Store struct {
	mu      sync.Mutex
	path    string
	Samples []Sample `json:"samples"`
}

// Load reads samples from path. A missing file is an empty store.
func Load(path string) (*Store, error) {
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, err
	}
	for i := range s.Samples {
		s.Samples[i].rel = relative(s.Samples[i].APs)
	}
	return s, nil
}

func (s *Store) save() error {
	b, err := json.MarshalIndent(s, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o644)
}

// Learn stores one labelled scan.
func (s *Store) Learn(zoneID string, aps []AP) error {
	if len(aps) < MinScanAP {
		return errors.New("scan has too few access points")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Samples = append(s.Samples, Sample{ZoneID: zoneID, APs: aps, At: time.Now().UTC().Format(time.RFC3339), rel: relative(aps)})
	return s.save()
}

// Forget drops every sample for a zone.
func (s *Store) Forget(zoneID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// A fresh slice: Locate may still be reading the old backing array.
	kept := make([]Sample, 0, len(s.Samples))
	for _, x := range s.Samples {
		if x.ZoneID != zoneID {
			kept = append(kept, x)
		}
	}
	s.Samples = kept
	return s.save()
}

// Counts is samples per zone.
func (s *Store) Counts() map[string]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]int{}
	for _, x := range s.Samples {
		out[x.ZoneID]++
	}
	return out
}

type Match struct {
	ZoneID     string  `json:"zoneId"`
	Confidence float64 `json:"confidence"`
	Distance   float64 `json:"distance"`
}

// Locate classifies a scan. Confidence is the share of the k neighbours that
// agree, shrunk when the nearest sample is far away.
func (s *Store) Locate(aps []AP) (Match, error) {
	if len(aps) < MinScanAP {
		return Match{}, errors.New("scan has too few access points")
	}
	s.mu.Lock()
	samples := s.Samples
	s.mu.Unlock()
	if len(samples) == 0 {
		return Match{}, errors.New("no training data yet, walk the venue in learn mode first")
	}
	q := relative(aps)
	type scored struct {
		zone string
		d    float64
	}
	all := make([]scored, 0, len(samples))
	for _, x := range samples {
		all = append(all, scored{x.ZoneID, distance(q, x.rel)})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].d < all[j].d })
	n := k
	if len(all) < n {
		n = len(all)
	}
	votes := map[string]float64{}
	for _, c := range all[:n] {
		votes[c.zone] += 1 / (1 + c.d)
	}
	var best string
	var bestV, total float64
	for z, v := range votes {
		total += v
		if v > bestV {
			bestV, best = v, z
		}
	}
	conf := bestV / total
	// A nearest distance of 10 dB RMS is a weak match; 0 is a perfect one.
	conf *= math.Max(0.2, 1-all[0].d/15)
	return Match{ZoneID: best, Confidence: math.Round(conf*100) / 100, Distance: math.Round(all[0].d*10) / 10}, nil
}

// relative maps each BSSID to its RSSI minus the scan's strongest RSSI.
func relative(aps []AP) map[string]float64 {
	maxR := math.Inf(-1)
	for _, a := range aps {
		if float64(a.RSSI) > maxR {
			maxR = float64(a.RSSI)
		}
	}
	out := make(map[string]float64, len(aps))
	for _, a := range aps {
		if cur, ok := out[a.BSSID]; !ok || float64(a.RSSI)-maxR > cur {
			out[a.BSSID] = float64(a.RSSI) - maxR
		}
	}
	return out
}

// distance is the RMS difference over the union of BSSIDs. An AP heard in
// one scan but not the other counts as the floor relative to that scan's
// strongest AP, about -60 dB relative.
func distance(a, b map[string]float64) float64 {
	const missing = floorDbm + 40
	var sum float64
	var n int
	for k, va := range a {
		vb, ok := b[k]
		if !ok {
			vb = missing
		}
		sum += (va - vb) * (va - vb)
		n++
	}
	for k, vb := range b {
		if _, ok := a[k]; !ok {
			sum += (missing - vb) * (missing - vb)
			n++
		}
	}
	if n == 0 {
		return math.Inf(1)
	}
	return math.Sqrt(sum / float64(n))
}
