// Package venue loads the static venue description from data/*.json and seeds
// it into SpacetimeDB.
package venue

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"

	"venuemap/bridge/internal/stdb"
)

// Coordinates are pixels of the floorplan image (data/nodes.json gives its
// size and metres per pixel); the client draws in the same space.
type Node struct {
	NodeID int     `json:"nodeId"`
	ZoneID string  `json:"zoneId"`
	Floor  int     `json:"floor"`
	Label  string  `json:"label"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
}

type Nodes struct {
	MetersPerUnit float64 `json:"metersPerUnit"`
	Width         float64 `json:"width"`
	Height        float64 `json:"height"`
	Nodes         []Node  `json:"nodes"`
}

type Point [2]float64

type Zone struct {
	ZoneID   string  `json:"zoneId"`
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	Floor    int     `json:"floor"`
	Capacity int     `json:"capacity"`
	Label    Point   `json:"label"`
	Poly     []Point `json:"poly"`
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

// MoveNode places a node at the label point of zoneID. The node's sightings
// and counts are attributed to that zone from the next tick on.
func (v *Venue) MoveNode(ctx context.Context, c *stdb.Client, nodeID int, zoneID string) error {
	var n *Node
	for i := range v.Nodes.Nodes {
		if v.Nodes.Nodes[i].NodeID == nodeID {
			n = &v.Nodes.Nodes[i]
		}
	}
	if n == nil {
		return fmt.Errorf("node %d is not in nodes.json", nodeID)
	}
	for _, z := range v.Zones {
		if z.ZoneID != zoneID {
			continue
		}
		n.ZoneID, n.Floor, n.X, n.Y = z.ZoneID, z.Floor, z.Label[0], z.Label[1]
		return c.Call(ctx, "seed_nodes", []nodeIn{{n.NodeID, n.ZoneID, n.Label, n.Floor, n.X, n.Y, n.NodeID >= 100}})
	}
	return fmt.Errorf("zone %q is not in zones.json", zoneID)
}

// Contains reports whether p lies inside the zone polygon (even-odd rule).
func (z *Zone) Contains(p Point) bool {
	in := false
	n := len(z.Poly)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		a, b := z.Poly[i], z.Poly[j]
		if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0] {
			in = !in
		}
	}
	return in
}

// Bounds returns the axis-aligned box around the zone polygon.
func (z *Zone) Bounds() (minX, minY, maxX, maxY float64) {
	minX, minY = math.Inf(1), math.Inf(1)
	maxX, maxY = math.Inf(-1), math.Inf(-1)
	for _, p := range z.Poly {
		minX, maxX = math.Min(minX, p[0]), math.Max(maxX, p[0])
		minY, maxY = math.Min(minY, p[1]), math.Max(maxY, p[1])
	}
	return
}

// Centroid is the mean of the polygon's vertices, close enough for a label
// or a walker target.
func (z *Zone) Centroid() Point {
	var c Point
	for _, p := range z.Poly {
		c[0] += p[0]
		c[1] += p[1]
	}
	n := float64(len(z.Poly))
	return Point{c[0] / n, c[1] / n}
}
