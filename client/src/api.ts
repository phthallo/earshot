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

export const api = {
  health: () => call<{ ok: boolean; mode: string; ask: boolean; voice: boolean }>('/api/health'),
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
