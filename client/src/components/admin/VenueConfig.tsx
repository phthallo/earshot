import { copy } from '../../copy';
import { Flash } from './Flash';
import { MockSwitch } from './MockSwitch';
import { SignIn } from './SignIn';
import { CALHACKS, VenuePage } from './VenuePage';
import type { useVenueAdmin } from './useVenueAdmin';

type Props = {
  admin: ReturnType<typeof useVenueAdmin>;
  floor: number;
  onFloor: (index: number) => void;
  onBack: () => void;
  onClose: () => void;
  // Set while a node is being placed and the map had to leave 3D for the plan.
  switchedToPlan: boolean;
};

// The setup card beside a venue's live map: floors, boards, relay key and node placing.
// Signed out it holds only the sign-in button.
export function VenueConfig({ admin, floor, onFloor, onBack, onClose, switchedToPlan }: Props) {
  const { me, venue, venues, loadError, refresh, signOut, floors, boards, nodeIds, placing, setPlacing, placeStatus } = admin;
  const venueId = venue?.venueId ?? '';
  return (
    <>
      <section className="sheet config-head">
        <h2>{copy.admin.setupTitle}</h2>
        <button type="button" className="quiet" onClick={onClose} aria-label={copy.zone.close}>
          ×
        </button>
      </section>
      {me === null && <SignIn title={null} />}
      {me && (
        <p className="whoami">
          {me.avatarUrl && <img src={me.avatarUrl} alt="" width={24} height={24} />}
          <strong>{me.login}</strong>
          {me.provider === 'local' && <span className="muted">{copy.admin.localSession}</span>}
          <button type="button" className="quiet" onClick={signOut}>
            {copy.admin.signOut}
          </button>
        </p>
      )}
      {me && loadError && <p className="warn">{loadError}</p>}
      {me && venue && (
        <>
          {switchedToPlan && <p className="hint">{copy.admin.switchedToPlan}</p>}
          <VenuePage
            venue={venue}
            floors={floors}
            boards={boards}
            floor={floor}
            onFloor={onFloor}
            nodeIds={nodeIds}
            placing={placing}
            onPlacing={setPlacing}
            placeStatus={placeStatus}
            onBack={onBack}
            onChanged={refresh}
            tools={venueId === CALHACKS ? <MockSwitch /> : null}
            flash={<Flash key={venueId} venueId={venueId} defaultId={nodeIds.find((id) => !boards.some((b) => b.nodeId === id)) ?? 104} onSaved={refresh} />}
          />
        </>
      )}
      {me && !venue && !loadError && venues.length > 0 && (
        <section className="sheet">
          <p className="hint">{copy.admin.notYours}</p>
          <button type="button" className="link" onClick={onBack}>
            {copy.admin.backToList}
          </button>
        </section>
      )}
    </>
  );
}
