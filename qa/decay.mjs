/**
 * Diagnosis only — changes nothing.
 *
 * Watch a long playback and record what decays: decoded frame delivery, the
 * element's readyState, whether the pool still hands back a drawable source,
 * how many decoders are alive, and JS heap growth. Frame *rate* is meaningless
 * on this software-rendered box, but all of these are not.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const PROFILE = `/tmp/gc-decay-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`,
         '--js-flags=--expose-gc'],
  cwd: ROOT, timeout: 60_000,
});
const win = await app.firstWindow();
win.on('pageerror', e => console.log('  [pageerror]', e.message));
await win.waitForLoadState('domcontentloaded');
await sleep(2200);

// Long-ish source: loop the 5s fixture across the timeline so playback runs 30s.
await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/test-clip.mp4`]);
for (let i = 0; i < 40; i++) {
  const n = await win.evaluate(async () => {
    const m = await import('app://gamecut/src/media/asset-store.js');
    return m.assets.all().filter(a => a.kind === 'video').length;
  });
  if (n) break;
  await sleep(400);
}

await win.evaluate(async () => {
  const { assets } = await import('app://gamecut/src/media/asset-store.js');
  const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
  const { store, cmds } = window.gc;
  store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
  cmds.removeSelected();
  const a = assets.all().find(x => x.kind === 'video');
  // Six copies back to back — 30s of timeline, six separate decoders.
  for (let i = 0; i < 6; i++) placeAsset(store, cmds, a.id, { start: i * 5, allowShift: false });
  store.emit('doc', {});
});
await sleep(800);

console.log('\n── 30s playback, sampled every 2s ───────');
console.log('  t     rs  paused  decoded  srcOK  decoders  heapMB');

const rows = await win.evaluate(async () => {
  const { store, comp, playback } = window.gc;
  const out = [];

  playback.seek(0);
  await new Promise(r => setTimeout(r, 400));
  playback.play();

  const t0 = performance.now();
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const t = store.rt.playhead;
    const clip = store.doc.tracks.flatMap(tr => tr.clips)
      .find(c => t >= c.start && t < c.start + c.duration && c.type === 'video');

    const els = [...document.querySelectorAll('#gc-decoder-host video')];
    const el = clip ? comp.pool.peek(clip) : null;
    const src = clip ? comp.pool.frameFor(clip, t, true) : null;

    out.push({
      ms: Math.round(performance.now() - t0),
      playhead: +t.toFixed(2),
      readyState: el ? el.readyState : -1,
      paused: el ? el.paused : null,
      // webkitDecodedFrameCount keeps climbing only while decode is really running
      decoded: el ? (el.webkitDecodedFrameCount ?? -1) : -1,
      dropped: el ? (el.webkitDroppedFrameCount ?? -1) : -1,
      srcOK: !!src,
      decoders: els.length,
      heapMB: performance.memory
        ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1,
    });
    if (!store.rt.playing) { out.push({ note: 'playback stopped early' }); break; }
  }
  playback.pause();
  return out;
});

let prevDecoded = 0;
for (const r of rows) {
  if (r.note) { console.log('  ' + r.note); continue; }
  const delta = r.decoded >= 0 ? r.decoded - prevDecoded : -1;
  prevDecoded = r.decoded;
  console.log(
    `  ${String((r.ms / 1000).toFixed(0) + 's').padEnd(5)} ` +
    `${String(r.readyState).padEnd(3)} ` +
    `${String(r.paused).padEnd(7)} ` +
    `${String(delta).padEnd(8)} ` +
    `${String(r.srcOK).padEnd(6)} ` +
    `${String(r.decoders).padEnd(9)} ` +
    `${r.heapMB}`);
}

console.log('\n  (decoded = new frames decoded since the previous sample;');
console.log('   srcOK   = pool returned a drawable frame, false means BLACK)');

await app.close();
await rm(PROFILE, { recursive: true, force: true });
