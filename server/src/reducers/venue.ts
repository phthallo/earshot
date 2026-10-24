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
