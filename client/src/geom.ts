import nodesJson from '../../data/nodes.json';

// Map coordinates are pixels of the Cal Hacks 13 floorplan at its source size
// (data/nodes.json holds width, height and metres per pixel). Zones are
// polygons in that space and positions from the server are already in it.
export const PLAN_WIDTH = nodesJson.width;
export const PLAN_HEIGHT = nodesJson.height;
export const VIEW_BOX = `0 0 ${PLAN_WIDTH} ${PLAN_HEIGHT}`;
export const METERS_PER_UNIT = nodesJson.metersPerUnit;

export type Point = [number, number];

export function polygonPath(points: Point[]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ') + ' Z';
}

// Colour for an anonymous dot from its hue byte: eight hues far enough apart
// to tell neighbours apart at a glance, light enough to read on the dark floor.
const ANON_PALETTE = ['#ff6b6b', '#ffa94d', '#ffe066', '#69db7c', '#22d3ee', '#74c0fc', '#b197fc', '#f783ac'];
export function anonColour(hue: number): string {
  return ANON_PALETTE[Math.floor((hue / 256) * ANON_PALETTE.length) % ANON_PALETTE.length];
}

// The hue byte the bridge gives a dot is the second byte of its hash, so a
// phone keeps its colour after its dot has left the map.
export function hashHue(hash: string): number {
  return parseInt(hash.slice(2, 4), 16) || 0;
}

// How long the bridge keeps a dot's past positions (anon.trailKeep).
export const TRAIL_KEEP_MS = 30 * 60000;
