import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { startWaves } from './waves';
import '../../landing.css';

type Stage = 'phone' | 'node' | 'bridge' | 'db' | 'map';
type Key = 'mac' | 'rssi' | 'hash' | 'zone' | 'cell' | 'name';

const STAGES: { id: Stage; label: string; warn?: boolean }[] = [
  { id: 'phone', label: 'Phone' },
  { id: 'node', label: 'ESP32 node', warn: true },
  { id: 'bridge', label: 'Bridge', warn: true },
  { id: 'db', label: 'SpacetimeDB' },
  { id: 'map', label: 'Map' },
];
const ROWS: { key: Key; label: string }[] = [
  { key: 'mac', label: 'Raw address' },
  { key: 'rssi', label: 'Signal strength' },
  { key: 'hash', label: 'Salted hash' },
  { key: 'zone', label: 'Zone count' },
  { key: 'cell', label: 'Grid cell' },
  { key: 'name', label: 'Name' },
];
// What each stage holds of each piece of data; empty means it never reaches it.
const HOLDS: Record<Stage, Record<Key, string>> = {
  phone: { mac: 'sent', rssi: 'sent', hash: '', zone: '', cell: '', name: '' },
  node: { mac: 'heard', rssi: 'heard', hash: '', zone: '', cell: '', name: '' },
  bridge: { mac: 'memory, 10 s', rssi: 'yes', hash: 'made here', zone: 'yes', cell: 'yes', name: '' },
  db: { mac: 'never', rssi: '', hash: 'stored', zone: 'stored', cell: 'stored', name: 'opt-in only' },
  map: { mac: 'never', rssi: '', hash: '', zone: 'shown', cell: 'as a dot', name: 'opt-in only' },
};
const RUNS: Record<Stage, [name: string, role: string, logo?: string][]> = {
  phone: [['Any phone', 'no app'], ['Probe frames', 'already sent']],
  node: [['ESP32-S3', '$5 board', 'espressif.svg'], ['ESP-IDF', 'firmware', 'espressif.svg'], ['ESP-NOW', 'battery uplink']],
  bridge: [
    ['Go', 'one binary', 'go.svg'],
    ['Laptop, Pi or server', 'Linux, macOS, Windows'],
    ['Claude', 'ask, privacy receipt', 'claude.svg'],
    ['Cartesia', 'voice', 'cartesia.png'],
    ['Moss', 'guide search', 'moss.png'],
    ['TigerData', 'zone history', 'tigerdata.png'],
    ['Fetch.ai', 'concierge agent', 'fetchai.svg'],
  ],
  db: [['SpacetimeDB', 'live tables', 'spacetimedb.png'], ['Row security', 'own rows only']],
  map: [['React', 'client', 'react.svg'], ['three.js', '3D hall', 'threedotjs.svg'], ['SVG', '2D plan']],
};

const NODE_PRICE = 5;
const COUNTER_PRICE = 2000;
const money = (n: number) => '$' + n.toLocaleString('en-US');

const SIGN_IN = '/venues?signin=1';
const LIVE_MAP = '/venues/calhacks?floor=2';
const PRIVACY = '/venues/calhacks/privacy';

type Props = { link: (to: string) => (e: MouseEvent) => void };

export function Landing({ link }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => (canvas.current ? startWaves(canvas.current) : undefined), []);
  const [stage, setStage] = useState<Stage>('phone');
  const [zones, setZones] = useState(8);

  return (
    <div className="landing">
      <section className="hero" id="top">
        <canvas ref={canvas} className="hero-bg" aria-hidden="true" />
        <div className="wrap">
          <header className="top">
            <a className="brand" href="#top">
              <img src="/brand/logo.svg" alt="" width="882" height="689" />
              <strong>Earshot</strong>
            </a>
            <nav aria-label="Sections">
              <a href="#map">The map</a>
              <a href="#path">Privacy and stack</a>
              <a href="#where">Who it's for</a>
              <a className="signin" href={SIGN_IN} onClick={link(SIGN_IN)}>
                Sign in
              </a>
            </nav>
          </header>
          <div className="hero-copy">
            <h1>Know how full every room is</h1>
            <p className="tag">Live crowd maps from the wifi signals phones already send, for $5 a zone.</p>
            <div className="actions">
              <a className="pill primary" href={SIGN_IN} onClick={link(SIGN_IN)}>
                Sign in with GitHub
              </a>
              <a className="pill" href={LIVE_MAP} onClick={link(LIVE_MAP)}>
                See the live map
              </a>
            </div>
          </div>
        </div>
      </section>

      <div className="wrap">
        <section id="map">
          <div className="section-head">
            <h2>See how full each zone is</h2>
            <a className="pill" href={LIVE_MAP} onClick={link(LIVE_MAP)}>
              Open the live map
            </a>
          </div>
          <div className="bento">
            <article className="tile wide">
              <div className="shot">
                <img src="/landing/plan-picked.png" width="1100" height="640" alt="The 2D plan of the mezzanine, with zone outlines and counts, an amber node marker, a cluster of phone dots and one picked dot with its white trail." loading="lazy" />
              </div>
              <div className="cap"><h3>Live counts for every zone</h3></div>
            </article>
            <article className="tile">
              <div className="shot">
                <img src="/landing/device-sheet.png" width="420" height="531" alt="The sheet for one picked phone. It shows the factory address b4:fb:e4:1e:b9:27, a timeline from first heard at 23:29 to now in Hardware Desk, and the live node that hears it at -58 dBm." loading="lazy" />
              </div>
              <div className="cap"><h3>Follow one dot</h3></div>
            </article>
            <article className="tile">
              <div className="shot">
                <img src="/landing/zone-card.png" width="860" height="720" alt="The Mezzanine Hacking zone card. It reads 66 people of about 300, 407 phones today with a typical stay of 5 minutes, and one named person, Tom." loading="lazy" />
              </div>
              <div className="cap"><h3>Tap a zone for its history</h3></div>
            </article>
            <article className="tile">
              <div className="glyph">
                <i className="grain" />
                <svg viewBox="0 0 160 160" aria-hidden="true">
                  <circle cx="48" cy="96" r="14" fill="#75bcff" opacity="0.4" />
                  <circle cx="104" cy="56" r="16" fill="#8fe3c9" />
                  <circle cx="98" cy="112" r="15" fill="#e7ac66" opacity="0.85" />
                  <circle cx="30" cy="40" r="9" fill="#75bcff" opacity="0.25" />
                  <circle cx="136" cy="130" r="8" fill="#b6d3ff" opacity="0.35" />
                </svg>
              </div>
              <div className="cap"><h3>One anonymous dot per phone</h3></div>
            </article>
            <article className="tile">
              <div className="glyph amber">
                <i className="grain" />
                <svg viewBox="0 0 160 160" aria-hidden="true">
                  <circle cx="80" cy="80" r="22" fill="#98acd9" />
                  <circle cx="80" cy="80" r="40" fill="none" stroke="#e7ac66" strokeWidth="9" />
                  <circle cx="80" cy="80" r="58" fill="none" stroke="#e7ac66" strokeWidth="1.5" opacity="0.4" />
                </svg>
              </div>
              <div className="cap"><h3>Fixed addresses get an amber ring</h3></div>
            </article>
            <article className="tile wide">
              <div className="glyph bright">
                <i className="grain" />
                <svg viewBox="0 0 160 160" aria-hidden="true">
                  <path d="M80 18l13 42 42 13-42 13-13 42-13-42-42-13 42-13z" fill="#75bcff" />
                  <path d="M80 48l6.5 20.5L107 75l-20.5 6.5L80 102l-6.5-20.5L53 75l20.5-6.5z" fill="#dfeeff" />
                </svg>
              </div>
              <div className="cap"><h3>Names only if you opt in</h3></div>
            </article>
          </div>
        </section>

        <section id="path">
          <h2>Privacy that lets venues say yes</h2>
          <div className="path">
            <div className="stages" role="tablist" aria-label="Where each piece of data stops">
              {STAGES.map((s) => (
                <button key={s.id} type="button" className={`stage${s.warn ? ' warn' : ''}`} role="tab" aria-selected={stage === s.id} onClick={() => setStage(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
            <div className="holds" role="tabpanel">
              {ROWS.map((r) => {
                const v = HOLDS[stage][r.key];
                return (
                  <div key={r.key} className={`holds-row${v ? '' : ' off'}${v === 'never' ? ' stop' : ''}`}>
                    <b>{r.label}</b>
                    <span>{v || 'not here'}</span>
                  </div>
                );
              })}
            </div>
            <div className="runs">
              <b>Runs on</b>
              <ul>
                {RUNS[stage].map(([name, role, logo]) => (
                  <li key={name}>
                    {logo && <img src={`/landing/logos/${logo}`} alt="" width={18} height={18} />}
                    <b>{name}</b>
                    <span>{role}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="facts">
              <ul>
                <li><b>Hashed before storage.</b> Addresses are salted and hashed on the bridge, never written down.</li>
                <li><b>No raw addresses stored.</b> The database never sees one.</li>
                <li><b>Names are opt-in.</b> Nobody is named unless they choose.</li>
                <li><b>Hide or delete anytime.</b> Anyone named controls their own data.</li>
                <li><b>Ask what we know.</b> Registered people get answers from live data.</li>
                <li><b>Short memory.</b> Dots 10 seconds, trails 30 minutes.</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="where">
          <h2>Built for people running places</h2>
          <div className="scenes">
            <article className="scene">
              <div>
                <h3>Event safety and operations<small>Event organisers and safety leads</small></h3>
                <p>See crowding build in each zone before it becomes a problem.</p>
              </div>
              <svg viewBox="0 0 150 100" aria-hidden="true">
                <rect x="4" y="10" width="142" height="80" rx="6" fill="none" stroke="#98acd9" strokeWidth="1.5" />
                <rect x="4" y="10" width="60" height="80" fill="rgba(255,157,138,0.4)" />
                <rect x="64" y="10" width="42" height="80" fill="rgba(255,157,138,0.16)" />
                <rect x="106" y="10" width="40" height="80" fill="rgba(143,227,201,0.2)" />
                <g fill="#e7ac66"><circle cx="34" cy="50" r="4" /><circle cx="85" cy="50" r="4" /><circle cx="126" cy="50" r="4" /></g>
                <text x="34" y="80" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">full</text>
                <text x="85" y="80" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">half</text>
                <text x="126" y="80" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">quiet</text>
              </svg>
            </article>
            <article className="scene">
              <div>
                <h3>Campus and building occupancy<small>Facilities staff in libraries, makerspaces and lecture halls</small></h3>
                <p>Know which spaces get used, when, and by how many.</p>
              </div>
              <svg viewBox="0 0 150 100" aria-hidden="true">
                <g fill="none" stroke="#98acd9" strokeWidth="1.5">
                  <rect x="4" y="6" width="68" height="40" rx="4" /><rect x="78" y="6" width="68" height="40" rx="4" />
                  <rect x="4" y="54" width="68" height="40" rx="4" /><rect x="78" y="54" width="68" height="40" rx="4" />
                </g>
                <g fill="#e7ac66"><circle cx="12" cy="14" r="3" /><circle cx="86" cy="14" r="3" /><circle cx="12" cy="62" r="3" /><circle cx="86" cy="62" r="3" /></g>
                <g fill="#75bcff">
                  <circle cx="30" cy="28" r="3" /><circle cx="44" cy="22" r="3" /><circle cx="56" cy="34" r="3" /><circle cx="100" cy="30" r="3" />
                  <circle cx="26" cy="76" r="3" /><circle cx="40" cy="84" r="3" /><circle cx="58" cy="70" r="3" /><circle cx="48" cy="78" r="3" />
                </g>
                <text x="112" y="80" textAnchor="middle" fontSize="11" fontWeight="700" fill="#8fe3c9">free</text>
              </svg>
            </article>
            <article className="scene">
              <div>
                <h3>Small venue footfall<small>Owners of cafes, markets and community centres</small></h3>
                <p>Count footfall and repeat visits for $5 a zone, with no staff time.</p>
              </div>
              <svg viewBox="0 0 150 100" aria-hidden="true">
                <path d="M8 90V40l67-28 67 28v50" fill="none" stroke="#98acd9" strokeWidth="1.5" />
                <rect x="62" y="60" width="26" height="30" fill="none" stroke="#98acd9" strokeWidth="1.5" />
                <circle cx="75" cy="52" r="4" fill="#e7ac66" />
                <g fill="#75bcff" opacity="0.9"><circle cx="30" cy="95" r="3" /><circle cx="46" cy="95" r="3" /><circle cx="104" cy="95" r="3" /><circle cx="120" cy="95" r="3" /><circle cx="136" cy="95" r="3" /></g>
                <text x="30" y="80" fontSize="10" fontWeight="700" fill="#8fe3c9">visitors</text>
                <text x="94" y="80" fontSize="10" fontWeight="700" fill="#b6d3ff">stay time</text>
              </svg>
            </article>
          </div>
          <div className="price">
            <label htmlFor="zones">
              Zones to cover <output>{zones}</output>
            </label>
            <input id="zones" type="range" min={1} max={40} value={zones} onChange={(e) => setZones(Number(e.target.value))} />
            <div className="price-bars">
              <div>
                <b>Earshot</b>
                <i style={{ '--w': `${((NODE_PRICE / COUNTER_PRICE) * 100).toFixed(2)}%` } as CSSProperties} />
                <output>{money(zones * NODE_PRICE)}</output>
              </div>
              <div>
                <b>People counters</b>
                <i className="other" style={{ '--w': '100%' } as CSSProperties} />
                <output>{money(zones * COUNTER_PRICE)}</output>
              </div>
            </div>
          </div>
        </section>

        <section className="close">
          <h2>Put Earshot in your venue</h2>
          <p className="sub">One $5 node per zone. The bridge is one binary on a laptop, a Raspberry Pi or any Linux server.</p>
          <div className="actions">
            <a className="pill primary" href={SIGN_IN} onClick={link(SIGN_IN)}>
              Sign in with GitHub
            </a>
            <a className="pill" href={LIVE_MAP} onClick={link(LIVE_MAP)}>
              See the live map
            </a>
          </div>
        </section>

        <footer>
          <span>Earshot. Built in 36 hours at Cal Hacks 13.0.</span>
          <span>
            <a href={LIVE_MAP} onClick={link(LIVE_MAP)}>Live map</a> &nbsp; <a href="/venues" onClick={link('/venues')}>Venues</a> &nbsp;{' '}
            <a href={PRIVACY} onClick={link(PRIVACY)}>Privacy</a>
          </span>
        </footer>
      </div>
    </div>
  );
}
