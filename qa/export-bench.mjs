/**
 * Export benchmark: where does the time go, on THIS machine, with real footage?
 *
 *   node qa/export-bench.mjs --file "C:\path\clip.mp4" [--secs 15] [--w 1920] [--h 1080]
 *                            [--fps 60] [--mbps 20] [--exact] [--sink null|memory] [--runs 1]
 *
 * Drives the real editor in Electron: imports the file, puts it on the
 * timeline, runs renderToMp4 exactly as the Export dialog does (same encoder
 * plan, same frame reader, same compositor), and prints the stage timings that
 * renderToMp4 fills in when it is given `profile`.
 *
 * The footage is only read, never copied or changed. Output goes to a sink that
 * counts bytes (`null`) or keeps them (`memory`); nothing is written to disk.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const FILE = arg('file');
if (!FILE || FILE === true) { console.error('usage: node qa/export-bench.mjs --file <video> [options]'); process.exit(2); }
const SECS = Number(arg('secs', 15));
const W = Number(arg('w', 1920)), H = Number(arg('h', 1080)), FPS = Number(arg('fps', 60));
const MBPS = Number(arg('mbps', 20));
const EXACT = arg('exact', false) === true;
const SINK = String(arg('sink', 'null'));
const RUNS = Number(arg('runs', 1));
const NOAUDIO = arg('noaudio', false) === true;
const SCENE = String(arg('scene', 'plain'));   // plain | vertical | overlays | heavy

const ROOT = path.resolve(import.meta.dirname, '..');
const PROFILE = await mkdtemp(path.join(tmpdir(), 'strike-bench-'));

const app = await electron.launch({ args: ['.', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 90_000 });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
await win.waitForLoadState('domcontentloaded');
await sleep(2500);
await win.waitForSelector('#homeNew', { timeout: 30_000 });
await win.click('#homeNew');
await win.waitForFunction(() => !document.getElementById('app').classList.contains('is-home'), null, { timeout: 30_000 });
await sleep(800);

console.log(`\nimporting ${path.basename(FILE)} …`);
await win.setInputFiles('#filePicker', [FILE]);
let info = null;
for (let i = 0; i < 240; i++) {
  info = await win.evaluate(async () => {
    const m = await import('app://gamecut/src/media/asset-store.js');
    const a = m.assets.all().find(x => x.kind === 'video');
    return a ? { id: a.id, w: a.width, h: a.height, dur: a.duration, audio: !!a.peaks?.buffer, streamAudio: !!a.streamAudio, missing: !!a.missing } : null;
  });
  if (info && info.w && (info.audio || NOAUDIO || i > 120)) break;
  await sleep(500);
}
if (!info) { console.error('import never finished'); await app.close(); process.exit(1); }
console.log(`  ${info.w}x${info.h}, ${info.dur?.toFixed?.(1)}s, sound ${info.audio ? 'ready' : 'NOT ready'}`);

const placed = await win.evaluate(async ({ id, secs, noaudio, scene }) => {
  const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
  const { makeClip } = await import('app://gamecut/src/core/schema.js');
  const { assets } = await import('app://gamecut/src/media/asset-store.js');
  const { store, cmds } = window.gc;
  store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
  cmds.removeSelected();
  placeAsset(store, cmds, id, { start: 0 });
  for (const t of store.doc.tracks) for (const c of t.clips) {
    if (c.duration > secs) c.duration = secs;
    if (noaudio) c.silent = true;
  }
  const vid = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
  const trackOf = (kind, n = 0) => store.doc.tracks.filter(t => t.kind === kind)[n];
  const asset = assets.get(id);

  /*
   * `scene` is a comma list of features, so each one's cost can be read on its own:
   *   plain            nothing extra          vcover   9:16 project, picture covers the frame
   *   vblur            9:16, blurred fill     text     a title with glow and outline
   *   shape            a rounded bar          zoom     a punch-in effect clip
   *   anim             a kill-counter overlay second   a 2nd shot with a dissolve into it
   *   cam              a cropped facecam layer
   *   overlays = text,shape,zoom,anim     heavy = vblur,overlays,second,cam
   */
  const want = new Set(scene.split(',').flatMap(s =>
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
  if (want.has('anim')) { try { text.clips.push(makeClip('anim', { trackId: text.id, start: 0.5, duration: secs - 1, anim: { id: 'killCounter', p: {} } })); } catch {} }
  /* A second video layer (facecam-style crop) and a dissolve between two shots. */
  if (want.has('second') && asset) {
    const home = store.doc.tracks.find(t => t.clips.includes(vid));
    const second = makeClip('video', { trackId: home.id, assetId: id, name: 'second', start: secs / 2, duration: secs / 2, inPoint: (vid.inPoint || 0) + 1,
      sourceDuration: vid.sourceDuration, transIn: { kind: 'dissolve', dur: 0.6, dir: 'none' }, fit: vid.fit });
    vid.duration = secs / 2;
    home.clips.push(second);
  }
  if (want.has('cam') && asset) {
    const v2 = store.doc.tracks.find(t => t.kind === 'video' && !t.clips.includes(vid));
    const cam = makeClip('video', { trackId: v2.id, assetId: id, name: 'cam', start: 0, duration: secs, inPoint: vid.inPoint || 0, sourceDuration: vid.sourceDuration,
      silent: true, crop: { x: 0.0, y: 0.6, w: 0.3, h: 0.4 }, transform: { x: 0.2, y: 0.12, scale: 0.35 } });
    v2.clips.push(cam);
  }
  store.docChanged('bench');
  return { duration: store.rt.duration, clips: store.doc.tracks.reduce((n, t) => n + t.clips.length, 0), size: [store.doc.width, store.doc.height] };
}, { id: info.id, secs: SECS, noaudio: NOAUDIO, scene: SCENE });
console.log(`  scene "${SCENE}": ${placed.clips} clip(s), ${placed.duration.toFixed(2)}s, project ${placed.size.join('x')}`);
await sleep(1200);

const results = [];
for (let run = 1; run <= RUNS; run++) {
  const r = await win.evaluate(async ({ W, H, FPS, MBPS, EXACT, SINK }) => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    const { store } = window.gc;
    let bytes = 0, chunks = 0;
    const kept = [];
    const sink = SINK === 'none' ? null : {
      write: async (chunk, position) => { bytes += chunk.byteLength; chunks++; if (SINK === 'memory') kept.push(chunk.slice(0)); },
    };
    const profile = {};
    let enc = null, warn = [];
    const t0 = performance.now();
    let out, err = null;
    try {
      out = await renderToMp4({
        store, width: W, height: H, fps: FPS, vBitrate: MBPS * 1e6, aBitrate: 192_000,
        frameAccuracy: EXACT ? 'exact' : 'fast', sink, profile,
        shouldCancel: () => false,
        onProgress: (e) => {
          if (e.phase === 'encoder' && e.codec) enc = { codec: e.codec, path: e.path, hw: e.hardwareAcceleration, mode: e.bitrateMode, bitrate: e.bitrate, audio: e.audioCodec };
          if (e.phase === 'done') warn = e.warnings || [];
        },
      });
    } catch (e) { err = String(e?.stack || e); }
    const wall = performance.now() - t0;
    return { wall, err, bytes: out?.bytes ?? out?.byteLength ?? bytes, chunks, profile, enc, warn };
  }, { W, H, FPS, MBPS, EXACT, SINK });

  results.push(r);
  console.log(`\n── run ${run} ──────────────────────────────`);
  if (r.err) { console.log('  FAILED:', r.err); continue; }
  const p = r.profile, fr = p.frames || 1;
  console.log(`  encoder     ${r.enc?.codec}  path=${r.enc?.path}  hw=${r.enc?.hw}  mode=${r.enc?.mode}  ${(r.enc?.bitrate / 1e6).toFixed(1)} Mbps  audio=${r.enc?.audio}`);
  console.log(`  decoder     fast reader used=${p.readerStats?.used}  hardware=${p.readerStats?.hardware}  corrective seeks=${p.corrections}`);
  console.log(`  wall time   ${(r.wall / 1000).toFixed(2)} s total · loop ${(p.loopMs / 1000).toFixed(2)} s · ${p.frames} frames`);
  console.log(`  speed       ${(fr / (p.loopMs / 1000)).toFixed(1)} frames/s  (${(fr / FPS / (r.wall / 1000)).toFixed(2)}x real time overall)`);
  console.log(`  output      ${(r.bytes / 1e6).toFixed(1)} MB in ${r.chunks} write(s)`);
  console.log('  stage                  ms/frame     share');
  const sum = Object.values(p.ms).reduce((a, b) => a + b, 0) || 1;
  for (const [k, v] of Object.entries(p.ms)) {
    console.log(`    ${k.padEnd(14)} ${(v / fr).toFixed(2).padStart(10)}   ${(100 * v / sum).toFixed(0).padStart(5)}%`);
  }
  if (r.warn.length) console.log('  warnings:', r.warn);
}
if (errors.length) { console.log('\npage errors/warnings:'); for (const e of [...new Set(errors)].slice(0, 15)) console.log('  ' + e); }

await app.close();
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
