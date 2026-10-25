// Cuts the clips and cards together in storyboard order, burns the captions,
// and writes demo/out/earshot-demo.mp4. Usage: node demo/build.mjs
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEO, probeDuration, run } from './lib/ffmpeg.mjs';
import { FPS, H, W, shots } from './storyboard.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const exists = (p) => access(p).then(() => true, () => false);

const inputs = [];
const filters = [];
let t = 0;
const pieces = [];
for (const [i, s] of shots.entries()) {
  const src = join(OUT, s.src);
  if (!(await exists(src))) throw new Error(`missing ${s.src}; run record.mjs and render-cards.mjs first`);
  const isStill = src.endsWith('.png');
  if (isStill) inputs.push('-loop', '1', '-t', String(s.seconds), '-i', src);
  else {
    const d = await probeDuration(src);
    if (d < s.seconds - 0.05) console.warn(`${s.src} is ${d.toFixed(1)} s, storyboard wants ${s.seconds}`);
    inputs.push('-t', String(s.seconds), '-i', src);
  }
  let v = `[${i}:v]fps=${FPS},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p`;
  // Cards cut in; the app clips get a 6 frame fade from black so a hard cut
  // onto a busy map does not flash.
  if (!isStill && !src.includes('cards/')) v += `,fade=in:st=0:d=0.2`;
  // Still cards hold; the last one fades out.
  if (i === shots.length - 1) v += `,fade=out:st=${s.seconds - 0.8}:d=0.8`;
  filters.push(`${v}[v${i}]`);
  pieces.push({ i, start: t, s });
  t += s.seconds;
}
filters.push(`${pieces.map((p) => `[v${p.i}]`).join('')}concat=n=${pieces.length}:v=1:a=0[cut]`);

// Captions: transparent PNGs overlaid for their shot's span, fading in.
let last = 'cut';
let n = shots.length;
for (const p of pieces) {
  if (!p.s.caption) continue;
  const png = join(OUT, 'captions', `${p.s.id}.png`);
  inputs.push('-loop', '1', '-t', String(p.s.seconds), '-i', png);
  const start = (p.start + 0.6).toFixed(3);
  const end = (p.start + p.s.seconds - 0.3).toFixed(3);
  filters.push(`[${n}:v]format=rgba,fade=in:st=0:d=0.3:alpha=1,setpts=PTS+${start}/TB[c${n}]`);
  filters.push(`[${last}][c${n}]overlay=0:0:enable='between(t,${start},${end})':eof_action=pass[o${n}]`);
  last = `o${n}`;
  n++;
}

const out = join(OUT, 'earshot-demo.mp4');
await run([...inputs, '-filter_complex', filters.join(';'), '-map', `[${last}]`, '-r', String(FPS), ...VIDEO, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { quiet: false });
console.log(`${out} (${t} s)`);
