// Records the app clips the storyboard needs, from the live app in headless
// Chromium on the GPU. Usage: node demo/record.mjs [clip ...]
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './lib/cdp.mjs';
import { framesToClip } from './lib/ffmpeg.mjs';
import { APP, BRIDGE, FPS, H, W, shots } from './storyboard.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const only = new Set(process.argv.slice(2));
const wanted = (name) => only.size === 0 || only.has(name);

// The video shows the map as a product: the dev-only pieces of chrome go.
const HIDE = `
  .swatch.mock, .legend .howto { display: none !important; }
  .banner { display: none !important; }
`;

// The strongest fixed-address phone the live node hears, preferring one of the
// team's own ESP32 boards (Espressif prefix) so no attendee's address is filmed.
async function pickDevice() {
  const sql = await fetch(`${process.env.STDB_URL || 'http://localhost:3000'}/v1/database/${process.env.STDB_DB || 'calhacks-24tt5'}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'SELECT * FROM anon_point',
  }).then((r) => r.json());
  const cols = sql[0].schema.elements.map((e) => e.name.some);
  const rows = sql[0].rows.map((r) => Object.fromEntries(r.map((v, i) => [cols[i], v])));
  const stable = rows.filter((r) => r.stable);
  let best = null;
  for (const r of stable) {
    const rep = await fetch(`${BRIDGE}/api/device?hash=${r.hash}`).then((x) => x.json()).catch(() => null);
    if (!rep) continue;
    const own = rep.device.mac?.toLowerCase().startsWith('b4:fb:e4') ? 10 : 0;
    const score = own + (rep.day?.stays?.length ?? 0) * 2 + Math.min(5, (rep.device.trail?.length ?? 0) / 10);
    if (!best || score > best.score) best = { hash: r.hash, score };
  }
  return best?.hash ?? stable[0]?.hash ?? rows[0]?.hash;
}

async function record(page, name, seconds, action) {
  const dir = join(OUT, 'frames', name);
  await rm(dir, { recursive: true, force: true });
  const cast = await page.screencast(dir);
  const t0 = performance.now();
  await action();
  const left = seconds * 1000 - (performance.now() - t0);
  if (left > 0) await sleep(left);
  const frames = await cast.stop();
  await framesToClip(frames, join(OUT, 'clips', `${name}.mp4`), { fps: FPS, width: W, height: H, maxSeconds: seconds });
  console.log(`${name}: ${frames.length} frames -> clips/${name}.mp4`);
}

const sceneBox = (page) => page.eval(`(() => { const r = document.querySelector('.map').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const selectedBox = (page) => page.eval(`(() => { const r = (document.querySelector('.zone.selected') || document.querySelector('.map')).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

await mkdir(join(OUT, 'clips'), { recursive: true });
const page = await launch({ width: W, height: H, gl: process.env.GL || 'vulkan', port: 9342 });
const seconds = (id) => shots.find((s) => s.id === id).seconds + 1;

try {
  if (wanted('orbit')) {
    await page.goto(`${APP}/?floor=2`, 5000);
    await page.css(HIDE);
    const b = await sceneBox(page);
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    await record(page, 'orbit', seconds('open'), async () => {
      await sleep(800);
      await page.drag(c, { x: c.x + 260, y: c.y - 40 }, { ms: 5200, button: 'right', steps: 150 });
    });
  }

  if (wanted('plan-zoom')) {
    await page.goto(`${APP}/?floor=2&mode=2d&zone=mezz_hack`, 4000);
    await page.css(HIDE);
    const z = await selectedBox(page);
    await page.eval(`history.replaceState(null, '', '/?floor=2&mode=2d'); dispatchEvent(new PopStateEvent('popstate'));`);
    await sleep(600);
    await record(page, 'plan-zoom', seconds('plan'), async () => {
      await sleep(1200);
      await page.wheel(z.x, z.y, -900, { ticks: 24, ms: 3200 });
    });
  }

  if (wanted('zone-card')) {
    await page.goto(`${APP}/?floor=2&mode=2d`, 4000);
    await page.css(HIDE);
    await record(page, 'zone-card', seconds('zone'), async () => {
      await sleep(1500);
      await page.eval(`history.replaceState(null, '', '/?floor=2&mode=2d&zone=mezz_hack'); dispatchEvent(new PopStateEvent('popstate'));`);
    });
  }

  if (wanted('device')) {
    const hash = await pickDevice();
    await page.goto(`${APP}/?floor=2&mode=2d&zone=mezz_hack`, 4000);
    await page.css(HIDE);
    const z = await selectedBox(page);
    await page.eval(`history.replaceState(null, '', '/?floor=2&mode=2d'); dispatchEvent(new PopStateEvent('popstate'));`);
    await page.wheel(z.x, z.y, -700, { ticks: 14, ms: 600 });
    await sleep(800);
    await record(page, 'device', seconds('device'), async () => {
      await sleep(1500);
      await page.eval(`history.replaceState(null, '', '/?floor=2&mode=2d&device=${hash}'); dispatchEvent(new PopStateEvent('popstate'));`);
    });
  }

  if (wanted('xray')) {
    await page.goto(`${APP}/?floor=2&xray=1`, 5000);
    await page.css(HIDE);
    const b = await sceneBox(page);
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    await page.wheel(c.x, c.y, -600, { ticks: 12, ms: 500 });
    await sleep(600);
    await record(page, 'xray', seconds('xray'), async () => {
      await sleep(600);
      await page.drag(c, { x: c.x - 220, y: c.y - 30 }, { ms: 5000, button: 'right', steps: 140 });
    });
  }
} finally {
  await page.close();
}
