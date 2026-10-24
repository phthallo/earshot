import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { METERS_PER_UNIT, PLAN_HEIGHT, PLAN_WIDTH, type Point } from '../geom';
import {
  AV_BOOTH, BACKDROP, BOOTHS, DECK, DECK_HOLE, ENVELOPE, HEIGHTS, MAIN_WALLS, MERCH_ROOM, MEZZ_DOORS, MEZZ_WALLS, NODES, OPENINGS,
  ROOMS, ROUNDS, STAGE, STAIRS, TABLES, ZONES, isRealNode, type Seg, type Table,
} from '../venue';
import { useNow } from '../hooks';
import type { Step } from '../api';
import { copy } from '../copy';
import { MapButtons } from './MapButtons';

const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
// Room names and the other floor's zone names only read from closer than this.
const CLOSE_DISTANCE = 220;
// Boxes narrower than this are framed as if they were this wide. A phone in
// portrait is about 0.7; fitting the hall to its width makes the zone names
// pile up, so it sees the middle at a tablet's scale and pans for the ends.
const MIN_FIT_ASPECT = 1.2;

// World units are floorplan pixels divided by SCALE, y up. Heights come from
// the organisers' render, in metres.
const SCALE = 10;
const M = (metres: number) => metres / METERS_PER_UNIT / SCALE;
const MEZZ_Y = M(HEIGHTS.mezzanine);
const WALL_THICK = M(0.45);
// Doors sit on their wall; anything this close to a wall line counts as on it.
const DOOR_TOL = 25;
const STAIR_STEPS = 22;

// The render's palette.
const PALETTE = {
  wall: 0x3a3d43,
  wallTrim: 0x55595f,
  partition: 0x43464c,
  partitionFloor: 0x35383d,
  mezzWall: 0xf4f2ee,
  service: 0x2a2c30,
  serviceRoof: 0x34373c,
  green: 0x3e6b4a,
  catering: 0x6b5a3e,
  theater: 0x2a3550,
  restroom: 0x3c4a5e,
  tableTop: 0xb97f4b,
  tableFrame: 0x834c27,
  sponsorTop: 0x9fd6f2,
  steps: 0x4a4d53,
  stepsAlt: 0x404348,
  stage: 0x1b2238,
  stageSide: 0x141a2c,
  accent: 0x3678c3,
  chair: 0xf2f0ec,
  chairLegs: 0x8e939b,
  cloth: 0xece8e0,
  deckEdge: 0x25272b,
};
const XRAY_OPACITY = 0.3;
const ROOM_FLOOR: Record<string, number> = {
  service: PALETTE.service,
  green: PALETTE.green,
  catering: PALETTE.catering,
  theater: PALETTE.theater,
  restroom: PALETTE.restroom,
  room: PALETTE.partitionFloor,
};
const ZONE_COLORS: Record<string, number> = {
  hack: 0xb9df74,
  food: 0xe7ac66,
  stage: 0xa7a5f9,
  rest: 0x75bcff,
  social: 0xddc291,
  workshop: 0xddc291,
  entry: 0x75bcff,
  sponsor: 0x75bcff,
};
// How long a marker takes to glide to a new fix, and to climb between floors.
const GLIDE_MS = 1500;
const CLIMB_MS = 4000;

type Props = {
  floor: number;
  xray: boolean;
  liveOnly: boolean;
  meId?: number;
  selectedZone?: string;
  onSelectZone: (zoneId: string | undefined) => void;
  // Tapping an anonymous dot opens that phone's sheet by hash.
  // While a dot is picked the others fade and its past positions are drawn.
  selectedDevice?: string;
  trail?: Step[];
  onSelectDevice: (hash: string) => void;
};

type Marker = {
  group: THREE.Group;
  body: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  stem: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  color: string;
  label: CSS2DObject;
  from: THREE.Vector3;
  to: THREE.Vector3;
  startedAt: number;
  duration: number;
};

const toWorld = ([x, y]: Point, h = 0) => new THREE.Vector3(x / SCALE - PLAN_WIDTH / SCALE / 2, h, y / SCALE - PLAN_HEIGHT / SCALE / 2);
const floorY = (floor: number) => (floor === 2 ? MEZZ_Y : 0);
const edges = (poly: Point[]): Seg[] => poly.map((p, i) => [...p, ...poly[(i + 1) % poly.length]] as Seg);

// One material per colour; the roughness of the first request wins.
const materials = new Map<number, THREE.MeshStandardMaterial>();
const mat = (color: number, roughness = 0.85) => {
  let m = materials.get(color);
  if (!m) materials.set(color, (m = new THREE.MeshStandardMaterial({ color, roughness })));
  return m;
};

function shapeOf(points: Point[], hole?: Point[]): THREE.Shape {
  const s = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? s.lineTo(x / SCALE, y / SCALE) : s.moveTo(x / SCALE, y / SCALE)));
  s.closePath();
  if (hole) {
    const h = new THREE.Path();
    hole.forEach(([x, y], i) => (i ? h.lineTo(x / SCALE, y / SCALE) : h.moveTo(x / SCALE, y / SCALE)));
    h.closePath();
    s.holes.push(h);
  }
  return s;
}

// A flat polygon lying on the ground plane (shape x,y become world x,z).
function slab(points: Point[], y: number, material: THREE.Material, hole?: Point[]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shapeOf(points, hole)), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(-PLAN_WIDTH / SCALE / 2, y, -PLAN_HEIGHT / SCALE / 2);
  return mesh;
}

// A polygon extruded upwards from y by height (world units).
function block(points: Point[], y: number, height: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeOf(points), { depth: height, bevelEnabled: false }), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(-PLAN_WIDTH / SCALE / 2, y + height, -PLAN_HEIGHT / SCALE / 2);
  return mesh;
}

// The render's floor: dark grey with specks, soft blotches and tile seams,
// drawn once onto a canvas and tiled. A slab's uv is its shape coordinate
// (px / SCALE), so one tile covers FLOOR_TILE world units.
const FLOOR_TILE = 12;
function floorTexture(): THREE.Texture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rnd = (n: number) => {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  ctx.fillStyle = '#2e3035';
  ctx.fillRect(0, 0, size, size);
  for (let n = 0; n < 2600; n++) {
    ctx.fillStyle = rnd(n) > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.10)';
    const s = 1 + rnd(n * 7) * 3;
    ctx.fillRect(rnd(n * 3) * size, rnd(n * 5) * size, s, s);
  }
  for (let n = 0; n < 14; n++) {
    const x = rnd(n * 11) * size;
    const y = rnd(n * 13) * size;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 120 + rnd(n) * 200);
    g.addColorStop(0, rnd(n * 17) > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.08)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, 0, size, 2);
  ctx.fillRect(0, 0, 2, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / FLOOR_TILE, 1 / FLOOR_TILE);
  tex.anisotropy = 8;
  return tex;
}

// Remove the parts of each wall that a door or opening covers.
function cutDoors(walls: Seg[], doors: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const [ax, ay, bx, by] of walls) {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const gaps: [number, number][] = [];
    for (const [dx1, dy1, dx2, dy2] of doors) {
      const proj = (x: number, y: number) => ({ t: (x - ax) * ux + (y - ay) * uy, d: Math.abs(-(x - ax) * uy + (y - ay) * ux) });
      const p = proj(dx1, dy1);
      const q = proj(dx2, dy2);
      const lo = Math.max(0, Math.min(p.t, q.t));
      const hi = Math.min(len, Math.max(p.t, q.t));
      if (hi > lo && p.d < DOOR_TOL && q.d < DOOR_TOL) gaps.push([lo, hi]);
    }
    gaps.sort((g, h) => g[0] - h[0]);
    let at = 0;
    const emit = (t0: number, t1: number) => t1 - t0 > 2 && out.push([ax + ux * t0, ay + uy * t0, ax + ux * t1, ay + uy * t1]);
    for (const [lo, hi] of gaps) {
      emit(at, lo);
      at = Math.max(at, hi);
    }
    emit(at, len);
  }
  return out;
}

// Wall segments as one merged mesh of boxes, with a lighter cap on top.
function walls(segs: Seg[], y: number, height: number, color: number, cap = PALETTE.wallTrim): THREE.Group {
  const g = new THREE.Group();
  if (!segs.length) return g;
  const bodies: THREE.BufferGeometry[] = [];
  const caps: THREE.BufferGeometry[] = [];
  for (const [ax, ay, bx, by] of segs) {
    const a = toWorld([ax, ay]);
    const b = toWorld([bx, by]);
    const len = a.distanceTo(b) + WALL_THICK * 0.9;
    const rot = -Math.atan2(b.z - a.z, b.x - a.x);
    const mid = a.clone().lerp(b, 0.5);
    const place = (geo: THREE.BufferGeometry, cy: number) =>
      geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(mid.x, cy, mid.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(1, 1, 1)));
    bodies.push(place(new THREE.BoxGeometry(len, height, WALL_THICK), y + height / 2));
    caps.push(place(new THREE.BoxGeometry(len + 0.1, 0.1, WALL_THICK + 0.1), y + height + 0.05));
  }
  g.add(new THREE.Mesh(mergeGeometries(bodies), mat(color, 0.95)));
  g.add(new THREE.Mesh(mergeGeometries(caps), mat(cap, 0.7)));
  return g;
}

// Rotated boxes for tables: a top slab and a slightly smaller body.
function furniture(items: Table[], top: number, body: number): THREE.Group {
  const g = new THREE.Group();
  if (!items.length) return g;
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const tops = new THREE.InstancedMesh(unit, mat(top), items.length);
  const bodies = new THREE.InstancedMesh(unit, mat(body), items.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const h = M(HEIGHTS.table);
  items.forEach((t, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-t.angle * Math.PI) / 180);
    const base = floorY(t.floor);
    // The plan's hacker-table blocks include the chairs; the table itself is 76 cm deep.
    const depth = t.kind === 'hacker' ? M(0.76) : t.h / SCALE;
    tops.setMatrixAt(i, m.compose(toWorld([t.x, t.y], base + h), q, new THREE.Vector3(t.w / SCALE, 0.08, depth)));
    bodies.setMatrixAt(i, m.compose(toWorld([t.x, t.y], base + h / 2), q, new THREE.Vector3(t.w / SCALE - 0.1, h, depth - 0.1)));
  });
  g.add(tops, bodies);
  return g;
}

// A flight of steps between the stair polygon's bottom and top edges.
function stairFlight(poly: Point[], bottom: Point, top: Point): THREE.Mesh {
  const es = edges(poly);
  const mid = ([x1, y1, x2, y2]: Seg): Point => [(x1 + x2) / 2, (y1 + y2) / 2];
  const nearest = (p: Point) => es.reduce((best, e) => (Math.hypot(mid(e)[0] - p[0], mid(e)[1] - p[1]) < Math.hypot(mid(best)[0] - p[0], mid(best)[1] - p[1]) ? e : best));
  const [tx1, ty1, tx2, ty2] = nearest(top);
  const [bx1, by1, bx2, by2] = nearest(bottom);
  // Pair the bottom corners with the top corners that face them.
  const flip = Math.hypot(bx1 - tx1, by1 - ty1) > Math.hypot(bx1 - tx2, by1 - ty2);
  const [ux1, uy1, ux2, uy2] = flip ? [tx2, ty2, tx1, ty1] : [tx1, ty1, tx2, ty2];
  const at = (k: number): [Point, Point] => [[bx1 + (ux1 - bx1) * k, by1 + (uy1 - by1) * k], [bx2 + (ux2 - bx2) * k, by2 + (uy2 - by2) * k]];
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < STAIR_STEPS; i++) {
    const [a0, b0] = at(i / STAIR_STEPS);
    const [a1, b1] = at((i + 1) / STAIR_STEPS);
    const height = ((i + 1) / STAIR_STEPS) * MEZZ_Y;
    // Extrusion runs along local +z, which the rotation below turns into -y,
    // so shift it to [-height, 0] to make the step stand on the floor.
    const geo = new THREE.ExtrudeGeometry(shapeOf([a0, b0, b1, a1]), { depth: height, bevelEnabled: false }).translate(0, 0, -height);
    const color = new THREE.Color(i % 2 ? PALETTE.stepsAlt : PALETTE.steps);
    const colors = new Float32Array(geo.attributes.position.count * 3);
    for (let j = 0; j < colors.length; j += 3) colors.set([color.r, color.g, color.b], j);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(geo);
  }
  const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(-PLAN_WIDTH / SCALE / 2, 0, -PLAN_HEIGHT / SCALE / 2);
  return mesh;
}

// A chair at a plan point, facing the direction `face` (radians, atan2(dx, dy)).
type Spot = { at: Point; floor: number; face: number };
const PX_PER_M = 1 / METERS_PER_UNIT;
const facing = (from: Point, to: Point) => Math.atan2(to[0] - from[0], to[1] - from[1]);

// Two or three chairs along each long side of a table, facing it.
function tableSpots(t: Table): Spot[] {
  const n = t.w > 2.2 * PX_PER_M ? 3 : 2;
  const rot = (-t.angle * Math.PI) / 180;
  const spots: Spot[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const along = (i - (n - 1) / 2) * (t.w / n);
      const out = side * 0.7 * PX_PER_M;
      const at: Point = [t.x + Math.cos(rot) * along - Math.sin(rot) * out, t.y - Math.sin(rot) * along - Math.cos(rot) * out];
      const onTable: Point = [t.x + Math.cos(rot) * along, t.y - Math.sin(rot) * along];
      spots.push({ at, floor: t.floor, face: facing(at, onTable) });
    }
  }
  return spots;
}

const pointInPoly = ([x, y]: Point, poly: Point[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const distToSeg = ([x, y]: Point, [ax, ay, bx, by]: Seg) => {
  const k = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (Math.hypot(bx - ax, by - ay) ** 2 || 1)));
  return Math.hypot(x - ax - k * (bx - ax), y - ay - k * (by - ay));
};

// Up to 40 theater seats in arcs facing the room's screen wall, kept off the walls.
function theaterSpots(poly: Point[]): Spot[] {
  if (poly.length < 12) return [];
  const [cx, cy] = poly.reduce(([sx, sy], [x, y]) => [sx + x / poly.length, sy + y / poly.length], [0, 0]);
  const focus: Point = [(poly[7][0] + poly[11][0]) / 2, (poly[7][1] + poly[11][1]) / 2];
  const walls = edges(poly);
  const spots: Spot[] = [];
  for (let row = 0; row < 6 && spots.length < 40; row++) {
    const r = (3.2 + row * 0.95) * PX_PER_M;
    for (let k = -12; k <= 12 && spots.length < 40; k++) {
      const a = Math.atan2(cy - focus[1], cx - focus[0]) + (k * 0.52 * PX_PER_M) / r;
      const at: Point = [focus[0] + Math.cos(a) * r, focus[1] + Math.sin(a) * r];
      if (pointInPoly(at, poly) && walls.every((w) => distToSeg(at, w) > 0.6 * PX_PER_M)) spots.push({ at, floor: 1, face: facing(at, focus) });
    }
  }
  return spots;
}

// Seats, backs and legs as three instanced meshes.
function chairs(spots: Spot[]): THREE.Group {
  const g = new THREE.Group();
  if (!spots.length) return g;
  const seat = new THREE.InstancedMesh(new THREE.BoxGeometry(M(0.42), M(0.05), M(0.4)), mat(PALETTE.chair), spots.length);
  const back = new THREE.InstancedMesh(new THREE.BoxGeometry(M(0.42), M(0.42), M(0.05)), mat(PALETTE.chair), spots.length);
  const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(M(0.36), M(0.42), M(0.34)), mat(PALETTE.chairLegs, 0.6), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  spots.forEach((s, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.face);
    const y = floorY(s.floor);
    const behind: Point = [s.at[0] - Math.sin(s.face) * 0.19 * PX_PER_M, s.at[1] - Math.cos(s.face) * 0.19 * PX_PER_M];
    seat.setMatrixAt(i, m.compose(toWorld(s.at, y + M(0.44)), q, one));
    back.setMatrixAt(i, m.compose(toWorld(behind, y + M(0.68)), q, one));
    legs.setMatrixAt(i, m.compose(toWorld(s.at, y + M(0.21)), q, one));
  });
  g.add(seat, back, legs);
  return g;
}

function label(text: string, className: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return new CSS2DObject(el);
}

// Everything that never changes: floors, walls, rooms, stairs, furniture.
// Returns the deck and the materials X-ray mode makes see-through.
function buildVenue(scene: THREE.Scene, roomLabels: HTMLElement[], onTextureLoad: () => void) {
  const solids = new Set<THREE.Material>();
  const solid = <T extends THREE.Object3D>(o: T): T => {
    o.traverse((c) => c instanceof THREE.Mesh && solids.add(c.material as THREE.Material));
    return o;
  };
  const floorTex = floorTexture();
  scene.add(slab(ENVELOPE, 0, new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1, side: THREE.DoubleSide })));
  const openings: Seg[] = OPENINGS.map((o) => [...o.a, ...o.b] as Seg);
  scene.add(solid(walls(cutDoors(edges(ENVELOPE), openings), 0, M(HEIGHTS.perimeter), PALETTE.wall)));
  scene.add(solid(walls(MAIN_WALLS, 0, M(HEIGHTS.partition), PALETTE.partition)));

  for (const r of ROOMS) {
    if (r.kind === 'stair') continue;
    scene.add(slab(r.poly, 0.05, mat(ROOM_FLOOR[r.kind] ?? PALETTE.partitionFloor, 1)));
    const h = M(r.kind === 'service' ? HEIGHTS.service : HEIGHTS.partition);
    if (r.kind !== 'theater') {
      const dividers: Seg[] = r.dividers.map(([a, b]) => [...a, ...b] as Seg);
      scene.add(solid(walls(cutDoors([...edges(r.poly), ...dividers], r.doors), 0, h, r.kind === 'service' ? PALETTE.wall : PALETTE.partition)));
    } else {
      scene.add(chairs(theaterSpots(r.poly)));
    }
    if (r.kind === 'service') scene.add(solid(slab(r.poly, h, mat(PALETTE.serviceRoof, 1))));
    if (r.label) {
      const [cx, cy] = r.poly.reduce(([sx, sy], [x, y]) => [sx + x / r.poly.length, sy + y / r.poly.length], [0, 0]);
      const l = label(r.label, 'scene-room');
      l.position.copy(toWorld([cx, cy], h + 0.5));
      scene.add(l);
      roomLabels.push(l.element);
    }
  }
  scene.add(solid(block(STAGE, 0, M(0.9), mat(PALETTE.stage))));
  scene.add(solid(block(AV_BOOTH, 0, M(1.1), mat(PALETTE.stageSide))));
  for (const s of STAIRS) scene.add(solid(stairFlight(s.poly, s.bottom, s.top)));

  // Mezzanine: a darker slab with a hole for the stair void, a fascia below
  // its edge, a wooden handrail, white partition walls with doors cut out,
  // and the photo backdrop.
  const deckMat = new THREE.MeshStandardMaterial({ map: floorTex, color: 0x9a9ca2, roughness: 1, side: THREE.DoubleSide });
  const deck = slab(DECK, MEZZ_Y, deckMat, DECK_HOLE);
  scene.add(deck);
  scene.add(solid(block(DECK, MEZZ_Y - M(0.5), M(0.5), mat(PALETTE.deckEdge))));
  scene.add(solid(walls([...edges(DECK), ...edges(DECK_HOLE)], MEZZ_Y + M(0.95), M(0.08), PALETTE.tableTop, PALETTE.tableTop)));
  scene.add(solid(walls(cutDoors([...MEZZ_WALLS, ...edges(MERCH_ROOM)], MEZZ_DOORS), MEZZ_Y, M(HEIGHTS.partition), PALETTE.mezzWall, 0xe6e1d6)));
  const [bx1, by1, bx2, by2] = BACKDROP;
  const a = toWorld([bx1, by1]);
  const b = toWorld([bx2, by2]);
  const backdropTex = new THREE.TextureLoader().load('/backdrop.jpg', onTextureLoad);
  backdropTex.colorSpace = THREE.SRGBColorSpace;
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(a.distanceTo(b), M(2.2)), new THREE.MeshStandardMaterial({ map: backdropTex, side: THREE.DoubleSide }));
  backdrop.position.copy(a).lerp(b, 0.5).setY(MEZZ_Y + M(1.1));
  backdrop.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
  scene.add(backdrop);

  scene.add(furniture(TABLES, PALETTE.tableTop, PALETTE.tableFrame));
  scene.add(furniture(BOOTHS, PALETTE.sponsorTop, PALETTE.cloth));
  scene.add(chairs(TABLES.filter((t) => t.kind === 'hacker').flatMap(tableSpots)));
  const roundGeo = new THREE.CylinderGeometry(1, 1, 0.08, 20);
  const roundSpots: Spot[] = [];
  for (const r of ROUNDS) {
    const m = new THREE.Mesh(roundGeo, mat(PALETTE.tableTop));
    m.scale.set(r.r / SCALE, 1, r.r / SCALE);
    m.position.copy(toWorld([r.x, r.y], floorY(r.floor) + M(HEIGHTS.table)));
    scene.add(m);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const at: Point = [r.x + Math.cos(a) * (r.r + 0.32 * PX_PER_M), r.y + Math.sin(a) * (r.r + 0.32 * PX_PER_M)];
      roundSpots.push({ at, floor: r.floor, face: facing(at, [r.x, r.y]) });
    }
  }
  scene.add(chairs(roundSpots));

  // Sniffer nodes: pins, amber for the real hardware.
  const nodePins = new Map<number, THREE.Mesh>();
  for (const n of NODES) {
    const real = isRealNode(n.nodeId);
    // Real hardware gets an amber cone so it stands out among the dots.
    const pin = real
      ? new THREE.Mesh(new THREE.ConeGeometry(1.2, 3.6, 12), new THREE.MeshStandardMaterial({ color: 0xe7ac66, emissive: 0xe7ac66, emissiveIntensity: 0.5 }))
      : new THREE.Mesh(new THREE.ConeGeometry(0.6, 2, 12), mat(0x8a93c4));
    pin.position.copy(toWorld([n.x, n.y], floorY(n.floor) + (real ? 1.8 : 1)));
    scene.add(pin);
    nodePins.set(n.nodeId, pin);
  }
  solids.add(deckMat);
  return { deck, solids: [...solids], nodePins };
}

// A real node that has not reported for this long is unplugged or out of radio range.
const NODE_ONLINE_MS = 60000;

export function VenueScene({ floor, xray, liveOnly, meId, selectedZone, onSelectZone, selectedDevice, trail = [], onSelectDevice }: Props) {
  const [counts] = useTable(tables.anonZoneCount);
  const [zoneRows] = useTable(tables.zone);
  const [positions] = useTable(tables.position);
  const [people] = useTable(tables.person);
  const [nodes] = useTable(tables.node);
  const [anonPoints] = useTable(tables.anonPoint);
  const personById = useMemo(() => new Map(people.map((p) => [p.personId, p])), [people]);
  const nodeRows = useMemo(() => new Map(nodes.map((n) => [n.nodeId, n])), [nodes]);
  const countByZone = useMemo(
    () => new Map(counts.filter((c) => !liveOnly || c.source !== 'mock').map((c) => [c.zoneId, c])),
    [counts, liveOnly],
  );
  const capacity = useMemo(() => new Map(zoneRows.map((z) => [z.zoneId, z.capacity])), [zoneRows]);

  const host = useRef<HTMLDivElement>(null);
  const world = useRef<{
    scene: THREE.Scene;
    zoneMeshes: Map<string, THREE.Mesh>;
    zoneLabels: Map<string, HTMLElement>;
    roomLabels: HTMLElement[];
    deck: THREE.Mesh;
    solids: THREE.Material[];
    markers: Map<number, Marker>;
    markerLayer: THREE.Group;
    nodePins: Map<number, THREE.Mesh>;
    // Ask for a frame. The loop only draws after something changed.
    invalidate: () => void;
  } | null>(null);
  const select = useRef(onSelectZone);
  select.current = onSelectZone;
  const selectDevice = useRef(onSelectDevice);
  selectDevice.current = onSelectDevice;
  // The current dot mesh and the hash behind each instance, for picking.
  const dotPick = useRef<{ mesh: THREE.InstancedMesh; hashes: string[] } | null>(null);
  const rotateBy = useRef<(angle: number) => void>(() => {});
  const zoomBy = useRef<(factor: number) => void>(() => {});
  const resetView = useRef<() => void>(() => {});

  // Build the static scene once.
  useEffect(() => {
    const el = host.current!;
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b1030, 500, 1400);
    const camera = new THREE.PerspectiveCamera(36, 2, 1, 4000);
    camera.position.set(-30, 175, 175);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'scene-labels';
    el.appendChild(labels.domElement);
    let dirty = true;
    const invalidate = () => {
      dirty = true;
    };
    // Panning is the common move on a map, so it gets the primary button and
    // one finger; orbit is right-drag or two fingers. Panning stays on the
    // floor plane and the target is kept over the hall.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 40;
    // A phone in portrait needs about 900 to fit the hall's width.
    controls.maxDistance = 1000;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.panSpeed = 2.5;
    controls.rotateSpeed = 0.9;
    controls.dampingFactor = 0.12;
    controls.keyPanSpeed = 30;
    // Arrow keys pan only while the map has focus, so they still move the
    // caret in the forms on the other pages.
    renderer.domElement.tabIndex = 0;
    controls.listenToKeyEvents(renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.addEventListener('change', invalidate);
    // Ctrl+wheel (a trackpad pinch) and Safari's gesture events zoom the page
    // unless something swallows them. The controls ignore a wheel mid-drag,
    // and a wheel over the label layer never reaches the canvas, so the host
    // swallows every one and hands those to the canvas itself.
    const swallow = (e: Event) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.target === renderer.domElement) return;
      const { deltaX, deltaY, deltaMode, clientX, clientY, ctrlKey, shiftKey, altKey, metaKey } = e;
      renderer.domElement.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, deltaMode, clientX, clientY, ctrlKey, shiftKey, altKey, metaKey, cancelable: true }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', swallow);
    el.addEventListener('gesturechange', swallow);
    // Holding Shift, Ctrl or Alt turns left-drag into orbit.
    const onModifier = (e: KeyboardEvent) => {
      controls.mouseButtons.LEFT = e.shiftKey || e.ctrlKey || e.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    };
    window.addEventListener('keydown', onModifier);
    window.addEventListener('keyup', onModifier);
    const halfW = PLAN_WIDTH / SCALE / 2;
    const halfH = PLAN_HEIGHT / SCALE / 2;
    // Distance at which the whole hall fits the width of the box. A box
    // narrower than MIN_FIT_ASPECT (a phone) keeps that scale, so labels stay
    // readable, and shows the middle of the hall; the rest is a pan away.
    const fitDistance = () => {
      const aspect = Math.max(camera.aspect, MIN_FIT_ASPECT);
      const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * aspect);
      return Math.min(controls.maxDistance, Math.max(controls.minDistance, (halfW * 1.14) / Math.tan(hfov / 2)));
    };
    const home = camera.position.clone().normalize();
    rotateBy.current = (angle) => {
      camera.position.sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).add(controls.target);
      invalidate();
    };
    zoomBy.current = (factor) => {
      const offset = camera.position.clone().sub(controls.target);
      offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance));
      camera.position.copy(controls.target).add(offset);
      invalidate();
    };
    resetView.current = () => {
      controls.target.set(0, 0, 0);
      camera.position.copy(home).setLength(fitDistance());
      invalidate();
    };

    scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x1a2050, 2.4));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    sun.position.set(-120, 220, 80);
    scene.add(sun);

    const roomLabels: HTMLElement[] = [];
    const { deck, solids, nodePins } = buildVenue(scene, roomLabels, invalidate);

    // Zones: a tinted slab a hair above each floor, heat drives opacity.
    const zoneMeshes = new Map<string, THREE.Mesh>();
    const zoneLabels = new Map<string, HTMLElement>();
    for (const z of ZONES) {
      const color = ZONE_COLORS[z.kind] ?? 0xddc291;
      const zm = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, transparent: true, opacity: 0.3, depthWrite: false });
      const mesh = slab(z.poly, floorY(z.floor) + 0.15, zm);
      mesh.userData.zoneId = z.zoneId;
      scene.add(mesh);
      zoneMeshes.set(z.zoneId, mesh);
      const l = label(z.name, 'scene-zone');
      l.position.copy(toWorld(z.label, floorY(z.floor) + 2));
      scene.add(l);
      zoneLabels.set(z.zoneId, l.element);
    }

    const markerLayer = new THREE.Group();
    scene.add(markerLayer);
    world.current = { scene, zoneMeshes, zoneLabels, roomLabels, deck, solids, markers: new Map(), markerLayer, nodePins, invalidate };

    // Clicking a zone slab selects it; a drag does not.
    const ray = new THREE.Raycaster();
    const onClick = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(p, camera);
      // Dots sit above the slabs, so they win when the ray passes through one.
      const d = dotPick.current;
      if (d) {
        const dot = ray.intersectObject(d.mesh)[0];
        if (dot && dot.instanceId !== undefined && d.hashes[dot.instanceId]) {
          selectDevice.current(d.hashes[dot.instanceId]);
          return;
        }
      }
      const hit = ray.intersectObjects([...zoneMeshes.values()])[0];
      select.current(hit ? (hit.object.userData.zoneId as string) : undefined);
    };
    let down: { x: number; y: number } | null = null;
    renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    renderer.domElement.addEventListener('click', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) onClick(e);
    });

    // The first sizing frames the whole hall; a later resize keeps the view
    // the person has set.
    let placed = false;
    const size = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!placed) {
        placed = true;
        resetView.current();
      }
      invalidate();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    let raf = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (controls.update()) dirty = true;
      const t0 = controls.target.clone();
      controls.target.x = THREE.MathUtils.clamp(controls.target.x, -halfW, halfW);
      controls.target.z = THREE.MathUtils.clamp(controls.target.z, -halfH, halfH);
      camera.position.add(controls.target).sub(t0);
      for (const m of world.current!.markers.values()) {
        const k = Math.min(1, (t - m.startedAt) / m.duration);
        if (k < 1) dirty = true;
        m.group.position.lerpVectors(m.from, m.to, k);
      }
      if (!dirty) return;
      dirty = false;
      const close = camera.position.distanceTo(controls.target) < CLOSE_DISTANCE;
      for (const l of world.current!.roomLabels) l.classList.toggle('far', !close);
      for (const l of world.current!.zoneLabels.values()) l.classList.toggle('far', !close);
      for (const m of world.current!.markers.values()) m.label.element.classList.toggle('far', !close);
      renderer.render(scene, camera);
      labels.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onModifier);
      window.removeEventListener('keyup', onModifier);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', swallow);
      el.removeEventListener('gesturechange', swallow);
      controls.dispose();
      renderer.dispose();
      el.replaceChildren();
      world.current = null;
    };
  }, []);

  // Heat, selection and floor emphasis.
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    for (const z of ZONES) {
      const mesh = w.zoneMeshes.get(z.zoneId)!;
      const zm = mesh.material as THREE.MeshStandardMaterial;
      const c = countByZone.get(z.zoneId);
      const heat = c ? Math.min(1, c.count / (capacity.get(z.zoneId) ?? 60)) : 0;
      const dim = z.floor !== floor ? 0.35 : 1;
      zm.opacity = (0.28 + heat * 0.6) * dim;
      zm.emissive.set(selectedZone === z.zoneId ? 0xffffff : zm.color);
      zm.emissiveIntensity = selectedZone === z.zoneId ? 0.5 : 0.35;
      const el = w.zoneLabels.get(z.zoneId)!;
      el.classList.toggle('selected', selectedZone === z.zoneId);
      el.classList.toggle('faded', z.floor !== floor);
      el.dataset.count = c ? String(c.count) : '';
    }
    for (const el of w.roomLabels) el.classList.toggle('faded', floor !== 1);
    w.invalidate();
  }, [countByZone, capacity, floor, selectedZone]);

  // X-ray: walls, roofs, stairs and the deck go see-through so people inside
  // rooms and under the mezzanine stay visible. The deck fades more when
  // looking at the ground floor.
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    for (const m of w.solids) {
      m.transparent = xray;
      m.opacity = xray ? XRAY_OPACITY : 1;
      m.depthWrite = !xray;
      m.needsUpdate = true;
    }
    if (xray) (w.deck.material as THREE.Material).opacity = floor === 2 ? 0.7 : XRAY_OPACITY;
    w.invalidate();
  }, [xray, floor]);

  // People: one marker each, gliding between fixes and climbing between floors.
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    const now = performance.now();
    const seen = new Set<number>();
    for (const p of positions) {
      const person = personById.get(p.personId);
      if (!person?.visible) continue;
      // A position placed by a mock node (id below 100) belongs to the simulated crowd.
      if (liveOnly && p.source !== 'app' && !isRealNode(p.nodeId)) continue;
      seen.add(p.personId);
      const target = toWorld([p.x, p.y], floorY(p.floor) + 1.2);
      let m = w.markers.get(p.personId);
      if (!m) {
        const group = new THREE.Group();
        const body = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), new THREE.MeshStandardMaterial({ color: person.color, emissive: person.color, emissiveIntensity: 0.6 }));
        group.add(body);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1.2), new THREE.MeshBasicMaterial({ color: person.color }));
        stem.position.y = -0.9;
        group.add(stem);
        const l = label(person.displayName, 'scene-person');
        l.position.y = 2.6;
        group.add(l);
        group.position.copy(target);
        w.markerLayer.add(group);
        m = { group, body, stem, color: person.color, label: l, from: target.clone(), to: target.clone(), startedAt: now, duration: GLIDE_MS };
        w.markers.set(p.personId, m);
      }
      // Colour and name can change on the Me page after the marker exists.
      if (m.color !== person.color) {
        m.color = person.color;
        m.body.material.color.set(person.color);
        m.body.material.emissive.set(person.color);
        m.stem.material.color.set(person.color);
      }
      if (m.label.element.textContent !== person.displayName) m.label.element.textContent = person.displayName;
      if (!m.to.equals(target)) {
        m.from.copy(m.group.position);
        m.to.copy(target);
        m.startedAt = now;
        m.duration = Math.abs(m.from.y - target.y) > 1 ? CLIMB_MS : GLIDE_MS;
      }
      m.label.element.classList.toggle('me', p.personId === meId);
      m.label.element.classList.toggle('app', p.source === 'app');
      m.group.visible = true;
    }
    for (const [id, m] of w.markers) {
      if (!seen.has(id)) {
        w.markerLayer.remove(m.group);
        m.label.element.remove();
        m.body.geometry.dispose();
        m.body.material.dispose();
        m.stem.geometry.dispose();
        m.stem.material.dispose();
        w.markers.delete(id);
      }
    }
    w.invalidate();
  }, [positions, personById, meId, liveOnly]);

  // Unregistered phones heard by the real nodes: small unlabelled dots, dimmer when far.
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    if (anonPoints.length === 0) return;
    // Spheres, not THREE.Points: a point is a few pixels at this camera distance.
    const geom = new THREE.SphereGeometry(0.9, 10, 8);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35 });
    const dots = new THREE.InstancedMesh(geom, material, anonPoints.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    // Instances share one material, so the unpicked dots are shrunk and
    // darkened rather than made transparent.
    anonPoints.forEach((p, i) => {
      const picked = p.hash === selectedDevice;
      const other = !!selectedDevice && !picked;
      const s = picked ? 1.6 : other ? 0.55 : 1;
      m.makeScale(s, s, s).setPosition(toWorld([p.x, p.y], floorY(p.floor) + 1));
      dots.setMatrixAt(i, m);
      const k = 0.4 + 0.35 * Math.max(0, Math.min(1, (p.rssi + 85) / 50));
      dots.setColorAt(i, c.setHSL(p.hue / 256, other ? 0.2 : 0.75, other ? k * 0.35 : k));
    });
    dots.instanceMatrix.needsUpdate = true;
    if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    w.scene.add(dots);
    dotPick.current = { mesh: dots, hashes: anonPoints.map((p) => p.hash) };
    // Phones with a factory address get a flat ring, so the trackable ones stand out.
    const stable = anonPoints.filter((p) => p.stable);
    const ringGeom = new THREE.TorusGeometry(1.7, 0.25, 6, 24);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xe7ac66 });
    const rings = new THREE.InstancedMesh(ringGeom, ringMaterial, stable.length);
    const flat = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    stable.forEach((p, i) => {
      rings.setMatrixAt(i, m.copy(flat).setPosition(toWorld([p.x, p.y], floorY(p.floor) + 1)));
    });
    rings.instanceMatrix.needsUpdate = true;
    w.scene.add(rings);
    w.invalidate();
    return () => {
      dotPick.current = null;
      w.scene.remove(dots, rings);
      geom.dispose();
      material.dispose();
      ringGeom.dispose();
      ringMaterial.dispose();
      w.invalidate();
    };
  }, [anonPoints, selectedDevice]);

  // The picked phone's past positions, a dashed line just above its floor.
  useEffect(() => {
    const w = world.current;
    if (!w || !selectedDevice || trail.length < 2) return;
    const pts = trail.map((s) => toWorld([s.x, s.y], floorY(s.floor) + 0.6));
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const material = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(geom, material);
    line.computeLineDistances();
    const stepGeom = new THREE.SphereGeometry(0.45, 8, 6);
    const stepMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
    const steps = new THREE.InstancedMesh(stepGeom, stepMaterial, pts.length - 1);
    const m = new THREE.Matrix4();
    pts.slice(0, -1).forEach((p, i) => steps.setMatrixAt(i, m.setPosition(p)));
    steps.instanceMatrix.needsUpdate = true;
    w.scene.add(line, steps);
    w.invalidate();
    return () => {
      w.scene.remove(line, steps);
      geom.dispose();
      material.dispose();
      stepGeom.dispose();
      stepMaterial.dispose();
      w.invalidate();
    };
  }, [selectedDevice, trail]);

  // Node pins: real nodes follow the table (the bridge moves them) and hide once
  // they stop reporting; mock nodes hide in live-only mode.
  const tick = useNow(5000);
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    for (const n of NODES) {
      const pin = w.nodePins.get(n.nodeId);
      if (!pin) continue;
      const real = isRealNode(n.nodeId);
      const row = real ? nodeRows.get(n.nodeId) : undefined;
      const lift = real ? 3.5 : 1.5;
      const at = row ? toWorld([row.x, row.y], floorY(row.floor) + lift) : toWorld([n.x, n.y], floorY(n.floor) + lift);
      pin.position.copy(at);
      const online = !!row && tick - row.lastSeenAt.toDate().getTime() < NODE_ONLINE_MS;
      pin.visible = real ? online : !liveOnly;
    }
    w.invalidate();
  }, [nodeRows, liveOnly, tick]);

  return (
    <figure className="map scene">
      <div ref={host} className="scene-host" role="img" aria-label={copy.floors[floor]} />
      <figcaption className="legend">
        {!liveOnly && <span className="swatch mock">{copy.legend.simulated}</span>}
        <span className="swatch star">{copy.legend.node}</span>
        {anonPoints.length > 0 && <span className="swatch anon">{copy.legend.anon}</span>}
        {anonPoints.some((p) => p.stable) && <span className="swatch stable">{copy.legend.stable}</span>}
        <span className="swatch phone">{copy.legend.app}</span>
        <span className="howto">{TOUCH ? copy.scene.dragTouch : copy.scene.drag}</span>
        <MapButtons
          onZoomIn={() => zoomBy.current(0.7)}
          onZoomOut={() => zoomBy.current(1 / 0.7)}
          onReset={() => resetView.current()}
          onRotateLeft={() => rotateBy.current(Math.PI / 4)}
          onRotateRight={() => rotateBy.current(-Math.PI / 4)}
        />
      </figcaption>
    </figure>
  );
}
