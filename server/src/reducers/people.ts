import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from '../tables';
import { plusMs, requireIngest, requirePerson, type Ctx } from '../lib/ctx';

export const PAIRING_WARMUP_MS = 5000;
export const PAIRING_WINDOW_MS = 5000;

export const upsertPerson = spacetimedb.reducer(
  { displayName: t.string(), team: t.string(), color: t.string() },
  (ctx, { displayName, team, color }) => {
    const name = displayName.trim().slice(0, 24);
    if (!name) throw new SenderError('enter a name');
    const existing = ctx.db.person.identity.find(ctx.sender);
    if (existing) {
      ctx.db.person.personId.update({ ...existing, displayName: name, team: team.trim().slice(0, 24), color });
      return;
    }
    ctx.db.person.insert({ personId: 0, identity: ctx.sender, displayName: name, team: team.trim().slice(0, 24), color, visible: true, paired: false, createdAt: ctx.timestamp });
  }
);

// Fingerprint app path. The bridge classified a wifi scan into a zone and
// calls this as the ingest identity. The phone app signed in with a pair
// code the bridge derives from the person id, so no code is stored here.
// Sniffer nodes win over the app when both have heard the phone recently.
export const APP_OVERRIDE_MS = 10000;

export const setAppPosition = spacetimedb.reducer(
  { personId: t.u32(), zoneId: t.string(), confidence: t.f32() },
  (ctx, { personId, zoneId, confidence }) => {
    requireIngest(ctx);
    const p = ctx.db.person.personId.find(personId);
    if (!p) throw new SenderError('unknown person');
    const z = ctx.db.zone.zoneId.find(zoneId);
    if (!z) throw new SenderError('unknown zone');
    const nodes = [...ctx.db.node.iter()].filter((n) => n.zoneId === zoneId);
    if (nodes.length === 0) throw new SenderError('zone has no node');
    const existing = ctx.db.position.personId.find(personId);
    const nowMs = Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
    if (existing && existing.source === 'node' && nowMs - Number(existing.updatedAt.microsSinceUnixEpoch / 1000n) < APP_OVERRIDE_MS) return;
    const x = nodes.reduce((a, n) => a + n.x, 0) / nodes.length;
    const y = nodes.reduce((a, n) => a + n.y, 0) / nodes.length;
    const row = {
      personId,
      nodeId: nodes[0].nodeId,
      zoneId,
      floor: z.floor,
      x,
      y,
      source: 'app',
      candidateNodeId: nodes[0].nodeId,
      candidateSince: ctx.timestamp,
      medianRssi: 0,
      confidence: Math.max(0, Math.min(1, confidence)),
      updatedAt: ctx.timestamp,
    };
    if (existing) ctx.db.position.personId.update(row);
    else ctx.db.position.insert(row);
  }
);

// Survey walk: the laptop counted distinct phones in a zone. Kept until a
// live node for that zone reports, or for SURVEY_TTL_MS.
export const setSurveyCount = spacetimedb.reducer({ zoneId: t.string(), count: t.u16() }, (ctx, { zoneId, count }) => {
  requireIngest(ctx);
  if (!ctx.db.zone.zoneId.find(zoneId)) throw new SenderError('unknown zone');
  const row = { zoneId, count, source: 'survey', updatedAt: ctx.timestamp };
  if (ctx.db.anonZoneCount.zoneId.find(zoneId)) ctx.db.anonZoneCount.zoneId.update(row);
  else ctx.db.anonZoneCount.insert(row);
});

export const setTeam = spacetimedb.reducer({ team: t.string() }, (ctx, { team }) => {
  const p = requirePerson(ctx);
  ctx.db.person.personId.update({ ...p, team: team.trim().slice(0, 24) });
});

export const setVisible = spacetimedb.reducer({ visible: t.bool() }, (ctx, { visible }) => {
  const p = requirePerson(ctx);
  ctx.db.person.personId.update({ ...p, visible });
  // The position table is public, so hiding has to remove the row.
  if (!visible) ctx.db.position.personId.delete(p.personId);
});

// Pairing: 5 s warm-up where every hash at the node is recorded as "already
// here", then a 5 s window where the strongest new hash wins. The tick closes it.
export const startPairing = spacetimedb.reducer({ nodeId: t.u16() }, (ctx, { nodeId }) => {
  requirePerson(ctx);
  if (!ctx.db.node.nodeId.find(nodeId)) throw new SenderError('unknown node');
  cancelOpenSessions(ctx);
  const s = ctx.db.pairingSession.insert({
    sessionId: 0n,
    identity: ctx.sender,
    nodeId,
    startedAt: ctx.timestamp,
    closesAt: plusMs(ctx.timestamp, PAIRING_WARMUP_MS + PAIRING_WINDOW_MS),
    status: 'open',
    resultMacHash: '',
  });
  // The beacon is public and carries no identity, so the bridge can see which
  // nodes are pairing without reading the own-row session table.
  ctx.db.pairingBeacon.insert({ sessionId: s.sessionId, nodeId, startedAt: ctx.timestamp });
});

export const cancelPairing = spacetimedb.reducer((ctx) => {
  cancelOpenSessions(ctx);
});

function cancelOpenSessions(ctx: Ctx) {
  for (const s of ctx.db.pairingSession.identity.filter(ctx.sender)) {
    if (s.status !== 'open') continue;
    ctx.db.pairingSession.sessionId.update({ ...s, status: 'cancelled' });
    ctx.db.pairingBeacon.sessionId.delete(s.sessionId);
  }
}

export function bind(ctx: Ctx, personId: number, identity: typeof ctx.sender, macHash: string, method: string) {
  const existing = ctx.db.deviceBinding.macHash.find(macHash);
  if (existing && existing.personId !== personId) throw new SenderError('that phone is already paired to someone else');
  if (!existing) ctx.db.deviceBinding.insert({ macHash, identity, personId, method, boundAt: ctx.timestamp });
  const p = ctx.db.person.personId.find(personId);
  if (p && !p.paired) ctx.db.person.personId.update({ ...p, paired: true });
}

// Typed-in MAC path. The bridge hashes the MAC with MAC_SALT and calls this as
// the ingest identity, naming the person it is for.
export const bindMacFor = spacetimedb.reducer({ personId: t.u32(), macHash: t.string() }, (ctx, { personId, macHash }) => {
  requireIngest(ctx);
  const p = ctx.db.person.personId.find(personId);
  if (!p) throw new SenderError('unknown person');
  bind(ctx, personId, p.identity, macHash, 'manual');
});

export const unbindDevice = spacetimedb.reducer({ macHash: t.string() }, (ctx, { macHash }) => {
  const p = requirePerson(ctx);
  const b = ctx.db.deviceBinding.macHash.find(macHash);
  if (!b || b.personId !== p.personId) throw new SenderError('not your device');
  ctx.db.deviceBinding.macHash.delete(macHash);
  ctx.db.sighting.macHash.delete(macHash);
  if ([...ctx.db.deviceBinding.identity.filter(ctx.sender)].length === 0) {
    ctx.db.person.personId.update({ ...p, paired: false });
    ctx.db.position.personId.delete(p.personId);
  }
});

// Everything about the caller, gone in one call.
export const deleteMe = spacetimedb.reducer((ctx) => {
  const p = ctx.db.person.identity.find(ctx.sender);
  if (!p) return;
  for (const b of [...ctx.db.deviceBinding.identity.filter(ctx.sender)]) {
    ctx.db.sighting.macHash.delete(b.macHash);
    ctx.db.deviceBinding.macHash.delete(b.macHash);
  }
  for (const s of [...ctx.db.pairingSession.identity.filter(ctx.sender)]) ctx.db.pairingSession.sessionId.delete(s.sessionId);
  for (const w of [...ctx.db.enrolmentWalk.identity.filter(ctx.sender)]) ctx.db.enrolmentWalk.walkId.delete(w.walkId);
  for (const c of [...ctx.db.walkCapture.iter()]) if (c.identity.equals(ctx.sender)) ctx.db.walkCapture.nodeId.delete(c.nodeId);
  ctx.db.matchResult.identity.delete(ctx.sender);
  ctx.db.signature.personId.delete(p.personId);
  ctx.db.position.personId.delete(p.personId);
  ctx.db.person.personId.delete(p.personId);
});
