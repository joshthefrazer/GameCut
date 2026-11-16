/**
 * The export cases that used to make a render look frozen.
 *
 *   1. A transition between two clips used whole. A transition asks the
 *      outgoing clip for a moment past its own end; with no spare footage the
 *      decoder can never get there, and each frame of the transition waited
 *      the full five-second deadline before a corrective seek. A ten-second
 *      timeline took well over a minute, and a minute of gameplay with a few
 *      cuts took the better part of an hour.
 *   2. A clip whose file has moved. The decoder waited on an element that had
 *      already failed — about ten seconds per exported frame.
 *
 * Both are measured against a deadline generous enough for a slow machine and
 * nowhere near what the broken versions took. Timings here mean something
 * because the bug was a fixed per-frame wait, not general slowness.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { patchClick } from './reveal.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || '/tmp');
const PROFILE = `/tmp/gc-edge-${process.pid}`;
const problems = [];
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── export edge cases ────────────────────');
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
patchClick(win);
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.waitForSelector('#homeNew'); await win.click('#homeNew'); await sleep(1200);

// Two copies of the same 5 s clip, end to end, each used whole.
await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/test-clip.mp4`]);
for (let i = 0; i < 60; i++) {
  const ok = await win.evaluate(() => window.gc.assets.all().some(a => a.kind === 'video' && a.duration > 0));
  if (ok) break;
  await sleep(300);
}

/** Render the current timeline at a small size and time it. */
const timedRender = (fps = 30) => win.evaluate(async (fps) => {
  const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
  const t0 = performance.now();
  const bytes = await renderToMp4({
    store: window.gc.store, width: 640, height: 360, fps,
    vBitrate: 2_000_000, aBitrate: 128_000, onProgress: () => {},
    // Give up well past the deadline below, so a stalled render fails rather than hangs.
    shouldCancel: () => performance.now() - t0 > 60000,
  });
  if (!bytes) return { ms: performance.now() - t0, b64: '', dur: window.gc.store.rt.duration };
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { ms: performance.now() - t0, b64: btoa(s), dur: window.gc.store.rt.duration };
}, fps);

await step('a dissolve between two whole clips renders at normal speed', async () => {
  await win.evaluate(async () => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { store, assets, cmds } = window.gc;
    store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
    cmds.removeSelected();
    const a = assets.all().find(x => x.kind === 'video');
    const track = store.doc.tracks.find(t => t.kind === 'video');
    const one = makeClip('video', { trackId: track.id, assetId: a.id, name: 'A', start: 0, duration: a.duration, sourceDuration: a.duration });
    const two = makeClip('video', { trackId: track.id, assetId: a.id, name: 'B', start: a.duration, duration: a.duration, sourceDuration: a.duration });
    two.transIn = { kind: 'dissolve', dur: 1 };
    track.clips.push(one, two);
    store.docChanged('edge');
  });
  const r = await timedRender();
  const file = path.join(OUT, 'edge-dissolve.mp4');
  if (r.ms > 45000) throw new Error(`a ${r.dur.toFixed(1)}s timeline took over ${(r.ms / 1000).toFixed(0)}s to render`);
  await writeFile(file, Buffer.from(r.b64, 'base64'));
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { stdio: 'pipe' });
  // The broken version took ~83 s for this 10 s timeline; healthy is ~10-20 s.
  if (r.ms > 45000) throw new Error(`a ${r.dur.toFixed(1)}s timeline took ${(r.ms / 1000).toFixed(1)}s to render`);
  console.log(`     ${r.dur.toFixed(1)}s timeline in ${(r.ms / 1000).toFixed(1)}s`);
});

await step('a clip whose file has gone does not freeze the export', async () => {
  await win.evaluate(() => {
    const { store, assets } = window.gc;
    const a = assets.all().find(x => x.kind === 'video');
    // What reopening a project with a moved file looks like.
    assets.update(a.id, { missing: true, url: 'gcmedia://does-not-exist' });
    for (const t of store.doc.tracks) for (const c of t.clips) c.transIn = null;
    store.docChanged('offline');
  });
  const r = await timedRender();
  // The broken version waited ~10 s per frame: 300 frames would take ~50 min.
  if (r.ms > 45000) throw new Error(`a ${r.dur.toFixed(1)}s timeline took ${(r.ms / 1000).toFixed(1)}s with a missing file`);
  console.log(`     ${r.dur.toFixed(1)}s timeline in ${(r.ms / 1000).toFixed(1)}s`);
});

await step('a glow on a big graphic survives a 4K export', async () => {
  // A glow is cyan (#38bdf8) light around the shape. At 4K a graphic scaled up
  // past ~1.3x used to lose every effect in the file while the preview kept them.
  await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/test-logo.png`]);
  for (let i = 0; i < 40; i++) {
    const ok = await win.evaluate(() => window.gc.assets.all().some(a => a.kind === 'image'));
    if (ok) break;
    await sleep(250);
  }
  await win.evaluate(async () => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { store, assets } = window.gc;
    for (const t of store.doc.tracks) t.clips.length = 0;
    const a = assets.all().find(x => x.kind === 'image');
    const track = store.doc.tracks.find(t => t.kind === 'video');
    const c = makeClip('image', { trackId: track.id, assetId: a.id, name: 'logo', start: 0, duration: 1,
      fit: 'contain', transform: { scale: 1.5 },
      fx: { glow: 0.16, glowColor: '#38bdf8', glowStrength: 1.2 } });
    track.clips.push(c);
    store.docChanged('glow4k');
  });
  const b64 = await win.evaluate(async () => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    const bytes = await renderToMp4({ store: window.gc.store, width: 3840, height: 2160, fps: 30,
      vBitrate: 20_000_000, aBitrate: 128_000, onProgress: () => {}, shouldCancel: () => false });
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const file = path.join(OUT, 'edge-glow-4k.mp4');
  const png = path.join(OUT, 'edge-glow-4k.png');
  await writeFile(file, Buffer.from(b64, 'base64'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.5', '-i', file, '-frames:v', '1', '-vf', 'scale=480:270', png]);
  const cyan = parseInt(execFileSync('python3', ['-c',
    `from PIL import Image; im=Image.open("${png}").convert("RGB"); print(sum(1 for r,g,b in im.getdata() if b>50 and b>r+30 and g>r+10))`,
  ], { encoding: 'utf8' }).trim(), 10);
  if (cyan < 200) throw new Error(`only ${cyan} glow-coloured pixels in the 4K file — the glow was dropped`);
  console.log(`     ${cyan} glow pixels in the exported 4K frame`);
});

await app.close();
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`EXPORT-EDGE FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('EXPORT-EDGE PASSED — transitions and missing files no longer stall a render.');
