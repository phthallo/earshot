# Architecture

```
 ESP32 nodes ──serial──┐
 laptop / Pi sniffers ─tcp :9000─┤                          ┌── web client (Vite + React, spacetimedb/react)
 Android app ──http /api/fp/*──┤── Go bridge ──reducers──► SpacetimeDB ◄─subscriptions─┤
 mock crowd (--mock) ──────────┘      │                                                 └── spacetime sql (judging, debugging)
                                      ├── /api/ask, /api/privacy-receipt   (Claude, SQL tool over public tables)
                                      ├── /api/voice/tts, /api/voice/stt   (Cartesia)
                                      ├── /api/pair-code, /api/bind-mac
                                      └── Fetch.ai concierge agent calls /api/ask
```

## SpacetimeDB module (`server/`)

Public tables: `node`, `zone`, `anon_zone_count` (count per zone with `source` live, mock or survey), `person`, `position` (x, y, floor, confidence, `source` node or app), `zone_activity`, and two identity-free mirrors the bridge polls, `pairing_beacon` and `walk_beacon`.

Own-row tables (row level security, a client only sees its own rows): `pairing_session`, `device_binding`, `enrolment_walk`, `match_result`.

Private tables: `sighting` (node id, mac hash, rssi), `walk_capture`, `signature` (the gait centroid), `ingest_key`, `tick_schedule`.

Hiding yourself deletes your `position` row, since that table is public. A zone with live nodes reports the largest count among them, not the sum, because the real nodes are clustered and hear the same phones.

Reducers:

- Ingest (bridge only, checked against `ingest_key`): `push_motion_batch`, `push_sightings_batch`, `push_csi`, `set_survey_count`, `seed_nodes`, `seed_zones`, `register_ingest`.
- People (caller's own identity): `upsert_person`, `set_team`, `set_visible`, `start_pairing`, `cancel_pairing`, `unbind_device`, `delete_me`, `set_app_position`, `bind_mac_for` (bridge, after a typed MAC).
- Walks: `start_walk`, `finish_walk`, `cancel_walk`, `match_walk`, `reset_walks`.
- `tick`, scheduled every 500 ms.

`tick` (`src/lib/position.ts`, unit tested) groups the last five seconds of sightings per person and per node, takes the median RSSI per node, and places the person at the RSSI-weighted centroid of the nodes that saw them. A position from the Android app overrides node placement for ten seconds. Positions expire after sixty seconds (two minutes for the app), sightings are pruned, zone counts are recomputed, and open pairing sessions are closed: the strongest MAC seen at the chosen node during the five second window that was not seen there in the previous thirty seconds and is not already bound becomes the person's device.

## Bridge (`bridge/`)

One binary, several modes (`bridge --help`):

- `--mock [--mock-people]`: random-waypoint walkers on the arc with zone attraction from `data/rhythm.json`, RSSI from distance plus noise, batched into one motion and one sightings call every two seconds.
- `--tcp :9000` and `--serial`: real nodes speak one JSON object per line (`hello`, `motion`, `sight`, `csi`); the bridge answers with `allow`, `pairing` and `walk` lines. The parser is shared across ESP32, laptop and Pi.
- `--node`: the same binary as a sniffer: reads 802.11 frames with gopacket from a monitor-mode interface, hashes the transmitter MAC with `MAC_SALT`, and emits the line protocol to stdout or to `--connect host:port`.
- `--survey`: sniff while walking, type zone ids on stdin, write per-zone distinct-device counts with `set_survey_count`.
- HTTP API on `--http :8080`: health, ask, privacy receipt, voice, pair code, bind MAC, fingerprint login/learn/locate/forget for the Android app (stored in `data/fingerprints.json`, gitignored). Pair code and bind MAC verify the caller's SpacetimeDB token against the identity, so a phone can only be bound to the person who holds it.

The Ask endpoint gives Claude one tool, `run_sql`, limited to SELECT on public tables with a row limit. Private tables (`sighting`, `device_binding`) are not reachable from it.

## Web client (`client/`)

Subscribes to the public tables plus the caller's own rows. The map is an annular arc (`data/nodes.json` holds the geometry; every zone is a slice `s0..s1` along it) drawn as SVG: grainy zone washes scaled by count over capacity, eight-point star blips with fading trails, dashed amber circles for the live nodes. URL parameters carry view, floor and selected zone.

## Android app (`android/`)

Scans wifi every ten seconds (throttling must be off in developer options), posts access point lists to the bridge, which matches them against learned zone fingerprints (k nearest neighbours on RSSI vectors) and calls `set_app_position`. Learn mode records labelled scans. iOS has no public scan API, so there is no iOS build.

## Firmware (`firmware/`)

ESP-IDF 5.5, plain ESP32. Promiscuous sniffing on one channel, salted SHA-256 of MACs, CSI turbulence over a subcarrier window as a motion score, optional LCD1602 status line, line protocol over UART at 921600. The bridge registers each node on its `hello` line and sends `{"t":"walk","on":1}` while a walk capture is open for that node. Builds clean with and without the LCD option; not yet run on a board.
