import zonesJson from '../../data/zones.json';
import nodesJson from '../../data/nodes.json';

export type ZoneGeom = {
  zoneId: string;
  name: string;
  kind: string;
  floor: number;
  s0: number;
  s1: number;
};

export type NodeGeom = {
  nodeId: number;
  zoneId: string;
  floor: number;
  label: string;
  x: number;
  y: number;
  s: number;
};

export const ZONES: ZoneGeom[] = zonesJson as ZoneGeom[];
export const NODES: NodeGeom[] = nodesJson.nodes as NodeGeom[];

// Nodes 101+ are hardware the team brought; 1..20 are the simulated mesh.
export const isRealNode = (nodeId: number) => nodeId >= 100;

export const zoneById = new Map(ZONES.map((z) => [z.zoneId, z]));
export const nodeById = new Map(NODES.map((n) => [n.nodeId, n]));

export const TEAM_COLORS = ['#b9df74', '#75bcff', '#e7ac66', '#ddc291', '#a7a5f9', '#ff9bb3'];
