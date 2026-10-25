// Headless Chromium over the DevTools protocol: navigate, evaluate, screenshot,
// drive the mouse and record a screencast. No npm dependencies.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME ||
  join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1920, height = 1080, port = 9340, scale = 1, gl = 'swiftshader', fileAccess = false } = {}) {
  const glFlags = gl === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [`--use-angle=${gl}`, '--ignore-gpu-blocklist'];
  const proc = spawn(
    CHROME,
    ['--headless=new', '--no-sandbox', '--hide-scrollbars', ...(fileAccess ? ['--allow-file-access-from-files'] : []), ...glFlags, `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, 'about:blank'],
    { stdio: 'ignore' },
  );
  let targets;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {}
  }
  const target = targets?.find((t) => t.type === 'page');
  if (!target) throw new Error(`chromium did not open a page on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

  const page = {
    width,
    height,
    send,
    on,
    async goto(url, settle = 1500) {
      const loaded = new Promise((r) => {
        const off = on('Page.loadEventFired', () => {
          off();
          r();
        });
      });
      await send('Page.navigate', { url });
      await loaded;
      await sleep(settle);
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
      return r.result.value;
    },
    async css(text) {
      await page.eval(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(text)}; document.head.appendChild(s); })()`);
    },
    async shot(path, { transparent = false, format = 'png', quality } = {}) {
      if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      const r = await send('Page.captureScreenshot', { format, quality, fromSurface: true, captureBeyondViewport: false });
      if (transparent) await send('Emulation.setDefaultBackgroundColorOverride');
      await writeFile(path, Buffer.from(r.data, 'base64'));
    },
    async mouse(type, x, y, { button = 'none', buttons = 0, modifiers = 0, deltaX = 0, deltaY = 0 } = {}) {
      await send('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, deltaX, deltaY, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0 });
    },
    async click(x, y) {
      await page.mouse('mouseMoved', x, y);
      await page.mouse('mousePressed', x, y, { button: 'left', buttons: 1 });
      await sleep(40);
      await page.mouse('mouseReleased', x, y, { button: 'left', buttons: 1 });
    },
    // A drag spread over `ms` with an ease so the motion starts and stops gently.
    async drag(from, to, { ms = 1500, button = 'left', steps = 60 } = {}) {
      const buttons = button === 'right' ? 2 : 1;
      await page.mouse('mouseMoved', from.x, from.y);
      await page.mouse('mousePressed', from.x, from.y, { button, buttons });
      const t0 = performance.now();
      for (let i = 1; i <= steps; i++) {
        const u = i / steps;
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        const x = from.x + (to.x - from.x) * e;
        const y = from.y + (to.y - from.y) * e;
        await page.mouse('mouseMoved', x, y, { button, buttons });
        const due = t0 + (ms * i) / steps;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
      }
      await page.mouse('mouseReleased', to.x, to.y, { button, buttons });
    },
    async wheel(x, y, deltaY, { ticks = 8, ms = 800 } = {}) {
      for (let i = 0; i < ticks; i++) {
        await page.mouse('mouseWheel', x, y, { deltaY: deltaY / ticks });
        await sleep(ms / ticks);
      }
    },
    // Records frames as JPEGs plus a timestamp list that ffmpeg's concat demuxer
    // turns into a constant frame rate clip (see lib/ffmpeg.mjs).
    async screencast(dir, { quality = 92 } = {}) {
      await mkdir(dir, { recursive: true });
      const frames = [];
      let n = 0;
      const off = on('Page.screencastFrame', async (p) => {
        const file = join(dir, `f${String(n++).padStart(5, '0')}.jpg`);
        frames.push({ file, t: p.metadata.timestamp });
        await writeFile(file, Buffer.from(p.data, 'base64'));
        send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      });
      await send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
      return {
        frames,
        async stop() {
          await send('Page.stopScreencast');
          off();
          await sleep(200);
          return frames;
        },
      };
    },
    async close() {
      try {
        await send('Browser.close');
      } catch {}
      proc.kill();
    },
  };
  return page;
}
