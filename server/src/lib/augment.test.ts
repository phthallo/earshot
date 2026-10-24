import { describe, expect, it } from 'vitest';
import { FEATURE_LEN, SUBCARRIERS, centroid, distance, features, synthesize, timeWarp } from './augment';

function walk(seed: number, frames = 30): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) for (let sc = 0; sc < SUBCARRIERS; sc++) out.push(20 + seed * Math.sin(i / 3 + sc * 0.4 + seed));
  return out;
}

const rng = (() => {
  let s = 7;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
})();

describe('features', () => {
  it('has fixed length and is normalised', () => {
    const f = features(walk(3));
    expect(f).toHaveLength(FEATURE_LEN);
    const mean = f.reduce((a, b) => a + b, 0) / f.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);
  });
  it('handles an empty walk', () => {
    expect(features([])).toHaveLength(FEATURE_LEN);
  });
});

describe('synthesize', () => {
  it('makes three variants close to the original', () => {
    const real = walk(3);
    const vs = synthesize(real, rng);
    expect(vs).toHaveLength(3);
    for (const v of vs) expect(distance(features(real), features(v))).toBeLessThan(0.6);
  });
  it('time warp changes frame count only', () => {
    const w = timeWarp(walk(2, 30), 1.2);
    expect(w.length % SUBCARRIERS).toBe(0);
    expect(w.length / SUBCARRIERS).toBe(36);
  });
});

describe('matching', () => {
  it('nearest centroid finds the right walker', () => {
    const a = centroid([features(walk(3)), ...synthesize(walk(3), rng).map(features)]);
    const b = centroid([features(walk(6)), ...synthesize(walk(6), rng).map(features)]);
    const probe = features(timeWarp(walk(3), 1.1));
    expect(distance(probe, a)).toBeLessThan(distance(probe, b));
  });
});
