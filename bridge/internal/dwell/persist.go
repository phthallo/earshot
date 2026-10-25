package dwell

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// The tracker's state on disk: salted hashes with their day, so a restart
// keeps each phone's travels. Never the MAC, and the file is gitignored and
// owner-only. Hashes older than a day are dropped on the next Sweep.
type snapshot struct {
	Since   time.Time                  `json:"since"`
	Stays   map[string][]time.Duration `json:"stays"`
	Devices map[string]savedDevice     `json:"devices"`
}

type savedDevice struct {
	First     time.Time `json:"first"`
	Last      time.Time `json:"last"`
	Zone      string    `json:"zone"`
	EnteredAt time.Time `json:"enteredAt"`
	Visits    int       `json:"visits"`
	Closed    bool      `json:"closed"`
	Visited   []string  `json:"visited"`
	Stays     []Stay    `json:"stays"`
}

// Load restores a file written by Save. A missing file is not an error.
func (t *Tracker) Load(path string) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var s snapshot
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.since = s.Since
	t.stays = s.Stays
	if t.stays == nil {
		t.stays = map[string][]time.Duration{}
	}
	t.devices = make(map[string]*device, len(s.Devices))
	for hash, d := range s.Devices {
		visited := make(map[string]bool, len(d.Visited))
		for _, z := range d.Visited {
			visited[z] = true
		}
		t.devices[hash] = &device{first: d.First, last: d.Last, zone: d.Zone, enteredAt: d.EnteredAt, visits: d.Visits, closed: d.Closed, visited: visited, stays: d.Stays}
	}
	return nil
}

// Save writes the state atomically. Nothing tracked yet writes nothing.
func (t *Tracker) Save(path string) error {
	t.mu.Lock()
	if t.devices == nil {
		t.mu.Unlock()
		return nil
	}
	s := snapshot{Since: t.since, Stays: t.stays, Devices: make(map[string]savedDevice, len(t.devices))}
	for hash, d := range t.devices {
		visited := make([]string, 0, len(d.visited))
		for z := range d.visited {
			visited = append(visited, z)
		}
		sort.Strings(visited)
		s.Devices[hash] = savedDevice{First: d.first, Last: d.last, Zone: d.zone, EnteredAt: d.enteredAt, Visits: d.visits, Closed: d.closed, Visited: visited, Stays: d.stays}
	}
	b, err := json.Marshal(s)
	t.mu.Unlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Persist saves every interval and once more when ctx ends, then returns.
func (t *Tracker) Persist(ctx context.Context, path string, interval time.Duration, logf func(string, ...any)) {
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			if err := t.Save(path); err != nil {
				logf("dwell: save: %v", err)
			}
		case <-ctx.Done():
			if err := t.Save(path); err != nil {
				logf("dwell: save: %v", err)
			}
			return
		}
	}
}
