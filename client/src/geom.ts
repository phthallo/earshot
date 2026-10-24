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

// Colour for an anonymous dot from its hue byte. Saturated enough to tell
// neighbours apart, light enough to read on the dark floor.
export function anonColour(hue: number): string {
  return `hsl(${Math.round((hue / 256) * 360)} 75% 62%)`;
}
