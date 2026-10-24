// Package venue loads the static venue description from data/*.json and seeds
// it into SpacetimeDB.
package venue

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"venuemap/bridge/internal/stdb"
)

type Node struct {
	NodeID int     `json:"nodeId"`
	ZoneID string  `json:"zoneId"`
	Floor  int     `json:"floor"`
	Label  string  `json:"label"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	S      float64 `json:"s"`
}

type Arc struct {
	CX, CY, R, A0, A1, HalfWidth float64
}

type Nodes struct {
	MetersPerUnit float64 `json:"metersPerUnit"`
	Arc           struct {
		CX        float64 `json:"cx"`
		CY        float64 `json:"cy"`
		R         float64 `json:"r"`
		A0        float64 `json:"a0"`
		A1        float64 `json:"a1"`
		HalfWidth float64 `json:"halfWidth"`
	} `json:"arc"`
	Nodes []Node `json:"nodes"`
}

type Zone struct {
	ZoneID   string  `json:"zoneId"`
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	S0       float64 `json:"s0"`
	S1       float64 `json:"s1"`
	Floor    int     `json:"floor"`
	Capacity int     `json:"capacity"`
}

type Venue struct {
	Nodes
	Zones []Zone
	Dir   string
}

func Load(dir string) (*Venue, error) {
	v := &Venue{Dir: dir}
	if err := readJSON(filepath.Join(dir, "nodes.json"), &v.Nodes); err != nil {
		return nil, err
	}
	if err := readJSON(filepath.Join(dir, "zones.json"), &v.Zones); err != nil {
		return nil, err
	}
	return v, nil
}

func readJSON(path string, out any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

type nodeIn struct {
	NodeID int     `json:"node_id"`
	ZoneID string  `json:"zone_id"`
	Label  string  `json:"label"`
	Floor  int     `json:"floor"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	IsReal bool    `json:"is_real"`
}

type zoneIn struct {
	ZoneID   string `json:"zone_id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Floor    int    `json:"floor"`
	Capacity int    `json:"capacity"`
}

// Seed pushes nodes and zones. Node ids at or above 100 are real hardware.
func (v *Venue) Seed(ctx context.Context, c *stdb.Client) error {
	nodes := make([]nodeIn, 0, len(v.Nodes.Nodes))
	for _, n := range v.Nodes.Nodes {
		nodes = append(nodes, nodeIn{n.NodeID, n.ZoneID, n.Label, n.Floor, n.X, n.Y, n.NodeID >= 100})
	}
	zones := make([]zoneIn, 0, len(v.Zones))
	for _, z := range v.Zones {
		zones = append(zones, zoneIn{z.ZoneID, z.Name, z.Kind, z.Floor, z.Capacity})
	}
	if err := c.Call(ctx, "seed_zones", zones); err != nil {
		return err
	}
	return c.Call(ctx, "seed_nodes", nodes)
}

// ZoneAt returns the zone covering arc parameter s on a floor.
func (v *Venue) ZoneAt(s float64, floor int) *Zone {
	for i := range v.Zones {
		z := &v.Zones[i]
		if z.Floor == floor && s >= z.S0 && s < z.S1 {
			return z
		}
	}
	return nil
}
