# Architecture

The product is Earshot, and only the venue data (`data/*.json` and the floorplan image `client/public/venue-main.jpg`) is Cal Hacks specific, so the firmware, bridge, server module and client are generic.

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

- `--mock [--mock-people]`: random-waypoint walkers in floorplan pixels, aiming at points sampled inside zone polygons with zone attraction from `data/rhythm.json`, now and then taking a staircase (`data/landmarks.json`) to the other floor; RSSI from distance plus noise, batched into one motion and one sightings call every two seconds.
- The simulated crowd can be switched off and on for everyone from the example venue's page under Venues once signed in (`POST /api/admin/mock`). Off pauses the walkers, calls `clear_mock` to drop the activity, counts and positions the mock nodes wrote, and hides the sample attendees; `/api/health` reports `mock` and `mode` so every client and Ask follow. On resumes the walkers where they were.
- `--tcp :9000` and `--serial`: real nodes speak one JSON object per line (`hello`, `motion`, `sight`, `aps`, `csi`); the bridge answers with `allow`, `pairing` and `walk` lines. The parser is shared across ESP32, laptop and Pi.
- Anonymous dots (`internal/anon`): the module drops sightings of unregistered phones on arrival, so the bridge places them itself. For every hash a real node heard in the last 10 s it takes the RSSI-weighted centroid of the nodes that heard it (the module's rule for registered people), adds a ring offset for distance when only one node heard it, snaps to 10 floorplan pixels, and pushes the set with `push_anon_points` every 2 s. The `anon_point` table holds floor, x, y, strongest RSSI, a hue byte, the salted hash and a `stable` flag (the node sent a factory MAC, locally administered bit clear), and the tick deletes rows older than 20 s. Both views draw them as small unlabelled dots; stable ones get an amber ring and their own legend entry, since a factory address follows the phone across networks and days.
- Dwell (`internal/dwell`): Android 10+ and iOS 14+ keep one randomised MAC per wifi network, so a phone on the venue wifi hashes to the same value all event. The anon tracker tells `dwell` which zone it placed each hash in; the tracker keeps the hash for 24 hours with its current zone, when it entered, and the zones it stayed in for two minutes or more. Fifteen minutes unheard ends a stay; coming back after that is a return. `/api/dwell[?zone=]` and the `zone_dwell` Ask tool return aggregates only: distinct phones, phones now, returning phones, completed stays and the median stay per zone; `/api/device` returns one hash's own day. The tracker is saved to `data/dwell.json` (gitignored, owner-only, salted hashes and never a MAC) every minute and at shutdown, so a restart keeps each phone's travels. Scan-only phones (fresh MAC per burst) fall below the two minute floor.
- Device sheet: sight items carry the raw MAC as a third element. The anon tracker keeps it in memory per hash with each node's latest RSSI and the first sighting; `anon_point` rows carry the hash so a tap on a dot can call `/api/device?hash=`, which returns the MAC (only to loopback callers, so the organiser laptop and not the venue wifi), whether its locally administered bit is set (randomised per network, so no vendor), the nodes hearing it loudest first, the dwell tracker's day for that hash (first heard, completed stays of two minutes or more with their times, current zone; the sheet draws it as a timeline), and a trail of the dot's past grid positions (a step per cell change, last 30 minutes, at most 120). While a dot is picked both views fade the other dots and draw the trail as a dashed white line. The MAC is never written to SpacetimeDB or Postgres and is dropped with the hash when nothing has heard it for 10 s.
- Battery nodes: a second ESP32 built with `sdkconfig.remote` (node id 104, `VENUEMAP_UPLINK_ESPNOW`) broadcasts its lines over ESP-NOW; the node on USB prints them on its own console, so the bridge sees both nodes on one serial port. No access point is involved, which sidesteps venue wifi client isolation.
- Moving nodes (`internal/locate`): an `aps` line lists the access points a node hears. When `data/fingerprints.json` has samples, the bridge matches the list with the same k-nearest-neighbours matcher the Android app uses and re-seeds the node at the matched zone's label point. `tick` places people at the centroid of the nodes that heard them, and `push_motion_batch` attributes counts to the node's current zone, so a node carried through the venue reports from wherever it is. Without fingerprints, nodes stay where `nodes.json` puts them.
- `--node`: the same binary as a sniffer: reads 802.11 frames with gopacket from a monitor-mode interface, hashes the transmitter MAC with `MAC_SALT`, and emits the line protocol to stdout or to `--connect host:port`.
- `--survey`: sniff while walking, type zone ids on stdin, write per-zone distinct-device counts with `set_survey_count`. With `--serial` the sniffer is an ESP32 on USB, the laptop keeps its wifi, and every `aps` line the node sends while a zone is open is saved as that zone's fingerprint, so one walk also teaches the venue. Otherwise the laptop's card on `--iface` in monitor mode.
- HTTP API on `--http :8080`: health, ask, privacy receipt, voice, pair code, bind MAC, fingerprint login/learn/locate/forget for the Android app (stored in `data/fingerprints.json`, gitignored). Pair code and bind MAC verify the caller's SpacetimeDB token against the identity, so a phone can only be bound to the person who holds it.

The Ask endpoint gives Claude one tool, `run_sql`, limited to SELECT on public tables with a row limit. Private tables (`sighting`, `device_binding`) are not reachable from it. Two more tools appear when their backing service is configured:

- `search_guide` (`internal/moss`): Moss cloud semantic search over `data/guide.json`, which holds one passage per zone, workshop, prize track and logistics item from the hacker guide. The bridge upserts the file into the index on every start, using Moss's manage and query HTTP endpoints directly (the Go SDK needs CGO). `/api/search?q=` exposes the same index to the client.
- `zone_history` (`internal/history`): every 30 seconds the bridge copies `anon_zone_count` and the max `zone_activity.smoothed_score` per zone into a Postgres table `zone_sample`, made a hypertable when the Timescale extension is present. `/api/history?zone=&hours=` returns five minute buckets (thirty minute past twelve hours). SpacetimeDB keeps no history, so this is the only place "when" questions can be answered. Only anonymous zone numbers are stored.

## Web client (`client/`)

Subscribes to the public tables plus the caller's own rows. Map coordinates are pixels of the organisers' Cal Hacks 13 floorplan (`client/public/venue-main.jpg`, 2956 x 1380, about 7 cm per pixel); `data/zones.json` holds a polygon per zone, `data/nodes.json` the node positions, and `data/landmarks.json` the rooms (with doors and dividers), walls, tables, sponsor booths, stage, entrances, mezzanine deck and staircases exported from the organisers' 3D render, with heights in metres. Two views share that data, switched by the `mode` URL parameter: a three.js scene (default) with the render's dark-grey floor, walled rooms coloured by kind, stepped staircases, tables and chairs, the mezzanine photo backdrop, zone slabs lit by count over capacity, and people as markers that glide between fixes and climb between floors (an X-ray toggle, `xray=1`, makes walls, stairs and the deck see-through); and an SVG plan with the same zones, booths and labels, eight-point star blips with fading trails and dashed amber circles for the live nodes. URL parameters also carry view, floor and selected zone.

## Android app (`android/`)

Scans wifi every ten seconds (throttling must be off in developer options), posts access point lists to the bridge, which matches them against learned zone fingerprints (k nearest neighbours on RSSI vectors) and calls `set_app_position`. Learn mode records labelled scans. iOS has no public scan API, so there is no iOS build.

## Firmware (`firmware/`)

ESP-IDF 5.5, ESP32-S3 (a plain ESP32 still builds with a UART console at 921600). Promiscuous sniffing on one channel, salted SHA-256 of MACs, CSI turbulence over a subcarrier window as a motion score, optional LCD1602 status line, line protocol over the native USB serial/JTAG port. The bridge registers each node on its `hello` line and sends `{"t":"walk","on":1}` while a walk capture is open for that node. Builds clean with and without the LCD option; not yet run on a board.
