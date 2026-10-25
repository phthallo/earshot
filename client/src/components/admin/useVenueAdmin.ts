import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../../module_bindings';
import { ApiError, api, type AdminFloor, type AdminVenue, type Me } from '../../api';
import { copy } from '../../copy';
import { PLAN_HEIGHT, PLAN_WIDTH } from '../../geom';
import type { Pin } from '../VenueMap';
import { CALHACKS, CALHACKS_NODES } from './VenuePage';

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

export type PlaceStatus = { kind: 'ok' | 'warn'; text: string } | null;

// Everything a venue's page needs to draw its plan and run its setup tools: who is signed in,
// the venue and its floors, flashed boards, node pins and the place-a-node flow.
export function useVenueAdmin(venueId: string) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [venues, setVenues] = useState<AdminVenue[]>([]);
  const [loadError, setLoadError] = useState('');
  const [nodes] = useTable(tables.node);
  const [floorRows] = useTable(tables.floor);
  const [boardRows] = useTable(tables.board);
  const [venueNodes] = useTable(tables.venueNode);
  const [anonPoints] = useTable(tables.anonPoint);
  const dots = useMemo(() => anonPoints.filter((p) => p.venueId === venueId), [anonPoints, venueId]);

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

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setMe(null);
    setVenues([]);
  }, []);

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

  const [placing, setPlacingState] = useState<number | undefined>();
  const [pending, setPending] = useState<Pin | null>(null);
  const [placeStatus, setPlaceStatus] = useState<PlaceStatus>(null);
  const setPlacing = useCallback((id: number | undefined) => {
    setPlacingState(id);
    setPlaceStatus(null);
  }, []);
  // Nodes offered for placing: the venue's flashed boards, real nodes already placed in it (ids from 100 up,
  // the same rule as the server; the simulated crowd's nodes below that are not placeable) and the demo trio.
  const nodeIds = useMemo(() => {
    const ids = new Set<number>([
      ...(venueId === CALHACKS ? CALHACKS_NODES : []),
      ...boards.map((b) => b.nodeId),
      ...venueNodes.filter((v) => v.venueId === venueId && v.nodeId >= 100).map((v) => v.nodeId),
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

  const place = useCallback(
    async (x: number, y: number, f: number) => {
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
    },
    [placing, venue],
  );

  return { me, venues, venue, loadError, refresh, signOut, floors, boards, nodeIds, pins, dots, placing, setPlacing, place, placeStatus };
}
