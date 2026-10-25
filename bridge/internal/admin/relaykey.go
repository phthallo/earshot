package admin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// relayPort is where the bridge listens for relays; the command shown in the
// admin page points at it on the public host.
const relayPort = "9000"

// newRelayKey returns a fresh key and the hash stored for it. The key is
// 26 lowercase base32 characters, easy to type from a phone screenshot.
func newRelayKey() (key, hash string) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	key = "es_" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:]))
	sum := sha256.Sum256([]byte(key))
	return key, hex.EncodeToString(sum[:])
}

// POST /api/admin/venues/{venueId}/key  replaces the venue's relay key and
// returns it once, with the command to run at the venue.
func (s *Server) rotateKey(w http.ResponseWriter, r *http.Request, sess Session) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	id := r.PathValue("venueId")
	if !s.mayWrite(ctx, w, id, sess.Login) {
		return
	}
	key, hash := newRelayKey()
	if err := s.Client.Call(ctx, "set_venue_key", id, hash); err != nil {
		log.Printf("set_venue_key: %v", err)
		writeJSON(w, 502, map[string]string{"error": friendly(err)})
		return
	}
	host := s.relayHost(r)
	writeJSON(w, 200, map[string]string{
		"key":     key,
		"command": "cd bridge && go run ./cmd/bridge --relay --serial /dev/ttyACM0 --connect " + host + ":" + relayPort + " --key " + key,
	})
}

// relayHost is the public host of this bridge without a port.
func (s *Server) relayHost(r *http.Request) string {
	if s.PublicURL != "" {
		if u, err := url.Parse(s.PublicURL); err == nil && u.Hostname() != "" {
			return u.Hostname()
		}
	}
	host := r.Host
	if h, _, err := splitHostPort(host); err == nil {
		return h
	}
	return host
}

func splitHostPort(hostport string) (string, string, error) {
	i := strings.LastIndex(hostport, ":")
	if i < 0 || strings.Contains(hostport[i:], "]") {
		return hostport, "", errNoPort
	}
	return strings.Trim(hostport[:i], "[]"), hostport[i+1:], nil
}

var errNoPort = &noPortError{}

type noPortError struct{}

func (*noPortError) Error() string { return "no port" }
