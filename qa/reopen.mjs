/**
 * Close GameCut, open it again, open the project from Home — then export.
 *
 * A project reopened from disk has no File objects and no decoded sound: all
 * of that is rebuilt from the saved paths. Two things went wrong there:
 *   · the sound was rebuilt by fetching each WHOLE file into memory, which for
 *     a multi-GB Medal or OBS recording is enough to take the editor down; it
 *     now goes through the same streamed audio-track reader as an import;
 *   · custom fonts were never registered again, so titles fell back to the
 *     default face (and the font was reported missing).
 * Both only show in a second launch, so this suite really launches twice.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { waitFor } from './wait.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || '/tmp');
const PROFILE = `/tmp/gc-reopen-${process.pid}`;
const problems = [];
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};
const launch = async () => {
  const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
  const win = await app.firstWindow();
  win.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await win.waitForLoadState('domcontentloaded'); await sleep(2000);
  return { app, win };
};

console.log('\n── reopen a project in a fresh launch ───');
await rm(PROFILE, { recursive: true, force: true });

let projectId = null;
await step('first launch: footage, a song, a font and a title are saved', async () => {
  const { app, win } = await launch();
  await win.waitForSelector('#homeNew'); await win.click('#homeNew'); await sleep(1200);
  await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/test-clip.mp4`,
    `${ROOT}/qa/fixtures/test-tone.mp3`, `${ROOT}/qa/fixtures/GCTestFont.ttf`]);
  for (let i = 0; i < 60; i++) {
    const n = await win.evaluate(() => window.gc.assets.all().filter(a => a.peaks || a.kind === 'font').length);
    if (n >= 3) break;
    await sleep(400);
  }
  projectId = await win.evaluate(async () => {
    const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
    const { store, cmds, assets, library } = window.gc;
    store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
    cmds.removeSelected();
    for (const a of assets.all()) if (a.kind === 'video' || a.kind === 'audio') placeAsset(store, cmds, a.id, { start: 0 });
    // A title in the custom font.
    const font = assets.all().find(a => a.kind === 'font');
    cmds.addTextClip(0);
    const t = store.doc.tracks.flatMap(x => x.clips).find(c => c.type === 'text');
    if (t) { t.text.font = font.family; store.docChanged('font'); }
    await library.save({ silent: true });
    return library.id;
  });
  if (!projectId) throw new Error('the project was never saved');
  await app.close();
});

await step('second launch: opening it from Home brings back the sound and the font', async () => {
  const { app, win } = await launch();
  await win.waitForSelector(`.proj[data-id="${projectId}"]`, { timeout: 15000 });
  await win.click(`.proj[data-id="${projectId}"]`);
  await waitFor(win, () => !document.getElementById('app').classList.contains('is-home'), null, { timeout: 20000 });

  // The font must come back by itself — nothing here registers it.
  let r = null;
  for (let i = 0; i < 50; i++) {
    r = await win.evaluate(() => {
      const font = window.gc.assets.all().find(a => a.kind === 'font');
      const vids = window.gc.assets.all().filter(a => a.kind === 'video' || a.kind === 'audio');
      return {
        family: font?.family, fontMissing: !!font?.missing,
        fontLoaded: font ? document.fonts.check(`16px "${font.family}"`) && [...document.fonts].some(f => f.family.replace(/"/g, '') === font.family) : false,
        sound: vids.map(a => ({ name: a.name, peaks: !!a.peaks, stream: !!a.streamAudio, missing: !!a.missing })),
      };
    });
    if (r.fontLoaded && r.sound.every(s => s.peaks)) break;
    await sleep(300);
  }
  if (r.fontMissing || !r.fontLoaded) throw new Error(`the font "${r.family}" did not come back (${JSON.stringify(r)})`);
  const silent = r.sound.filter(s => !s.peaks);
  if (silent.length) throw new Error('no sound rebuilt for: ' + silent.map(s => s.name).join(', '));

  // And exporting straight away has sound in it.
  const b64 = await win.evaluate(async () => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    const bytes = await renderToMp4({ store: window.gc.store, width: 640, height: 360, fps: 30,
      vBitrate: 2_000_000, aBitrate: 128_000, onProgress: () => {}, shouldCancel: () => false });
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const file = path.join(OUT, 'reopen-export.mp4');
  await writeFile(file, Buffer.from(b64, 'base64'));
  const vol = execFileSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  void vol;
  const err = execFileSync('sh', ['-c', `ffmpeg -hide_banner -i "${file}" -af volumedetect -f null - 2>&1 | grep max_volume || true`], { encoding: 'utf8' });
  const m = /max_volume:\s*(-?[\d.]+)/.exec(err);
  if (!m) throw new Error('the export after reopening has no sound stream');
  if (parseFloat(m[1]) < -60) throw new Error(`the export after reopening is silent (max ${m[1]} dB)`);
  console.log(`     font "${r.family}" back; export max volume ${m[1]} dB`);
  await app.close();
});

await step('the clips being exported get their sound prepared first', async () => {
  const { app, win } = await launch();
  const order = await win.evaluate(async () => {
    const { queueAudio, prioritizeAudio } = await import('app://gamecut/src/media/audio-jobs.js');
    const { assets } = window.gc;
    const ran = [];
    const mk = (n) => { const a = assets.add({ kind: 'audio', name: n, url: 'x' }); return assets.get(a.id || a); };
    const [a, b, c, d] = ['long-1', 'long-2', 'on-timeline', 'long-3'].map(mk);
    const work = (n) => async () => { ran.push(n); await new Promise(r => setTimeout(r, 30)); };
    const done = [a, b, c, d].map(x => queueAudio(x, work(x.name)));
    prioritizeAudio([c.id]);              // what the export dialog does
    await Promise.all(done);
    return ran;
  });
  // long-1 had already started; the clip in the video must come straight after.
  if (order[1] !== 'on-timeline') throw new Error('order was ' + order.join(', '));
  await app.close();
});

await rm(PROFILE, { recursive: true, force: true });
console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`REOPEN FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('REOPEN PASSED — a project opened in a new launch has its sound and its fonts.');
