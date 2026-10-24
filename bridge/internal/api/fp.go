package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"venuemap/bridge/internal/fp"
)

// Fingerprint endpoints used by the Android app. The app signs in with the
// six-character pair code shown on the person's web registration card
// (see pair.go).

// POST /api/fp/login {pairCode} -> person
func (s *Server) fpLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PairCode string `json:"pairCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	p, err := s.personByCode(ctx, in.PairCode)
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "database unavailable"})
		return
	}
	if p == nil {
		writeJSON(w, 404, map[string]string{"error": "No one has that code. Check the six characters on your registration card."})
		return
	}
	writeJSON(w, 200, p)
}

// GET /api/fp/zones -> zones with sample counts, for learn mode
func (s *Server) fpZones(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	// "floor" is a SQL function name, so selecting it by name fails to parse.
	rows, err := s.Client.Sql(ctx, "SELECT * FROM zone")
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "database unavailable"})
		return
	}
	counts := map[string]int{}
	if s.FP != nil {
		counts = s.FP.Counts()
	}
	type z struct {
		ZoneID  string `json:"zoneId"`
		Name    string `json:"name"`
		Floor   int    `json:"floor"`
		Samples int    `json:"samples"`
	}
	out := make([]z, 0, len(rows))
	for _, row := range rows {
		id := row.Str("zone_id")
		out = append(out, z{ZoneID: id, Name: row.Str("name"), Floor: int(row.Num("floor")), Samples: counts[id]})
	}
	writeJSON(w, 200, out)
}

// POST /api/fp/learn {zoneId, scans:[{bssid,rssi}]}
func (s *Server) fpLearn(w http.ResponseWriter, r *http.Request) {
	if s.FP == nil {
		writeJSON(w, 503, map[string]string{"error": "fingerprinting off"})
		return
	}
	var in struct {
		ZoneID string  `json:"zoneId"`
		Scans  []fp.AP `json:"scans"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.ZoneID == "" {
		writeJSON(w, 400, map[string]string{"error": "zoneId and scans required"})
		return
	}
	if err := s.FP.Learn(in.ZoneID, in.Scans); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "samples": s.FP.Counts()[in.ZoneID]})
}

// POST /api/fp/forget {zoneId}
func (s *Server) fpForget(w http.ResponseWriter, r *http.Request) {
	if s.FP == nil {
		writeJSON(w, 503, map[string]string{"error": "fingerprinting off"})
		return
	}
	var in struct {
		ZoneID string `json:"zoneId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.ZoneID == "" {
		writeJSON(w, 400, map[string]string{"error": "zoneId required"})
		return
	}
	if err := s.FP.Forget(in.ZoneID); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// POST /api/fp/locate {pairCode, scans} -> {zoneId, confidence}
// Classifies the scan and moves the person on the map.
func (s *Server) fpLocate(w http.ResponseWriter, r *http.Request) {
	if s.FP == nil {
		writeJSON(w, 503, map[string]string{"error": "fingerprinting off"})
		return
	}
	var in struct {
		PairCode string  `json:"pairCode"`
		Scans    []fp.AP `json:"scans"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	p, err := s.personByCode(ctx, in.PairCode)
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "database unavailable"})
		return
	}
	if p == nil {
		writeJSON(w, 401, map[string]string{"error": "unknown pair code"})
		return
	}
	m, err := s.FP.Locate(in.Scans)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if err := s.Client.Call(ctx, "set_app_position", p.PersonID, m.ZoneID, m.Confidence); err != nil {
		log.Printf("set_app_position: %v", err)
		writeJSON(w, 502, map[string]string{"error": friendly(err)})
		return
	}
	writeJSON(w, 200, m)
}
