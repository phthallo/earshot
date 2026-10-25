// Renders the title, number, end and caption frames, and the architecture
// sequence, from cards/card.html. Usage: node demo/render-cards.mjs
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from './lib/cdp.mjs';
import { sequenceToClip } from './lib/ffmpeg.mjs';
import { FPS, H, W, arch, data, shots } from './storyboard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const CARD = pathToFileURL(join(HERE, 'cards/card.html')).href;
const url = (params) => `${CARD}?${new URLSearchParams(params)}`;

await mkdir(join(OUT, 'cards'), { recursive: true });
await mkdir(join(OUT, 'captions'), { recursive: true });
const page = await launch({ width: W, height: H, port: 9343, fileAccess: true });
const numbers = await data();

try {
  const still = async (name, params) => {
    await page.goto(url(params), 700);
    await page.shot(join(OUT, 'cards', `${name}.png`));
    console.log(`cards/${name}.png`);
  };
  await still('title', { kind: 'title', line: 'Know how full every room is.' });
  await still('num-phones', { kind: 'number', n: String(numbers.phones), label: `phones heard in ${numbers.zone} tonight` });
  await still('num-stay', { kind: 'number', n: `${numbers.stayMin} min`, label: 'typical stay' });
  await still('num-cost', { kind: 'number', n: '$5', label: 'per node. A people counter is about $2,000.' });
  await still('end', { kind: 'end', line: 'Built in 36 hours at Cal Hacks 13.0.', small: 'Live map on the demo laptop. Source and docs in the repo.' });

  for (const s of shots.filter((x) => x.caption)) {
    await page.goto(url({ kind: 'caption', text: s.caption }), 500);
    await page.shot(join(OUT, 'captions', `${s.id}.png`), { transparent: true });
    console.log(`captions/${s.id}.png`);
  }

  // Architecture: one frame per video frame so the packet moves smoothly.
  const archShot = shots.find((s) => s.id === 'arch');
  const step = archShot.seconds / arch.length;
  const proof = '{"t":"sight","id":104,"ts":48213,"items":[["9df8d3af",-61,"b4:fb:e4:1e:c0:23"]]}\n2026/10/24 23:31:05 anon: [[69 phones]], node 103 heard 69 (loudest for 69)';
  await page.goto(url({ kind: 'arch', hops: JSON.stringify(arch), step: step.toFixed(3), proof }), 900);
  const dir = join(OUT, 'frames', 'arch');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const total = Math.round(archShot.seconds * FPS);
  for (let i = 0; i < total; i++) {
    await page.eval(`window.seek(${(i / FPS).toFixed(4)})`);
    await page.shot(join(dir, `f${String(i).padStart(5, '0')}.png`));
  }
  await sequenceToClip(dir, join(OUT, 'cards', 'arch.mp4'), { fps: FPS });
  console.log(`cards/arch.mp4 (${total} frames)`);
} finally {
  await sleep(100);
  await page.close();
}
