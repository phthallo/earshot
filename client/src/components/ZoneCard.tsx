import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { copy } from '../copy';
import { isRealNode, zoneById } from '../venue';
import { clock, useMe } from '../hooks';

const MAX_NAMES = 8;

// The selected zone: how full it is and which registered people are in it.
export function ZoneCard({ zoneId, liveOnly, onClose }: { zoneId: string; liveOnly: boolean; onClose: () => void }) {
  const me = useMe();
  const [counts] = useTable(tables.anonZoneCount);
  const [zoneRows] = useTable(tables.zone);
  const [positions] = useTable(tables.position);
  const [people] = useTable(tables.person);
  const zone = zoneById.get(zoneId);
  if (!zone) return null;

  const row = counts.find((c) => c.zoneId === zoneId);
  const count = row && (!liveOnly || row.source !== 'mock') ? row : undefined;
  const capacity = zoneRows.find((z) => z.zoneId === zoneId)?.capacity ?? zone.capacity;
  const fill = count ? Math.min(1, count.count / Math.max(1, capacity)) : 0;
  const level = fill >= 0.9 ? 'full' : fill >= 0.6 ? 'busy' : '';

  const personById = new Map(people.map((p) => [p.personId, p]));
  // Same rule as the map: in live-only mode the simulated walkers do not count.
  const here = positions
    .filter((p) => p.zoneId === zoneId && (!liveOnly || p.source === 'app' || isRealNode(p.nodeId)))
    .map((p) => personById.get(p.personId))
    .filter((p): p is NonNullable<typeof p> => !!p && p.visible)
    .sort((a, b) => Number(b.personId === me?.personId) - Number(a.personId === me?.personId) || a.displayName.localeCompare(b.displayName));

  return (
    <section className="sheet zone-card">
      <div className="zone-head">
        <h2>{zone.name}</h2>
        <button type="button" className="quiet" onClick={onClose} aria-label={copy.zone.close}>
          ×
        </button>
      </div>
      <p className="zone-floor">{copy.floors[zone.floor]}</p>

      {count ? (
        <>
          <p className="fill">
            {copy.zone.people(count.count)} <span className="muted">{copy.zone.of(capacity)}</span>
          </p>
          <div className={`meter ${level}`} role="img" aria-label={copy.zone.fullness(Math.round(fill * 100))}>
            <span style={{ transform: `scaleX(${fill})` }} />
          </div>
          <p className="hint">{copy.zone.source[count.source]?.(clock(count.updatedAt.toDate())) ?? count.source}</p>
        </>
      ) : (
        <p className="hint">{copy.zone.noCount}</p>
      )}

      {here.length > 0 && (
        <div className="here">
          <h3>{copy.zone.here}</h3>
          <ul>
            {here.slice(0, MAX_NAMES).map((p) => (
              <li key={p.personId} className={me?.team && p.team === me.team && p.personId !== me.personId ? 'mate' : ''}>
                <span className="dot" style={{ background: p.color }} />
                {p.displayName}
                {p.personId === me?.personId && <span className="muted">({copy.legend.you.toLowerCase()})</span>}
              </li>
            ))}
            {here.length > MAX_NAMES && <li className="muted">{copy.zone.more(here.length - MAX_NAMES)}</li>}
          </ul>
        </div>
      )}
    </section>
  );
}
