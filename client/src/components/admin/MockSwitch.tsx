import { useEffect, useState } from 'react';
import { ApiError, api } from '../../api';
import { copy } from '../../copy';

// Turns the simulated crowd on or off for every viewer. Hidden on a bridge
// started without --mock.
export function MockSwitch() {
  const [state, setState] = useState<{ available: boolean; on: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .health()
      .then((h) => setState({ available: h.mockAvailable, on: h.mock }))
      .catch(() => setState(null));
  }, []);

  if (!state?.available) return null;

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      const r = await api.setMock(!state!.on);
      setState({ available: true, on: r.enabled });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sheet">
      <h3>{copy.admin.mockTitle}</h3>
      <p>
        {state.on ? copy.admin.mockOn : copy.admin.mockOff}{' '}
        <button type="button" className="quiet" onClick={toggle} disabled={busy}>
          {busy ? copy.admin.mockBusy : state.on ? copy.admin.mockTurnOff : copy.admin.mockTurnOn}
        </button>
      </p>
      <p className="hint">{copy.admin.mockHelp}</p>
      {error && <p className="warn">{error}</p>}
    </section>
  );
}
