package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"venuemap/bridge/internal/stdb"
	"venuemap/bridge/internal/venue"
)

// Calhacks is the built-in venue: anyone signed in may place nodes there.
const Calhacks = "calhacks"
const CalhacksName = "Cal Hacks 13.0"

const maxUpload = 10 << 20

var slugRe = regexp.MustCompile(`^[a-z0-9-]{2,40}$`)
var macRe = regexp.MustCompile(`^([0-9a-f]{2}:){5}[0-9a-f]{2}$`)

type Server struct {
	Client             *stdb.Client
	Venue              *venue.Venue
	DataDir            string
	Secret             []byte
	GithubClientID     string
	GithubClientSecret string
	ClientURL          string // origin the browser may be sent back to
	PublicURL          string // where browsers reach the bridge; empty uses the request host
	HTTP               *http.Client
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/github", s.authGithub)
	mux.HandleFunc("GET /api/auth/github/callback", s.authCallback)
	mux.HandleFunc("GET /api/auth/me", s.authMe)
	mux.HandleFunc("POST /api/auth/logout", s.authLogout)
	mux.HandleFunc("GET /api/admin/venues", s.withSession(s.listVenues))
	mux.HandleFunc("POST /api/admin/venues", s.withSession(s.createVenue))
	mux.HandleFunc("POST /api/admin/venues/{venueId}/floors", s.withSession(s.uploadFloor))
	mux.HandleFunc("POST /api/admin/nodes/place", s.withSession(s.placeNode))
	mux.HandleFunc("POST /api/admin/boards", s.withSession(s.rememberBoard))
	mux.HandleFunc("DELETE /api/admin/boards/{mac}", s.withSession(s.forgetBoard))
	mux.HandleFunc("GET /api/venues/calhacks/export", s.export)
	mux.Handle("GET /uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(filepath.Join(s.DataDir, "uploads")))))
}

// SeedCalhacks writes the built-in venue and its two floors so the admin page
// lists them like any other venue. Plan units are the 2956x1380 floorplan.
func (s *Server) SeedCalhacks(ctx context.Context) error {
	if err := s.Client.Call(ctx, "upsert_venue", Calhacks, CalhacksName, ""); err != nil {
		return err
	}
	w, h := s.Venue.Width, s.Venue.Height
	if err := s.Client.Call(ctx, "upsert_floor", Calhacks, 1, "Ground floor", "/venue-main.jpg", w, h); err != nil {
		return err
	}
	return s.Client.Call(ctx, "upsert_floor", Calhacks, 2, "Mezzanine", "/venue-mezz.jpg", w, h)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Reducer errors arrive as "POST ...: 400 <message>". Keep the message.
func friendly(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": 4"); i >= 0 && len(msg) > i+6 {
		return strings.TrimSpace(msg[i+6:])
	}
	return msg
}

func sqlString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

type venueRow struct {
	VenueID    string `json:"venueId"`
	Name       string `json:"name"`
	OwnerLogin string `json:"ownerLogin"`
	CreatedAt  string `json:"createdAt"`
}

func toVenue(r stdb.Row) venueRow {
	return venueRow{VenueID: r.Str("venue_id"), Name: r.Str("name"), OwnerLogin: r.Str("owner_login"), CreatedAt: timestampISO(r["created_at"])}
}

// SQL returns a timestamp as [micros]; the client wants ISO 8601.
func timestampISO(v any) string {
	arr, ok := v.([]any)
	if !ok || len(arr) != 1 {
		return ""
	}
	micros, ok := arr[0].(float64)
	if !ok {
		return ""
	}
	return time.UnixMicro(int64(micros)).UTC().Format(time.RFC3339)
}

func (s *Server) venueByID(ctx context.Context, id string) (*venueRow, error) {
	rows, err := s.Client.Sql(ctx, "SELECT * FROM venue WHERE venue_id = "+sqlString(id))
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	v := toVenue(rows[0])
	return &v, nil
}

// mayWrite answers whether login may change venue id: calhacks takes anyone
// signed in, other venues only their owner. On refusal the response is written.
func (s *Server) mayWrite(ctx context.Context, w http.ResponseWriter, id, login string) bool {
	if !slugRe.MatchString(id) {
		writeJSON(w, 400, map[string]string{"error": "venueId must be 2 to 40 lowercase letters, digits or dashes."})
		return false
	}
	if id == Calhacks {
		return true
	}
	v, err := s.venueByID(ctx, id)
	if err != nil {
		log.Printf("venue lookup: %v", err)
		writeJSON(w, 502, map[string]string{"error": "The database did not answer. Try again."})
		return false
	}
	if v == nil {
		writeJSON(w, 404, map[string]string{"error": "No such venue."})
		return false
	}
	if v.OwnerLogin != login {
		writeJSON(w, 403, map[string]string{"error": "Only the venue's owner can change it."})
		return false
	}
	return true
}

// GET /api/admin/venues
func (s *Server) listVenues(w http.ResponseWriter, r *http.Request, sess Session) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	rows, err := s.Client.Sql(ctx, "SELECT * FROM venue WHERE owner_login = "+sqlString(sess.Login)+" OR venue_id = "+sqlString(Calhacks))
	if err != nil {
		log.Printf("venues: %v", err)
		writeJSON(w, 502, map[string]string{"error": "The database did not answer. Try again."})
		return
	}
	out := make([]venueRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, toVenue(r))
	}
	writeJSON(w, 200, out)
}

// POST /api/admin/venues {venueId, name}
func (s *Server) createVenue(w http.ResponseWriter, r *http.Request, sess Session) {
	var in struct {
		VenueID string `json:"venueId"`
		Name    string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if !slugRe.MatchString(in.VenueID) {
		writeJSON(w, 400, map[string]string{"error": "venueId must be 2 to 40 lowercase letters, digits or dashes."})
		return
	}
	if in.Name == "" || len(in.Name) > 80 {
		writeJSON(w, 400, map[string]string{"error": "Give the venue a name, up to 80 characters."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	existing, err := s.venueByID(ctx, in.VenueID)
	if err != nil {
		log.Printf("venue lookup: %v", err)
		writeJSON(w, 502, map[string]string{"error": "The database did not answer. Try again."})
		return
	}
	if existing != nil && existing.OwnerLogin != sess.Login {
		writeJSON(w, 409, map[string]string{"error": "That venue id is taken."})
		return
	}
	if err := s.Client.Call(ctx, "upsert_venue", in.VenueID, in.Name, sess.Login); err != nil {
		log.Printf("upsert_venue: %v", err)
		writeJSON(w, 502, map[string]string{"error": friendly(err)})
		return
	}
	created, err := s.venueByID(ctx, in.VenueID)
	if err != nil || created == nil {
		created = &venueRow{VenueID: in.VenueID, Name: in.Name, OwnerLogin: sess.Login}
	}
	writeJSON(w, 200, created)
}

// POST /api/admin/venues/{venueId}/floors  multipart: index, name, image
func (s *Server) uploadFloor(w http.ResponseWriter, r *http.Request, sess Session) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	id := r.PathValue("venueId")
	if !s.mayWrite(ctx, w, id, sess.Login) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+64<<10)
	if err := r.ParseMultipartForm(maxUpload); err != nil {
		writeJSON(w, 413, map[string]string{"error": "The image must be 10 MB or smaller."})
		return
	}
	index, err := strconv.Atoi(r.FormValue("index"))
	if err != nil || index < 0 || index > 255 {
		writeJSON(w, 400, map[string]string{"error": "index must be a number from 0 to 255."})
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = "Floor " + strconv.Itoa(index)
	}
	f, _, err := r.FormFile("image")
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "Attach the floor image as 'image'."})
		return
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxUpload+1))
	if err != nil || len(b) > maxUpload {
		writeJSON(w, 413, map[string]string{"error": "The image must be 10 MB or smaller."})
		return
	}
	pw, ph, ext, err := imageSize(b)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "Upload a png, jpg or webp."})
		return
	}
	dir := filepath.Join(s.DataDir, "uploads", id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("uploads: %v", err)
		writeJSON(w, 500, map[string]string{"error": "Could not save the image."})
		return
	}
	// One file per floor: drop an earlier upload with a different extension.
	for _, old := range []string{"png", "jpg", "webp"} {
		if old != ext {
			_ = os.Remove(filepath.Join(dir, fmt.Sprintf("%d.%s", index, old)))
		}
	}
	file := fmt.Sprintf("%d.%s", index, ext)
	if err := os.WriteFile(filepath.Join(dir, file), b, 0o644); err != nil {
		log.Printf("uploads: %v", err)
		writeJSON(w, 500, map[string]string{"error": "Could not save the image."})
		return
	}
	imageURL := s.origin(r) + "/uploads/" + id + "/" + file
	if err := s.Client.Call(ctx, "upsert_floor", id, index, name, imageURL, float64(pw), float64(ph)); err != nil {
		log.Printf("upsert_floor: %v", err)
		writeJSON(w, 502, map[string]string{"error": friendly(err)})
		return
	}
	writeJSON(w, 200, map[string]any{"venueId": id, "index": index, "name": name, "imageUrl": imageURL, "width": pw, "height": ph})
}

// POST /api/admin/nodes/place {nodeId, venueId, floor, x, y, label?}
func (s *Server) placeNode(w http.ResponseWriter, r *http.Request, sess Session) {
	var in struct {
		NodeID  int     `json:"nodeId"`
		VenueID string  `json:"venueId"`
		Floor   int     `json:"floor"`
		X       float64 `json:"x"`
		Y       float64 `json:"y"`
		Label   string  `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	if in.NodeID < 1 || in.NodeID > 65535 {
		writeJSON(w, 400, map[string]string{"error": "nodeId must be from 1 to 65535."})
		return
	}
	if in.Floor < 0 || in.Floor > 255 {
		writeJSON(w, 400, map[string]string{"error": "floor must be from 0 to 255."})
		return
	}
	in.Label = strings.TrimSpace(in.Label)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if !s.mayWrite(ctx, w, in.VenueID, sess.Login) {
		return
	}
	if err := s.Client.Call(ctx, "place_node", in.NodeID, in.VenueID, in.Floor, in.X, in.Y, in.Label); err != nil {
		log.Printf("place_node: %v", err)
		writeJSON(w, 502, map[string]string{"error": friendly(err)})
		return
	}
	if in.VenueID == Calhacks {
		if err := s.Venue.PlaceNode(ctx, s.Client, in.NodeID, in.Floor, in.X, in.Y, in.Label); err != nil {
			log.Printf("place node %d in memory: %v", in.NodeID, err)
		}
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// POST /api/admin/boards {mac, nodeId, venueId}
func (s *Server) rememberBoard(w http.ResponseWriter, r *http.Request, sess Session) {
	var in struct {
		MAC     string `json:"mac"`
		NodeID  int    `json:"nodeId"`
		VenueID string `json:"venueId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	mac := strings.ToLower(strings.TrimSpace(in.MAC))
	if !macRe.MatchString(mac) {
		writeJSON(w, 400, map[string]string{"error": "mac must be six colon-separated hex pairs."})
		return
	}
	if in.NodeID < 1 || in.NodeID > 65535 {
		writeJSON(w, 400, map[string]string{"error": "nodeId must be from 1 to 65535."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if !s.mayWrite(ctx, w, in.VenueID, sess.Login) {
		return
	}
	if err := s.Client.Call(ctx, "remember_board", mac, in.NodeID, sess.Login, in.VenueID); err != nil {
		log.Printf("remember_board: %v", err)
		writeJSON(w, 502, map[string]string{"error": friendly(err)})
		return
	}
	writeJSON(w, 200, map[string]any{"mac": mac, "nodeId": in.NodeID, "ownerLogin": sess.Login, "venueId": in.VenueID, "flashedAt": time.Now().UTC().Format(time.RFC3339)})
}

// DELETE /api/admin/boards/{mac}: only the login that remembered it.
func (s *Server) forgetBoard(w http.ResponseWriter, r *http.Request, sess Session) {
	mac := strings.ToLower(r.PathValue("mac"))
	if !macRe.MatchString(mac) {
		writeJSON(w, 400, map[string]string{"error": "mac must be six colon-separated hex pairs."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	rows, err := s.Client.Sql(ctx, "SELECT owner_login FROM board WHERE mac = "+sqlString(mac))
	if err != nil {
		log.Printf("board lookup: %v", err)
		writeJSON(w, 502, map[string]string{"error": "The database did not answer. Try again."})
		return
	}
	if len(rows) == 0 {
		writeJSON(w, 404, map[string]string{"error": "No such board."})
		return
	}
	if rows[0].Str("owner_login") != sess.Login {
		writeJSON(w, 403, map[string]string{"error": "Only whoever flashed this board can forget it."})
		return
	}
	if err := s.Client.Call(ctx, "forget_board", mac); err != nil {
		log.Printf("forget_board: %v", err)
		writeJSON(w, 502, map[string]string{"error": friendly(err)})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// GET /api/venues/calhacks/export: the hardcoded render as one JSON file.
// Nodes come from memory so placements made this session are included.
func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	var zones, landmarks json.RawMessage
	for _, f := range []struct {
		name string
		out  *json.RawMessage
	}{{"zones.json", &zones}, {"landmarks.json", &landmarks}} {
		b, err := os.ReadFile(filepath.Join(s.DataDir, f.name))
		if err != nil {
			log.Printf("export: %v", err)
			writeJSON(w, 500, map[string]string{"error": "Could not read " + f.name + "."})
			return
		}
		*f.out = b
	}
	out := map[string]any{
		"venueId": Calhacks,
		"name":    CalhacksName,
		"plan":    map[string]float64{"width": s.Venue.Width, "height": s.Venue.Height, "metersPerUnit": s.Venue.MetersPerUnit},
		"floors": []map[string]any{
			{"index": 1, "name": "Ground floor", "imageUrl": "/venue-main.jpg"},
			{"index": 2, "name": "Mezzanine", "imageUrl": "/venue-mezz.jpg"},
		},
		"zones":     zones,
		"nodes":     s.Venue.Nodes.Nodes,
		"landmarks": landmarks,
	}
	w.Header().Set("Content-Disposition", `attachment; filename=calhacks-venue.json`)
	writeJSON(w, 200, out)
}
