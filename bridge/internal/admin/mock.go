package admin

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// MockCrowd is the simulated crowd when the bridge runs with --mock.
type MockCrowd interface {
	Enabled() bool
	SetEnabled(ctx context.Context, on bool) error
}

// POST /api/admin/mock {enabled}: switches the simulated crowd for everyone.
func (s *Server) setMock(w http.ResponseWriter, r *http.Request, _ Session) {
	if s.Mock == nil {
		writeJSON(w, 404, map[string]string{"error": "This bridge has no simulated crowd. Start it with --mock."})
		return
	}
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.Mock.SetEnabled(ctx, in.Enabled); err != nil {
		log.Printf("mock switch: %v", err)
		writeJSON(w, 502, map[string]string{"error": friendly(err)})
		return
	}
	log.Printf("simulated crowd %s", map[bool]string{true: "on", false: "off"}[in.Enabled])
	writeJSON(w, 200, map[string]bool{"enabled": s.Mock.Enabled()})
}
