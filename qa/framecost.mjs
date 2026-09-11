/**
 * Where does one playback frame's time actually go?
 *
 * The lag is identical on a 30-second clip and a 70-minute one, so it is a
 * fixed per-frame cost, not anything that scales with the recording. This times
 * each thing the transport does every frame, separately, at 1080p.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const PROFILE = `/tmp/gc-cost-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60_000,
});
const win = await app.firstWindow();
win.on('pageerror', e => console.log('  [pageerror]', e.message));
await win.waitForLoadState('domcontentloaded');
await sleep(2200);

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
await win.click('#btnZoomFit');
await sleep(600);

const report = await win.evaluate(async () => {
  const { store, comp, playback, preview } = window.gc;

  const time = (label, fn, n = 40) => {
    fn(); fn();                                   // warm
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    return { label, ms: +((performance.now() - t0) / n).toFixed(2) };
  };

  // Park somewhere with picture, decoder ready.
  playback.seek(2);
  await new Promise(r => setTimeout(r, 2500));

  const out = { scales: {}, perFrame: [] };

  // 1. Compositor alone, at each preview quality.
  for (const q of [1, 0.5, 0.25]) {
    store.ui.previewScale = q;
    comp.resize();
    await new Promise(r => setTimeout(r, 400));
    comp.render(2, false);
    out.scales[q] = {
      canvas: `${comp.canvas.width}x${comp.canvas.height}`,
      ...time('render', () => comp.render(2, true), 30),
    };
  }
  store.ui.previewScale = 0.5; comp.resize();

  // 2. Each other per-frame job, timed on its own.
  out.perFrame.push(time('comp.render', () => comp.render(2, true), 30));
  out.perFrame.push(time('emit playhead (timeline repaint is rAF-coalesced)',
    () => store.emit('playhead', store.rt.playhead), 30));
  out.perFrame.push(time('gizmo.sync', () => preview.gizmo.sync(store.rt.playhead), 30));

  // The timeline paint is coalesced behind rAF, so call the real thing.
  const tl = window.gc.timeline;
  out.perFrame.push(time('timeline paint (direct)', () => {
    if (tl.paintNow) tl.paintNow();
    else store.emit('playhead', store.rt.playhead);
  }, 20));

  // 3. Does anything force a synchronous layout every frame?
  //    Count getBoundingClientRect calls during one simulated frame.
  let rects = 0;
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...a) { rects++; return origRect.apply(this, a); };
  comp.render(2, true);
  store.emit('playhead', store.rt.playhead);
  preview.gizmo.sync(store.rt.playhead);
  await new Promise(r => requestAnimationFrame(r));
  Element.prototype.getBoundingClientRect = origRect;
  out.layoutReadsPerFrame = rects;

  // 4. How fast can the decoder actually deliver 1080p60 frames?
  const el = document.querySelector('#gc-decoder-host video');
  let delivered = 0;
  if (el?.requestVideoFrameCallback) {
    const pump = () => { delivered++; el.requestVideoFrameCallback(pump); };
    el.requestVideoFrameCallback(pump);
  }
  playback.seek(2);
  playback.play();
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, 3000));
  const secs = (performance.now() - t0) / 1000;
  playback.pause();
  out.decodedFps = +(delivered / secs).toFixed(1);
  out.videoSize = el ? `${el.videoWidth}x${el.videoHeight}` : 'none';

  return out;
});

console.log(JSON.stringify(report, null, 2));
await app.close();
await rm(PROFILE, { recursive: true, force: true });
