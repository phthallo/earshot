# Where everyone is

A live map of Cal Hacks 13.0 at the Palace of Fine Arts, drawn from wifi. Anonymous crowd heat per zone, plus named blips for people who opt in, so you can find your team, a quiet corner, or the food line without walking the whole arc.

Built for Cal Hacks 13.0 (Oct 24 to 25, 2026) on SpacetimeDB, with Claude for questions and privacy receipts, Cartesia for voice, and a Fetch.ai concierge agent.

## What is real and what is simulated

| On the map | Where it comes from | Label in the UI |
|---|---|---|
| Zone heat across the venue | A mock crowd replayer (`bridge --mock`), weighted by time of day from `data/rhythm.json` | "Simulated crowd" |
| Zone counts from a walk-through | `bridge --survey`: someone walks the venue with a laptop in monitor mode and types the zone they are in | "Surveyed hh:mm" |
| Zone counts at a live node | Real sniffers (laptop, Raspberry Pi, ESP32) counting distinct hashed MACs | "Live count" |
| Named blips | People who registered and paired their phone at a node, or who run the Android app | star, dashed ring for the app |

Nothing on the map is identified without registration. Nodes hash every MAC with a salt before it leaves the sniffing process. See `docs/ARCHITECTURE.md` for the data flow and the privacy page in the app for what is stored per person.

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

`ANTHROPIC_API_KEY` in `.env` turns on the Ask tab and privacy receipts. `CARTESIA_API_KEY` turns on the microphone and spoken answers.

## Run it with hardware

- Laptop or Raspberry Pi sniffer: put the wifi card in monitor mode (commands in `bridge/internal/sniff/sniff.go`), then `bridge --node --iface mon0 --id 101 --connect <bridge-host>:9000`.
- ESP32: flash `firmware/`, then `bridge --serial /dev/ttyUSB0`.
- Android phone: build `android/`, sign in with the pair code from the Me tab.

Node ids 101, 102 and 103 are the three live nodes clustered in the hardware area (`data/nodes.json`). Real nodes drop in next to the mock crowd; the UI shows which zones are live.

## Layout

```
server/    SpacetimeDB module (TypeScript): tables, reducers, scheduled tick
bridge/    Go: mock crowd, node ingest, HTTP API (ask, voice, pairing, fingerprints)
client/    Vite + React web app
firmware/  ESP-IDF node firmware
android/   Wifi fingerprint app (Kotlin, Compose)
agent/     Fetch.ai concierge agent
data/      Venue geometry, zones, mock attendees, crowd rhythm
docs/      Architecture and hardware notes
```

## Tests

```sh
(cd server && pnpm test)        # tick maths: positions, pairing, expiry
(cd bridge && go test ./...)
(cd client && pnpm typecheck)
```
