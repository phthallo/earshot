import { useState } from 'react';
import { ApiError, api, type AdminVenue, type RelayKey as Key } from '../../api';
import { copy } from '../../copy';

// The venue's relay key: made here, shown once, never fetched again.
export function RelayKey({ venue, onChanged }: { venue: AdminVenue; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Key | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  async function generate() {
    setBusy(true);
    setError('');
    setConfirming(false);
    try {
      setShown(await api.rotateKey(venue.venueId));
      setCopied(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand() {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="sheet">
      <h3>{copy.admin.relayTitle}</h3>
      <p className="hint">{copy.admin.relayIntro}</p>
      {shown ? (
        <div className="stack">
          <p className="warn">{copy.admin.relayShownOnce}</p>
          <label>
            {copy.admin.relayCommandLabel}
            <textarea className="mono" readOnly rows={3} value={shown.command} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <div className="row">
            <button type="button" className="primary" onClick={copyCommand}>
              {copied ? copy.admin.relayCopied : copy.admin.relayCopy}
            </button>
          </div>
        </div>
      ) : (
        <p className="hint">{venue.hasKey ? copy.admin.relayHasKey : copy.admin.relayNoKey}</p>
      )}
      {!shown && confirming && <p className="warn">{copy.admin.relayReplaceConfirm}</p>}
      {!shown && (
        <div className="row">
          {venue.hasKey && !confirming ? (
            <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(true)}>
              {copy.admin.relayReplace}
            </button>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={generate}>
              {busy ? copy.admin.relayGenerating : venue.hasKey ? copy.admin.relayReplace : copy.admin.relayGenerate}
            </button>
          )}
          {confirming && (
            <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(false)}>
              {copy.admin.relayCancel}
            </button>
          )}
        </div>
      )}
      {error && <p className="warn">{error}</p>}
    </section>
  );
}
