import nodesJson from '../../data/nodes.json';

// The venue is drawn as an arc. Every zone is a slice of it, given by s0..s1
// in [0,1] along the arc. Positions from the server are already in this
// coordinate space (data/nodes.json shares the arc parameters).
const { arc } = nodesJson;

const rad = (deg: number) => (deg * Math.PI) / 180;

export function angleAt(s: number): number {
  return rad(arc.a0 + s * (arc.a1 - arc.a0));
}

export function pointAt(s: number, r = arc.r): { x: number; y: number } {
  const a = angleAt(s);
  return { x: arc.cx + r * Math.cos(a), y: arc.cy + r * Math.sin(a) };
}

// Annular sector between two arc positions. Padding shrinks it a little so
// neighbouring zones read as separate washes.
export function sectorPath(s0: number, s1: number, pad = 0.004): string {
  const a = s0 + pad;
  const b = s1 - pad;
  const rIn = arc.r - arc.halfWidth;
  const rOut = arc.r + arc.halfWidth;
  const p0 = pointAt(a, rOut);
  const p1 = pointAt(b, rOut);
  const p2 = pointAt(b, rIn);
  const p3 = pointAt(a, rIn);
  return [
    `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)}`,
    `A ${rOut} ${rOut} 0 0 1 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`,
    `L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    `A ${rIn} ${rIn} 0 0 0 ${p3.x.toFixed(1)} ${p3.y.toFixed(1)}`,
    'Z',
  ].join(' ');
}

export const VIEW_BOX = '-30 215 1060 435';
export const METERS_PER_UNIT = nodesJson.metersPerUnit;
