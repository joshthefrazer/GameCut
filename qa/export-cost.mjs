/**
 * Where does export time actually go?
 *
 * Times each phase of the per-frame loop separately against real 1080p60
 * footage, so the thing that gets optimised is the thing that is slow rather
 * than the thing that looks slow.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const PROFILE = `/tmp/gc-xcost-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60_000,
});
const win = await app.firstWindow();
win.on('pageerror', e => console.log('  [pageerror]', e.message));
await win.waitForLoadState('domcontentloaded');
await sleep(2500);

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

const r = await win.evaluate(async () => {
  const { Compositor } = await import('app://gamecut/src/engine/compositor.js');
  const { store } = window.gc;

  const W = 640, H = 360, fps = 30, N = 90;

  // Fingerprint the composited canvas: same picture in, same number out.
  const hash = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 4 * 13) {
      h ^= d[i]; h = Math.imul(h, 16777619);
      h ^= d[i + 1]; h = Math.imul(h, 16777619);
      h ^= d[i + 2]; h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  const walk = async (forceSeek) => {
    const canvas = document.createElement('canvas');
    const comp = new Compositor(store, canvas, { fixedSize: { w: W, h: H } });
    const out = [], errs = [];
    let corrections = 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const t = i / fps;
      const clips = comp.activeClips(t).map(x => x.clip);
      if (i === 0 || forceSeek) await comp.pool.seekExact(clips, t);
      else corrections += await comp.pool.streamTo(clips, t, { tolerance: Math.min(1 / (fps * 2), 1 / 120) });
      comp.render(t, false);
      const el = comp.pool.peek(clips[0]);
      if (el) errs.push(+((comp.pool._lastMediaTime ?? el.currentTime) - t).toFixed(4));
      out.push(hash(canvas));
    }
    const ms = Math.round(performance.now() - t0);
    comp.pool.endStream();
    comp.dispose();
    errs.sort((a, b) => a - b);
    return { out, ms, corrections,
             errLo: errs[0], errMid: errs[Math.floor(errs.length / 2)], errHi: errs[errs.length - 1] };
  };

  const streamed = await walk(false);
  const seeked = await walk(true);

  const diff = [];
  for (let i = 0; i < N; i++) if (streamed.out[i] !== seeked.out[i]) diff.push(i);

  return { N, fps, streamed, seeked, diff };
});

console.log('\n── export: playing forward vs seeking every frame ──\n');
console.log(`  ${r.N} frames at ${r.fps}fps from a 1080p60 source\n`);
console.log(`  play forward   ${String(r.streamed.ms).padStart(7)} ms   ${r.streamed.corrections} corrective seeks`);
console.log(`  seek each      ${String(r.seeked.ms).padStart(7)} ms`);
console.log(`\n  ${(r.seeked.ms / r.streamed.ms).toFixed(1)}x faster`);
console.log(`  frame time error: ${r.streamed.errLo}s .. ${r.streamed.errHi}s (median ${r.streamed.errMid}s)`);
console.log(`  frames that differ: ${r.diff.length}/${r.N}` +
            (r.diff.length ? `  (${r.diff.slice(0, 12).join(', ')}${r.diff.length > 12 ? ' …' : ''})` : '  — identical'));
console.log('');

await app.close();
await rm(PROFILE, { recursive: true, force: true });
