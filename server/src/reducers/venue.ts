import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from '../tables';
import { requireIngest } from '../lib/ctx';

const NodeIn = t.object('NodeIn', {
  nodeId: t.u16(),
  zoneId: t.string(),
  label: t.string(),
  floor: t.u8(),
  x: t.f32(),
  y: t.f32(),
  isReal: t.bool(),
});

const ZoneIn = t.object('ZoneIn', {
  zoneId: t.string(),
  name: t.string(),
  kind: t.string(),
  floor: t.u8(),
  capacity: t.u16(),
});

// The first caller becomes the ingest identity. After that only an existing
// ingest identity can add another. Documented in HANDOFF.md.
export const registerIngest = spacetimedb.reducer({ label: t.string() }, (ctx, { label }) => {
  if (ctx.db.ingestKey.identity.find(ctx.sender)) return;
  if (ctx.db.ingestKey.count() > 0n) throw new SenderError('ingest already claimed; ask an existing ingest identity to add you');
  ctx.db.ingestKey.insert({ identity: ctx.sender, label });
});

export const addIngest = spacetimedb.reducer({ identity: t.identity(), label: t.string() }, (ctx, { identity, label }) => {
  requireIngest(ctx);
  if (!ctx.db.ingestKey.identity.find(identity)) ctx.db.ingestKey.insert({ identity, label });
});

export const seedNodes = spacetimedb.reducer({ nodes: t.array(NodeIn) }, (ctx, { nodes }) => {
  requireIngest(ctx);
  for (const n of nodes) {
    const existing = ctx.db.node.nodeId.find(n.nodeId);
    const row = { ...n, lastSeenAt: existing?.lastSeenAt ?? ctx.timestamp };
    if (existing) ctx.db.node.nodeId.update(row);
    else ctx.db.node.insert(row);
  }
});

export const seedZones = spacetimedb.reducer({ zones: t.array(ZoneIn) }, (ctx, { zones }) => {
  requireIngest(ctx);
  for (const z of zones) {
    if (ctx.db.zone.zoneId.find(z.zoneId)) ctx.db.zone.zoneId.update(z);
    else ctx.db.zone.insert(z);
  }
});

export const upsertVenue = spacetimedb.reducer(
  { venueId: t.string(), name: t.string(), ownerLogin: t.string() },
  (ctx, { venueId, name, ownerLogin }) => {
    requireIngest(ctx);
    const existing = ctx.db.venue.venueId.find(venueId);
    const row = { venueId, name, ownerLogin, createdAt: existing?.createdAt ?? ctx.timestamp };
    if (existing) ctx.db.venue.venueId.update(row);
    else ctx.db.venue.insert(row);
  }
);

export const upsertFloor = spacetimedb.reducer(
  { venueId: t.string(), index: t.u8(), name: t.string(), imageUrl: t.string(), width: t.f32(), height: t.f32() },
  (ctx, { venueId, index, name, imageUrl, width, height }) => {
    requireIngest(ctx);
    const row = { floorKey: `${venueId}/${index}`, venueId, index, name, imageUrl, width, height };
    if (ctx.db.floor.floorKey.find(row.floorKey)) ctx.db.floor.floorKey.update(row);
    else ctx.db.floor.insert(row);
  }
);

// Ids at or above 100 are real hardware, same rule as the bridge's seed.
export const placeNode = spacetimedb.reducer(
  { nodeId: t.u16(), venueId: t.string(), floor: t.u8(), x: t.f32(), y: t.f32(), label: t.string() },
  (ctx, { nodeId, venueId, floor, x, y, label }) => {
    requireIngest(ctx);
    const existing = ctx.db.node.nodeId.find(nodeId);
    const row = {
      nodeId,
      zoneId: existing?.zoneId ?? '',
      label: label || existing?.label || `Node ${nodeId}`,
      floor,
      x,
      y,
      isReal: nodeId >= 100,
      lastSeenAt: existing?.lastSeenAt ?? ctx.timestamp,
    };
    if (existing) ctx.db.node.nodeId.update(row);
    else ctx.db.node.insert(row);
    const link = { nodeId, venueId };
    if (ctx.db.venueNode.nodeId.find(nodeId)) ctx.db.venueNode.nodeId.update(link);
    else ctx.db.venueNode.insert(link);
  }
);

export const rememberBoard = spacetimedb.reducer(
  { mac: t.string(), nodeId: t.u16(), ownerLogin: t.string(), venueId: t.string() },
  (ctx, { mac, nodeId, ownerLogin, venueId }) => {
    requireIngest(ctx);
    const row = { mac, nodeId, ownerLogin, venueId, flashedAt: ctx.timestamp };
    if (ctx.db.board.mac.find(mac)) ctx.db.board.mac.update(row);
    else ctx.db.board.insert(row);
  }
);

export const forgetBoard = spacetimedb.reducer({ mac: t.string() }, (ctx, { mac }) => {
  requireIngest(ctx);
  ctx.db.board.mac.delete(mac);
});
