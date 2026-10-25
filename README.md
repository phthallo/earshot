# Earshot

Map, profile and query large, messy crowds and their history with affordable ESP32s.
Questions and privacy receipts use Claude, spoken answers use Cartesia, the concierge agent runs on Fetch.ai, the venue guide is indexed in Moss and zone history lives in TigerData.

## Where it applies

- Event safety and operations: warn when a crowd builds up, get evacuation headcounts, balance queues.
- Campus and building occupancy: libraries, makerspaces and lecture halls, with no cameras.
- Small venue footfall: cafes, markets and community centres, with $5 nodes where a people counter costs about $2k.

## Run it with no hardware

Requirements: Node 22, pnpm, Go 1.25, the `spacetime` CLI 2.13.

```sh
cp .env.example .env            # defaults work for a local SpacetimeDB
spacetime start                 # local server on :3000, keep it running
spacetime publish -s local venuemap
spacetime generate --lang typescript --module-path server --out-dir client/src/module_bindings
(cd bridge && go run ./cmd/bridge --mock --mock-people)
(cd client && pnpm install && pnpm dev)
```

Open http://localhost:5173. The map fills with the simulated crowd and eight sample attendees.

Every API key is optional.

- `ANTHROPIC_API_KEY` in `.env` turns on the Ask box under the map panel and privacy receipts. Without it the map, registration and privacy summary all still work. `OPENAI_BASE_URL` plus `OPENAI_API_KEY` reach Claude through an OpenAI-compatible proxy instead (for example `https://ai.hackclub.com/proxy/v1` with `OPENAI_MODEL=anthropic/claude-sonnet-5.5`).
- `CARTESIA_API_KEY` turns on the microphone and spoken answers.
- `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY` index `data/guide.json` (zones, schedule, workshops, prizes) in Moss and give Ask a `search_guide` tool.
- `TIGER_DSN` points at a Postgres (TigerData or local Timescale). The bridge samples every zone's count into it every 30 seconds, the map shows a six hour sparkline for the selected zone, and Ask gets a `zone_history` tool for "when is food least busy".

Local history store for development:

```sh
podman run -d --name venuemap-tsdb -p 5433:5432 -e POSTGRES_PASSWORD=venuemap docker.io/timescale/timescaledb:latest-pg17
# then in .env: TIGER_DSN=postgres://postgres:venuemap@localhost:5433/postgres
```

## Run it with hardware

- Laptop or Raspberry Pi sniffer: put the wifi card in monitor mode (commands in `bridge/internal/sniff/sniff.go`), then `bridge --node --iface mon0 --id 101 --connect <bridge-host>:9000`.
- ESP32-S3: flash `firmware/` with `idf.py`, or open the Venues page in Chrome and flash from the browser, then `bridge --serial /dev/ttyACM0`. The Venues page also places nodes on the plan; see `docs/ADMIN.md`.
- Hosted bridge, boards elsewhere: make a relay key on the venue's page and run the command it prints at the venue from a checkout of this repo, `cd bridge && go run ./cmd/bridge --relay --serial /dev/ttyACM0 --connect <host>:9000 --key es_…`. A bare `bridge` is Linux's ethernet bridge tool from iproute, not this program. One bridge serves any number of venues; each relay only speaks for the nodes placed in its venue.
- Android phone: build `android/`, sign in with the pair code from the Me tab.

Node ids 101, 102 and 103 are the three live nodes clustered in the hardware area (`data/nodes.json`). Real nodes drop in next to the mock crowd, and the UI shows which zones are live.

## Layout

```
server/    SpacetimeDB module (TypeScript): tables, reducers, scheduled tick
bridge/    Go: mock crowd, node ingest, HTTP API (ask, voice, pairing, fingerprints)
client/    Vite + React web app
firmware/  ESP-IDF node firmware
android/   Wifi fingerprint app (Kotlin, Compose)
agent/     Fetch.ai concierge agent
data/      Venue geometry, zones, mock attendees, crowd rhythm
docs/      Architecture, style guide, venue admin and hardware notes
```

## Deploy

`Dockerfile` builds one image: the bridge on port 8080 serving the API and the built client, and the relay port 9000. The client is built against maincloud (`VITE_STDB_URI`, `VITE_STDB_DB` build args) and talks to the origin it is served from.

```sh
docker build -t earshot .
docker run -p 8080:8080 -p 9000:9000 --env-file .env -v earshot-data:/app/data earshot
```

Set `STDB_URI`, `STDB_DB`, `STDB_TOKEN` (the ingest identity's token), `MAC_SALT`, `SESSION_SECRET`, `PUBLIC_URL` and `CLIENT_URL` (both the public https origin) plus any API keys. `/app/data` is a volume for uploads, placed nodes and fingerprints. The container runs live nodes only; set `BRIDGE_ARGS` to `--mock --mock-people` for the simulated crowd. The hosted instance is https://earshot.underwhelm.ing, deployed by Coolify from `main`.

## Tests

```sh
(cd server && pnpm test)        # tick maths: positions, pairing, expiry
(cd bridge && go test ./...)
(cd client && pnpm typecheck)
```
