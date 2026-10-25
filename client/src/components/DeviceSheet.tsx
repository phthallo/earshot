import { useEffect, useState } from 'react';
import { api, ApiError, type DeviceReport, type Step } from '../api';
import { copy } from '../copy';
import { zoneById } from '../venue';
import { ago, clock, useNow } from '../hooks';

// Bridge rule: unheard for 15 minutes ends a visit, so a stay starting that
// long after the previous one ended opens a new visit.
const RETURN_MS = 15 * 60000;

// Four signal bars from RSSI; the thresholds match the dot's distance fade.
const bars = (rssi: number) => (rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1);

type StayRow = { from: Date; zone: string; minutes: number; visit: number; current: boolean };

// Completed stays plus the current one, each with the visit it belongs to.
function stayRows(day: NonNullable<DeviceReport['day']>): StayRow[] {
  const rows: StayRow[] = [];
  let visit = 1;
  let prevEnd = new Date(day.firstSeen);
  const push = (from: Date, zone: string, to: Date | null) => {
    if (from.getTime() - prevEnd.getTime() >= RETURN_MS) visit++;
    rows.push({ from, zone, minutes: to ? Math.round((to.getTime() - from.getTime()) / 60000) : 0, visit, current: !to });
    prevEnd = to ?? from;
  };
  for (const s of day.stays) push(new Date(s.from), s.zone, new Date(s.to));
  push(new Date(day.enteredAt), day.zone, null);
  return rows;
}

// One unregistered phone, picked by tapping its dot: its wifi address and
// what the nodes can tell from it. Refreshed every two seconds while open.
export function DeviceSheet({ hash, onTrail, onClose }: { hash: string; onTrail: (trail: Step[]) => void; onClose: () => void }) {
  const [report, setReport] = useState<DeviceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    const load = () =>
      api
        .device(hash)
        .then((r) => {
          if (!cancelled) {
            setReport(r);
            setError(null);
            onTrail(r.device.trail ?? []);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof ApiError ? e.message : copy.errors.generic);
        });
    load();
    const id = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hash]);

  const zoneName = (id: string) => zoneById.get(id)?.name ?? id;
  const d = report?.device;
  const day = report?.day;

  return (
    <section className="sheet device-sheet">
      <div className="zone-head">
        <h2>{copy.device.title}</h2>
        <button type="button" className="quiet" onClick={onClose} aria-label={copy.device.close}>
          ×
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
      {d && (
        <>
          <h3>{copy.device.mac}</h3>
          {d.mac ? (
            <>
              <p className="mono">{d.mac}</p>
              <p className="hint">{d.randomised ? copy.device.randomised : copy.device.hardware}</p>
            </>
          ) : (
            <p className="hint">{report?.addressWithheld ? (d.randomised ? copy.device.randomised : copy.device.hardware) : copy.device.noMac}</p>
          )}

          {day && (
            <>
              <h3>{copy.device.today}</h3>
              <ol className="timeline">
                <li>
                  <time>{clock(new Date(day.firstSeen))}</time>
                  <span>{copy.device.firstHeard}</span>
                </li>
                {stayRows(day).map((r) => (
                  <li key={r.from.toISOString()}>
                    <time>{clock(r.from)}</time>
                    <span>
                      {r.visit > 1 && <small>{copy.device.returned(r.visit)}</small>}
                      {r.current ? (r.zone ? copy.device.here(zoneName(r.zone)) : copy.device.offZone) : zoneName(r.zone)}
                      {r.minutes > 0 && <small>{copy.device.stayDuration(r.minutes)}</small>}
                    </span>
                  </li>
                ))}
                <li className="now">
                  <time>{ago(new Date(d.lastSeen), now)}</time>
                  <span>{copy.device.now}</span>
                </li>
              </ol>
            </>
          )}

          <h3>{copy.device.heard}</h3>
          {d.nodes.length === 0 && <p className="hint">{copy.device.quiet(ago(new Date(d.lastSeen), now))}</p>}
          <ul className="heard">
            {d.nodes.map((n) => (
              <li key={n.nodeId}>
                <span>
                  {n.label || `node ${n.nodeId}`}
                  {n.zoneId && <small>{zoneName(n.zoneId)}</small>}
                </span>
                <span className="signal" aria-label={copy.device.dbm(n.rssi)}>
                  <i data-bars={bars(n.rssi)} />
                  {copy.device.dbm(n.rssi)}
                </span>
              </li>
            ))}
          </ul>
          {!day && d.nodes.length > 0 && <p className="hint">{copy.device.lastHeard(ago(new Date(d.lastSeen), now))}</p>}

          <p className="hash" title={d.hash}>
            {copy.device.hash} <span className="mono">{d.hash.slice(0, 12)}…</span>
          </p>
        </>
      )}
    </section>
  );
}
