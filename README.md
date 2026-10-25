# Earshot

Earshot is a live crowd map built from the wifi probe frames phones already send. $5 ESP32 nodes, one per zone, hear phones within roughly 30 m. The map shows zone counts against capacity and anonymous dots, in a 3D scene or a 2D plan, and it updates every 2 s.

We ran it at Cal Hacks 13.0 at the Palace of Fine Arts in San Francisco, 24 to 25 Oct 2026. One live ESP32 sat on the mezzanine. Over the evening it heard about 400 distinct phones, with 60 to 75 in range at any moment. The rest of the hall is a simulated crowd, and the UI labels it as simulated. The venue has 14 zones and 24 planned node positions.

A Go bridge on a laptop salts and hashes each phone's MAC address. The raw MAC stays only in bridge memory and is dropped 10 s after the phone goes quiet. The database stores only hashes, zone counts and grid cells. A dot gets a name only if its owner registers.

Questions and privacy receipts use Claude, spoken answers use Cartesia, the concierge agent runs on Fetch.ai, the venue guide is indexed in Moss and zone history lives in TigerData.

Landing page: `client/public/landing/index.html`, served at `/landing/index.html` by the dev server. Published link: https://claude.ai/artifact/HxcdrRsN6hEQmDCGP97zmB

## What is real and what is simulated

| On the map | Where it comes from | Label in the UI |
|---|---|---|
| Zone heat across the venue | A mock crowd replayer (`bridge --mock`), weighted by time of day from `data/rhythm.json` | "Simulated crowd" |
| Zone counts from a walk-through | `bridge --survey`: someone walks the venue with an ESP32 on USB or a laptop in monitor mode and types the zone they are in | "Surveyed hh:mm" |
| Zone counts at a live node | Real sniffers (laptop, Raspberry Pi, ESP32) counting distinct hashed MACs | "Live count" |
| Named blips | People who registered and paired their phone at a node, or who run the Android app | star, dashed ring for the app |

Nothing on the map is named without registration. Nodes send each phone's MAC and its salted hash. The database stores only the hash and the bridge keeps the MAC in memory.

Tapping an unregistered dot shows whether that phone's MAC is randomised, which nodes hear it and how strongly, and its day: first heard, zone it is in, return visits, zones it stayed in. The MAC itself is shown only to a browser on the bridge host.

Phones keep one randomised MAC per wifi network. So the bridge can also report per zone how many distinct phones visited, how many came back, and how long they typically stayed.

See `docs/ARCHITECTURE.md` for the data flow and the privacy page in the app for what is stored per person.

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

- `ANTHROPIC_API_KEY` in `.env` turns on the Ask tab and privacy receipts. Without it the map, registration, team view and privacy summary all still work.
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

## Tests

```sh
(cd server && pnpm test)        # tick maths: positions, pairing, expiry
(cd bridge && go test ./...)
(cd client && pnpm typecheck)
```
