// Package node defines the line protocol spoken by every sensing node
// (laptop sniffer, Pi, ESP32) and the bridge. One JSON object per line.
package node

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

// Message is the union of all node to bridge messages. T selects the kind.
type Message struct {
	T     string    `json:"t"`
	ID    int       `json:"id"`
	Ts    int64     `json:"ts,omitempty"`
	FW    string    `json:"fw,omitempty"`
	Ch    int       `json:"ch,omitempty"`
	Score float64   `json:"score,omitempty"`
	State string    `json:"state,omitempty"`
	PIR   int       `json:"pir,omitempty"`
	Anon  int       `json:"anon,omitempty"`
	Items [][]any   `json:"items,omitempty"` // [macHash, rssi] or [macHash, rssi, mac]
	Amps  []float64 `json:"amps,omitempty"`
	// Relay key, on the "auth" line a relay sends first over TCP.
	Key string `json:"key,omitempty"`
}

// Sight is one decoded item of a sight line.
type Sight struct {
	MacHash string
	RSSI    int
	// The raw MAC, when the node sends it. Kept in bridge memory for the
	// device sheet, never written to the database.
	MAC string
}

// Sights decodes Items. RSSI arrives as a number from Go nodes and as a
// string from older firmware; items without a hash are dropped.
func (m Message) Sights() []Sight {
	out := make([]Sight, 0, len(m.Items))
	for _, it := range m.Items {
		if len(it) < 2 {
			continue
		}
		hash, _ := it[0].(string)
		rssi := 0
		switch v := it[1].(type) {
		case float64:
			rssi = int(v)
		case string:
			rssi, _ = strconv.Atoi(v)
		}
		s := Sight{MacHash: hash, RSSI: rssi}
		if len(it) > 2 {
			s.MAC, _ = it[2].(string)
		}
		if hash != "" {
			out = append(out, s)
		}
	}
	return out
}

// Command is a bridge to node message.
type Command struct {
	T    string   `json:"t"`
	On   int      `json:"on,omitempty"`
	MACs []string `json:"macs,omitempty"`
}

// HashMAC normalises a MAC and returns hex SHA-256(salt || mac). Raw MACs are
// hashed on the node and never leave it.
func HashMAC(salt, mac string) string {
	m := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(mac), "-", ":"))
	sum := sha256.Sum256([]byte(salt + m))
	return hex.EncodeToString(sum[:])
}
