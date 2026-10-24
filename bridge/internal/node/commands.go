package node

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"sync"
	"time"

	"venuemap/bridge/internal/stdb"
)

// links holds the writable side of each connected node, keyed by node id.
// A node is added when its hello line arrives and removed when the link closes.
type links struct {
	mu sync.Mutex
	w  map[int]io.Writer
}

func (l *links) set(id int, w io.Writer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.w == nil {
		l.w = map[int]io.Writer{}
	}
	l.w[id] = w
}

func (l *links) drop(w io.Writer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, cur := range l.w {
		if cur == w {
			delete(l.w, id)
		}
	}
}

// Send writes one command line to a node. Unknown node ids are ignored,
// since the mock node ids never have a link.
func (h *Handler) Send(id int, c Command) {
	h.links.mu.Lock()
	w := h.links.w[id]
	h.links.mu.Unlock()
	if w == nil {
		return
	}
	b, _ := json.Marshal(c)
	if _, err := w.Write(append(b, '\n')); err != nil {
		log.Printf("node %d send: %v", id, err)
	}
}

// WatchWalks polls walk_beacon and turns CSI streaming on at the node a
// walk capture is open for, and off again when the capture closes.
func (h *Handler) WatchWalks(ctx context.Context, client *stdb.Client) {
	on := map[int]bool{}
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		rows, err := client.Sql(ctx, "SELECT node_id FROM walk_beacon")
		if err != nil {
			continue
		}
		want := map[int]bool{}
		for _, r := range rows {
			want[int(r.Num("node_id"))] = true
		}
		for id := range want {
			if !on[id] {
				h.Send(id, Command{T: "walk", On: 1})
				on[id] = true
			}
		}
		for id := range on {
			if !want[id] {
				h.Send(id, Command{T: "walk", On: 0})
				delete(on, id)
			}
		}
	}
}
