import { schema, table, t } from 'spacetimedb/server';

// Venue geometry. Seeded by the bridge from data/nodes.json and data/zones.json.
export const node = table(
  { name: 'node', public: true },
  {
    nodeId: t.u16().primaryKey(),
    zoneId: t.string(),
    label: t.string(),
    floor: t.u8(),
    x: t.f32(),
    y: t.f32(),
    isReal: t.bool(),
    lastSeenAt: t.timestamp(),
  }
);

export const zone = table(
  { name: 'zone', public: true },
  {
    zoneId: t.string().primaryKey(),
    name: t.string(),
    kind: t.string(),
    floor: t.u8(),
    capacity: t.u16(),
  }
);

// Venues made in the admin page. The built-in Cal Hacks venue is "calhacks"
// with an empty owner; the bridge is the only writer.
export const venue = table(
  { name: 'venue', public: true },
  {
    venueId: t.string().primaryKey(),
    name: t.string(),
    ownerLogin: t.string(),
    createdAt: t.timestamp(),
    // SHA-256 hex of the relay key a venue's relay sends on connect; '' when none was made.
    // The key itself is shown once in the admin page and never stored.
    ingestKeyHash: t.string().default(''),
  }
);

export const floor = table(
  { name: 'floor', public: true },
  {
    // "<venueId>/<index>"
    floorKey: t.string().primaryKey(),
    venueId: t.string(),
    index: t.u8(),
    name: t.string(),
    imageUrl: t.string(),
    // Plan units: image pixels for uploaded floors.
    width: t.f32(),
    height: t.f32(),
  }
);

// Boards flashed from the browser, by MAC.
export const board = table(
  { name: 'board', public: true },
  {
    mac: t.string().primaryKey(),
    nodeId: t.u16(),
    ownerLogin: t.string(),
    venueId: t.string(),
    flashedAt: t.timestamp(),
  }
);

export const venueNode = table(
  { name: 'venue_node', public: true },
  {
    nodeId: t.u16().primaryKey(),
    venueId: t.string(),
  }
);

// Per-node motion, one row per node, overwritten every second.
export const zoneActivity = table(
  { name: 'zone_activity', public: true },
  {
    nodeId: t.u16().primaryKey(),
    zoneId: t.string(),
    score: t.f32(),
    smoothedScore: t.f32(),
    state: t.string(),
    pir: t.bool(),
    anonCount: t.u16(),
    updatedAt: t.timestamp(),
  }
);

export const anonZoneCount = table(
  { name: 'anon_zone_count', public: true },
  {
    zoneId: t.string().primaryKey(),
    count: t.u16(),
    // live: a real node heard them. mock: the replayer. survey: a walk with the laptop.
    source: t.string(),
    updatedAt: t.timestamp(),
  }
);

// Where the real nodes hear unregistered phones: one dot per phone, placed by
// the bridge between the nodes that heard it, rounded to about a metre. The
// set is replaced on every push.
export const anonPoint = table(
  { name: 'anon_point', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    floor: t.u8(),
    x: t.f32(),
    y: t.f32(),
    // Strongest RSSI any node heard, so the client can fade distant phones.
    rssi: t.i16(),
    updatedAt: t.timestamp(),
    // One byte of the phone's salted hash, so a dot keeps its colour between
    // pushes and can be followed by eye. 256 buckets identify nobody.
    // Last with a default so the hosted table migrates in place.
    hue: t.u8().default(0),
    // The full salted hash, so a click on the dot can ask the bridge for the
    // phone's MAC and sightings. The MAC itself stays in bridge memory.
    hash: t.string().default(''),
    // The phone sent a factory address rather than one made up for this
    // network, so the same dot can be followed across networks and days.
    stable: t.bool().default(false),
    // Which venue's nodes heard the phone; each push replaces one venue's dots only.
    venueId: t.string().default(''),
  }
);

export const person = table(
  { name: 'person', public: true },
  {
    personId: t.u32().primaryKey().autoInc(),
    identity: t.identity().unique(),
    displayName: t.string(),
    team: t.string(),
    color: t.string(),
    visible: t.bool(),
    paired: t.bool(),
    createdAt: t.timestamp(),
  }
);

export const position = table(
  { name: 'position', public: true },
  {
    personId: t.u32().primaryKey(),
    nodeId: t.u16(),
    zoneId: t.string(),
    floor: t.u8(),
    // RSSI-weighted centroid of the nodes that heard the phone, in map units.
    x: t.f32(),
    y: t.f32(),
    // node: sniffer nodes heard the phone. app: the phone app sent a wifi fingerprint.
    source: t.string(),
    candidateNodeId: t.u16(),
    candidateSince: t.timestamp(),
    medianRssi: t.i16(),
    confidence: t.f32(),
    updatedAt: t.timestamp(),
  }
);

// Private: the centroid is a biometric template.
export const signature = table(
  { name: 'signature' },
  {
    personId: t.u32().primaryKey(),
    centroid: t.array(t.f32()),
    nReal: t.u16(),
    nSynthetic: t.u16(),
    updatedAt: t.timestamp(),
  }
);

// Public mirrors of the own-row session tables, without identities, so the
// bridge (not the database owner) can see which nodes are pairing or recording.
export const pairingBeacon = table(
  { name: 'pairing_beacon', public: true },
  {
    sessionId: t.u64().primaryKey(),
    nodeId: t.u16(),
    startedAt: t.timestamp(),
  }
);

export const walkBeacon = table(
  { name: 'walk_beacon', public: true },
  {
    nodeId: t.u16().primaryKey(),
    personId: t.u32(),
    frameCount: t.u32(),
  }
);

// Own-row tables. Public so the SDK can subscribe, filtered to the owner by the
// visibility filters in index.ts.
export const deviceBinding = table(
  { name: 'device_binding', public: true },
  {
    macHash: t.string().primaryKey(),
    identity: t.identity().index('btree'),
    personId: t.u32(),
    method: t.string(),
    boundAt: t.timestamp(),
  }
);

export const pairingSession = table(
  { name: 'pairing_session', public: true },
  {
    sessionId: t.u64().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    nodeId: t.u16().index('btree'),
    startedAt: t.timestamp(),
    closesAt: t.timestamp(),
    status: t.string(),
    resultMacHash: t.string(),
  }
);

export const enrolmentWalk = table(
  { name: 'enrolment_walk', public: true },
  {
    walkId: t.u64().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    personId: t.u32(),
    nodeId: t.u16(),
    sampleIdx: t.u8(),
    synthetic: t.bool(),
    features: t.array(t.f32()),
    recordedAt: t.timestamp(),
  }
);

export const matchResult = table(
  { name: 'match_result', public: true },
  {
    identity: t.identity().primaryKey(),
    matchedPersonId: t.u32(),
    distance: t.f32(),
    secondDistance: t.f32(),
    nCandidates: t.u16(),
    at: t.timestamp(),
  }
);

// Private tables. Never reach a client.
export const sighting = table(
  { name: 'sighting' },
  {
    id: t.u64().primaryKey().autoInc(),
    nodeId: t.u16().index('btree'),
    macHash: t.string().index('btree'),
    rssi: t.i16(),
    ts: t.timestamp().index('btree'),
  }
);

export const walkCapture = table(
  { name: 'walk_capture' },
  {
    nodeId: t.u16().primaryKey(),
    identity: t.identity(),
    personId: t.u32(),
    sampleIdx: t.u8(),
    frames: t.array(t.f32()),
    startedAt: t.timestamp(),
  }
);

export const ingestKey = table(
  { name: 'ingest_key' },
  {
    identity: t.identity().primaryKey(),
    label: t.string(),
  }
);

export const tickSchedule = table(
  { name: 'tick_schedule' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

export const spacetimedb = schema({
  node,
  zone,
  venue,
  floor,
  board,
  venueNode,
  zoneActivity,
  anonZoneCount,
  anonPoint,
  person,
  position,
  signature,
  pairingBeacon,
  walkBeacon,
  deviceBinding,
  pairingSession,
  enrolmentWalk,
  matchResult,
  sighting,
  walkCapture,
  ingestKey,
  tickSchedule,
});

export default spacetimedb;
