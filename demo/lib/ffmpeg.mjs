// Thin wrappers around the system ffmpeg.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Fedora's ffmpeg ships without libx264; OpenH264 at a fixed bitrate is the
// portable choice. Override with FFMPEG_VIDEO='-c:v libx264 -crf 18'.
export const VIDEO = (process.env.FFMPEG_VIDEO || '-c:v libopenh264 -b:v 14M -maxrate 20M -bufsize 28M -profile:v high').split(' ');

export function run(args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', quiet ? 'error' : 'info', '-y', ...args], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ffmpeg ${args.join(' ')}`))));
  });
}

// Screencast frames arrive whenever the page repaints, so each frame is held
// until the next one. The concat demuxer takes those durations and the output
// is resampled to a constant frame rate.
export async function framesToClip(frames, out, { fps = 30, width = 1920, height = 1080, trimStart = 0, maxSeconds } = {}) {
  if (frames.length < 2) throw new Error(`not enough frames for ${out}`);
  const t0 = frames[0].t + trimStart;
  const kept = frames.filter((f) => f.t >= t0 && (maxSeconds === undefined || f.t <= t0 + maxSeconds));
  const lines = ['ffconcat version 1.0'];
  kept.forEach((f, i) => {
    const next = kept[i + 1];
    const dur = next ? Math.max(1 / 120, next.t - f.t) : 1 / fps;
    lines.push(`file '${f.file}'`, `duration ${dur.toFixed(4)}`);
  });
  lines.push(`file '${kept[kept.length - 1].file}'`);
  const list = out.replace(/\.mp4$/, '.ffconcat');
  await writeFile(list, lines.join('\n') + '\n');
  await run(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${fps},scale=${width}:${height}:flags=lanczos,format=yuv420p`, ...VIDEO, out]);
}

// A directory of numbered PNGs rendered one per frame.
export async function sequenceToClip(dir, out, { fps = 30, pattern = 'f%05d.png' } = {}) {
  await run(['-framerate', String(fps), '-i', join(dir, pattern), '-vf', 'format=yuv420p', ...VIDEO, out]);
}

export async function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.on('exit', (c) => (c === 0 ? resolve(parseFloat(s)) : reject(new Error('ffprobe failed'))));
  });
}
