// Measures how many frames per second the 3D scene reaches in headless Chromium
// with a given GL backend: node demo/probe.mjs [swiftshader|gl|vulkan]
import { launch, sleep } from './lib/cdp.mjs';

const gl = process.argv[2] || 'swiftshader';
const page = await launch({ gl, port: 9341 });
await page.goto('http://localhost:5173/?floor=2', 6000);
const fps = await page.eval(`new Promise((r) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else r(n / 2); }; requestAnimationFrame(tick); })`);
const webgl = await page.eval(`(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); const d = g && g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : String(!!g); })()`);
console.log(JSON.stringify({ gl, fps, webgl }));
await sleep(100);
await page.close();
