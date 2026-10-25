import { useState, type FormEvent } from 'react';
import { ApiError, api, type AdminVenue } from '../../api';
import { copy } from '../../copy';

const SLUG = /^[a-z0-9-]{2,40}$/;

export function VenueList({ venues, onOpen, onCreated }: { venues: AdminVenue[]; onOpen: (venueId: string) => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!SLUG.test(slug) || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.createVenue(slug, name.trim());
      await onCreated();
      setName('');
      setSlug('');
      onOpen(slug);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  // The built-in venue has no owner; it is offered as an example, not as one of yours.
  const mine = venues.filter((v) => v.ownerLogin !== '');
  const example = venues.find((v) => v.ownerLogin === '');

  return (
    <>
      <section className="sheet">
        <h2>{copy.admin.listTitle}</h2>
        {mine.length === 0 && <p className="hint">{copy.admin.listEmpty}</p>}
        <ul className="venues">
          {mine.map((v) => (
            <li key={v.venueId}>
              <button type="button" className="link" onClick={() => onOpen(v.venueId)}>
                {v.name}
              </button>
              <span className="muted">{v.venueId}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="sheet">
        <h3>{copy.admin.createTitle}</h3>
        <form className="stack" onSubmit={create}>
          <label>
            {copy.admin.nameLabel}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={copy.admin.namePlaceholder} required />
          </label>
          <label>
            {copy.admin.slugLabel}
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder={copy.admin.slugPlaceholder}
              pattern="[a-z0-9-]{2,40}"
              required
              aria-describedby="slug-help"
            />
            <span id="slug-help" className="hint">
              {copy.admin.slugHelp}
            </span>
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !SLUG.test(slug) || !name.trim()}>
              {copy.admin.create}
            </button>
          </div>
          {error && <p className="warn">{error}</p>}
        </form>
      </section>
      {example && (
        <section className="sheet">
          <h3>{copy.admin.exampleTitle}</h3>
          <button type="button" className="link" onClick={() => onOpen(example.venueId)}>
            {copy.admin.exampleOpen}
          </button>
        </section>
      )}
    </>
  );
}
