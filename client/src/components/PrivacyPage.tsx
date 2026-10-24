import { useState } from 'react';
import { api, ApiError } from '../api';
import { copy } from '../copy';
import { useMe } from '../hooks';

export function PrivacyPage({ mock }: { mock: boolean }) {
  const me = useMe();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchReceipt() {
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.receipt(me.personId);
      setReceipt(r.receipt);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sheet">
      <h2>{copy.privacy.title}</h2>
      <p className="intro">{copy.privacy.anon}</p>
      {mock && <p className="hint">{copy.privacy.mock}</p>}
      {me ? (
        <>
          <button type="button" className="primary" onClick={fetchReceipt} disabled={busy}>
            {busy ? copy.privacy.loading : copy.privacy.receipt}
          </button>
          {receipt && <blockquote className="receipt">{receipt}</blockquote>}
        </>
      ) : (
        <p className="hint">{copy.privacy.needRegister}</p>
      )}
      {error && <p className="warn" role="alert">{error}</p>}
    </section>
  );
}
