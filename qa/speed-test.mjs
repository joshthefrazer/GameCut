/**
 * One-command speed test for the export changes: old behaviour vs new, side by side.
 *
 *   node qa/speed-test.mjs --file "D:\clips\some-1080p60-clip.mp4"
 *       [--secs 8] [--rounds 2] [--scenes plain,vblur,cam,second,heavy]
 *       [--w 1920] [--h 1080] [--fps 60] [--mbps 20] [--noaudio] [--no-failures]
 *
 * What it does, in order:
 *   1. Prints the machine (CPU, memory, which graphics chip Chromium really uses).
 *   2. Warms up, then times each scene with the OLD behaviour and the NEW behaviour,
 *      alternating, and prints frames per second for each and the change.
 *      "Old" is switched on with three test flags (set on `globalThis`, never by the app):
 *        __strikeLegacyBackdrop  one-step blur backdrop     (src/engine/layers/video-layer.js)
 *        __strikeNoShare         one decode per layer        (src/export/render-export.js)
 *        __strikeLegacyRetire    reader closed too early in transitions (same file)
 *   3. Checks the new blurred background LOOKS the same as the old one (pixel difference).
 *   4. Failure paths (skip with --no-failures): a simulated encoder failure half-way through an
 *      export, and simulated decoder failures. The exported file is written to qa/out/ and, if
 *      ffmpeg is installed, decoded end to end to prove it is intact.
 *
 * The footage is only read. Results are printed AND saved to qa/out/speed-test-<pc>-<time>.txt:
 * bring that file back (or paste it) to compare machines.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir, cpus, totalmem, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const FILE = arg('file');
if (!FILE || FILE === true) {
  console.error('usage: node qa/speed-test.mjs --file <a 1080p60 video> [--secs 8] [--rounds 2] [--scenes plain,vblur,cam,second,heavy]');
  process.exit(2);
}
const SECS = Number(arg('secs', 8));
const ROUNDS = Math.max(1, Number(arg('rounds', 2)));
const SCENES = String(arg('scenes', 'plain,vblur,cam,second,heavy')).split(',').map(s => s.trim()).filter(Boolean);
const W = Number(arg('w', 1920)), H = Number(arg('h', 1080)), FPS = Number(arg('fps', 60));
const MBPS = Number(arg('mbps', 20));
const NOAUDIO = arg('noaudio', false) === true;
const FAILURES = arg('no-failures', false) !== true;

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'qa', 'out');
await mkdir(OUT, { recursive: true });

const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const f1 = (n) => Number.isFinite(n) ? n.toFixed(1) : 'n/a';

/* ── Start the real editor ─────────────────────────────────────────────── */
const PROFILE = await mkdtemp(path.join(tmpdir(), 'strike-speed-'));
const app = await electron.launch({ args: ['.', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 120_000 });
const win = await app.firstWindow();
const pageErrors = [];
win.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
win.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text()); });
await win.waitForLoadState('domcontentloaded');
await sleep(2500);
await win.waitForSelector('#homeNew', { timeout: 30_000 });
await win.click('#homeNew');
await win.waitForFunction(() => !document.getElementById('app').classList.contains('is-home'), null, { timeout: 30_000 });
await sleep(800);

/* A sink that writes the exported file to disk, for the checks that need to open it. */
let outFd = null;
await win.exposeFunction('stSinkWrite', (position, b64) => {
  if (outFd === null) return;
  const buf = Buffer.from(b64, 'base64');
  writeSync(outFd, buf, 0, buf.length, position);
});

/* ── Machine ───────────────────────────────────────────────────────────── */
const gpu = await win.evaluate(() => {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    const e = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
  } catch { return 'unknown'; }
});
let gpuInfo = '';
try {
  const info = await app.evaluate(async ({ app: a }) => a.getGPUInfo('basic'));
  gpuInfo = (info?.gpuDevice || []).map(d => `${d.vendorId?.toString(16) ?? '?'}:${d.deviceId?.toString(16) ?? '?'}${d.active ? ' (active)' : ''}`).join(', ');
} catch { /* not available */ }
log('════════════════════════════════════════════════════════════');
log(` Strike export speed test   ${new Date().toISOString()}`);
log(` PC        ${hostname()}  ·  ${cpus()[0]?.model?.trim()}  ·  ${cpus().length} threads  ·  ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM`);
log(` Graphics  ${gpu}${gpuInfo ? `   [${gpuInfo}]` : ''}`);
log(` Settings  ${W}x${H} @ ${FPS} fps, ${MBPS} Mbps, ${SECS}s per run, ${ROUNDS} round(s), audio ${NOAUDIO ? 'off' : 'on'}`);
log('════════════════════════════════════════════════════════════');

/* ── Import the clip ───────────────────────────────────────────────────── */
await win.setInputFiles('#filePicker', [FILE]);
let info = null;
for (let i = 0; i < 300; i++) {
  info = await win.evaluate(async () => {
    const m = await import('app://gamecut/src/media/asset-store.js');
    const a = m.assets.all().find(x => x.kind === 'video');
    return a ? { id: a.id, w: a.width, h: a.height, dur: a.duration, audio: !!a.peaks?.buffer } : null;
  });
  if (info && info.w && (info.audio || NOAUDIO || i > 120)) break;
  await sleep(500);
}
if (!info) { log('The clip never finished importing.'); await app.close(); process.exit(1); }
log(` Clip      ${path.basename(FILE)}  ${info.w}x${info.h}, ${info.dur?.toFixed?.(1)} s, sound ${info.audio ? 'ready' : 'not ready'}`);
if (info.dur && info.dur < SECS + 2) log(` (the clip is only ${info.dur.toFixed(1)} s long; use --secs ${Math.max(2, Math.floor(info.dur - 2))} or a longer clip)`);

/* ── Page-side helpers (serialised into the editor) ────────────────────── */
async function buildScene({ id, secs, noaudio, scene }) {
  const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
  const { makeClip } = await import('app://gamecut/src/core/schema.js');
  const { assets } = await import('app://gamecut/src/media/asset-store.js');
  const { store, cmds } = window.gc;
  store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
  cmds.removeSelected();
  store.doc.width = 1920; store.doc.height = 1080; store.doc.aspect = '16:9';
  placeAsset(store, cmds, id, { start: 0 });
  for (const t of store.doc.tracks) for (const c of t.clips) {
    if (c.duration > secs) c.duration = secs;
    if (noaudio) c.silent = true;
  }
  const vid = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
  const trackOf = (kind, n = 0) => store.doc.tracks.filter(t => t.kind === kind)[n];
  const asset = assets.get(id);
  const want = new Set(scene.split('+').flatMap(s =>
    s === 'overlays' ? ['text', 'shape', 'zoom', 'anim'] :
    s === 'heavy' ? ['vblur', 'text', 'shape', 'zoom', 'anim', 'second', 'cam'] :
    s === 'vertical' ? ['vblur'] : [s]));
  if (want.has('vblur') || want.has('vcover')) {
    store.doc.width = 1080; store.doc.height = 1920; store.doc.aspect = '9:16';
    vid.fit = want.has('vblur') ? 'blur' : 'cover';
  }
  const text = trackOf('text', 0);
  if (want.has('text')) text.clips.push(makeClip('text', { trackId: text.id, start: 0.5, duration: secs - 1, text: { text: 'CLUTCH ROUND', anim: 'pop', animLoop: 'none', glow: 0.4, strokeWidth: 0.02 } }));
  if (want.has('shape')) text.clips.push(makeClip('shape', { trackId: text.id, start: 0, duration: secs, shape: { kind: 'rect', fill: '#2563eb', radius: 0.02 }, transform: { x: 0.5, y: 0.9, w: 0.8, h: 0.08 } }));
  if (want.has('zoom')) text.clips.push(makeClip('effect', { trackId: text.id, start: 0.5, duration: secs - 1, effect: { kind: 'zoom', amount: 0.6, x: 0.5, y: 0.5 } }));
  if (want.has('anim')) { try { text.clips.push(makeClip('anim', { trackId: text.id, start: 0.5, duration: secs - 1, anim: { id: 'killCounter', p: {} } })); } catch { /* optional */ } }
  if (want.has('second') && asset) {
    const home = store.doc.tracks.find(t => t.clips.includes(vid));
    const second = makeClip('video', { trackId: home.id, assetId: id, name: 'second', start: secs / 2, duration: secs / 2, inPoint: (vid.inPoint || 0) + 1,
      sourceDuration: vid.sourceDuration, transIn: { kind: 'dissolve', dur: 0.6, dir: 'none' }, fit: vid.fit });
    vid.duration = secs / 2;
    home.clips.push(second);
  }
  if (want.has('cam') && asset) {
    const v2 = store.doc.tracks.find(t => t.kind === 'video' && !t.clips.includes(vid));
    v2.clips.push(makeClip('video', { trackId: v2.id, assetId: id, name: 'cam', start: 0, duration: secs, inPoint: vid.inPoint || 0, sourceDuration: vid.sourceDuration,
      silent: true, crop: { x: 0.0, y: 0.6, w: 0.3, h: 0.4 }, transform: { x: 0.2, y: 0.12, scale: 0.35 } }));
  }
  store.docChanged('speed-test');
  return { w: store.doc.width, h: store.doc.height, dur: store.rt.duration };
}

async function exportOnce({ fps, mbps, flags, keep }) {
  Object.assign(globalThis, { __strikeLegacyBackdrop: false, __strikeNoShare: false, __strikeLegacyRetire: false }, flags || {});
  const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
  const { store } = window.gc;
  const u8ToB64 = (u8) => {
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  };
  let bytes = 0;
  const sink = { write: async (chunk, position) => { bytes += chunk.byteLength; if (keep) await window.stSinkWrite(position, u8ToB64(chunk)); } };
  const profile = {};
  let warn = [], enc = null, err = null;
  const t0 = performance.now();
  try {
    await renderToMp4({
      store, width: store.doc.width, height: store.doc.height, fps, vBitrate: mbps * 1e6, aBitrate: 192_000,
      frameAccuracy: 'fast', sink, profile, shouldCancel: () => false,
      onProgress: (e) => {
        if (e.phase === 'encoder' && e.codec) enc = { codec: e.codec, path: e.path, hw: e.hardwareAcceleration };
        if (e.phase === 'done') warn = e.warnings || [];
      },
    });
  } catch (e) { err = String(e?.stack || e); }
  // Leave the switches off for whoever runs next.
  Object.assign(globalThis, { __strikeLegacyBackdrop: false, __strikeNoShare: false, __strikeLegacyRetire: false, __strikeFailEncoderAt: -1, __strikeFailReader: 0 });
  return { err, warn, enc, bytes, wall: performance.now() - t0, profile };
}

const fpsOf = (r) => (r.profile.frames && r.profile.loopMs) ? r.profile.frames / (r.profile.loopMs / 1000) : NaN;
const OLD = { __strikeLegacyBackdrop: true, __strikeNoShare: true, __strikeLegacyRetire: true };
const NEW = {};

/* ── 1. Warm-up (not reported): first exports pay for encoder and shader start-up ── */
log('\nWarming up…');
{
  const b = await win.evaluate(buildScene, { id: info.id, secs: Math.min(SECS, 3), noaudio: NOAUDIO, scene: 'plain' });
  const r = await win.evaluate(exportOnce, { fps: FPS, mbps: MBPS, flags: NEW, keep: false });
  if (r.err) { log('Warm-up export FAILED:\n' + r.err); await app.close(); process.exit(1); }
  log(`  encoder: ${r.enc?.codec} · ${r.enc?.path} · hardware=${r.enc?.hw}`);
}

/* ── 2. Old vs new, scene by scene ─────────────────────────────────────── */
const summary = [];
for (const scene of SCENES) {
  const b = await win.evaluate(buildScene, { id: info.id, secs: SECS, noaudio: NOAUDIO, scene });
  const times = { old: [], new: [] };
  const stages = { old: null, new: null };
  let failed = null;
  for (let round = 1; round <= ROUNDS && !failed; round++) {
    const order = round % 2 ? ['old', 'new'] : ['new', 'old'];       // alternate so warm-up and heat favour neither
    for (const v of order) {
      const r = await win.evaluate(exportOnce, { fps: FPS, mbps: MBPS, flags: v === 'old' ? OLD : NEW, keep: false });
      if (r.err) { failed = `${v}: ${r.err.split('\n')[0]}`; break; }
      times[v].push(fpsOf(r));
      stages[v] = r.profile.ms ? Object.fromEntries(Object.entries(r.profile.ms).map(([k, ms]) => [k, ms / r.profile.frames])) : null;
    }
  }
  const o = mean(times.old), n = mean(times.new);
  summary.push({ scene, size: `${b.w}x${b.h}`, old: o, new: n, change: (n / o - 1) * 100, failed });
  log(`\n  ${scene.padEnd(8)} ${b.w}x${b.h}   old ${times.old.map(f1).join(' / ')} fps   new ${times.new.map(f1).join(' / ')} fps${failed ? '   FAILED ' + failed : ''}`);
  if (stages.old && stages.new) {
    const keys = Object.keys(stages.new);
    log('           ms per frame     ' + keys.map(k => k.padStart(13)).join(''));
    log('             old            ' + keys.map(k => f1(stages.old[k]).padStart(13)).join(''));
    log('             new            ' + keys.map(k => f1(stages.new[k]).padStart(13)).join(''));
  }
}

log('\n────────────────────────────────────────────────────────────');
log(' RESULT (frames per second; higher is better)');
log('   scene      size          old      new     change');
for (const s of summary) {
  log(`   ${s.scene.padEnd(9)} ${s.size.padEnd(11)} ${f1(s.old).padStart(7)}  ${f1(s.new).padStart(7)}   ${s.failed ? 'FAILED' : (s.change >= 0 ? '+' : '') + s.change.toFixed(0) + '%'}`);
}
log('   (Plain footage is limited by the video engine itself; the changes should show on vblur, cam, second and heavy.)');

/* ── 3. Does the new blurred background look the same? ─────────────────── */
if (SCENES.includes('vblur') || SCENES.includes('heavy')) {
  await win.evaluate(buildScene, { id: info.id, secs: SECS, noaudio: true, scene: 'vblur' });
  const look = await win.evaluate(async ({ id }) => {
    const { Compositor } = await import('app://gamecut/src/engine/compositor.js');
    const { Mp4FrameReader } = await import('app://gamecut/src/export/frame-reader.js');
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    const { store } = window.gc;
    const t = 1.0;
    const cv = document.createElement('canvas');
    const comp = new Compositor(store, cv, { fixedSize: { w: 540, h: 960 } });
    const rd = await Mp4FrameReader.open(assets.get(id));
    if (!rd) return { err: 'frame reader unavailable for this clip' };
    const clip = comp.clipsNeededAt(t)[0];
    const pic = await rd.canvasAt((clip.inPoint || 0) + t);
    for (const c of comp.clipsNeededAt(t)) comp.pool.overrides.set(c.id, pic);
    const grab = (legacy) => {
      globalThis.__strikeLegacyBackdrop = legacy;
      comp.render(t, false);
      return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    };
    const a = grab(true), b = grab(false);
    globalThis.__strikeLegacyBackdrop = false;
    let sum = 0, max = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const d = Math.abs(a[i + k] - b[i + k]); sum += d; if (d > max) max = d; n++; }
    rd.close(); comp.dispose();
    return { mean: sum / n, max };
  }, { id: info.id });
  log('\n BLURRED BACKGROUND LOOK CHECK (new vs old, one frame, 0-255 per colour channel)');
  if (look.err) log('   ' + look.err);
  else log(`   mean difference ${look.mean.toFixed(2)}, largest ${look.max}   ->   ${look.mean < 4 ? 'looks the same' : 'DIFFERENT: have a look at an exported vertical video'}`);
}

/* ── 4. Failure paths ──────────────────────────────────────────────────── */
if (FAILURES) {
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  const haveFfmpeg = ff.status === 0;
  const checkFile = (file, expectedFrames) => {
    if (!haveFfmpeg) return `saved to ${file}  (ffmpeg not installed: open it in a player and check it plays to the end)`;
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
    const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const frames = Number((probe.stdout || '').trim());
    const clean = dec.status === 0 && !(dec.stderr || '').trim();
    return `${clean ? 'decodes cleanly end to end' : 'DECODE ERRORS: ' + (dec.stderr || '').trim().split('\n')[0]}; ${Number.isFinite(frames) ? frames : '?'} video frames (expected ${expectedFrames})  [${file}]`;
  };

  log('\n FAILURE PATHS');
  // Short on purpose: the three-failures test ends on the slow player path for the whole run.
  const b = await win.evaluate(buildScene, { id: info.id, secs: Math.min(SECS, 4), noaudio: NOAUDIO, scene: 'second' });
  const expectedFrames = Math.max(1, Math.round(b.dur * FPS));

  // 4a. The encoder "fails" half-way: a new one must take over and the file must still be whole.
  {
    const file = path.join(OUT, 'speed-test-encoder-restart.mp4');
    outFd = openSync(file, 'w');
    const r = await win.evaluate(async ({ fps, mbps, at }) => {
      globalThis.__strikeFailEncoderAt = at;
      return null;
    }, { fps: FPS, mbps: MBPS, at: Math.floor(expectedFrames / 2) });
    const res = await win.evaluate(exportOnce, { fps: FPS, mbps: MBPS, flags: {}, keep: true });
    closeSync(outFd); outFd = null;
    const restarted = res.warn.some(w => /encoder stopped/i.test(w));
    log(`   encoder failure at frame ${Math.floor(expectedFrames / 2)}:  ${res.err ? 'EXPORT FAILED: ' + res.err.split('\n')[0] : (restarted ? 'restarted and finished' : 'finished, but NO restart was recorded (hook did not fire?)')}`);
    if (!res.err) log('     ' + checkFile(file, expectedFrames));
  }

  // 4b. One decoder failure: should recover with a fresh decoder, no slow fallback.
  {
    await win.evaluate(() => { globalThis.__strikeFailReader = 1; });
    const res = await win.evaluate(exportOnce, { fps: FPS, mbps: MBPS, flags: {}, keep: false });
    const slow = res.warn.some(w => /slower method/i.test(w));
    log(`   one decoder failure:      ${res.err ? 'EXPORT FAILED: ' + res.err.split('\n')[0] : (slow ? 'fell back to the slow player (unexpected)' : 'recovered with a fresh decoder')}  (fallback ${f1(res.profile.ms?.fallback / res.profile.frames)} ms/frame)`);
  }

  // 4c. Three decoder failures in a row: gives up on the fast reader, uses the player, and says so.
  {
    await win.evaluate(() => { globalThis.__strikeFailReader = 3; });
    const res = await win.evaluate(exportOnce, { fps: FPS, mbps: MBPS, flags: {}, keep: false });
    const slow = res.warn.some(w => /slower method/i.test(w));
    log(`   three decoder failures:   ${res.err ? 'EXPORT FAILED: ' + res.err.split('\n')[0] : (slow ? 'used the slower player and told the user' : 'finished without the expected warning')}`);
  }
}

if (pageErrors.length) { log('\n PAGE ERRORS (first few)'); for (const e of [...new Set(pageErrors)].slice(0, 8)) log('   ' + e); }
log('\nDone.');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const report = path.join(OUT, `speed-test-${hostname()}-${stamp}.txt`);
await writeFile(report, lines.join('\n') + '\n', 'utf8');
console.log(`\nSaved: ${report}`);

await app.close();
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
