import { useRef, type MouseEvent } from 'react';
import type { AdminFloor } from '../../api';
import { copy } from '../../copy';
import type { Pin } from '../VenueMap';

// An uploaded floor image with node pins. Clicks report image pixels, which is
// what the bridge stores for uploaded floors.
export function FloorPlan({ floor, pins, onClick }: { floor: AdminFloor; pins: Pin[]; onClick?: (x: number, y: number) => void }) {
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
