import { Range } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import spacetimedb, { tickSchedule } from '../tables';
import { fromMs, toMs, type Ctx } from '../lib/ctx';
import {
  EXPIRE_MS,
  IDLE_DECAY,
  IDLE_MS,
  SIGHTING_RETENTION_MS,
  WINDOW_MS,
  centroid,
  medianByNode,
  nextPosition,
  pickPairingMac,
  type Pos,
  type Sight,
} from '../lib/position';
import { bind, PAIRING_WARMUP_MS } from './people';

export const TICK_MS = 500;
// App fingerprints arrive every 5 to 30 s depending on the phone's scan throttle.
export const APP_EXPIRE_MS = 120000;
// A survey count stands in for a zone with no live node for this long.
export const SURVEY_TTL_MS = 3 * 60 * 60 * 1000;

const from = (ts: Timestamp) => new Range<Timestamp>({ tag: 'included', value: ts }, { tag: 'unbounded' });
const before = (ts: Timestamp) => new Range<Timestamp>({ tag: 'unbounded' }, { tag: 'excluded', value: ts });

function updatePositions(ctx: Ctx, nowMs: number) {
  const windowStart = fromMs(nowMs - WINDOW_MS);
  const byPerson = new Map<number, Sight[]>();
  const bindingCache = new Map<string, number | null>();
  for (const s of ctx.db.sighting.ts.filter(from(windowStart))) {
    let pid = bindingCache.get(s.macHash);
    if (pid === undefined) {
      pid = ctx.db.deviceBinding.macHash.find(s.macHash)?.personId ?? null;
      bindingCache.set(s.macHash, pid);
    }
    if (pid === null) continue;
    const sight: Sight = { nodeId: s.nodeId, macHash: s.macHash, rssi: s.rssi, tsMs: toMs(s.ts) };
    const arr = byPerson.get(pid);
    if (arr) arr.push(sight);
    else byPerson.set(pid, [sight]);
  }

  for (const [personId, sights] of byPerson) {
    const existing = ctx.db.position.personId.find(personId);
    // An app position is replaced outright the moment a node hears the phone.
    const prev: Pos | null = existing && existing.source === 'node'
      ? { nodeId: existing.nodeId, candidateNodeId: existing.candidateNodeId, candidateSinceMs: toMs(existing.candidateSince), medianRssi: existing.medianRssi, confidence: existing.confidence, updatedMs: toMs(existing.updatedAt) }
      : null;
    const stats = medianByNode(sights);
    const next = nextPosition(prev, stats, nowMs);
    if (!next) continue;
    const node = ctx.db.node.nodeId.find(next.nodeId);
    if (!node) continue;
    const pts = [];
    for (const [nodeId, st] of stats) {
      const n = ctx.db.node.nodeId.find(nodeId);
      if (n && n.floor === node.floor) pts.push({ x: n.x, y: n.y, rssi: st.median });
    }
    const c = centroid(pts) ?? { x: node.x, y: node.y };
    const row = {
      personId,
      nodeId: next.nodeId,
      zoneId: node.zoneId,
      floor: node.floor,
      x: c.x,
      y: c.y,
      source: 'node',
      candidateNodeId: next.candidateNodeId,
      candidateSince: fromMs(next.candidateSinceMs),
      medianRssi: Math.round(next.medianRssi),
      confidence: next.confidence,
      updatedAt: fromMs(next.updatedMs),
    };
    if (existing) ctx.db.position.personId.update(row);
    else ctx.db.position.insert(row);
  }

  for (const p of [...ctx.db.position.iter()]) {
    const ttl = p.source === 'app' ? APP_EXPIRE_MS : EXPIRE_MS;
    if (nowMs - toMs(p.updatedAt) > ttl) ctx.db.position.personId.delete(p.personId);
  }
}

function closePairings(ctx: Ctx, nowMs: number) {
  for (const s of [...ctx.db.pairingSession.iter()]) {
    if (s.status !== 'open' || toMs(s.closesAt) > nowMs) continue;
    const split = toMs(s.startedAt) + PAIRING_WARMUP_MS;
    const seenBefore = new Set<string>();
    const window: Sight[] = [];
    for (const row of ctx.db.sighting.nodeId.filter(s.nodeId)) {
      const t = toMs(row.ts);
      if (t < toMs(s.startedAt)) continue;
      if (t < split) seenBefore.add(row.macHash);
      else window.push({ nodeId: row.nodeId, macHash: row.macHash, rssi: row.rssi, tsMs: t });
    }
    const bound = new Set<string>();
    for (const b of ctx.db.deviceBinding.iter()) bound.add(b.macHash);
    const mac = pickPairingMac(window, seenBefore, bound);

    const person = ctx.db.person.identity.find(s.identity);
    if (mac && person) {
      bind(ctx, person.personId, s.identity, mac, 'pair');
      ctx.db.pairingSession.sessionId.update({ ...s, status: 'done', resultMacHash: mac });
    } else {
      ctx.db.pairingSession.sessionId.update({ ...s, status: 'failed' });
    }
    ctx.db.pairingBeacon.sessionId.delete(s.sessionId);
    // Hashes of bystanders recorded during the session are not kept.
    for (const row of [...ctx.db.sighting.nodeId.filter(s.nodeId)]) {
      if (!bound.has(row.macHash) && row.macHash !== mac) ctx.db.sighting.id.delete(row.id);
    }
  }
}

function decayActivity(ctx: Ctx, nowMs: number) {
  // Real nodes in one zone are close together and hear the same phones, so a
  // live zone takes the largest count among them and ignores the mock nodes.
  const counts = new Map<string, { mock: number; liveMax: number; live: boolean }>();
  for (const a of [...ctx.db.zoneActivity.iter()]) {
    const age = nowMs - toMs(a.updatedAt);
    if (age > IDLE_MS && a.smoothedScore > 0.01) {
      ctx.db.zoneActivity.nodeId.update({ ...a, smoothedScore: a.smoothedScore * IDLE_DECAY, state: 'idle', pir: false });
    }
    const fresh = age <= EXPIRE_MS;
    const isReal = ctx.db.node.nodeId.find(a.nodeId)?.isReal ?? false;
    const cur = counts.get(a.zoneId) ?? { mock: 0, liveMax: 0, live: false };
    if (fresh && isReal) {
      cur.live = true;
      cur.liveMax = Math.max(cur.liveMax, a.anonCount);
    } else if (fresh) cur.mock += a.anonCount;
    counts.set(a.zoneId, cur);
  }
  for (const [zoneId, c] of counts) {
    const existing = ctx.db.anonZoneCount.zoneId.find(zoneId);
    // A recent survey beats the mock crowd, never a live node.
    if (existing && existing.source === 'survey' && !c.live && nowMs - toMs(existing.updatedAt) < SURVEY_TTL_MS) continue;
    const row = { zoneId, count: Math.min(65535, c.live ? c.liveMax : c.mock), source: c.live ? 'live' : 'mock', updatedAt: ctx.timestamp };
    if (existing) ctx.db.anonZoneCount.zoneId.update(row);
    else ctx.db.anonZoneCount.insert(row);
  }
}

export const tick = spacetimedb.reducer({ onSchedule: tickSchedule }, { timer: tickSchedule.rowType }, (ctx, _args) => {
  const nowMs = toMs(ctx.timestamp);
  updatePositions(ctx, nowMs);
  closePairings(ctx, nowMs);
  decayActivity(ctx, nowMs);
  ctx.db.sighting.ts.delete(before(fromMs(nowMs - SIGHTING_RETENTION_MS)));
});
