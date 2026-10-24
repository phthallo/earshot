// Package node defines the line protocol spoken by every sensing node
// (laptop sniffer, Pi, ESP32) and the bridge. One JSON object per line.
package node

import (
	"crypto/sha256"
	"encoding/hex"
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
	Items [][2]any  `json:"items,omitempty"` // [macHash, rssi]
	Amps  []float64 `json:"amps,omitempty"`
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
