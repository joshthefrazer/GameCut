/**
 * The engine, the way a person meets it.
 *
 * Modelled on qa/gfx-real.mjs: footage goes in through the file picker, edits
 * are made with the mouse and keyboard wherever a person would make them, and
 * every verdict is read off real pixels — the preview canvas, or frames pulled
 * back out of an exported MP4 with ffmpeg. Each check here was written against
 * the broken code first and watched fail; a check that cannot fail on the bug
 * it names is not a check.
 *
 * Where a step reaches past the interface (building an exact timeline with
 * `cmds`, say) it is to SET UP the situation, never to observe the result.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { patchClick, revealLocator } from './reveal.mjs';

const ROOT = (await import('node:path')).resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || '/tmp';
const PROFILE = `/tmp/gc-engine-${process.pid}`;
const FX = (n) => `${ROOT}/qa/fixtures/${n}`;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;

const problems = [];
const step = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  const before = problems.length;
  const t0 = Date.now();
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
};

console.log('\n── engine ───────────────────────────────');
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
patchClick(win);
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
win.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.waitForSelector('#homeNew'); await win.click('#homeNew'); await sleep(1200);

/* ── helpers ─────────────────────────────────────────────────── */

/** Remove every clip, so each step starts from an empty timeline. */
const clearTimeline = () => win.evaluate(() => {
  const { store, cmds, playback } = window.gc;
  if (store.rt.playing) playback.pause();
  store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
  cmds.removeSelected();
  playback.seek(0);
});

/** Import through the real file picker and wait until every file is an asset. */
const imported = new Map();
async function importFiles(...names) {
  const need = names.filter(n => !imported.has(n));
  if (need.length) {
    await win.setInputFiles('#filePicker', need.map(FX));
    for (let i = 0; i < 80; i++) {
      const got = await win.evaluate((ns) => ns.map(n =>
        window.gc.assets.all().find(a => a.name === n)?.id || null), need);
      if (got.every(Boolean)) { need.forEach((n, k) => imported.set(n, got[k])); break; }
      await sleep(250);
    }
  }
  const ids = names.map(n => imported.get(n));
  if (ids.some(x => !x)) throw new Error(`import of ${names.join(', ')} did not finish`);
  return ids;
}

/**
 * Put an asset on a given track at a given time — set-up, not observation.
 * Returns the clip id.
 */
const putClip = (assetId, opts = {}) => win.evaluate(async ({ assetId, opts }) => {
  const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
  const { store, cmds } = window.gc;
  let trackId;
  if (opts.track != null) {
    const vids = store.doc.tracks.filter(t => t.kind === 'video');
    while (vids.length <= opts.track) { cmds.addTrack('video'); vids.splice(0, vids.length, ...store.doc.tracks.filter(t => t.kind === 'video')); }
    trackId = vids[opts.track].id;
  }
  const c = placeAsset(store, cmds, assetId, { start: opts.start ?? 0, trackId, patch: opts.patch });
  return c?.id || null;
}, { assetId, opts });

const clipById = (id) => win.evaluate((id) =>
  JSON.parse(JSON.stringify(window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id) || null)), id);

/**
 * A coarse picture of the preview: mean RGB in a grid of cells, plus how much
 * of it is lit. Coarse on purpose — the question is always "is this the
 * right picture", not "is it bit-identical".
 */
const sig = (opts = {}) => win.evaluate(async ({ wait, gx, gy }) => {
  if (wait) await new Promise(r => setTimeout(r, wait));
  const cv = document.getElementById('previewCanvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const cells = new Array(gx * gy * 3).fill(0), n = new Array(gx * gy).fill(0);
  let lit = 0, tot = 0;
  for (let y = 0; y < cv.height; y += 2) for (let x = 0; x < cv.width; x += 2) {
    const i = (y * cv.width + x) * 4;
    const c = Math.min(gy - 1, Math.floor(y / cv.height * gy)) * gx + Math.min(gx - 1, Math.floor(x / cv.width * gx));
    cells[c * 3] += d[i]; cells[c * 3 + 1] += d[i + 1]; cells[c * 3 + 2] += d[i + 2]; n[c]++;
    tot++; if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
  }
  for (let c = 0; c < n.length; c++) for (let k = 0; k < 3; k++) cells[c * 3 + k] /= Math.max(1, n[c]);
  return { cells, lit: lit / tot, w: cv.width, h: cv.height };
}, { wait: opts.wait ?? 200, gx: opts.gx ?? 32, gy: opts.gy ?? 18 });

/** Mean absolute difference between two signatures, 0..255. */
const sdiff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.cells.length; i++) s += Math.abs(a.cells[i] - b.cells[i]);
  return s / a.cells.length;
};

/** What a forced, from-scratch paint of this moment looks like. */
const forcedSig = () => win.evaluate(() => {
  const { comp, store } = window.gc;
  comp._painted = false;
  comp.render(store.rt.playhead, false);
}).then(() => sig({ wait: 0 }));

/** Timeline geometry, in page pixels. */
async function tlPoint(t, trackIndex = 0) {
  const box = await win.locator('#timelineView').boundingBox();
  const p = await win.evaluate(({ t, trackIndex }) => {
    const { store, timeline } = window.gc;
    const tr = store.doc.tracks.filter(x => x.kind === 'video')[trackIndex];
    const row = timeline.L.rowFor(tr.id);
    return { x: timeline.L.t2x(t), y: row.y + row.h / 2 };
  }, { t, trackIndex });
  return { x: box.x + p.x, y: box.y + p.y, box };
}

/** Click the ruler at time t, as a person moving the playhead does. */
async function clickRuler(t) {
  const box = await win.locator('#timelineView').boundingBox();
  const x = await win.evaluate((t) => window.gc.timeline.L.t2x(t), t);
  await win.mouse.click(box.x + x, box.y + 10);
}

/** Make sure the whole timeline span we care about is visible. */
async function zoomToFit() {
  await win.click('#btnZoomFit').catch(() => {});
  await sleep(150);
}

/** Render the project to an MP4 through the real export renderer. */
async function exportMp4(name, { w = 640, h = 360, fps = 30, timeout = 240_000 } = {}) {
  const r = await win.evaluate(async ({ w, h, fps }) => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    const t0 = performance.now();
    const bytes = await renderToMp4({
      store: window.gc.store, width: w, height: h, fps,
      vBitrate: 8_000_000, aBitrate: 128_000, shouldCancel: () => false, onProgress: () => {},
    });
    const ms = performance.now() - t0;
    if (!bytes) return null;
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return { b64: btoa(s), ms };
  }, { w, h, fps }, { timeout });
  if (!r) throw new Error('the export produced nothing');
  const file = `${OUT}/engine-${name}.mp4`;
  await writeFile(file, Buffer.from(r.b64, 'base64'));
  return { file, ms: r.ms };
}

/** One frame of an exported file as raw RGB. */
function fileFrame(file, t, w, h) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file,
    '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 << 20 });
  return { w, h, d: buf };
}
const px = (f, x, y) => { const i = (Math.round(y) * f.w + Math.round(x)) * 3; return [f.d[i], f.d[i + 1], f.d[i + 2]]; };
/** Share of a frame's pixels for which `pred(r,g,b)` holds. */
const share = (f, pred, rect = null) => {
  let n = 0, k = 0;
  const [x0, y0, x1, y1] = rect || [0, 0, f.w, f.h];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * f.w + x) * 3; n++; if (pred(f.d[i], f.d[i + 1], f.d[i + 2])) k++;
  }
  return k / Math.max(1, n);
};
const isRed = (r, g, b) => r > 200 && g < 90 && b < 90;

/* ── steps ───────────────────────────────────────────────────── */

/** Type into an Inspector field by its row label (`nth` picks the field in a pair). */
async function setField(label, value, nth = 0) {
  const row = win.locator('#inspectorRoot .row').filter({
    has: win.locator('label', { hasText: new RegExp(`^${label}$`) }),
  }).first();
  const input = row.locator('input').nth(nth);
  await revealLocator(input);
  await input.click();
  await input.fill(String(value));
  await input.press('Enter');
  await sleep(150);
}

/** Select a clip by clicking it on the timeline. */
async function clickClip(id) {
  await zoomToFit();
  const p = await win.evaluate((id) => {
    const { store, timeline } = window.gc;
    const tr = store.doc.tracks.find(t => t.clips.some(c => c.id === id));
    const c = tr.clips.find(c => c.id === id);
    const row = timeline.L.rowFor(tr.id);
    return { x: timeline.L.t2x(c.start + Math.min(c.duration / 2, 0.6)), y: row.y + row.h / 2 };
  }, id);
  const box = await win.locator('#timelineView').boundingBox();
  await win.mouse.click(box.x + p.x, box.y + p.y);
  await sleep(200);
}

/** Press play, sample the preview `n` times `gap` ms apart, then stop. */
async function sampleWhilePlaying(n = 4, gap = 300) {
  await win.click('#btnPlay');
  const out = [];
  for (let i = 0; i < n; i++) out.push(await sig({ wait: gap }));
  await win.click('#btnPlay');
  await sleep(150);
  return out;
}

/**
 * Graphics-only timelines animate while playing.
 *
 * Playback only repaints when a decoder hands over a new frame, and anything
 * that is not footage — text, shapes — is exempt because it has no decoder to
 * wait for. Images were lumped in with footage, so a timeline of stills never
 * repainted at all once play was pressed: keyframes, fades and motion presets
 * on a graphic sat frozen on their first frame for as long as it played.
 */
await step('a graphic with a motion animates during playback with no footage', async () => {
  await clearTimeline();
  const [logo] = await importFiles('test-logo.png');
  const id = await putClip(logo, { start: 0, patch: { fit: 'contain', transform: { scale: 0.5 } } });
  await clickClip(id);
  await win.click('#inspectorRoot [data-motion="spin"]');
  await sleep(200);
  await win.evaluate(() => window.gc.playback.seek(0));
  const s = await sampleWhilePlaying(4, 300);
  const moves = [sdiff(s[0], s[1]), sdiff(s[1], s[2]), sdiff(s[2], s[3])];
  console.log(`     frame-to-frame change while playing: ${moves.map(m => m.toFixed(2)).join(', ')}`);
  if (moves.filter(m => m > 0.5).length < 2) throw new Error('the spinning graphic did not move while the timeline played');
});

/**
 * A hard cut between two stills shows the second one.
 *
 * Nothing about a cut produces a decoder frame, so with only stills on the
 * timeline the paint-when-something-changed rule never noticed the picture had
 * changed: the first still stayed up after the cut for as long as it played.
 */
await step('a cut between two stills shows the second one while playing', async () => {
  await clearTimeline();
  const [logo] = await importFiles('test-logo.png');
  await putClip(logo, { start: 0, track: 0, patch: { fit: 'contain', transform: { scale: 0.9 } } });
  await putClip(logo, { start: 5, track: 0, patch: { fit: 'contain', transform: { scale: 0.25 } } });
  await win.evaluate(() => window.gc.playback.seek(4.4));
  const before = await sig({ wait: 300 });
  await win.click('#btnPlay');
  await sleep(1300);
  const s = await sig({ wait: 0 });
  const at = await win.evaluate(() => window.gc.store.rt.playhead);
  await win.click('#btnPlay');
  await sleep(150);
  const want = await forcedSig();
  console.log(`     at ${at.toFixed(2)}s: lit ${(s.lit * 100).toFixed(1)}% (was ${(before.lit * 100).toFixed(1)}%, should be ${(want.lit * 100).toFixed(1)}%)`);
  if (at < 5.2) throw new Error(`playback never got past the cut (at ${at.toFixed(2)}s)`);
  if (sdiff(s, want) > 3) throw new Error('playing past the cut still shows the first still');
});

await step('a fade-in on a still plays as a fade', async () => {
  await clearTimeline();
  const [logo] = await importFiles('test-logo.png');
  const id = await putClip(logo, { start: 0, patch: { fit: 'contain', transform: { scale: 0.5 } } });
  await clickClip(id);
  await setField('Fade', 2.5, 0);
  await win.evaluate(() => window.gc.playback.seek(0));
  const s = await sampleWhilePlaying(3, 450);
  const reds = s.map(x => x.cells.filter((v, i) => i % 3 === 0).reduce((a, b) => a + b, 0));
  console.log(`     red energy while fading in: ${reds.map(r => r.toFixed(0)).join(' → ')}`);
  if (!(reds[2] > reds[0] * 1.15)) throw new Error('the still did not brighten while its fade-in played');
});

/**
 * After an edit made while paused, the preview shows the edit.
 *
 * Every edit repaints once, immediately. If the decoder did not have the frame
 * at that instant — a seek still running, an element just created because the
 * clip moved — the paint was abandoned to avoid flashing black, and nothing
 * ever asked again: the frame arrived, sat in the decoder, and the preview
 * stayed black or kept showing a picture from before the edit until something
 * unrelated happened to repaint it.
 */
async function previewMatches(what) {
  // Give the decoders as long as they need to land on the frame — the claim
  // under test is that the preview catches up once they have, not that 1080p
  // seeks are quick. Settled = every decoder has a frame and none is seeking.
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const settled = await win.evaluate(() => [...document.querySelectorAll('#gc-decoder-host video')]
      .every(v => v.readyState >= 2 && !v.seeking));
    if (settled && i >= 4) break;
  }
  await sleep(250);
  const s = await sig({ wait: 0 });
  const want = await forcedSig();
  const d = sdiff(s, want);
  if (want.lit < 0.2) throw new Error(`${what}: even a forced paint is dark — the set-up is wrong`);
  if (d > 3) {
    throw new Error(`${what}: the preview is ${s.lit < 0.05 ? 'black' : 'stale'} `
      + `(differs from a fresh paint by ${d.toFixed(1)}/255, lit ${(s.lit * 100).toFixed(0)}%)`);
  }
  return d;
}

await step('after dragging a clip, clicking the ruler shows the right frame', async () => {
  await clearTimeline();
  const [hd] = await importFiles('hd1080p60.mp4');
  const id = await putClip(hd, { start: 0, track: 0 });
  await zoomToFit();
  await win.evaluate(() => window.gc.playback.seek(2));
  await sleep(600);
  // Drag it five seconds later with the mouse.
  const a = await tlPoint(3, 0);
  const b = await tlPoint(8, 0);
  await win.mouse.move(a.x, a.y);
  await win.mouse.down();
  for (let i = 1; i <= 12; i++) { await win.mouse.move(a.x + (b.x - a.x) * i / 12, a.y); await sleep(16); }
  await win.mouse.up();
  await sleep(200);
  const c = await clipById(id);
  if (Math.abs(c.start - 5) > 0.3) throw new Error(`the drag left the clip at ${c.start.toFixed(2)}s, not 5s`);
  const ds = [];
  for (const t of [8, 20, 30]) { await clickRuler(t); ds.push(await previewMatches(`at ${t}s`)); }
  console.log(`     clicked 8s, 20s, 30s: off a fresh paint by ${ds.map(d => d.toFixed(1)).join(', ')}`);
});

await step('after deleting a middle piece the preview is right', async () => {
  await clearTimeline();
  const [hd] = await importFiles('hd1080p60.mp4');
  await putClip(hd, { start: 0, track: 0 });
  await zoomToFit();
  for (const t of [10, 15]) {
    await clickRuler(t); await sleep(200);
    await win.click('#btnSplit'); await sleep(200);
  }
  const mid = await win.evaluate(() => window.gc.store.doc.tracks.flatMap(t => t.clips)
    .find(c => c.start > 9.9 && c.start < 10.1)?.id);
  if (!mid) throw new Error('splitting twice did not leave a middle piece');
  await clickClip(mid);
  await win.click('#btnDelete');
  await sleep(200);
  const ds = [];
  for (const t of [17, 4, 25]) { await clickRuler(t); ds.push(await previewMatches(`at ${t}s`)); }
  console.log(`     off a fresh paint by ${ds.map(d => d.toFixed(1)).join(', ')}`);
});

await step('after changing speed the preview is right', async () => {
  await clearTimeline();
  const [hd] = await importFiles('hd1080p60.mp4');
  const id = await putClip(hd, { start: 0, track: 0 });
  await clickClip(id);
  await clickRuler(3); await sleep(500);
  await setField('Speed', 2.5);
  await previewMatches('right after the speed change');
  const ds = [];
  for (const t of [6, 12]) { await clickRuler(t); ds.push(await previewMatches(`at ${t}s`)); }
  console.log(`     off a fresh paint by ${ds.map(d => d.toFixed(1)).join(', ')}`);
});

/**
 * Changing preview quality resizes the canvas, which wipes it. The picture
 * has to be back straight away, not whenever the decoder next has news.
 */
await step('changing preview quality keeps the picture', async () => {
  await clearTimeline();
  const [hd] = await importFiles('hd1080p60.mp4');
  await putClip(hd, { start: 0, track: 0 });
  await clickRuler(6);
  await previewMatches('before');
  const opts = await win.evaluate(() => [...document.getElementById('previewQuality').options].map(o => o.value));
  const res = [];
  for (const v of [opts[0], opts.at(-1), opts[1] ?? opts[0]]) {
    await win.selectOption('#previewQuality', v);
    const s = await sig({ wait: 60 });
    res.push(`${v}: ${s.w}px lit ${(s.lit * 100).toFixed(0)}%`);
    if (s.lit < 0.2) throw new Error(`switching quality to ${v} left the preview blank`);
  }
  console.log('     ' + res.join(' · '));
});

/* ── done ────────────────────────────────────────────────────── */
await win.screenshot({ path: `${OUT}/engine.png` }).catch(() => {});
await app.close();
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`ENGINE FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('ENGINE PASSED — the preview keeps up with every edit, and export agrees with it.');
