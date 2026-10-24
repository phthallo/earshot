import { describe, expect, it } from 'vitest';
import { HOLD_MS, centroid, medianByNode, nextPosition, pickPairingMac, type Sight } from './position';

const at = (nodeId: number, rssi: number, tsMs = 0, macHash = 'a'): Sight => ({ nodeId, rssi, tsMs, macHash });

describe('medianByNode', () => {
  it('drops nodes with one sample and takes the median of the rest', () => {
    const m = medianByNode([at(1, -50), at(1, -70), at(1, -60), at(2, -40)]);
    expect(m.get(1)).toEqual({ median: -60, n: 3 });
    expect(m.has(2)).toBe(false);
  });
});

describe('nextPosition', () => {
  const stats = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), { median: v, n: 2 }]));

  it('places a new person at the strongest node', () => {
    const p = nextPosition(null, stats({ 1: -70, 2: -55 }), 1000);
    expect(p?.nodeId).toBe(2);
    expect(p?.confidence).toBeCloseTo(0.875);
  });

  it('does not switch for a small gain', () => {
    const prev = nextPosition(null, stats({ 1: -60 }), 0)!;
    const p = nextPosition(prev, stats({ 1: -60, 2: -56 }), 1000);
    expect(p?.nodeId).toBe(1);
  });

  it('switches only after the candidate holds', () => {
    let prev = nextPosition(null, stats({ 1: -60 }), 0)!;
    const p1 = nextPosition(prev, stats({ 1: -60, 2: -50 }), 1000)!;
    expect(p1.nodeId).toBe(1);
    expect(p1.candidateNodeId).toBe(2);
    prev = p1;
    const p2 = nextPosition(prev, stats({ 1: -60, 2: -50 }), 1000 + HOLD_MS);
    expect(p2?.nodeId).toBe(2);
  });

  it('returns null when nothing is heard', () => {
    expect(nextPosition(null, new Map(), 0)).toBeNull();
  });
});

describe('pickPairingMac', () => {
  it('picks the strongest new unbound mac', () => {
    const w = [at(1, -40, 0, 'old'), at(1, -41, 0, 'old'), at(1, -50, 0, 'new'), at(1, -52, 0, 'new'), at(1, -45, 0, 'bound'), at(1, -45, 0, 'bound'), at(1, -30, 0, 'once')];
    expect(pickPairingMac(w, new Set(['old']), new Set(['bound']))).toBe('new');
  });
  it('returns null with no candidate', () => {
    expect(pickPairingMac([at(1, -40, 0, 'old')], new Set(['old']), new Set())).toBeNull();
  });
});

describe('centroid', () => {
  it('pulls toward the louder node', () => {
    const c = centroid([
      { x: 0, y: 0, rssi: -50 },
      { x: 10, y: 0, rssi: -70 },
    ])!;
    expect(c.x).toBeGreaterThan(0.5);
    expect(c.x).toBeLessThan(2);
    expect(c.y).toBe(0);
  });

  it('is null with no points', () => {
    expect(centroid([])).toBeNull();
  });
});
