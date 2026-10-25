import { Suspense, lazy, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/react';
import { reducers } from './module_bindings';
import { copy } from './copy';
import { api, type Health, type Step } from './api';
import { useMe, useParam, usePath } from './hooks';
import { VenueMap } from './components/VenueMap';
// three.js is most of the bundle; the shell and the plan view do not wait for it.
const VenueScene = lazy(() => import('./components/VenueScene').then((m) => ({ default: m.VenueScene })));
import { RegisterSheet } from './components/RegisterSheet';
import { WalkEnrol } from './components/WalkEnrol';
import { AskBar } from './components/AskBar';
import { Cards } from './components/Cards';
import { PrivacyPage } from './components/PrivacyPage';
import { ZoneHistory } from './components/ZoneHistory';
import { ZoneDwell } from './components/ZoneDwell';
import { DeviceSheet } from './components/DeviceSheet';
import { ZoneCard } from './components/ZoneCard';
import { AdminPanel } from './components/admin/AdminPanel';
import { FloorPlan } from './components/admin/FloorPlan';
import { VenueConfig } from './components/admin/VenueConfig';
import { CALHACKS } from './components/admin/VenuePage';
import { useVenueAdmin } from './components/admin/useVenueAdmin';
import { Landing } from './components/landing/Landing';

// A venue's pages: the map (Ask sits beside it, under whatever zone or phone is selected, so a
// question and the thing it is about stay on screen together), Me and Privacy as settings pages,
// and setup, which is the map with the organiser's tools card open.
type View = 'map' | 'me' | 'privacy' | 'setup';
type Tab = Exclude<View, 'setup'>;
const TABS: Tab[] = ['map', 'me', 'privacy'];

export const VENUES_PATH = '/venues';
export const venuePath = (venueId: string, view: View = 'map') => `${VENUES_PATH}/${encodeURIComponent(venueId)}${view === 'map' ? '' : `/${view}`}`;
const VENUE_PATH = /^\/venues\/([a-z0-9-]+)(?:\/(me|privacy|setup))?\/?$/;

// Pages by path: / the marketing page, /venues (sign in, pick or create a venue) and
// /venues/<id>[/me|/privacy|/setup], a venue's live map and its pages.
export function App() {
  const [path, go] = usePath();
  const m = VENUE_PATH.exec(path);
  const link = (to: string) => (e: MouseEvent) => {
    e.preventDefault();
    go(to);
  };
  if (m) return <LiveMap key={m[1]} go={go} link={link} venueId={m[1]} view={(m[2] as View | undefined) ?? 'map'} />;
  if (path.startsWith(VENUES_PATH)) return <Venues go={go} link={link} />;
  return <Landing link={link} />;
}

type Nav = { go: (path: string) => void; link: (to: string) => (e: MouseEvent) => void };

// The planet sits outside the header so the header's stacking context does not put it over the logo.
const Planet = () => <img className="planet" src="/brand/earth.png" alt="" aria-hidden="true" />;

function Brand() {
  return (
    <a className="brand" href="https://calhacks.io" aria-label="Cal Hacks 13.0">
      <img src="/brand/logo.svg" alt="" width="882" height="689" />
    </a>
  );
}

// The venues list. Plain Earshot: the Cal Hacks lettering belongs to the example venue's map.
function Venues({ go, link }: Nav) {
  return (
    <div className="app view-admin">
      <header className="top">
        <div className="title">
          <h1 className="wordmark">{copy.appName}</h1>
        </div>
        <nav className="tabs" aria-label="Pages">
          <a href={VENUES_PATH} className="on" aria-current="page" onClick={link(VENUES_PATH)}>
            {copy.nav.admin}
          </a>
        </nav>
      </header>
      <main className="view-admin">
        <AdminPanel onVenue={(id) => go(id ? venuePath(id) : VENUES_PATH)} />
      </main>
    </div>
  );
}

// A venue's live map. The Cal Hacks venue has the modelled hall (3D or plan, zones, the
// simulated crowd, Ask, Me and Privacy); any other venue shows its uploaded floor images
// with node pins and the phones its relay hears. Both carry the setup card behind "Set up".
function LiveMap({ venueId, view: page, go, link }: Nav & { venueId: string; view: View }) {
  const { isActive, connectionError } = useSpacetimeDB();
  const me = useMe();
  const hall = venueId === CALHACKS;
  const admin = useVenueAdmin(venueId);
  // Venues without the modelled hall have only the map and its setup.
  const view: View = hall || page === 'setup' ? page : 'map';
  const setup = view === 'setup';
  // The floor, zone and phone picked on the map stay in the query across the venue's pages.
  const setView = (v: View) => go(venuePath(venueId, v) + location.search);
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
  const floors = hall ? [1, 2] : admin.floors.map((f) => f.index);
  const floor = floors.includes(Number(floorParam)) ? Number(floorParam) : (floors[0] ?? 1);
  // Placing a node needs a click on the plan, so a 3D map drops to the plan meanwhile.
  const placing = setup && admin.placing !== undefined;
  const mode = hall && modeParam !== '2d' && !placing ? '3d' : '2d';
  const switchedToPlan = placing && modeParam !== '2d';

  const setVisible = useReducer(reducers.setVisible);
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const poll = () => api.health().then(setHealth).catch(() => setHealth(null));
    poll();
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, []);

  // Beside the map: the setup card when open, else the picked zone or phone and the Ask box.
  // Other views have one panel.
  let panel: ReactNode = null;
  if (setup) {
    panel = (
      <Cards
        cards={{
          setup: (
            <VenueConfig
              admin={admin}
              floor={floor}
              onFloor={(f) => setFloor(String(f))}
              onBack={() => go(VENUES_PATH)}
              onClose={() => {
                admin.setPlacing(undefined);
                setView('map');
              }}
              switchedToPlan={switchedToPlan}
            />
          ),
        }}
      />
    );
  } else if (view === 'map' && !hall) {
    panel = <Cards cards={{}} />;
  } else if (view === 'map') {
    const hidden = me && !me.visible;
    panel = (
      <Cards
        cards={{
          hidden: hidden && (
            <p className="hint">
              {copy.map.hidden}{' '}
              <button type="button" className="link" onClick={() => setVisible({ visible: true })}>
                {copy.map.show}
              </button>
            </p>
          ),
          device: deviceParam && <DeviceSheet hash={deviceParam} onTrail={setTrail} onClose={() => pickDevice('')} />,
          zone: zoneParam && (
            <>
              <ZoneCard zoneId={zoneParam} liveOnly={liveOnly} onClose={() => setZone('')} />
              <ZoneDwell zoneId={zoneParam} />
            </>
          ),
          history: zoneParam && health?.history && <ZoneHistory zoneId={zoneParam} />,
          ask: health?.ask !== false && <AskBar voice={health?.voice ?? false} liveOnly={liveOnly} />,
        }}
      />
    );
  } else if (view === 'me') {
    panel = (
      <>
        <RegisterSheet />
        <WalkEnrol />
      </>
    );
  } else if (view === 'privacy') {
    panel = <PrivacyPage mock={health?.mode?.includes('mock') ?? true} receipts={health?.ask ?? true} onGoToMe={() => setView('me')} />;
  }

  return (
    <div className={`app view-${setup ? 'map' : view}`}>
      {hall && <Planet />}
      <header className="top">
        {hall && <Brand />}
        <div className="title">
          <h1 className="wordmark">{copy.appName}</h1>
          <p className="tagline">{hall ? copy.tagline : (admin.venue?.name ?? venueId)}</p>
        </div>
        <nav className="tabs" aria-label="Pages">
          {(hall ? TABS : (['map'] as Tab[])).map((v) => {
            const on = view === v || (v === 'map' && setup);
            return (
              <a key={v} href={venuePath(venueId, v)} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setView(v); }}>
                {copy.nav[v]}
              </a>
            );
          })}
          {/* Leaves this venue: set apart from the venue's own pages. */}
          <a href={VENUES_PATH} className="away" onClick={link(VENUES_PATH)}>
            {copy.nav.myVenues}
          </a>
        </nav>
        <nav className="floors" aria-label="Floor">
          {floors.map((f) => (
            <button key={f} type="button" className={floor === f ? 'on' : ''} onClick={() => setFloor(String(f))} aria-pressed={floor === f}>
              {hall ? copy.floors[f] : (admin.floors.find((x) => x.index === f)?.name ?? String(f))}
            </button>
          ))}
          {hall && (
            <>
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
            </>
          )}
          <span className="divider" aria-hidden="true" />
          <button type="button" className={setup ? 'on' : ''} onClick={() => setView(setup ? 'map' : 'setup')} aria-pressed={setup}>
            {copy.admin.setup}
          </button>
        </nav>
      </header>

      <main className={`view-${setup ? 'map' : view}`}>
        {!isActive && <p className="banner">{connectionError ? copy.map.offline : copy.map.connecting}</p>}
        {!hall ? (
          (() => {
            const current = admin.floors.find((f) => f.index === floor);
            return current ? (
              <FloorPlan floor={current} pins={admin.pins} dots={admin.dots} onClick={placing ? (x, y) => admin.place(x, y, floor) : undefined} />
            ) : (
              <figure className="map floor-plan">
                <p className="hint">{copy.admin.floorsEmpty}</p>
              </figure>
            );
          })()
        ) : mode === '3d' ? (
          <Suspense fallback={<figure className="map scene"><div className="scene-host" /></figure>}>
            <VenueScene floor={floor === 2 ? 2 : 1} xray={xray} liveOnly={liveOnly} meId={me?.personId} selectedZone={zoneParam || undefined} onSelectZone={(z) => setZone(z ?? '')} selectedDevice={deviceParam || undefined} trail={trail} onSelectDevice={pickDevice} />
          </Suspense>
        ) : (
          <VenueMap floor={floor === 2 ? 2 : 1} liveOnly={liveOnly} meId={me?.personId} selectedZone={zoneParam || undefined} onSelectZone={(z) => setZone(z ?? '')} selectedDevice={deviceParam || undefined} trail={trail} onSelectDevice={pickDevice} onPlanClick={placing ? admin.place : undefined} pins={setup ? admin.pins : []} />
        )}
        {view === 'map' || setup ? panel : <aside className="panel">{panel}</aside>}
      </main>
    </div>
  );
}
