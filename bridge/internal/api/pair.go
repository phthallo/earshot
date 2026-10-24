package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Pair codes let the Android app act for a person without a SpacetimeDB
// login. A code is HMAC(MAC_SALT, person id) mapped onto a 31-letter
// alphabet, so nothing is stored and anyone holding the salt can check one.
// The web client fetches its own code with its SpacetimeDB token; the
// bridge asks the database to verify that token before answering.

// No 0/O/1/I so the code survives being read off a screen.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

var pairCodeRe = regexp.MustCompile(`^[A-Z2-9]{6}$`)
var identityRe = regexp.MustCompile(`^(0x)?[0-9a-f]{64}$`)

func PairCode(salt string, personID int) string {
	mac := hmac.New(sha256.New, []byte(salt))
	fmt.Fprintf(mac, "pair:%d", personID)
	sum := mac.Sum(nil)
	var b strings.Builder
	for i := 0; i < 6; i++ {
		b.WriteByte(codeAlphabet[int(sum[i])%len(codeAlphabet)])
	}
	return b.String()
}

type personRow struct {
	PersonID    int    `json:"personId"`
	DisplayName string `json:"displayName"`
	Team        string `json:"team"`
	Color       string `json:"color"`
}

// personByCode scans registered people for the one whose derived code
// matches. Linear in people, fine for a venue.
func (s *Server) personByCode(ctx context.Context, code string) (*personRow, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if !pairCodeRe.MatchString(code) {
		return nil, nil
	}
	rows, err := s.Client.Sql(ctx, "SELECT person_id, display_name, team, color FROM person")
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		id := int(r.Num("person_id"))
		if PairCode(s.Salt, id) == code {
			return &personRow{PersonID: id, DisplayName: r.Str("display_name"), Team: r.Str("team"), Color: r.Str("color")}, nil
		}
	}
	return nil, nil
}

// GET /api/pair-code?identity=0x...  with Authorization: Bearer <stdb token>
// Returns the caller's own code after the database confirms the token
// belongs to that identity.
func (s *Server) pairCode(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	id, ok := s.callerPerson(ctx, w, r)
	if !ok {
		return
	}
	writeJSON(w, 200, map[string]any{"personId": id, "pairCode": PairCode(s.Salt, id)})
}

// callerPerson resolves ?identity= plus the bearer SpacetimeDB token to the
// caller's person id. On failure it has already written the response.
func (s *Server) callerPerson(ctx context.Context, w http.ResponseWriter, r *http.Request) (int, bool) {
	identity := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("identity")))
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !identityRe.MatchString(identity) || token == "" {
		writeJSON(w, 400, map[string]string{"error": "identity and bearer token required"})
		return 0, false
	}
	identity = strings.TrimPrefix(identity, "0x")
	ok, err := s.Client.VerifyIdentity(ctx, identity, token)
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "database unavailable"})
		return 0, false
	}
	if !ok {
		writeJSON(w, 401, map[string]string{"error": "token does not match identity"})
		return 0, false
	}
	rows, err := s.Client.Sql(ctx, "SELECT person_id FROM person WHERE identity = 0x"+identity)
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "database unavailable"})
		return 0, false
	}
	if len(rows) == 0 {
		writeJSON(w, 404, map[string]string{"error": "register first"})
		return 0, false
	}
	return int(rows[0].Num("person_id")), true
}
