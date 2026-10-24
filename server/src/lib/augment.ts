// Walk features and augmentation. Pure, no SpacetimeDB imports.
//
// A walk is a stream of 12-subcarrier amplitude frames at ~10 Hz. The feature
// vector resamples it to STEPS frames and normalises each subcarrier, giving a
// fixed 384-float vector that a nearest-centroid match can compare.

export const SUBCARRIERS = 12;
export const STEPS = 32;
export const FEATURE_LEN = SUBCARRIERS * STEPS;

export type Rng = () => number; // uniform [0, 1)

export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Flat frames (n * SUBCARRIERS floats) to a FEATURE_LEN vector. */
export function features(flat: number[]): number[] {
  const n = Math.floor(flat.length / SUBCARRIERS);
  const out = new Array<number>(FEATURE_LEN).fill(0);
  if (n === 0) return out;
  for (let sc = 0; sc < SUBCARRIERS; sc++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += flat[i * SUBCARRIERS + sc];
    mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) varSum += (flat[i * SUBCARRIERS + sc] - mean) ** 2;
    const sd = Math.sqrt(varSum / n) || 1;
    for (let k = 0; k < STEPS; k++) {
      const pos = n === 1 ? 0 : (k * (n - 1)) / (STEPS - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(n - 1, i0 + 1);
      const f = pos - i0;
      const a = flat[i0 * SUBCARRIERS + sc];
      const b = flat[i1 * SUBCARRIERS + sc];
      out[k * SUBCARRIERS + sc] = ((1 - f) * a + f * b - mean) / sd;
    }
  }
  return out;
}

/** Stretch or squash time by `factor`, keeping SUBCARRIERS per frame. */
export function timeWarp(flat: number[], factor: number): number[] {
  const n = Math.floor(flat.length / SUBCARRIERS);
  const m = Math.max(2, Math.round(n * factor));
  const out = new Array<number>(m * SUBCARRIERS);
  for (let j = 0; j < m; j++) {
    const pos = (j * (n - 1)) / (m - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(n - 1, i0 + 1);
    const f = pos - i0;
    for (let sc = 0; sc < SUBCARRIERS; sc++) {
      out[j * SUBCARRIERS + sc] = (1 - f) * flat[i0 * SUBCARRIERS + sc] + f * flat[i1 * SUBCARRIERS + sc];
    }
  }
  return out;
}

export function amplitudeJitter(flat: number[], sigma: number, rng: Rng): number[] {
  return flat.map((v) => v * (1 + sigma * gaussian(rng)));
}

/** Replace one whole subcarrier with its mean, as a dropped carrier would read. */
export function subcarrierDropout(flat: number[], sc: number): number[] {
  const n = Math.floor(flat.length / SUBCARRIERS);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flat[i * SUBCARRIERS + sc];
  mean /= n || 1;
  const out = flat.slice();
  for (let i = 0; i < n; i++) out[i * SUBCARRIERS + sc] = mean;
  return out;
}

/** Three synthetic variants of one real walk. */
export function synthesize(flat: number[], rng: Rng): number[][] {
  return [
    timeWarp(flat, 0.85 + 0.3 * rng()),
    amplitudeJitter(flat, 0.05, rng),
    subcarrierDropout(flat, Math.floor(rng() * SUBCARRIERS)),
  ];
}

export function centroid(vectors: number[][]): number[] {
  const out = new Array<number>(FEATURE_LEN).fill(0);
  if (vectors.length === 0) return out;
  for (const v of vectors) for (let i = 0; i < FEATURE_LEN; i++) out[i] += v[i];
  for (let i = 0; i < FEATURE_LEN; i++) out[i] /= vectors.length;
  return out;
}

export function distance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < FEATURE_LEN; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / FEATURE_LEN);
}
