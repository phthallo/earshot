// bridge feeds SpacetimeDB from sensing nodes (or a mock crowd) and serves
// the HTTP API the web client and the Fetch.ai agent call.
//
//	bridge --mock                      no hardware, simulated crowd
//	bridge --mock --mock-people        plus eight sample attendees as named blips
//	bridge --survey --iface mon0       walk the venue, type zone ids, counts saved
//	bridge --survey --serial /dev/ttyUSB0   same, sniffing with an ESP32 on USB
//	bridge --serial /dev/ttyUSB0       ESP32 nodes over UART
//	bridge --tcp :9000                 relays and laptop/Pi sniffers connect here
//	bridge --relay --serial /dev/ttyACM0 --connect host:9000 --key es_…   forward USB boards to a hosted bridge
//	bridge --node --iface mon0 --id 101 --connect host:9000 --key es_…    run as a sniffer node
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"venuemap/bridge/internal/admin"
	"venuemap/bridge/internal/anon"
	"venuemap/bridge/internal/api"
	"venuemap/bridge/internal/ask"
	"venuemap/bridge/internal/config"
	"venuemap/bridge/internal/dwell"
	"venuemap/bridge/internal/fp"
	"venuemap/bridge/internal/history"
	"venuemap/bridge/internal/ingest"
	"venuemap/bridge/internal/locate"
	"venuemap/bridge/internal/mock"
	"venuemap/bridge/internal/moss"
	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/sniff"
	"venuemap/bridge/internal/stdb"
	surveypkg "venuemap/bridge/internal/survey"
	"venuemap/bridge/internal/venue"
	"venuemap/bridge/internal/voice"
)

func main() {
	var (
		mockMode   = flag.Bool("mock", false, "replay a simulated crowd for the anonymous heat map")
		mockPeople = flag.Bool("mock-people", false, "with --mock: also register the eight sample attendees as named blips")
		survey     = flag.Bool("survey", false, "walk-through count mode: sniff on --serial (one ESP32) or --iface, type zone ids on stdin")
		serial     = flag.String("serial", "", "comma separated serial ports (overrides SERIAL_PORTS)")
		tcp        = flag.String("tcp", ":9000", "listen for sniffer nodes here, empty to disable")
		httpAddr   = flag.String("http", ":8080", "HTTP API address")
		dataDir    = flag.String("data", "", "directory with nodes.json etc (default ../data relative to the binary's repo)")
		static     = flag.String("static", "", "serve the built web client (client/dist) from this directory on --http too")
		envFile    = flag.String("env", "", "path to .env (default: repo root .env)")
		// node mode
		nodeMode  = flag.Bool("node", false, "run as a sniffer node instead of the bridge")
		relayMode = flag.Bool("relay", false, "forward the boards on --serial to the bridge at --connect")
		iface     = flag.String("iface", "mon0", "monitor-mode interface (node mode)")
		nodeID    = flag.Int("id", 101, "node id (node mode)")
		connect   = flag.String("connect", "", "bridge host:port to send lines to (node and relay mode); empty prints to stdout")
		relayKey  = flag.String("key", "", "the venue's relay key from the Venues page (overrides RELAY_KEY)")
	)
	flag.Parse()

	root := repoRoot()
	if *envFile == "" {
		*envFile = filepath.Join(root, ".env")
	}
	config.LoadDotenv(*envFile)
	if *dataDir == "" {
		*dataDir = filepath.Join(root, "data")
	}
	salt := config.Get("MAC_SALT", "dev-salt")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *relayKey == "" {
		*relayKey = config.Get("RELAY_KEY", "")
	}
	if *nodeMode {
		if err := sniff.Run(ctx, sniff.Options{Iface: *iface, NodeID: *nodeID, Connect: *connect, Key: *relayKey, Salt: salt}); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *relayMode {
		if *connect == "" || *serial == "" {
			log.Fatal("relay mode needs --serial and --connect")
		}
		if *relayKey == "" {
			log.Fatal("relay mode needs --key (from the venue's page under Venues)")
		}
		var ports []string
		for _, p := range strings.Split(*serial, ",") {
			if p = strings.TrimSpace(p); p != "" {
				ports = append(ports, p)
			}
		}
		if err := node.Relay(ctx, ports, *connect, *relayKey); err != nil {
			log.Fatal(err)
		}
		return
	}

	uri := config.Get("STDB_URI", "http://localhost:3000")
	db := config.Get("STDB_DB", "venuemap")
	token := config.Get("STDB_TOKEN", "")
	// Tokens are only valid for the server that minted them, so caches are kept
	// per server: ~/.venuemap/<host>/token and the mock attendee tokens beside it.
	home, _ := os.UserHomeDir()
	cacheDir := filepath.Join(home, ".venuemap", strings.NewReplacer("://", "_", ":", "_", "/", "_").Replace(uri))
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		log.Fatalf("cache dir: %v", err)
	}
	if token == "" {
		t, err := stdb.LoadOrMintToken(ctx, uri, filepath.Join(cacheDir, "token"))
		if err != nil {
			log.Fatalf("token: %v", err)
		}
		token = t
	}
	client := stdb.New(uri, db, token)
	if err := client.Call(ctx, "register_ingest", "bridge"); err != nil {
		log.Fatalf("register_ingest: %v (is the module published and is this the first bridge identity?)", err)
	}

	v, err := venue.Load(*dataDir)
	if err != nil {
		log.Fatalf("venue: %v", err)
	}
	if err := v.Seed(ctx, client); err != nil {
		log.Fatalf("seed: %v", err)
	}
	log.Printf("seeded %d nodes, %d zones into %s/%s", len(v.Nodes.Nodes), len(v.Zones), uri, db)

	fps, err := fp.Load(filepath.Join(*dataDir, "fingerprints.json"))
	if err != nil {
		log.Fatalf("fingerprints: %v", err)
	}

	if *survey {
		o := surveypkg.Options{Source: *iface}
		if *serial != "" {
			o.Source, o.Store = *serial, fps
			o.Caps, o.APs, err = surveypkg.FromSerial(ctx, *serial)
		} else {
			o.Caps, err = sniff.Open(ctx, *iface)
		}
		if err != nil {
			log.Fatal(err)
		}
		if err := surveypkg.Run(ctx, client, v, o, os.Stdin, os.Stdout); err != nil {
			log.Fatal(err)
		}
		return
	}

	batch := ingest.New(client, 2*time.Second)
	go batch.Run(ctx)

	var crowd *mock.Mock
	if *mockMode {
		m, err := mock.New(v, client, batch, salt, cacheDir, *mockPeople)
		if err != nil {
			log.Fatalf("mock: %v", err)
		}
		if err := m.Setup(ctx); err != nil {
			log.Fatalf("mock setup: %v", err)
		}
		go m.Run(ctx)
		crowd = m
		log.Printf("mock crowd running")
	}

	h := &node.Handler{Batch: batch, Client: client}
	if len(fps.Samples) > 0 {
		loc := &locate.Locator{Store: fps, Venue: v, Client: client}
		h.Locate = loc.Handle
		log.Printf("%d zone fingerprints: real nodes are placed from the access points they hear", len(fps.Samples))
	} else {
		log.Printf("no zone fingerprints yet (walk with --survey --serial or the app's learn mode): real nodes stay where nodes.json puts them")
	}
	stays := &dwell.Tracker{}
	// Each phone's day survives a restart: saved every minute and at shutdown.
	dwellFile := filepath.Join(*dataDir, "dwell.json")
	if err := stays.Load(dwellFile); err != nil {
		log.Printf("dwell: %v (starting empty)", err)
	}
	dwellSaved := make(chan struct{})
	go func() {
		defer close(dwellSaved)
		stays.Persist(ctx, dwellFile, time.Minute, log.Printf)
	}()
	dots := &anon.Tracker{Venue: v, VenueID: admin.Calhacks, Dwell: stays}
	go dots.Run(ctx, client, 2*time.Second)
	venues := &anon.Registry{Client: client, Local: admin.Calhacks, Built: dots, Interval: 2 * time.Second}
	go venues.Run(ctx)
	h.LocalVenue = admin.Calhacks
	h.Observe = venues.Observe
	h.Auth = venues.Auth
	h.Allow = venues.Allow
	go h.WatchWalks(ctx, client)
	ports := *serial
	if ports == "" {
		ports = config.Get("SERIAL_PORTS", "")
	}
	for _, p := range strings.Split(ports, ",") {
		if p = strings.TrimSpace(p); p != "" {
			go h.ReadSerial(ctx, p)
		}
	}
	if *tcp != "" {
		go func() {
			if err := h.ServeTCP(ctx, *tcp); err != nil {
				log.Printf("tcp: %v", err)
			}
		}()
	}

	adm := &admin.Server{
		Client:             client,
		Venue:              v,
		DataDir:            *dataDir,
		Secret:             admin.SecretOrRandom(config.Get("SESSION_SECRET", "")),
		GithubClientID:     config.Get("GITHUB_CLIENT_ID", ""),
		GithubClientSecret: config.Get("GITHUB_CLIENT_SECRET", ""),
		ClientURL:          config.Get("CLIENT_URL", ""),
		PublicURL:          config.Get("PUBLIC_URL", ""),
		OnPlace:            venues.Refresh,
	}
	if err := adm.SeedCalhacks(ctx); err != nil {
		log.Fatalf("seed venue: %v", err)
	}
	if adm.GithubClientID == "" {
		log.Printf("GITHUB_CLIENT_ID unset: admin sign-in uses the local account")
	}
	srv := &api.Server{Client: client, Salt: salt, FP: fps, Dwell: stays, Dots: dots, Admin: adm, ClientURL: adm.ClientURL, Static: *static}
	if *static != "" {
		log.Printf("serving web client from %s", *static)
	}
	if crowd != nil {
		adm.Mock, srv.Mock = crowd, crowd
	}
	if pid, key := config.Get("MOSS_PROJECT_ID", ""), config.Get("MOSS_PROJECT_KEY", ""); pid != "" && key != "" {
		docs, err := moss.LoadDocs(filepath.Join(*dataDir, "guide.json"))
		if err != nil {
			log.Fatalf("guide: %v", err)
		}
		srv.Search = moss.New(pid, key, config.Get("MOSS_INDEX", "venuemap-guide"))
		srv.Search.SyncInBackground(ctx, docs)
	} else {
		log.Printf("MOSS_PROJECT_KEY unset: guide search disabled")
	}
	if dsn := config.Get("TIGER_DSN", ""); dsn != "" {
		store, err := history.Open(ctx, dsn, client)
		if err != nil {
			log.Fatalf("history: %v", err)
		}
		srv.History = store
		go store.Run(ctx, 30*time.Second)
		log.Printf("zone history sampling every 30s")
	} else {
		log.Printf("TIGER_DSN unset: zone history disabled")
	}
	var asker *ask.Asker
	if base, key := config.Get("OPENAI_BASE_URL", ""), config.Get("OPENAI_API_KEY", ""); base != "" && key != "" {
		model := config.Get("OPENAI_MODEL", "anthropic/claude-sonnet-5.5")
		asker = ask.NewOpenAI(client, base, key, model)
		log.Printf("ask: %s via %s", model, base)
	} else if key := config.Get("ANTHROPIC_API_KEY", ""); key != "" && !strings.HasSuffix(key, "...") {
		asker = ask.New(client, key, config.Get("ANTHROPIC_MODEL", "claude-opus-5-5"))
	} else {
		log.Printf("ANTHROPIC_API_KEY and OPENAI_BASE_URL unset: /api/ask disabled")
	}
	if asker != nil {
		asker.Search, asker.History, asker.Dwell = srv.Search, srv.History, stays
		if crowd != nil {
			asker.MockOn = crowd.Enabled
		}
		srv.Ask = asker
	}
	if key := config.Get("CARTESIA_API_KEY", ""); key != "" && !strings.HasSuffix(key, "...") {
		srv.Voice = voice.New(key, config.Get("CARTESIA_VOICE_ID", ""))
	} else {
		log.Printf("CARTESIA_API_KEY unset: /api/voice disabled")
	}

	hs := &http.Server{Addr: *httpAddr, Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = hs.Shutdown(shutdownCtx)
	}()
	log.Printf("http api on %s", *httpAddr)
	if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-dwellSaved
}

// repoRoot walks up from the working directory to the folder holding data/.
func repoRoot() string {
	dir, _ := os.Getwd()
	for i := 0; i < 5; i++ {
		if st, err := os.Stat(filepath.Join(dir, "data", "nodes.json")); err == nil && !st.IsDir() {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	wd, _ := os.Getwd()
	return wd
}
