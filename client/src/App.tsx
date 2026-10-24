import { useEffect, useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { copy } from './copy';
import { api } from './api';
import { useMe, useParam } from './hooks';
import { VenueMap } from './components/VenueMap';
import { RegisterSheet } from './components/RegisterSheet';
import { TeamPanel } from './components/TeamPanel';
import { WalkEnrol } from './components/WalkEnrol';
import { AskBar } from './components/AskBar';
import { PrivacyPage } from './components/PrivacyPage';

type View = 'map' | 'me' | 'team' | 'ask' | 'privacy';
const VIEWS: View[] = ['map', 'me', 'team', 'ask', 'privacy'];

export function App() {
  const { isActive, connectionError } = useSpacetimeDB();
  const me = useMe();
  const [viewParam, setView] = useParam('view', 'map', true);
  const [floorParam, setFloor] = useParam('floor', '1');
  const [zoneParam, setZone] = useParam('zone', '');
  const view = (VIEWS.includes(viewParam as View) ? viewParam : 'map') as View;
  const floor = floorParam === '2' ? 2 : 1;

  const [health, setHealth] = useState<{ mode: string; ask: boolean; voice: boolean } | null>(null);
  useEffect(() => {
    const poll = () => api.health().then(setHealth).catch(() => setHealth(null));
    poll();
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, []);

  function showZone(zoneId: string, zoneFloor: number) {
    setFloor(String(zoneFloor));
    setZone(zoneId);
    setView('map');
  }

  return (
    <div className="app">
      <header className="top">
        <h1 className="wordmark">{copy.appName}</h1>
        <p className="tagline">{copy.tagline}</p>
        <nav className="floors" aria-label="Floor">
          {[1, 2].map((f) => (
            <button key={f} type="button" className={floor === f ? 'on' : ''} onClick={() => setFloor(String(f))} aria-pressed={floor === f}>
              {copy.floors[f]}
            </button>
          ))}
        </nav>
      </header>

      <main className={`view-${view}`}>
        {!isActive && <p className="banner">{connectionError ? copy.map.offline : copy.map.connecting}</p>}
        <VenueMap floor={floor} meId={me?.personId} selectedZone={zoneParam || undefined} onSelectZone={(z) => setZone(z ?? '')} />
        <aside className="panel">
          {view === 'map' && me && !me.visible && <p className="hint">{copy.map.hidden}</p>}
          {view === 'me' && (
            <>
              <RegisterSheet />
              <WalkEnrol />
            </>
          )}
          {view === 'team' && <TeamPanel onSelectZone={showZone} />}
          {view === 'ask' && <AskBar voice={health?.voice ?? false} />}
          {view === 'privacy' && <PrivacyPage mock={health?.mode?.includes('mock') ?? true} />}
        </aside>
      </main>

      <nav className="tabs" aria-label="Pages">
        {VIEWS.map((v) => (
          <a key={v} href={`?view=${v}${floor === 2 ? '&floor=2' : ''}`} className={view === v ? 'on' : ''} aria-current={view === v ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setView(v); }}>
            {copy.nav[v]}
          </a>
        ))}
      </nav>
    </div>
  );
}
