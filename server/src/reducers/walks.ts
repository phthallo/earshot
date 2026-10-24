import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from '../tables';
import { requirePerson } from '../lib/ctx';
import { centroid, distance, features, synthesize } from '../lib/augment';

export const REAL_WALKS = 3;

// Start recording CSI at a node. The bridge streams frames into walk_capture
// via push_csi until finish_walk or cancel_walk.
export const startWalk = spacetimedb.reducer({ nodeId: t.u16() }, (ctx, { nodeId }) => {
  const p = requirePerson(ctx);
  if (!ctx.db.node.nodeId.find(nodeId)) throw new SenderError('unknown node');
  const busy = ctx.db.walkCapture.nodeId.find(nodeId);
  if (busy && !busy.identity.equals(ctx.sender)) throw new SenderError('someone else is recording at that node');
  const done = [...ctx.db.enrolmentWalk.identity.filter(ctx.sender)].filter((w) => !w.synthetic).length;
  const row = { nodeId, identity: ctx.sender, personId: p.personId, sampleIdx: done, frames: [] as number[], startedAt: ctx.timestamp };
  if (busy) ctx.db.walkCapture.nodeId.update(row);
  else ctx.db.walkCapture.insert(row);
  // Public mirror without identity so the bridge knows where to stream CSI.
  const beacon = { nodeId, personId: p.personId, frameCount: 0 };
  if (ctx.db.walkBeacon.nodeId.find(nodeId)) ctx.db.walkBeacon.nodeId.update(beacon);
  else ctx.db.walkBeacon.insert(beacon);
});

export const cancelWalk = spacetimedb.reducer((ctx) => {
  for (const c of [...ctx.db.walkCapture.iter()]) {
    if (!c.identity.equals(ctx.sender)) continue;
    ctx.db.walkCapture.nodeId.delete(c.nodeId);
    ctx.db.walkBeacon.nodeId.delete(c.nodeId);
  }
});

function recompute(ctx: Parameters<typeof requirePerson>[0], personId: number) {
  const walks = [...ctx.db.enrolmentWalk.iter()].filter((w) => w.personId === personId);
  const real = walks.filter((w) => !w.synthetic).length;
  const row = { personId, centroid: centroid(walks.map((w) => w.features)), nReal: real, nSynthetic: walks.length - real, updatedAt: ctx.timestamp };
  if (ctx.db.signature.personId.find(personId)) ctx.db.signature.personId.update(row);
  else ctx.db.signature.insert(row);
}

// One real walk becomes one real row plus three synthetic rows (time warp,
// amplitude jitter, subcarrier dropout). Labelled so the UI can say so.
export const finishWalk = spacetimedb.reducer((ctx) => {
  const p = requirePerson(ctx);
  const cap = [...ctx.db.walkCapture.iter()].find((c) => c.identity.equals(ctx.sender));
  if (!cap) throw new SenderError('no walk in progress');
  if (cap.frames.length < 12 * 10) throw new SenderError('too short, walk past the node again');
  ctx.db.walkCapture.nodeId.delete(cap.nodeId);
  ctx.db.walkBeacon.nodeId.delete(cap.nodeId);
  const base = { walkId: 0n, identity: ctx.sender, personId: p.personId, nodeId: cap.nodeId, sampleIdx: cap.sampleIdx, recordedAt: ctx.timestamp };
  ctx.db.enrolmentWalk.insert({ ...base, synthetic: false, features: features(cap.frames) });
  for (const v of synthesize(cap.frames, () => ctx.random())) {
    ctx.db.enrolmentWalk.insert({ ...base, synthetic: true, features: features(v) });
  }
  recompute(ctx, p.personId);
});

// Match the current capture against every enrolled signature, then drop it.
export const matchWalk = spacetimedb.reducer((ctx) => {
  requirePerson(ctx);
  const cap = [...ctx.db.walkCapture.iter()].find((c) => c.identity.equals(ctx.sender));
  if (!cap) throw new SenderError('no walk in progress');
  if (cap.frames.length < 12 * 10) throw new SenderError('too short, walk past the node again');
  ctx.db.walkCapture.nodeId.delete(cap.nodeId);
  ctx.db.walkBeacon.nodeId.delete(cap.nodeId);
  const probe = features(cap.frames);
  let bestId = 0;
  let best = Infinity;
  let second = Infinity;
  let n = 0;
  for (const s of ctx.db.signature.iter()) {
    n++;
    const d = distance(probe, s.centroid);
    if (d < best) {
      second = best;
      best = d;
      bestId = s.personId;
    } else if (d < second) second = d;
  }
  const row = { identity: ctx.sender, matchedPersonId: bestId, distance: n ? best : 0, secondDistance: n > 1 ? second : 0, nCandidates: n, at: ctx.timestamp };
  if (ctx.db.matchResult.identity.find(ctx.sender)) ctx.db.matchResult.identity.update(row);
  else ctx.db.matchResult.insert(row);
});

export const resetWalks = spacetimedb.reducer((ctx) => {
  const p = requirePerson(ctx);
  for (const w of [...ctx.db.enrolmentWalk.identity.filter(ctx.sender)]) ctx.db.enrolmentWalk.walkId.delete(w.walkId);
  ctx.db.signature.personId.delete(p.personId);
  ctx.db.matchResult.identity.delete(ctx.sender);
});
