import { useEffect, useMemo, useRef } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { pointAt, sectorPath, VIEW_BOX } from '../geom';
import { NODES, ZONES, isRealNode } from '../venue';
import { copy } from '../copy';
import { clock, useNow } from '../hooks';

const NODE_ONLINE_MS = 15000;

type Props = {
  floor: number;
  meId?: number;
  selectedZone?: string;
  onSelectZone: (zoneId: string | undefined) => void;
};

type Trail = { x: number; y: number; t: number }[];

const TRAIL_MS = 20000;

export function VenueMap({ floor, meId, selectedZone, onSelectZone }: Props) {
  const [counts] = useTable(tables.anonZoneCount);
  const [zones] = useTable(tables.zone);
  const [positions] = useTable(tables.position);
  const [people] = useTable(tables.person);
  const [nodes] = useTable(tables.node);

  const countByZone = useMemo(() => new Map(counts.map((c) => [c.zoneId, c])), [counts]);
  const capacity = useMemo(() => new Map(zones.map((z) => [z.zoneId, z.capacity])), [zones]);
  const personById = useMemo(() => new Map(people.map((p) => [p.personId, p])), [people]);
  const tick = useNow(5000);
  const liveNodes = useMemo(
    () => new Set(nodes.filter((n) => n.isReal && tick - n.lastSeenAt.toDate().getTime() < NODE_ONLINE_MS).map((n) => n.nodeId)),
    [nodes, tick],
  );

  // Fading trail per person, kept outside React state so updates stay cheap.
  const trails = useRef(new Map<number, Trail>());
  useEffect(() => {
    const now = Date.now();
    for (const p of positions) {
      const t = trails.current.get(p.personId) ?? [];
      const last = t[t.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) t.push({ x: p.x, y: p.y, t: now });
      trails.current.set(p.personId, t.filter((pt) => now - pt.t < TRAIL_MS));
    }
  }, [positions]);

  const floorZones = ZONES.filter((z) => z.floor === floor);
  const floorNodes = NODES.filter((n) => n.floor === floor);
  const blips = positions.filter((p) => p.floor === floor && (personById.get(p.personId)?.visible ?? false));

  const sources = new Set(floorZones.map((z) => countByZone.get(z.zoneId)?.source).filter(Boolean));
  const surveyed = floorZones.map((z) => countByZone.get(z.zoneId)).find((c) => c?.source === 'survey');

  return (
    <figure className="map">
      <svg viewBox={VIEW_BOX} role="img" aria-label={copy.floors[floor]}>
        <defs>
          <filter id="grain" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="noise" />
            <feColorMatrix in="noise" type="saturate" values="0" result="grey" />
            <feComponentTransfer in="grey" result="soft">
              <feFuncA type="linear" slope="0.55" intercept="0.45" />
            </feComponentTransfer>
            <feComposite in="SourceGraphic" in2="soft" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" />
          </filter>
          <radialGradient id="blipGlow">
            <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <path className="arc-base" d={sectorPath(0, 1, 0)} />

        {floorZones.map((z, i) => {
          const c = countByZone.get(z.zoneId);
          const cap = capacity.get(z.zoneId) ?? 60;
          const heat = c ? Math.min(1, c.count / cap) : 0;
          const s = (z.s0 + z.s1) / 2;
          // Labels sit outside the band on alternating radii so narrow
          // neighbours at the top of the arc do not collide.
          const label = pointAt(s, 650 + 60 + (i % 2 ? 46 : 18));
          const anchor = s < 0.08 ? 'start' : s > 0.92 ? 'end' : 'middle';
          const selected = selectedZone === z.zoneId;
          return (
            <g key={z.zoneId} className={`zone kind-${z.kind}${selected ? ' selected' : ''}`} onClick={() => onSelectZone(selected ? undefined : z.zoneId)}>
              <path className="zone-wash" d={sectorPath(z.s0, z.s1)} style={{ fillOpacity: 0.18 + heat * 0.72 }} filter="url(#grain)" />
              <path className="zone-edge" d={sectorPath(z.s0, z.s1)} />
              <text className="zone-label" x={label.x} y={label.y} textAnchor={anchor}>
                {z.name}
              </text>
              <text className="zone-count" x={label.x} y={label.y + 16} textAnchor={anchor}>
                {c ? c.count : ''}
              </text>
            </g>
          );
        })}

        {floorNodes.map((n) => {
          const real = isRealNode(n.nodeId);
          const online = liveNodes.has(n.nodeId);
          return (
            <g key={n.nodeId} className={`node${real ? ' real' : ''}${online ? ' online' : ''}`}>
              <circle cx={n.x} cy={n.y} r={real ? 7 : 3.5} />
              {real && (
                <text x={n.x} y={n.y + 20} textAnchor="middle">
                  {n.label.replace('Live node: ', '')}
                </text>
              )}
            </g>
          );
        })}

        {blips.map((p) => {
          const person = personById.get(p.personId)!;
          const trail = trails.current.get(p.personId) ?? [];
          const now = Date.now();
          return (
            <g key={p.personId} className={`blip${p.personId === meId ? ' me' : ''}`} style={{ color: person.color }}>
              {trail.slice(0, -1).map((t, i) => (
                <circle key={i} className="trail" cx={t.x} cy={t.y} r={2.2} style={{ opacity: 0.6 * (1 - (now - t.t) / TRAIL_MS) }} />
              ))}
              <circle className="glow" cx={p.x} cy={p.y} r={22} fill="url(#blipGlow)" style={{ opacity: 0.25 + p.confidence * 0.4 }} />
              <path className="star" transform={`translate(${p.x} ${p.y})`} d="M0 -9 L2.4 -2.4 L9 0 L2.4 2.4 L0 9 L-2.4 2.4 L-9 0 L-2.4 -2.4 Z" />
              <text className="blip-name" x={p.x} y={p.y - 14} textAnchor="middle">
                {person.displayName}
              </text>
              {p.source === 'app' && <circle className="app-ring" cx={p.x} cy={p.y} r={13} />}
            </g>
          );
        })}
      </svg>

      <figcaption className="legend">
        {sources.has('mock') && <span className="swatch mock">{copy.legend.simulated}</span>}
        {sources.has('live') && <span className="swatch live">{copy.legend.live}</span>}
        {surveyed && <span className="swatch survey">{copy.legend.surveyed(clock(surveyed.updatedAt.toDate()))}</span>}
        <span className="swatch star">{copy.legend.node}</span>
        <span className="swatch phone">{copy.legend.app}</span>
      </figcaption>
    </figure>
  );
}
