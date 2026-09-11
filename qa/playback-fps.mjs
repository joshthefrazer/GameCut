/**
 * The number that actually matters: pictures per second on screen, with real
 * 1080p60 footage, in a full-size window.
 *
 * Everything else in qa/ measures a part. This plays the clip and counts what
 * reaches the canvas, at each preview quality, the way a person would see it.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const PROFILE = `/tmp/gc-fps-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
         `--user-data-dir=${PROFILE}`],
  cwd: ROOT, timeout: 60_000,
});
const win = await app.firstWindow();
win.on('pageerror', e => console.log('  [pageerror]', e.message));
await win.waitForLoadState('domcontentloaded');
await sleep(2500);

const gpu = await app.evaluate(({ app }) => {
  try { return app.getGPUFeatureStatus().gpu_compositing; } catch { return 'unknown'; }
});

await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/hd1080p60.mp4`]);
for (let i = 0; i < 80; i++) {
  const ok = await win.evaluate(async () => {
    const m = await import('app://gamecut/src/media/asset-store.js');
    return m.assets.all().some(a => a.kind === 'video' && a.width === 1920);
  });
  if (ok) break;
  await sleep(500);
}

await win.evaluate(async () => {
  const { assets } = await import('app://gamecut/src/media/asset-store.js');
  const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
  const { store, cmds } = window.gc;
  store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
  cmds.removeSelected();
  placeAsset(store, cmds, assets.all().find(a => a.width === 1920).id, { start: 0 });
});
await sleep(1500);

const results = [];
for (const q of [1, 0.5, 0.25]) {
  const r = await win.evaluate(async (q) => {
    const { store, comp, playback } = window.gc;
    store.ui.previewScale = q;
    store.rt.renderScale = null;
    comp.resize();
    playback.seek(1);
    await new Promise(r => setTimeout(r, 1500));

    let painted = 0;
    const decoded0 = comp.pool.decodedFrames;
    const prev = playback.onTick;
    playback.onTick = (t, ms, ok) => { if (ok) painted++; prev?.(t, ms, ok); };

    // The governor would change quality underneath the measurement.
    const scaleGuard = setInterval(() => { store.rt.renderScale = null; }, 100);

    const t0 = performance.now();
    playback.play();
    await new Promise(r => setTimeout(r, 4000));
    playback.pause();
    const secs = (performance.now() - t0) / 1000;

    clearInterval(scaleGuard);
    playback.onTick = prev;
    return {
      canvas: `${comp.canvas.width}x${comp.canvas.height}`,
      shown: +(painted / secs).toFixed(1),
      decoded: +((comp.pool.decodedFrames - decoded0) / secs).toFixed(1),
    };
  }, q);
  results.push({ q, ...r });
}

console.log('\n── playback, 1080p60, full-size window ──');
console.log(`  GPU compositing: ${gpu}\n`);
for (const r of results) {
  const name = r.q >= 1 ? 'full   ' : r.q >= 0.5 ? 'half   ' : 'quarter';
  console.log(`  ${name} ${r.canvas.padEnd(10)} ${String(r.shown).padStart(5)} fps on screen · decoded ${r.decoded} fps`);
}
console.log('');

await app.close();
await rm(PROFILE, { recursive: true, force: true });
