import { memo, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { PLAN_HEIGHT, PLAN_WIDTH, VIEW_BOX, polygonPath } from '../geom';
import { anonColour } from '../geom';
import { AMENITIES, BOOTHS, DECK, ENVELOPE, LABELS, MEZZ_IMAGE, NODES, OPENINGS, ROOMS, TABLES, ZONES, isRealNode } from '../venue';
import { copy } from '../copy';
import { clock, useNow } from '../hooks';
import type { Step } from '../api';
import { usePanZoom } from '../panzoom';
import { MapButtons } from './MapButtons';

const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// A real node that has not reported for this long is unplugged or out of radio range.
const NODE_ONLINE_MS = 60000;

type Props = {
  floor: number;
  liveOnly: boolean;
  meId?: number;
  selectedZone?: string;
  onSelectZone: (zoneId: string | undefined) => void;
  // Tapping an anonymous dot opens that phone's sheet by hash. While one is
  // picked the other dots fade and its past positions are drawn as a path.
  selectedDevice?: string;
  trail?: Step[];
  onSelectDevice: (hash: string) => void;
  // Admin placing: a click anywhere on the plan reports plan units, and the
  // given nodes are drawn as pins wherever the node table has them.
  onPlanClick?: (x: number, y: number, floor: number) => void;
  pins?: Pin[];
};

export type Pin = { nodeId: number; x: number; y: number; floor: number; pending?: boolean };

type Trail = { x: number; y: number; t: number }[];

const TRAIL_MS = 20000;

// The floorplan image and the walls under the zones. Memoised: positions
// arrive every second and this part never changes between floors.
const PlanBase = memo(function PlanBase({ floor }: { floor: number }) {
  const mezz = floor === 2;
  return (
    <>
      {/* The organisers' floorplan, inverted so its lines read on the night background. */}
      {mezz ? (
        <image
          className="plan"
          href="/venue-mezz.jpg"
          x={-MEZZ_IMAGE.dx / MEZZ_IMAGE.scale}
          y={-MEZZ_IMAGE.dy / MEZZ_IMAGE.scale}
          width={PLAN_WIDTH / MEZZ_IMAGE.scale}
          height={PLAN_HEIGHT / MEZZ_IMAGE.scale}
          preserveAspectRatio="none"
        />
      ) : (
        <image className="plan" href="/venue-main.jpg" x="0" y="0" width={PLAN_WIDTH} height={PLAN_HEIGHT} preserveAspectRatio="none" />
      )}
      <path className="envelope" d={polygonPath(ENVELOPE)} />
      {mezz && <path className="deck" d={polygonPath(DECK)} />}
      {!mezz && ROOMS.map((r) => <path key={r.id} className="room-outline" d={polygonPath(r.poly)} />)}
    </>
  );
});

// Tables, booths, doors and room names: a few hundred elements, drawn above the zones.
const Furniture = memo(function Furniture({ floor }: { floor: number }) {
  const mezz = floor === 2;
  const floorBooths = BOOTHS.filter((b) => b.floor === floor);
  const floorTables = TABLES.filter((t) => t.floor === floor);
  // A room or amenity name this close to a zone's name would sit on top of it.
  const underZoneName = (x: number, y: number) =>
    ZONES.some((z) => z.floor === floor && Math.abs(z.label[0] - x) < 220 && Math.abs(z.label[1] - y) < 90);
  const floorLabels = LABELS.filter((r) => r.floor === floor && !underZoneName(r.x, r.y));
  const floorAmenities = AMENITIES.filter((a) => a.floor === floor && !underZoneName(a.x, a.y));
  return (
    <g className="furniture">
      {floorTables.map((t, i) => (
        <rect key={i} className="table" x={-t.w / 2} y={-t.h / 2} width={t.w} height={t.h} transform={`translate(${t.x} ${t.y}) rotate(${t.angle})`} />
      ))}
      {floorBooths.map((b, i) => (
        <rect key={i} className="booth" x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} transform={`translate(${b.x} ${b.y}) rotate(${b.angle})`}>
          <title>{b.name}</title>
        </rect>
      ))}
      {!mezz &&
        OPENINGS.map((o) => (
          <g key={o.label + o.a[0]} className="opening">
            <line x1={o.a[0]} y1={o.a[1]} x2={o.b[0]} y2={o.b[1]} />
            <text x={(o.a[0] + o.b[0]) / 2} y={(o.a[1] + o.b[1]) / 2 + 48} textAnchor="middle">
              {o.label}
            </text>
          </g>
        ))}
      {floorLabels.map((r) => (
        <text key={r.label + r.x} className="room" x={r.x} y={r.y} textAnchor="middle">
          {r.label}
        </text>
      ))}
      {floorAmenities.map((a) => (
        <text key={a.label} className="amenity" x={a.x} y={a.y} textAnchor="middle">
          {a.label}
        </text>
      ))}
    </g>
  );
});

export function VenueMap({ floor, liveOnly, meId, selectedZone, onSelectZone, selectedDevice, trail = [], onSelectDevice, onPlanClick, pins = [] }: Props) {
  const [counts] = useTable(tables.anonZoneCount);
  const [zones] = useTable(tables.zone);
  const [positions] = useTable(tables.position);
  const [people] = useTable(tables.person);
  const [nodes] = useTable(tables.node);
  const [anonPoints] = useTable(tables.anonPoint);

  const countByZone = useMemo(
    () => new Map(counts.filter((c) => !liveOnly || c.source !== 'mock').map((c) => [c.zoneId, c])),
    [counts, liveOnly],
  );
  const capacity = useMemo(() => new Map(zones.map((z) => [z.zoneId, z.capacity])), [zones]);
  const personById = useMemo(() => new Map(people.map((p) => [p.personId, p])), [people]);
  const tick = useNow(5000);
  const liveNodes = useMemo(
    () => new Set(nodes.filter((n) => n.isReal && tick - n.lastSeenAt.toDate().getTime() < NODE_ONLINE_MS).map((n) => n.nodeId)),
    [nodes, tick],
  );

  // Fading trail per person, kept outside React state so updates stay cheap.
  // Updated before render rather than in an effect, so the render that shows
  // a new position also shows its trail.
  const trails = useRef(new Map<number, Trail>());
  useMemo(() => {
    const now = Date.now();
    const seen = new Set<number>();
    for (const p of positions) {
      seen.add(p.personId);
      const t = trails.current.get(p.personId) ?? [];
      const last = t[t.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) t.push({ x: p.x, y: p.y, t: now });
      trails.current.set(p.personId, t.filter((pt) => now - pt.t < TRAIL_MS));
    }
    for (const id of trails.current.keys()) if (!seen.has(id)) trails.current.delete(id);
  }, [positions]);

  const mezz = floor === 2;
  const floorZones = ZONES.filter((z) => z.floor === floor);
  // Real nodes can move (the bridge relocates them from the access points they
  // hear), so their position comes from the table when it has one.
  const nodeRows = useMemo(() => new Map(nodes.map((n) => [n.nodeId, n])), [nodes]);
  const floorNodes = NODES.map((n) => {
    const row = nodeRows.get(n.nodeId);
    return row && isRealNode(n.nodeId) ? { ...n, x: row.x, y: row.y, floor: row.floor, zoneId: row.zoneId } : n;
  }).filter((n) => n.floor === floor && (isRealNode(n.nodeId) ? liveNodes.has(n.nodeId) : !liveOnly));
  // A position placed by a mock node (id below 100) belongs to the simulated crowd.
  const blips = positions.filter(
    (p) => p.floor === floor && (personById.get(p.personId)?.visible ?? false) && (!liveOnly || p.source === 'app' || isRealNode(p.nodeId)),
  );

  const dots = anonPoints.filter((p) => p.floor === floor);
  const floorTrail = trail.filter((s) => s.floor === floor);
  const view = usePanZoom(PLAN_WIDTH, PLAN_HEIGHT);
  const floorPins = pins.filter((p) => p.floor === floor);
  // The pan-zoom capture handler swallows the click that ends a drag, so this only sees taps.
  const onClick = onPlanClick
    ? (e: ReactMouseEvent<SVGSVGElement>) => {
        const p = view.toPlan(e.clientX, e.clientY);
        if (p.x < 0 || p.y < 0 || p.x > PLAN_WIDTH || p.y > PLAN_HEIGHT) return;
        onPlanClick(Math.round(p.x), Math.round(p.y), floor);
      }
    : undefined;

  const sources = new Set(floorZones.map((z) => countByZone.get(z.zoneId)?.source).filter(Boolean));
  const surveyed = floorZones.map((z) => countByZone.get(z.zoneId)).find((c) => c?.source === 'survey');

  return (
    <figure className={`map${mezz ? ' mezz' : ''}${onPlanClick ? ' placing' : ''}`}>
      <svg ref={view.svg} viewBox={VIEW_BOX} role="img" aria-label={copy.floors[floor]} {...view.handlers} onClick={onClick}>
        <defs>
          <radialGradient id="blipGlow">
            <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <PlanBase floor={floor} />

        {floorZones.map((z) => {
          const c = countByZone.get(z.zoneId);
          const cap = capacity.get(z.zoneId) ?? 60;
          const heat = c ? Math.min(1, c.count / cap) : 0;
          const selected = selectedZone === z.zoneId;
          const d = polygonPath(z.poly);
          const [lx, ly] = z.label;
          return (
            <g key={z.zoneId} className={`zone kind-${z.kind}${selected ? ' selected' : ''}`} onClick={() => onSelectZone(selected ? undefined : z.zoneId)}>
              <path className="zone-wash" d={d} style={{ fillOpacity: 0.14 + heat * 0.7 }} />
              <path className="zone-edge" d={d} />
              <text className="zone-label" x={lx} y={ly} textAnchor="middle">
                {z.name}
              </text>
              <text className="zone-count" x={lx} y={ly + 40} textAnchor="middle">
                {c ? c.count : ''}
              </text>
            </g>
          );
        })}

        <Furniture floor={floor} />

        {floorNodes.map((n) => {
          const real = isRealNode(n.nodeId);
          const online = liveNodes.has(n.nodeId);
          return (
            <g key={n.nodeId} className={`node${real ? ' real' : ''}${online ? ' online' : ''}`}>
              <circle cx={n.x} cy={n.y} r={real ? 18 : 8} />
              {real && (
                <text x={n.x} y={n.y + 48} textAnchor="middle">
                  {n.label.replace('Live node: ', '')}
                </text>
              )}
            </g>
          );
        })}

        {/* Unregistered phones the real nodes hear: no name, no identity, faded with distance. */}
        {dots.map((d) => (
          <circle
            key={d.id}
            className={[d.stable ? 'anon-dot stable' : 'anon-dot', d.hash === selectedDevice ? 'picked' : ''].join(' ').trim()}
            cx={d.x}
            cy={d.y}
            r={d.hash === selectedDevice ? 12 : 9}
            style={{
              fill: anonColour(d.hue),
              opacity: (0.45 + 0.5 * Math.max(0, Math.min(1, (d.rssi + 85) / 50))) * (selectedDevice && d.hash !== selectedDevice ? 0.18 : 1),
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectDevice(d.hash);
            }}
          />
        ))}

        {/* Where the picked phone has been on this floor, oldest step smallest. */}
        {selectedDevice && floorTrail.length > 1 && (
          <g className="device-trail">
            <polyline points={floorTrail.map((s) => `${s.x},${s.y}`).join(' ')} />
            {floorTrail.slice(0, -1).map((s, i) => (
              <circle key={i} cx={s.x} cy={s.y} r={3 + (4 * i) / floorTrail.length} />
            ))}
          </g>
        )}

        {floorPins.map((p) => (
          <g key={p.nodeId} className={`pin${p.pending ? ' pending' : ''}`} aria-label={copy.admin.pinLabel(p.nodeId)}>
            <circle cx={p.x} cy={p.y} r={40} />
            <text x={p.x} y={p.y + 76} textAnchor="middle">
              {p.nodeId}
            </text>
          </g>
        ))}

        {blips.map((p) => {
          const person = personById.get(p.personId)!;
          const trail = trails.current.get(p.personId) ?? [];
          const now = Date.now();
          return (
            <g key={p.personId} className={`blip${p.personId === meId ? ' me' : ''}`} style={{ color: person.color }}>
              {trail.slice(0, -1).map((t, i) => (
                <circle key={i} className="trail" cx={t.x} cy={t.y} r={5} style={{ opacity: 0.6 * (1 - (now - t.t) / TRAIL_MS) }} />
              ))}
              <circle className="glow" cx={p.x} cy={p.y} r={55} fill="url(#blipGlow)" style={{ opacity: 0.25 + p.confidence * 0.4 }} />
              <path className="star" transform={`translate(${p.x} ${p.y}) scale(2.4)`} d="M0 -9 L2.4 -2.4 L9 0 L2.4 2.4 L0 9 L-2.4 2.4 L-9 0 L-2.4 -2.4 Z" />
              <text className="blip-name" x={p.x} y={p.y - 34} textAnchor="middle">
                {person.displayName}
              </text>
              {p.source === 'app' && <circle className="app-ring" cx={p.x} cy={p.y} r={32} />}
            </g>
          );
        })}
      </svg>

      <figcaption className="legend">
        {sources.has('mock') && <span className="swatch mock">{copy.legend.simulated}</span>}
        {sources.has('live') && <span className="swatch live">{copy.legend.live}</span>}
        {surveyed && <span className="swatch survey">{copy.legend.surveyed(clock(surveyed.updatedAt.toDate()))}</span>}
        <span className="swatch star">{copy.legend.node}</span>
        {dots.length > 0 && <span className="swatch anon">{copy.legend.anon}</span>}
        {dots.some((d) => d.stable) && <span className="swatch stable">{copy.legend.stable}</span>}
        <span className="swatch phone">{copy.legend.app}</span>
        <span className="howto">{TOUCH ? copy.scene.planDragTouch : copy.scene.planDrag}</span>
        <MapButtons onZoomIn={() => view.zoomBy(0.6)} onZoomOut={() => view.zoomBy(1 / 0.6)} onReset={view.reset} />
      </figcaption>
    </figure>
  );
}
