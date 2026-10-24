import { t } from 'spacetimedb/server';
import spacetimedb from '../tables';
import { requireIngest, type Ctx } from '../lib/ctx';

const MotionIn = t.object('MotionIn', {
  nodeId: t.u16(),
  score: t.f32(),
  state: t.string(),
  pir: t.bool(),
  anonCount: t.u16(),
});

const SightIn = t.object('SightIn', { macHash: t.string(), rssi: t.i16() });
const NodeSightsIn = t.object('NodeSightsIn', { nodeId: t.u16(), items: t.array(SightIn) });

const SMOOTH = 0.6;

function touchNode(ctx: Ctx, nodeId: number) {
  const n = ctx.db.node.nodeId.find(nodeId);
  if (n) ctx.db.node.nodeId.update({ ...n, lastSeenAt: ctx.timestamp });
}

function pairingOpenAt(ctx: Ctx, nodeId: number): boolean {
  for (const s of ctx.db.pairingSession.nodeId.filter(nodeId)) if (s.status === 'open') return true;
  return false;
}

export const pushMotionBatch = spacetimedb.reducer({ items: t.array(MotionIn) }, (ctx, { items }) => {
  requireIngest(ctx);
  for (const m of items) {
    const node = ctx.db.node.nodeId.find(m.nodeId);
    if (!node) continue;
    const prev = ctx.db.zoneActivity.nodeId.find(m.nodeId);
    const smoothed = prev ? prev.smoothedScore * (1 - SMOOTH) + m.score * SMOOTH : m.score;
    const row = { nodeId: m.nodeId, zoneId: node.zoneId, score: m.score, smoothedScore: smoothed, state: m.state, pir: m.pir, anonCount: m.anonCount, updatedAt: ctx.timestamp };
    if (prev) ctx.db.zoneActivity.nodeId.update(row);
    else ctx.db.zoneActivity.insert(row);
    touchNode(ctx, m.nodeId);
  }
});

// Only hashes of bound phones are kept, plus every hash at a node while a
// pairing session is open there. Everything else is dropped on arrival.
export const pushSightingsBatch = spacetimedb.reducer({ nodes: t.array(NodeSightsIn) }, (ctx, { nodes }) => {
  requireIngest(ctx);
  for (const n of nodes) {
    if (!ctx.db.node.nodeId.find(n.nodeId)) continue;
    const keepAll = pairingOpenAt(ctx, n.nodeId);
    for (const s of n.items) {
      if (!keepAll && !ctx.db.deviceBinding.macHash.find(s.macHash)) continue;
      ctx.db.sighting.insert({ id: 0n, nodeId: n.nodeId, macHash: s.macHash, rssi: s.rssi, ts: ctx.timestamp });
    }
    touchNode(ctx, n.nodeId);
  }
});

// CSI frames only matter while someone is recording a walk at that node.
export const pushCsi = spacetimedb.reducer({ nodeId: t.u16(), amps: t.array(t.f32()) }, (ctx, { nodeId, amps }) => {
  requireIngest(ctx);
  const cap = ctx.db.walkCapture.nodeId.find(nodeId);
  if (!cap) return;
  if (cap.frames.length > 12 * 600) return; // 60 s at 10 Hz is plenty
  const frames = [...cap.frames, ...amps];
  ctx.db.walkCapture.nodeId.update({ ...cap, frames });
  const beacon = ctx.db.walkBeacon.nodeId.find(nodeId);
  if (beacon) ctx.db.walkBeacon.nodeId.update({ ...beacon, frameCount: frames.length });
});
