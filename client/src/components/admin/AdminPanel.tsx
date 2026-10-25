import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../../module_bindings';
import { ApiError, api, type AdminFloor, type AdminVenue, type Me } from '../../api';
import { copy } from '../../copy';
import { PLAN_HEIGHT, PLAN_WIDTH } from '../../geom';
import { VenueMap, type Pin } from '../VenueMap';
import { FloorPlan } from './FloorPlan';
import { Flash } from './Flash';
import { SignIn } from './SignIn';
import { VenueList } from './VenueList';
import { CALHACKS, CALHACKS_NODES, VenuePage } from './VenuePage';

// The built-in venue's floors until the floor table has rows for it.
const CALHACKS_FLOORS: AdminFloor[] = [1, 2].map((index) => ({
  floorKey: `${CALHACKS}/${index}`,
  venueId: CALHACKS,
  index,
  name: copy.floors[index],
  imageUrl: index === 2 ? '/venue-mezz.jpg' : '/venue-main.jpg',
  width: PLAN_WIDTH,
  height: PLAN_HEIGHT,
}));

type Props = {
  venueId: string;
  onVenue: (venueId: string) => void;
  floor: number;
  onFloor: (floor: number) => void;
};

// Renders the plan figure and the panel side by side; App places both in its grid.
export function AdminPanel({ venueId, onVenue, floor, onFloor }: Props) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [venues, setVenues] = useState<AdminVenue[]>([]);
  const [loadError, setLoadError] = useState('');
  const [nodes] = useTable(tables.node);
  const [floorRows] = useTable(tables.floor);
  const [boardRows] = useTable(tables.board);
  const [venueNodes] = useTable(tables.venueNode);

  const refresh = useCallback(async () => {
    try {
      setVenues(await api.venues());
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : copy.errors.generic);
    }
  }, []);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        return refresh();
      })
      .catch(() => setMe(null));
  }, [refresh]);

  async function signOut() {
    await api.logout().catch(() => {});
    setMe(null);
    setVenues([]);
  }

  const venue = venues.find((v) => v.venueId === venueId);
  const floors = useMemo(() => {
    const rows = floorRows.filter((f) => f.venueId === venueId).sort((a, b) => a.index - b.index);
    return rows.length === 0 && venueId === CALHACKS ? CALHACKS_FLOORS : rows;
  }, [floorRows, venueId]);
  const boards = useMemo(
    () =>
      boardRows
        .filter((b) => b.venueId === venueId)
        .map((b) => ({ mac: b.mac, nodeId: b.nodeId, flashedAt: b.flashedAt.toDate() }))
        .sort((a, b) => a.nodeId - b.nodeId),
    [boardRows, venueId],
  );

  const [placing, setPlacing] = useState<number | undefined>();
  const [pending, setPending] = useState<Pin | null>(null);
  const [placeStatus, setPlaceStatus] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  // Nodes offered for placing: the venue's flashed boards, nodes already placed in it, and the demo trio for Cal Hacks.
  const nodeIds = useMemo(() => {
    const ids = new Set<number>([
      ...(venueId === CALHACKS ? CALHACKS_NODES : []),
      ...boards.map((b) => b.nodeId),
      ...venueNodes.filter((v) => v.venueId === venueId).map((v) => v.nodeId),
    ]);
    return [...ids].sort((a, b) => a - b);
  }, [venueId, boards, venueNodes]);

  const pins = useMemo<Pin[]>(() => {
    const rows = nodes.filter((n) => nodeIds.includes(n.nodeId)).map((n) => ({ nodeId: n.nodeId, x: n.x, y: n.y, floor: n.floor }));
    if (!pending) return rows;
    return [...rows.filter((r) => r.nodeId !== pending.nodeId), pending];
  }, [nodes, nodeIds, pending]);

  // Once the table shows the node where it was clicked, the stored row takes over from the local pin.
  useEffect(() => {
    if (!pending) return;
    const row = nodes.find((n) => n.nodeId === pending.nodeId);
    if (row && row.floor === pending.floor && Math.abs(row.x - pending.x) < 1 && Math.abs(row.y - pending.y) < 1) setPending(null);
  }, [nodes, pending]);

  async function place(x: number, y: number, f: number) {
    if (placing === undefined || !venue) return;
    const pin = { nodeId: placing, x, y, floor: f, pending: true };
    setPending(pin);
    setPlaceStatus({ kind: 'ok', text: copy.admin.placeSaving });
    try {
      await api.placeNode({ nodeId: placing, venueId: venue.venueId, floor: f, x, y });
      setPlaceStatus({ kind: 'ok', text: copy.admin.placeSaved(placing) });
    } catch (err) {
      setPending(null);
      setPlaceStatus({ kind: 'warn', text: err instanceof ApiError ? err.message : copy.errors.generic });
    }
  }

  const currentFloor = floors.find((f) => f.index === floor) ?? floors[0];
  const showPlan = !!me && !!venue;
  const noop = () => {};

  // Without a venue open, the hall sits beside the panel as on the other pages.
  let plan: ReactNode = <VenueMap floor={1} liveOnly={false} onSelectZone={noop} onSelectDevice={noop} />;
  if (showPlan && venueId === CALHACKS) {
    plan = (
      <VenueMap
        floor={currentFloor?.index === 2 ? 2 : 1}
        liveOnly={false}
        onSelectZone={noop}
        onSelectDevice={noop}
        onPlanClick={placing !== undefined ? place : undefined}
        pins={pins}
      />
    );
  } else if (showPlan && currentFloor) {
    plan = <FloorPlan floor={currentFloor} pins={pins} onClick={placing !== undefined ? (x, y) => place(x, y, currentFloor.index) : undefined} />;
  }

  return (
    <>
      {plan}
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
        {me && !venueId && <VenueList venues={venues} onOpen={onVenue} onCreated={refresh} />}
        {me && venue && (
          <VenuePage
            venue={venue}
            floors={floors}
            boards={boards}
            floor={currentFloor?.index ?? 1}
            onFloor={onFloor}
            nodeIds={nodeIds}
            placing={placing}
            onPlacing={(id) => {
              setPlacing(id);
              setPlaceStatus(null);
            }}
            placeStatus={placeStatus}
            onBack={() => onVenue('')}
            onChanged={refresh}
            flash={<Flash key={venueId} venueId={venueId} defaultId={nodeIds.find((id) => !boards.some((b) => b.nodeId === id)) ?? 104} onSaved={refresh} />}
          />
        )}
        {me && venueId && !venue && !loadError && venues.length > 0 && (
          <section className="sheet">
            <button type="button" className="link" onClick={() => onVenue('')}>
              {copy.admin.backToList}
            </button>
          </section>
        )}
      </aside>
    </>
  );
}
