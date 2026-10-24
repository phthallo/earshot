import { useEffect, useState } from 'react';
import { api, ApiError, type HistoryPoint } from '../api';
import { copy } from '../copy';
import { zoneById } from '../venue';
import { clock } from '../hooks';

const W = 280;
const H = 56;
const HOURS = 6;

// Phones heard in one zone over the last six hours, refreshed each minute.
export function ZoneHistory({ zoneId }: { zoneId: string }) {
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zone = zoneById.get(zoneId);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .history(zoneId, HOURS)
        .then((r) => {
          if (!cancelled) {
            setPoints(r.points);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof ApiError ? e.message : copy.errors.generic);
        });
    load();
    const id = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [zoneId]);

  if (!zone) return null;

  const max = Math.max(1, ...(points ?? []).map((p) => p.phones));
  const path = (points ?? [])
    .map((p, i, all) => {
      const x = all.length === 1 ? W : (i / (all.length - 1)) * W;
      const y = H - 4 - (p.phones / max) * (H - 8);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  const quietest = (points ?? []).reduce<HistoryPoint | null>((q, p) => (q === null || p.phones < q.phones ? p : q), null);
  const busiest = (points ?? []).reduce<HistoryPoint | null>((b, p) => (b === null || p.phones > b.phones ? p : b), null);

  return (
    <section className="sheet zone-history">
      <h3>{copy.history.title(zone.name)}</h3>
      {error && <p className="warn">{error}</p>}
      {points && points.length < 2 && !error && <p className="hint">{copy.history.collecting}</p>}
      {points && points.length >= 2 && (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="spark" role="img" aria-label={copy.history.title(zone.name)}>
            <path d={path} />
          </svg>
          <p className="hint">
            {copy.history.range(HOURS)}
            {quietest && busiest && quietest !== busiest && ` ${copy.history.quietBusy(clock(new Date(quietest.t)), clock(new Date(busiest.t)))}`}
          </p>
        </>
      )}
    </section>
  );
}
