import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { copy } from '../copy';
import { zoneById } from '../venue';
import { ago, useMe, useNow } from '../hooks';

export function TeamPanel({ onSelectZone, onGoToMe }: { onSelectZone: (zoneId: string, floor: number) => void; onGoToMe: () => void }) {
  const me = useMe();
  const now = useNow();
  const [people] = useTable(tables.person);
  const [positions] = useTable(tables.position);

  if (!me || !me.team) {
    return (
      <section className="sheet">
        <h2>{copy.team.title}</h2>
        <p className="intro">{copy.team.none}</p>
        <button type="button" className="primary" onClick={onGoToMe}>
          {copy.team.goMe}
        </button>
      </section>
    );
  }

  const mates = people.filter((p) => p.team === me.team && p.visible);
  const posById = new Map(positions.map((p) => [p.personId, p]));

  return (
    <section className="sheet">
      <h2>{me.team}</h2>
      {mates.length <= 1 && <p className="intro">{copy.team.alone(me.team)}</p>}
      <ul className="people">
        {mates.map((p) => {
          const pos = posById.get(p.personId);
          const zone = pos ? zoneById.get(pos.zoneId) : undefined;
          return (
            <li key={p.personId}>
              <span className="dot" style={{ background: p.color }} />
              <strong>{p.displayName}</strong>
              {p.personId === me.personId && <span className="muted"> ({copy.legend.you.toLowerCase()})</span>}
              {pos && zone ? (
                <button type="button" className="link" onClick={() => onSelectZone(zone.zoneId, zone.floor)}>
                  {zone.name}, {copy.floors[zone.floor].toLowerCase()}
                  <span className="muted">
                    {' '}
                    ({copy.team.via[pos.source] ?? pos.source}, {ago(pos.updatedAt.toDate(), now)})
                  </span>
                </button>
              ) : (
                <span className="muted">{copy.team.notSeen}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
