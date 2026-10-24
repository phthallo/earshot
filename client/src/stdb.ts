import { DbConnection } from './module_bindings';

export const STDB_URI = import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000';
export const STDB_DB = import.meta.env.VITE_STDB_DB ?? 'venuemap';
export const BRIDGE_URL = (import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:8080').replace(/\/$/, '');

const TOKEN_KEY = 'venuemap.token';

export function savedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // private window; nothing to forget
  }
}

export function connectionBuilder() {
  return DbConnection.builder()
    .withUri(STDB_URI)
    .withDatabaseName(STDB_DB)
    .withToken(savedToken())
    .onConnect((_conn, _identity, token) => {
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        // private window; the identity lasts for this tab only
      }
    });
}
