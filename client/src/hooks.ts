import { useEffect, useMemo, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings';

export function useMe() {
  const { identity } = useSpacetimeDB();
  const [people] = useTable(tables.person);
  return useMemo(() => (identity ? people.find((p) => p.identity.isEqual(identity)) : undefined), [people, identity]);
}

// A clock that ticks once a second so countdowns and "x s ago" labels update.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// URL search params as state: ?view=map&floor=2&zone=food
// Only `push` keys add history entries; the rest replace, so Back leaves the page in one press.
export function useParam(key: string, fallback: string, push = false): [string, (v: string) => void] {
  const read = () => new URLSearchParams(location.search).get(key) ?? fallback;
  const [value, setValue] = useState(read);
  useEffect(() => {
    const onPop = () => setValue(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fallback]);
  const set = (v: string) => {
    const params = new URLSearchParams(location.search);
    if (v === fallback) params.delete(key);
    else params.set(key, v);
    const qs = params.toString();
    const url = qs ? `?${qs}` : location.pathname;
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    setValue(v);
  };
  return [value, set];
}

export function ago(date: Date, now: number): string {
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
