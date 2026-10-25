import { copy } from '../../copy';
import { SignIn } from './SignIn';
import { VenueList } from './VenueList';
import { useVenueAdmin } from './useVenueAdmin';

// The venues page: sign in, then the caller's venues with the create form and the example.
export function AdminPanel({ onVenue }: { onVenue: (venueId: string) => void }) {
  const { me, venues, loadError, refresh, signOut } = useVenueAdmin('');
  return (
    <aside className="panel">
      {me === null && <SignIn />}
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
      {me && <VenueList venues={venues} onOpen={onVenue} onCreated={refresh} />}
    </aside>
  );
}
