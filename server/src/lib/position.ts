// Pure position logic. No SpacetimeDB imports so vitest can run it.

export type Sight = { nodeId: number; macHash: string; rssi: number; tsMs: number };

export type Pos = {
  nodeId: number;
  candidateNodeId: number;
  candidateSinceMs: number;
  medianRssi: number;
  confidence: number;
  updatedMs: number;
};

export const WINDOW_MS = 5000;
export const MIN_SAMPLES = 2;
export const SWITCH_MARGIN_DB = 6;
export const HOLD_MS = 1500;
export const EXPIRE_MS = 60000;
export const SIGHTING_RETENTION_MS = 70000;
export const IDLE_MS = 15000;
export const IDLE_DECAY = 0.8;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function confidence(medianRssi: number): number {
  return Math.min(1, Math.max(0, (medianRssi + 90) / 40));
}

export type NodeStat = { median: number; n: number };

export function medianByNode(sights: Sight[]): Map<number, NodeStat> {
  const by = new Map<number, number[]>();
  for (const s of sights) {
    const arr = by.get(s.nodeId);
    if (arr) arr.push(s.rssi);
    else by.set(s.nodeId, [s.rssi]);
  }
  const out = new Map<number, NodeStat>();
  for (const [nodeId, rssis] of by) {
    if (rssis.length >= MIN_SAMPLES) out.set(nodeId, { median: median(rssis), n: rssis.length });
  }
  return out;
}

export type Pt = { x: number; y: number; rssi: number };

/**
 * RSSI-weighted centroid of the nodes that heard a phone. Weight is linear
 * power (10^(rssi/20)), so a node 12 dB louder pulls four times harder.
 * Null when there are no points.
 */
export function centroid(pts: Pt[]): { x: number; y: number } | null {
  if (pts.length === 0) return null;
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  for (const p of pts) {
    const w = Math.pow(10, p.rssi / 20);
    wx += w * p.x;
    wy += w * p.y;
    wsum += w;
  }
  return { x: wx / wsum, y: wy / wsum };
}

function best(stats: Map<number, NodeStat>): [number, NodeStat] | null {
  let b: [number, NodeStat] | null = null;
  for (const e of stats) if (!b || e[1].median > b[1].median) b = e;
  return b;
}

/** Next position from this window's sightings. Returns null when nothing should change. */
export function nextPosition(prev: Pos | null, stats: Map<number, NodeStat>, nowMs: number): Pos | null {
  const top = best(stats);
  if (!top) return null;
  const [bestNode, bestStat] = top;

  if (!prev) {
    return {
      nodeId: bestNode,
      candidateNodeId: bestNode,
      candidateSinceMs: nowMs,
      medianRssi: bestStat.median,
      confidence: confidence(bestStat.median),
      updatedMs: nowMs,
    };
  }

  const atCurrent = stats.get(prev.nodeId);
  if (bestNode === prev.nodeId) {
    return { ...prev, candidateNodeId: prev.nodeId, candidateSinceMs: nowMs, medianRssi: bestStat.median, confidence: confidence(bestStat.median), updatedMs: nowMs };
  }

  const currentMedian = atCurrent ? atCurrent.median : -120;
  if (bestStat.median < currentMedian + SWITCH_MARGIN_DB) {
    // Still heard best at the current node: refresh it, drop any candidate.
    if (atCurrent) return { ...prev, candidateNodeId: prev.nodeId, candidateSinceMs: nowMs, medianRssi: atCurrent.median, confidence: confidence(atCurrent.median), updatedMs: nowMs };
    return null;
  }

  if (prev.candidateNodeId === bestNode && nowMs - prev.candidateSinceMs >= HOLD_MS) {
    return { nodeId: bestNode, candidateNodeId: bestNode, candidateSinceMs: nowMs, medianRssi: bestStat.median, confidence: confidence(bestStat.median), updatedMs: nowMs };
  }
  if (prev.candidateNodeId !== bestNode) {
    return { ...prev, candidateNodeId: bestNode, candidateSinceMs: nowMs, updatedMs: atCurrent ? nowMs : prev.updatedMs };
  }
  return null;
}

/**
 * Pick the phone a pairing session belongs to: the MAC with the strongest median
 * at that node during the window that was not heard there just before and is not
 * already bound. Returns null if no candidate.
 */
export function pickPairingMac(windowSights: Sight[], seenBefore: Set<string>, bound: Set<string>): string | null {
  const by = new Map<string, number[]>();
  for (const s of windowSights) {
    if (seenBefore.has(s.macHash) || bound.has(s.macHash)) continue;
    const arr = by.get(s.macHash);
    if (arr) arr.push(s.rssi);
    else by.set(s.macHash, [s.rssi]);
  }
  let bestMac: string | null = null;
  let bestMedian = -Infinity;
  for (const [mac, rssis] of by) {
    if (rssis.length < MIN_SAMPLES) continue;
    const m = median(rssis);
    if (m > bestMedian) {
      bestMedian = m;
      bestMac = mac;
    }
  }
  return bestMac;
}
