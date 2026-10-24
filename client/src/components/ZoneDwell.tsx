import { useEffect, useState } from 'react';
import { api, type ZoneDwell as Dwell } from '../api';
import { copy } from '../copy';

// Distinct phones and typical stay for one zone today, refreshed each minute.
// Silent until a real node has heard a phone here, so the mock crowd shows nothing.
export function ZoneDwell({ zoneId }: { zoneId: string }) {
  const [dwell, setDwell] = useState<Dwell | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDwell(null);
    const load = () =>
      api
        .dwell(zoneId)
        .then((d) => {
          if (!cancelled) setDwell(d);
        })
        .catch(() => {
          if (!cancelled) setDwell(null);
        });
    load();
    const id = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [zoneId]);

  if (!dwell || dwell.unique === 0) return null;
  return <p className="hint">{copy.dwell.summary(dwell.unique, dwell.medianStayMin)}</p>;
}
