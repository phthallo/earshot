// Package ingest batches node readings and pushes them to SpacetimeDB as two
// reducer calls per flush, keeping well under the free tier's call rate.
package ingest

import (
	"context"
	"log"
	"sync"
	"time"

	"venuemap/bridge/internal/stdb"
)

type Motion struct {
	NodeID    int     `json:"node_id"`
	Score     float64 `json:"score"`
	State     string  `json:"state"`
	PIR       bool    `json:"pir"`
	AnonCount int     `json:"anon_count"`
}

type Sight struct {
	MacHash string `json:"mac_hash"`
	RSSI    int    `json:"rssi"`
}

type NodeSights struct {
	NodeID int     `json:"node_id"`
	Items  []Sight `json:"items"`
}

type Batcher struct {
	client   *stdb.Client
	interval time.Duration
	mu       sync.Mutex
	motion   map[int]Motion
	sights   map[int][]Sight
	Calls    int
}

func New(c *stdb.Client, interval time.Duration) *Batcher {
	return &Batcher{client: c, interval: interval, motion: map[int]Motion{}, sights: map[int][]Sight{}}
}

func (b *Batcher) Motion(m Motion) {
	b.mu.Lock()
	b.motion[m.NodeID] = m
	b.mu.Unlock()
}

func (b *Batcher) Sightings(nodeID int, items []Sight) {
	if len(items) == 0 {
		return
	}
	b.mu.Lock()
	b.sights[nodeID] = append(b.sights[nodeID], items...)
	b.mu.Unlock()
}

// Run flushes until ctx ends.
func (b *Batcher) Run(ctx context.Context) {
	t := time.NewTicker(b.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			b.Flush(ctx)
		}
	}
}

func (b *Batcher) Flush(ctx context.Context) {
	b.mu.Lock()
	motion := make([]Motion, 0, len(b.motion))
	for _, m := range b.motion {
		motion = append(motion, m)
	}
	sights := make([]NodeSights, 0, len(b.sights))
	for id, items := range b.sights {
		sights = append(sights, NodeSights{NodeID: id, Items: items})
	}
	b.motion = map[int]Motion{}
	b.sights = map[int][]Sight{}
	b.mu.Unlock()

	if len(motion) > 0 {
		if err := b.client.Call(ctx, "push_motion_batch", motion); err != nil {
			log.Printf("push_motion_batch: %v", err)
		}
		b.Calls++
	}
	if len(sights) > 0 {
		if err := b.client.Call(ctx, "push_sightings_batch", sights); err != nil {
			log.Printf("push_sightings_batch: %v", err)
		}
		b.Calls++
	}
}
