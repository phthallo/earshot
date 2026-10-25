import { BRIDGE_URL } from './stdb';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BRIDGE_URL + path, init);
  } catch {
    throw new ApiError(0, 'The bridge is not reachable. Is it running?');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

const json = (data: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

export type Health = { ok: boolean; mode: string; ask: boolean; voice: boolean; search: boolean; history: boolean };
export type HistoryPoint = { t: string; phones: number; movement: number };
export type ZoneDwell = { zoneId: string; unique: number; now: number; stays: number; medianStayMin: number };
export type NodeHear = { nodeId: number; label: string; zoneId: string; rssi: number; ago: number };
// One past position of an anonymous dot.
export type Step = { floor: number; x: number; y: number; at: string };

export type DeviceReport = {
  device: { hash: string; mac: string; randomised: boolean; firstSeen: string; lastSeen: string; nodes: NodeHear[]; trail: Step[] };
  day: {
    firstSeen: string;
    lastSeen: string;
    zone: string;
    enteredAt: string;
    visits: number;
    zonesStayed: string[];
    // Completed stays of two minutes or more, oldest first.
    stays: { zone: string; from: string; to: string }[];
  } | null;
  // True when the bridge knows the address but the caller is not on the bridge host.
  addressWithheld: boolean;
};

// Admin routes carry the bridge's session cookie.
const withCookie = (init: RequestInit = {}): RequestInit => ({ ...init, credentials: 'include' });

export type Me = { login: string; avatarUrl: string; provider: 'github' | 'local' };
export type AdminFloor = { floorKey: string; venueId: string; index: number; name: string; imageUrl: string; width: number; height: number };
export type AdminVenue = { venueId: string; name: string; ownerLogin: string };
export type PlaceBody = { nodeId: number; venueId: string; floor: number; x: number; y: number; label?: string };

export const api = {
  health: () => call<Health>('/api/health'),
  me: () => call<Me>('/api/auth/me', withCookie()),
  logout: () => call<unknown>('/api/auth/logout', withCookie({ method: 'POST' })),
  venues: async (): Promise<AdminVenue[]> => {
    const body = await call<AdminVenue[] | { venues: AdminVenue[] }>('/api/admin/venues', withCookie());
    return Array.isArray(body) ? body : (body?.venues ?? []);
  },
  createVenue: (venueId: string, name: string) => call<AdminVenue>('/api/admin/venues', withCookie(json({ venueId, name }))),
  uploadFloor: (venueId: string, index: number, name: string, image: File) => {
    const form = new FormData();
    form.set('index', String(index));
    form.set('name', name);
    form.set('image', image);
    return call<AdminFloor>(`/api/admin/venues/${encodeURIComponent(venueId)}/floors`, withCookie({ method: 'POST', body: form }));
  },
  placeNode: (body: PlaceBody) => call<unknown>('/api/admin/nodes/place', withCookie(json(body))),
  rememberBoard: (mac: string, nodeId: number, venueId: string) => call<unknown>('/api/admin/boards', withCookie(json({ mac, nodeId, venueId }))),
  forgetBoard: (mac: string) => call<unknown>(`/api/admin/boards/${encodeURIComponent(mac)}`, withCookie({ method: 'DELETE' })),
  githubSignInUrl: () => `${BRIDGE_URL}/api/auth/github?return=${encodeURIComponent(location.href)}`,
  exportUrl: (venueId: string) => `${BRIDGE_URL}/api/venues/${encodeURIComponent(venueId)}/export`,
  history: (zoneId: string, hours: number) =>
    call<{ zone: string; hours: number; bucketSeconds: number; points: HistoryPoint[] }>(`/api/history?zone=${encodeURIComponent(zoneId)}&hours=${hours}`),
  dwell: (zoneId: string) => call<ZoneDwell>(`/api/dwell?zone=${encodeURIComponent(zoneId)}`),
  device: (hash: string) => call<DeviceReport>(`/api/device?hash=${encodeURIComponent(hash)}`),
  bindMac: (identityHex: string, token: string, mac: string) =>
    call<{ ok: boolean }>(`/api/bind-mac?identity=0x${identityHex}`, {
      ...json({ mac }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }),
  ask: (question: string) => call<{ answer: string }>('/api/ask', json({ question })),
  receipt: (personId: number) => call<{ receipt: string }>(`/api/privacy-receipt?personId=${personId}`),
  pairCode: (identityHex: string, token: string) =>
    call<{ pairCode: string; personId: number }>(`/api/pair-code?identity=0x${identityHex}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  async tts(text: string): Promise<Blob> {
    const res = await fetch(BRIDGE_URL + '/api/voice/tts', json({ text }));
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, body?.error ?? 'Voice is off.');
    }
    return res.blob();
  },
  sttUrl: () => BRIDGE_URL.replace(/^http/, 'ws') + '/api/voice/stt',
};
