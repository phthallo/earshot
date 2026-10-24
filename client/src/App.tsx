import { Suspense, lazy, useEffect, useState } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/react';
import { reducers } from './module_bindings';
import { copy } from './copy';
import { api, type Health, type Step } from './api';
import { useMe, useParam } from './hooks';
import { VenueMap } from './components/VenueMap';
// three.js is most of the bundle; the shell and the plan view do not wait for it.
const VenueScene = lazy(() => import('./components/VenueScene').then((m) => ({ default: m.VenueScene })));
import { RegisterSheet } from './components/RegisterSheet';
import { TeamPanel } from './components/TeamPanel';
import { WalkEnrol } from './components/WalkEnrol';
import { AskBar } from './components/AskBar';
import { PrivacyPage } from './components/PrivacyPage';
import { ZoneHistory } from './components/ZoneHistory';
import { ZoneDwell } from './components/ZoneDwell';
import { DeviceSheet } from './components/DeviceSheet';
import { ZoneCard } from './components/ZoneCard';

type View = 'map' | 'me' | 'team' | 'ask' | 'privacy';
const VIEWS: View[] = ['map', 'me', 'team', 'ask', 'privacy'];

export function App() {
  const { isActive, connectionError } = useSpacetimeDB();
  const me = useMe();
  const [viewParam, setView] = useParam('view', 'map', true);
  const [floorParam, setFloor] = useParam('floor', '1');
  const [zoneParam, setZone] = useParam('zone', '');
  const [deviceParam, setDevice] = useParam('device', '');
  // Where the selected dot has been, from the sheet's poll, drawn on the map.
  const [trail, setTrail] = useState<Step[]>([]);
  const pickDevice = (hash: string) => {
    if (hash !== deviceParam) setTrail([]);
    setDevice(hash);
  };
  const [modeParam, setMode] = useParam('mode', '3d');
  const [xrayParam, setXray] = useParam('xray', '0');
  const xray = xrayParam === '1';
  const [liveParam, setLive] = useParam('live', '0');
  const liveOnly = liveParam === '1';
  const floor = floorParam === '2' ? 2 : 1;
  const mode = modeParam === '2d' ? '2d' : '3d';

  const setVisible = useReducer(reducers.setVisible);
  const [health, setHealth] = useState<Health | null>(null);
  // A bridge without Ask hides the tab; a saved ?view=ask link lands on the map.
  const askOff = health?.ask === false;
  const view = (VIEWS.includes(viewParam as View) && !(askOff && viewParam === 'ask') ? viewParam : 'map') as View;
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
    <div className={`app view-${view}`}>
      <img className="planet" src="/brand/earth.png" alt="" aria-hidden="true" />
      <header className="top">
        <a className="brand" href="https://calhacks.io" aria-label="Cal Hacks 13.0">
          <img src="/brand/logo.svg" alt="" width="882" height="689" />
        </a>
        <div className="title">
          <h1 className="wordmark">{copy.appName}</h1>
          <p className="tagline">{copy.tagline}</p>
        </div>
        <nav className="tabs" aria-label="Pages">
          {VIEWS.filter((v) => v !== 'ask' || !askOff).map((v) => (
            <a key={v} href={`?view=${v}${floor === 2 ? '&floor=2' : ''}`} className={view === v ? 'on' : ''} aria-current={view === v ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setView(v); }}>
              {copy.nav[v]}
            </a>
          ))}
          <a href="/landing/index.html">{copy.nav.about}</a>
        </nav>
        <nav className="floors" aria-label="Floor">
          {[1, 2].map((f) => (
            <button key={f} type="button" className={floor === f ? 'on' : ''} onClick={() => setFloor(String(f))} aria-pressed={floor === f}>
              {copy.floors[f]}
            </button>
          ))}
          <span className="divider" aria-hidden="true" />
          {(['3d', '2d'] as const).map((m) => (
            <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => setMode(m)} aria-pressed={mode === m}>
              {copy.modes[m]}
            </button>
          ))}
          {mode === '3d' && (
            <button type="button" className={xray ? 'on' : ''} onClick={() => setXray(xray ? '0' : '1')} aria-pressed={xray}>
              {copy.scene.xray}
            </button>
          )}
          <button type="button" className={liveOnly ? 'on' : ''} onClick={() => setLive(liveOnly ? '0' : '1')} aria-pressed={liveOnly}>
            {copy.liveOnly}
          </button>
        </nav>
      </header>

      <main className={`view-${view}`}>
        {!isActive && <p className="banner">{connectionError ? copy.map.offline : copy.map.connecting}</p>}
        {mode === '3d' ? (
          <Suspense fallback={<figure className="map scene"><div className="scene-host" /></figure>}>
            <VenueScene floor={floor} xray={xray} liveOnly={liveOnly} meId={me?.personId} selectedZone={zoneParam || undefined} onSelectZone={(z) => setZone(z ?? '')} selectedDevice={deviceParam || undefined} trail={trail} onSelectDevice={pickDevice} />
          </Suspense>
        ) : (
          <VenueMap floor={floor} liveOnly={liveOnly} meId={me?.personId} selectedZone={zoneParam || undefined} onSelectZone={(z) => setZone(z ?? '')} selectedDevice={deviceParam || undefined} trail={trail} onSelectDevice={pickDevice} />
        )}
        <aside className="panel">
          {view === 'map' && me && !me.visible && (
            <p className="hint">
              {copy.map.hidden}{' '}
              <button type="button" className="link" onClick={() => setVisible({ visible: true })}>
                {copy.map.show}
              </button>
            </p>
          )}
          {view === 'map' && deviceParam && <DeviceSheet hash={deviceParam} onTrail={setTrail} onClose={() => pickDevice('')} />}
          {view === 'map' && zoneParam && <ZoneCard zoneId={zoneParam} liveOnly={liveOnly} onClose={() => setZone('')} />}
          {view === 'map' && zoneParam && health?.history && <ZoneHistory zoneId={zoneParam} />}
          {view === 'map' && zoneParam && <ZoneDwell zoneId={zoneParam} />}
          {view === 'me' && (
            <>
              <RegisterSheet />
              <WalkEnrol />
            </>
          )}
          {view === 'team' && <TeamPanel onSelectZone={showZone} onGoToMe={() => setView('me')} />}
          {view === 'ask' && <AskBar enabled={health?.ask ?? true} voice={health?.voice ?? false} />}
          {view === 'privacy' && <PrivacyPage mock={health?.mode?.includes('mock') ?? true} receipts={health?.ask ?? true} onGoToMe={() => setView('me')} />}
          {(view === 'team' || view === 'ask') && <img className="art" src="/brand/bear-plane.png" alt="" aria-hidden="true" />}
        </aside>
      </main>
    </div>
  );
}
