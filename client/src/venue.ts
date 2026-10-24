import zonesJson from '../../data/zones.json';
import nodesJson from '../../data/nodes.json';
import landmarksJson from '../../data/landmarks.json';
import type { Point } from './geom';

export type ZoneGeom = {
  zoneId: string;
  name: string;
  kind: string;
  floor: number;
  capacity: number;
  label: Point;
  poly: Point[];
};

export type NodeGeom = {
  nodeId: number;
  zoneId: string;
  floor: number;
  label: string;
  x: number;
  y: number;
};

// A wall, door or opening: x1, y1, x2, y2 in plan pixels.
export type Seg = [number, number, number, number];
export type Table = { name: string; kind: string; floor: number; x: number; y: number; w: number; h: number; angle: number };
export type Round = { floor: number; x: number; y: number; r: number };
export type Amenity = { label: string; kind: string; floor: number; x: number; y: number };
export type TextLabel = { label: string; floor: number; x: number; y: number };
export type Room = { id: string; kind: string; label: string | null; floor: number; poly: Point[]; dividers: Point[][]; doors: Seg[] };
export type Opening = { label: string; floor: number; a: Point; b: Point };
export type Stair = { id: string; poly: Point[]; bottom: Point; top: Point };

export const ZONES: ZoneGeom[] = zonesJson as ZoneGeom[];
export const NODES: NodeGeom[] = nodesJson.nodes as NodeGeom[];

// Furniture, rooms and walls from the organisers' render, same pixel space.
// Heights are metres; the mezzanine image is offset from the main one by
// mezz_px = main_px * scale + (dx, dy).
export const HEIGHTS = landmarksJson.heights;
export const MEZZ_IMAGE = landmarksJson.mezzImage;
export const BOOTHS: Table[] = landmarksJson.booths;
export const TABLES: Table[] = landmarksJson.tables;
export const ROUNDS: Round[] = landmarksJson.rounds;
export const AMENITIES: Amenity[] = landmarksJson.amenities;
export const LABELS: TextLabel[] = landmarksJson.labels;
export const ROOMS: Room[] = landmarksJson.rooms as Room[];
export const OPENINGS: Opening[] = landmarksJson.openings as Opening[];
export const DECK: Point[] = landmarksJson.deck as Point[];
export const DECK_HOLE: Point[] = landmarksJson.mezzExtras.hole as Point[];
export const ENVELOPE: Point[] = landmarksJson.envelope as Point[];
export const STAIRS: Stair[] = landmarksJson.stairs as Stair[];
export const MAIN_WALLS: Seg[] = landmarksJson.mainWalls as Seg[];
export const MEZZ_WALLS: Seg[] = landmarksJson.mezzWalls as Seg[];
export const MEZZ_DOORS: Seg[] = landmarksJson.mezzDoors as Seg[];
export const MERCH_ROOM: Point[] = landmarksJson.merchRoom as Point[];
export const STAGE: Point[] = landmarksJson.stage as Point[];
export const AV_BOOTH: Point[] = landmarksJson.av as Point[];
export const BACKDROP: Seg = landmarksJson.mezzExtras.backdrop as Seg;

// Nodes 101+ are hardware the team brought; 1..21 are the simulated mesh.
export const isRealNode = (nodeId: number) => nodeId >= 100;

export const zoneById = new Map(ZONES.map((z) => [z.zoneId, z]));
export const nodeById = new Map(NODES.map((n) => [n.nodeId, n]));

export const TEAM_COLORS = ['#b9df74', '#75bcff', '#e7ac66', '#ddc291', '#a7a5f9', '#ff9bb3'];
