import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, api, type AdminFloor, type AdminVenue } from '../../api';
import { copy } from '../../copy';
import { ago, useNow } from '../../hooks';
import { RelayKey } from './RelayKey';

type Board = { mac: string; nodeId: number; flashedAt: Date };

export const CALHACKS = 'calhacks';
// The three live boards at the hackathon; always offered for placing on its plan.
export const CALHACKS_NODES = [103, 104, 105];

type Props = {
  venue: AdminVenue;
  floors: AdminFloor[];
  boards: Board[];
  floor: number;
  onFloor: (index: number) => void;
  nodeIds: number[];
  placing: number | undefined;
  onPlacing: (nodeId: number | undefined) => void;
  placeStatus: { kind: 'ok' | 'warn'; text: string } | null;
  onBack: () => void;
  onChanged: () => Promise<void>;
  // Venue-wide controls shown under the title, such as the example's simulated crowd switch.
  tools?: ReactNode;
  flash: ReactNode;
};

export function VenuePage({ venue, floors, boards, floor, onFloor, nodeIds, placing, onPlacing, placeStatus, onBack, onChanged, tools, flash }: Props) {
  const now = useNow(30000);
  const builtIn = venue.venueId === CALHACKS;
  const [index, setIndex] = useState('');
  // Floors arrive over the subscription after mount, so the suggested number follows them.
  const nextIndex = String(floors.reduce((m, f) => Math.max(m, f.index), 0) + 1);
  const [name, setName] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  async function upload(e: FormEvent) {
    e.preventDefault();
    const i = Number(index || nextIndex);
    if (!image || !name.trim() || !Number.isInteger(i) || i < 0 || i > 255) return;
    setUploading(true);
    setUploadError('');
    try {
      await api.uploadFloor(venue.venueId, i, name.trim(), image);
      await onChanged();
      setIndex('');
      setName('');
      setImage(null);
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : copy.errors.generic);
    } finally {
      setUploading(false);
    }
  }

  // The board table updates the list on its own; a failed delete leaves the row.
  const forget = (mac: string) => api.forgetBoard(mac).catch(() => {});

  return (
    <>
      <section className="sheet">
        <h2>{venue.name}</h2>
        <button type="button" className="link" onClick={onBack}>
          {copy.admin.backToList}
        </button>
        {builtIn && (
          <a className="button" href={api.exportUrl(venue.venueId)} download="calhacks-venue.json">
            {copy.admin.export}
          </a>
        )}
      </section>
      {tools}

      <section className="sheet">
        <h3>{copy.admin.floorsTitle}</h3>
        {floors.length === 0 && <p className="hint">{copy.admin.floorsEmpty}</p>}
        {floors.length > 0 && (
          <ul className="floor-list">
            {floors.map((f) => (
              <li key={f.floorKey}>
                <img src={f.imageUrl} alt="" width={64} height={40} loading="lazy" />
                <span>
                  <strong>{f.name}</strong>
                  <span className="muted">
                    {' '}
                    {f.index} · {Math.round(f.width)}×{Math.round(f.height)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {!builtIn && (
          <form className="stack" onSubmit={upload}>
            <div className="row">
              <label className="short">
                {copy.admin.floorIndexLabel}
                <input type="number" inputMode="numeric" min={0} max={255} value={index || nextIndex} onChange={(e) => setIndex(e.target.value)} required />
              </label>
              <label>
                {copy.admin.floorNameLabel}
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={copy.floors[1]} required />
              </label>
            </div>
            <label>
              {copy.admin.floorImageLabel}
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setImage(e.target.files?.[0] ?? null)} required />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={uploading || !image || !name.trim()}>
                {uploading ? copy.admin.uploading : copy.admin.upload}
              </button>
            </div>
            {uploadError && <p className="warn">{uploadError}</p>}
          </form>
        )}
      </section>

      <section className="sheet">
        <h3>{copy.admin.nodesTitle}</h3>
        {boards.length === 0 && <p className="hint">{copy.admin.nodesEmpty}</p>}
        {boards.length > 0 && (
          <ul className="boards">
            {boards.map((b) => (
              <li key={b.mac}>
                <strong>{b.nodeId}</strong>
                <span className="mono">{b.mac}</span>
                <span className="muted">{copy.admin.flashedAgo(ago(b.flashedAt, now))}</span>
                <button type="button" className="quiet" onClick={() => forget(b.mac)}>
                  {copy.admin.forget}
                </button>
              </li>
            ))}
          </ul>
        )}
        {flash}
      </section>

      <RelayKey venue={venue} onChanged={onChanged} />

      <section className="sheet">
        <h3>{copy.admin.placeTitle}</h3>
        {floors.length === 0 ? (
          <p className="hint">{copy.admin.placeNoFloors}</p>
        ) : (
          <div className="row">
            <label>
              {copy.admin.placePick}
              <select value={placing ?? ''} onChange={(e) => onPlacing(e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">–</option>
                {nodeIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {copy.admin.floorLabel}
              <select value={floor} onChange={(e) => onFloor(Number(e.target.value))}>
                {floors.map((f) => (
                  <option key={f.floorKey} value={f.index}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {placing !== undefined && floors.length > 0 && <p className="hint">{copy.admin.placeHint(placing)}</p>}
        {placeStatus && <p className={placeStatus.kind}>{placeStatus.text}</p>}
      </section>
    </>
  );
}
