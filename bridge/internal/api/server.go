// Package api is the bridge's HTTP surface for the web client and the
// Fetch.ai agent: ask, bind a typed MAC, privacy receipt, voice.
package api

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"venuemap/bridge/internal/admin"
	"venuemap/bridge/internal/anon"
	"venuemap/bridge/internal/dwell"
	"venuemap/bridge/internal/fp"
	"venuemap/bridge/internal/history"
	"venuemap/bridge/internal/moss"
	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/stdb"
)

type Asker interface {
	Ask(ctx context.Context, question string, liveOnly bool) (answer string, err error)
	PrivacyReceipt(ctx context.Context, personID int) (string, error)
}

type Voice interface {
	TTS(ctx context.Context, text string) (audio []byte, contentType string, err error)
	STT(w http.ResponseWriter, r *http.Request)
}

type Server struct {
	Client  *stdb.Client
	Salt    string
	Ask     Asker          // nil when ANTHROPIC_API_KEY is unset
	Voice   Voice          // nil when CARTESIA_API_KEY is unset
	Search  *moss.Client   // nil when MOSS_PROJECT_KEY is unset
	History *history.Store // nil when TIGER_DSN is unset
	Dwell   *dwell.Tracker // nil without real nodes
	Dots    *anon.Tracker  // nil without real nodes
	FP      *fp.Store
	Admin   *admin.Server
	Mock    admin.MockCrowd // nil without --mock
	// ClientURL is the one non-localhost origin that may send the session
	// cookie; other origins get the open, credential-less CORS header.
	ClientURL string
	// Static is the built web client (client/dist). Empty serves the API only.
	Static string
}

var macRe = regexp.MustCompile(`^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$`)

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("POST /api/bind-mac", s.bindMac)
	mux.HandleFunc("POST /api/ask", s.ask)
	mux.HandleFunc("GET /api/privacy-receipt", s.receipt)
	mux.HandleFunc("GET /api/search", s.search)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("GET /api/dwell", s.dwell)
	mux.HandleFunc("GET /api/device", s.device)
	mux.HandleFunc("POST /api/voice/tts", s.tts)
	mux.HandleFunc("GET /api/voice/stt", s.stt)
	mux.HandleFunc("GET /api/pair-code", s.pairCode)
	mux.HandleFunc("POST /api/fp/login", s.fpLogin)
	mux.HandleFunc("GET /api/fp/zones", s.fpZones)
	mux.HandleFunc("POST /api/fp/learn", s.fpLearn)
	mux.HandleFunc("POST /api/fp/forget", s.fpForget)
	mux.HandleFunc("POST /api/fp/locate", s.fpLocate)
	if s.Admin != nil {
		s.Admin.Register(mux)
	}
	if s.Static != "" {
		mux.Handle("/", spa(s.Static))
	}
	return cors(mux, s.ClientURL)
}

// spa serves the built client: real files as they are, every other path as
// index.html so the client's own routing (/venues, /venues/<id>) works on a
// fresh load. API paths that matched nothing above stay 404.
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	index := filepath.Join(dir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/uploads/") {
			http.NotFound(w, r)
			return
		}
		if p != "/" {
			if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(path.Clean(p)))); err == nil && !st.IsDir() {
				if strings.HasPrefix(p, "/assets/") {
					// Vite hashes these file names.
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, index)
	})
}

// cors echoes the Origin, with credentials allowed, only for the configured
// client origin and localhost; anything else may still read the public API.
func cors(h http.Handler, clientURL string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && trustedOrigin(origin, clientURL) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Add("Vary", "Origin")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		w.Header().Set("Access-Control-Allow-Headers", "content-type, authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	mode, mockOn := "live", false
	if s.Mock != nil && s.Mock.Enabled() {
		mode, mockOn = "mock", true
	}
	writeJSON(w, 200, map[string]any{"ok": true, "mode": mode, "mock": mockOn, "mockAvailable": s.Mock != nil, "ask": s.Ask != nil, "voice": s.Voice != nil, "search": s.Search != nil, "history": s.History != nil})
}

// search is the guide index straight from the client, no Claude in between.
func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	if s.Search == nil {
		writeJSON(w, 503, map[string]string{"error": "Guide search is off. Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in .env and restart the bridge."})
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 300 {
		writeJSON(w, 400, map[string]string{"error": "Give q, up to 300 characters."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	res, err := s.Search.Query(ctx, q, 5)
	if err != nil {
		log.Printf("search: %v", err)
		writeJSON(w, 502, map[string]string{"error": "Guide search did not answer. Try again."})
		return
	}
	writeJSON(w, 200, res)
}

// history returns bucketed samples for one zone. Only anonymous numbers.
func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	if s.History == nil {
		writeJSON(w, 503, map[string]string{"error": "Zone history is off. Set TIGER_DSN in .env and restart the bridge."})
		return
	}
	zone := r.URL.Query().Get("zone")
	if zone == "" {
		writeJSON(w, 400, map[string]string{"error": "zone is required"})
		return
	}
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	window, bucket := history.Window(hours)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	pts, err := s.History.Recent(ctx, zone, window, bucket)
	if err != nil {
		log.Printf("history: %v", err)
		writeJSON(w, 502, map[string]string{"error": "History did not answer. Try again."})
		return
	}
	writeJSON(w, 200, map[string]any{"zone": zone, "hours": int(window.Hours()), "bucketSeconds": int(bucket.Seconds()), "points": pts})
}

// dwell returns unique phones, returning phones and typical stay per zone,
// or for the one zone asked for. Aggregates only, computed in memory.
func (s *Server) dwell(w http.ResponseWriter, r *http.Request) {
	if s.Dwell == nil {
		writeJSON(w, 503, map[string]string{"error": "Dwell statistics need a real sniffer node."})
		return
	}
	if zone := r.URL.Query().Get("zone"); zone != "" {
		writeJSON(w, 200, s.Dwell.Zone(zone, time.Now()))
		return
	}
	writeJSON(w, 200, s.Dwell.Report(time.Now()))
}

// device returns everything the bridge holds about one unregistered phone:
// current sightings from the dot tracker and its day from dwell. The raw MAC
// only goes to a browser on the bridge host itself (the organiser's laptop);
// anyone on the venue wifi gets the randomised flag and the hash.
func (s *Server) device(w http.ResponseWriter, r *http.Request) {
	hash := r.URL.Query().Get("hash")
	if s.Dots == nil || hash == "" {
		writeJSON(w, 404, map[string]string{"error": "No such phone."})
		return
	}
	now := time.Now()
	d := s.Dots.Device(hash, now)
	if d == nil {
		writeJSON(w, 404, map[string]string{"error": "That phone has gone quiet. Pick another dot."})
		return
	}
	var day *dwell.DeviceInfo
	if s.Dwell != nil {
		day = s.Dwell.Device(hash)
	}
	withheld := false
	if !isLoopback(r.RemoteAddr) && d.MAC != "" {
		d.MAC = ""
		withheld = true
	}
	writeJSON(w, 200, map[string]any{"device": d, "day": day, "addressWithheld": withheld})
}

func trustedOrigin(origin, clientURL string) bool {
	if clientURL != "" && strings.EqualFold(strings.TrimRight(origin, "/"), strings.TrimRight(clientURL, "/")) {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// bindMac hashes a typed-in MAC with the salt and binds it to the caller.
// The caller proves who they are with their SpacetimeDB token, the same way
// pairCode does, so nobody can bind a phone to someone else's name.
func (s *Server) bindMac(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MAC string `json:"mac"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	mac := strings.ToLower(strings.TrimSpace(in.MAC))
	if !macRe.MatchString(mac) {
		writeJSON(w, 400, map[string]string{"error": "Enter the address as six pairs, like 3a:91:c0:4f:12:8e."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	personID, ok := s.callerPerson(ctx, w, r)
	if !ok {
		return
	}
	if err := s.Client.Call(ctx, "bind_mac_for", personID, node.HashMAC(s.Salt, mac)); err != nil {
		log.Printf("bind_mac_for: %v", err)
		writeJSON(w, 409, map[string]string{"error": friendly(err)})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// Reducer errors arrive as "POST ...: 400 <message>". Keep the message.
func friendly(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": 4"); i >= 0 && len(msg) > i+6 {
		return strings.TrimSpace(msg[i+6:])
	}
	return msg
}

func (s *Server) ask(w http.ResponseWriter, r *http.Request) {
	if s.Ask == nil {
		writeJSON(w, 503, map[string]string{"error": "Ask is off. Set ANTHROPIC_API_KEY in .env and restart the bridge."})
		return
	}
	var in struct {
		Question string `json:"question"`
		// True when the viewer has the map's "Live only" switch on.
		LiveOnly bool `json:"liveOnly"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || strings.TrimSpace(in.Question) == "" {
		writeJSON(w, 400, map[string]string{"error": "Type a question."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	ans, err := s.Ask.Ask(ctx, in.Question, in.LiveOnly)
	if err != nil {
		log.Printf("ask: %v", err)
		writeJSON(w, 502, map[string]string{"error": "Couldn't get an answer. Try again."})
		return
	}
	writeJSON(w, 200, map[string]string{"answer": ans})
}

func (s *Server) receipt(w http.ResponseWriter, r *http.Request) {
	if s.Ask == nil {
		writeJSON(w, 503, map[string]string{"error": "Set ANTHROPIC_API_KEY to generate receipts."})
		return
	}
	pid, err := strconv.Atoi(r.URL.Query().Get("personId"))
	if err != nil || pid <= 0 {
		writeJSON(w, 400, map[string]string{"error": "personId must be a number"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	txt, err := s.Ask.PrivacyReceipt(ctx, pid)
	if err != nil {
		log.Printf("receipt: %v", err)
		writeJSON(w, 502, map[string]string{"error": "Couldn't build the receipt. Try again."})
		return
	}
	writeJSON(w, 200, map[string]string{"receipt": txt})
}

func (s *Server) tts(w http.ResponseWriter, r *http.Request) {
	if s.Voice == nil {
		writeJSON(w, 503, map[string]string{"error": "Voice is off. Set CARTESIA_API_KEY in .env."})
		return
	}
	var in struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Text == "" {
		writeJSON(w, 400, map[string]string{"error": "nothing to say"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	audio, ct, err := s.Voice.TTS(ctx, in.Text)
	if err != nil {
		log.Printf("tts: %v", err)
		writeJSON(w, 502, map[string]string{"error": "Speech failed."})
		return
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write(audio)
}

func (s *Server) stt(w http.ResponseWriter, r *http.Request) {
	if s.Voice == nil {
		http.Error(w, "voice off", 503)
		return
	}
	s.Voice.STT(w, r)
}
