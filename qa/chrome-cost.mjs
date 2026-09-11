/**
 * What does the *window chrome* cost, per frame, before any video is involved?
 *
 * The decisive clue: making the window smaller made playback smooth. The
 * preview canvas is sized from the project and the quality setting, never from
 * the window — so if the cost were in compositing the picture, resizing the
 * window would change nothing at all. It changed everything, which means the
 * expense is in the browser compositing the *window*, not the frame.
 *
 * Two things in the stylesheet do that, and both scale with area:
 *   · three 120px-blurred blobs animating forever behind everything
 *   · backdrop-filter on all five panels, which re-reads and re-blurs whatever
 *     is behind them every time it changes — and something behind them is
 *     always changing, because of the blobs
 *
 * This measures the frame rate of a plain rAF loop with those on, then with
 * them off. No video, no decoding: purely what it costs to put this window on
 * screen.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const PROFILE = `/tmp/gc-chrome-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60_000,
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await sleep(2500);

const gpu = await app.evaluate(async ({ app }) => {
  const s = app.getGPUFeatureStatus();
  return { gpu_compositing: s.gpu_compositing, rasterization: s.rasterization, canvas: s['2d_canvas'] };
});

const measure = async (label) => win.evaluate(async (label) => {
  // Give the compositor a beat to settle after any style change.
  await new Promise(r => setTimeout(r, 500));
  return await new Promise((resolve) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => {
      if (performance.now() - t0 > 2500) {
        resolve({ label, fps: +(n / ((performance.now() - t0) / 1000)).toFixed(1) });
        return;
      }
      n++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}, label);

const before = await measure('as shipped');

await win.evaluate(() => {
  const s = document.createElement('style');
  s.id = 'gc-cost-probe';
  s.textContent = `
    .aurora i { animation: none !important; }
    * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  `;
  document.head.appendChild(s);
});
const noBlur = await measure('no animated blobs, no backdrop-filter');

await win.evaluate(() => {
  document.getElementById('gc-cost-probe').textContent += `
    .aurora { display: none !important; }
  `;
});
const noAurora = await measure('...and no ambient wash at all');

console.log('\n── what the window itself costs ─────────');
console.log(`  GPU compositing: ${gpu.gpu_compositing}`);
console.log(`  rasterization:   ${gpu.rasterization}`);
console.log(`  2d canvas:       ${gpu.canvas}`);
console.log('');
for (const r of [before, noBlur, noAurora]) {
  console.log(`  ${String(r.fps).padStart(6)} fps   ${r.label}`);
}
console.log('');

await app.close();
await rm(PROFILE, { recursive: true, force: true });
