# Venue admin

Sign in with GitHub, create a venue, upload one render per floor, flash nodes from the browser and place them on the plan by clicking. The bridge is the authority: it holds the GitHub session and is the only SpacetimeDB identity allowed to write venue, floor, node and board rows.

## Sign-in

GitHub OAuth web flow, handled by the bridge.

| Route | Purpose |
|---|---|
| `GET /api/auth/github?return=<url>` | Redirects to GitHub. Needs `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Without them the bridge signs the caller in as `local` so the flow still works on a laptop, and `/api/auth/me` says `provider: "local"`. |
| `GET /api/auth/github/callback` | Exchanges the code, reads the login, sets the `earshot_session` cookie (HMAC-signed with `SESSION_SECRET`, 30 days, `SameSite=Lax`), redirects to `return`. |
| `GET /api/auth/me` | `{ login, avatarUrl, provider }` or 401. |
| `POST /api/auth/logout` | Clears the cookie. |

CORS: when a request carries `Origin`, the bridge echoes it and sets `Access-Control-Allow-Credentials: true`. The client sends `credentials: 'include'`.

## Venues and floors

Tables in SpacetimeDB, all public, written only by ingest identities.

```
venue  { venueId: string PK, name: string, ownerLogin: string, createdAt: timestamp }
floor  { floorKey: string PK ("<venueId>/<index>"), venueId: string, index: u8, name: string,
         imageUrl: string, width: f32, height: f32 }
board  { mac: string PK, nodeId: u16, ownerLogin: string, venueId: string, flashedAt: timestamp }
node   unchanged: nodeId PK, zoneId, label, floor, x, y, isReal, lastSeenAt
venue_node { nodeId: u16 PK, venueId: string }
```

Reducers (ingest only): `upsertVenue`, `upsertFloor`, `placeNode { nodeId, venueId, floor, x, y, label }`, `rememberBoard { mac, nodeId, ownerLogin, venueId }`, `forgetBoard { mac }`.

The built-in Cal Hacks venue is `venueId: "calhacks"`, owner `""`, upserted by the bridge at startup with floors 1 "Ground floor" and 2 "Mezzanine". Any signed-in user may place nodes there (hackathon demo). Other venues accept writes only from their owner. Bridge env: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (GitHub OAuth app with callback `<PUBLIC_URL>/api/auth/github/callback`), `SESSION_SECRET` (random per process when unset, so sessions end on restart), `CLIENT_URL` (the only non-localhost origin `return` may point at), `PUBLIC_URL` (where browsers reach the bridge).

Bridge routes, cookie required, JSON bodies unless noted:

| Route | Body | Effect |
|---|---|---|
| `GET /api/admin/venues` | | `[{venueId, name, ownerLogin, createdAt}]`: venues owned by the caller, plus `calhacks`. Floors and boards come from the `floor` and `board` tables over the SpacetimeDB subscription. |
| `POST /api/admin/venues` | `{ venueId, name }` | `venueId` is a slug `[a-z0-9-]{2,40}`. 409 if taken by someone else. |
| `POST /api/admin/venues/{venueId}/floors` | multipart: `index`, `name`, `image` (png/jpg/webp, max 10 MB) | Saves to `data/uploads/<venueId>/<index>.<ext>` (gitignored), served at `/uploads/...`, upserts the floor row with the image's pixel size. `imageUrl` is absolute: `PUBLIC_URL` or the request origin plus the upload path. The Cal Hacks floors keep `/venue-main.jpg` and `/venue-mezz.jpg`, served by the client. |
| `POST /api/admin/nodes/place` | `{ nodeId, venueId, floor, x, y, label? }` | Upserts the node row and `venue_node`. For `calhacks` the bridge also updates its in-memory node list so anonymous dots and the mock use the new position. Plan units: for `calhacks` the 2956x1380 plan; for uploaded floors, image pixels. |
| `POST /api/admin/boards` | `{ mac, nodeId, venueId }` | remember a flashed board. |
| `DELETE /api/admin/boards/{mac}` | | forget it. Only the login that remembered it may. |
| `GET /api/venues/calhacks/export` | | JSON bundle of the hardcoded render: `{ venueId, name, plan: {width, height, metersPerUnit}, floors: [{index, name, imageUrl}], zones, nodes, landmarks }`. Served as a download (`Content-Disposition: attachment; filename=calhacks-venue.json`). No auth. |

## Flashing from the browser

`client/public/firmware/manifest-usb.json` and `manifest-battery.json` point at the two builds under `client/public/firmware/`. The page uses `esp-web-tools` (`<esp-web-install-button manifest=...>`) over Web Serial. Chrome or Edge on desktop over `https://` or `localhost`.

After flashing, the page opens the port itself at 115200, sends `{"t":"set","id":104}` and reads back the hello line:

```
{"t":"hello","id":104,"fw":"esp-0.2","ch":6,"mac":"b4:fb:e4:1e:c0:23","uplink":"espnow"}
```

The firmware keeps the id in NVS (`venuemap/id`) and falls back to `CONFIG_VENUEMAP_NODE_ID` when nothing is stored. The `set` reply is always printed on USB, even on a battery build whose normal lines go over ESP-NOW. The page then calls `POST /api/admin/boards` with the mac and id.

## Client

New view `admin` (nav label "Venues"). States: signed out (GitHub button), venue list, venue page with three parts: floors (upload, list), nodes (boards remembered, flash button, set id), and place mode (pick a node, click the plan). For `calhacks` the plan is the existing 2D map; for other venues it is the uploaded image with node pins. The floor switcher lists the venue's floors.
