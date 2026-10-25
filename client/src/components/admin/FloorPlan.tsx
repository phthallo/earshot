import { useRef, type MouseEvent } from 'react';
import type { AdminFloor } from '../../api';
import { copy } from '../../copy';
import { anonColour } from '../../geom';
import type { Pin } from '../VenueMap';

export type Dot = { id: number; floor: number; x: number; y: number; rssi: number; hue: number; stable: boolean };

// An uploaded floor image with node pins and the phones the venue's relay
// hears. Clicks report image pixels, which is what the bridge stores for
// uploaded floors.
export function FloorPlan({ floor, pins, dots = [], onClick }: { floor: AdminFloor; pins: Pin[]; dots?: Dot[]; onClick?: (x: number, y: number) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const w = floor.width || img.current?.naturalWidth || 1;
  const h = floor.height || img.current?.naturalHeight || 1;

  function pick(e: MouseEvent<HTMLImageElement>) {
    if (!onClick) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const nw = el.naturalWidth || w;
    const nh = el.naturalHeight || h;
    onClick(Math.round(((e.clientX - r.left) / r.width) * nw), Math.round(((e.clientY - r.top) / r.height) * nh));
  }

  return (
    <figure className={`map floor-plan${onClick ? ' placing' : ''}`}>
      <div className="floor-plan-box" style={{ aspectRatio: `${w} / ${h}` }}>
        <img ref={img} src={floor.imageUrl} alt={floor.name} onClick={pick} draggable={false} />
        {dots
          .filter((d) => d.floor === floor.index)
          .map((d) => (
            <span
              key={d.id}
              className={d.stable ? 'anon-dot stable' : 'anon-dot'}
              style={{
                left: `${(d.x / w) * 100}%`,
                top: `${(d.y / h) * 100}%`,
                background: anonColour(d.hue),
                opacity: 0.45 + 0.5 * Math.max(0, Math.min(1, (d.rssi + 85) / 50)),
              }}
            />
          ))}
        {pins
          .filter((p) => p.floor === floor.index)
          .map((p) => (
            <span
              key={p.nodeId}
              className={`pin${p.pending ? ' pending' : ''}`}
              style={{ left: `${(p.x / w) * 100}%`, top: `${(p.y / h) * 100}%` }}
              aria-label={copy.admin.pinLabel(p.nodeId)}
            >
              <b>{p.nodeId}</b>
            </span>
          ))}
      </div>
    </figure>
  );
}
