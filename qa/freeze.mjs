/**
 * Freeze frame: "pause the video here and keep it paused".
 *
 * Through the real UI: import, put the playhead at 3 s, press Shift+F. Then
 * the timeline must read clip | still | rest-of-clip, the still must be a real
 * PNG file on disk, carry the clip's crop, show exactly the frame at 3 s for
 * the whole pause, and the export must be two seconds longer with the video's
 * sound stopping during the pause. One Undo puts it all back.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { patchClick } from './reveal.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || '/tmp');
const PROFILE = `/tmp/gc-freeze-${process.pid}`;
const SRC = path.join(OUT, 'freeze-src.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi',
  '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC]);
const problems = [];
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};
const py = (code) => execFileSync('python3', ['-c', code], { encoding: 'utf8' }).trim();
const frameAt = (file, sec, png) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'scale=320:180', png]);
const diff = (a, b) => parseFloat(py(`from PIL import Image, ImageChops, ImageStat
a=Image.open("${a}").convert("L"); b=Image.open("${b}").convert("L").resize(a.size)
print(sum(ImageStat.Stat(ImageChops.difference(a,b)).mean))`));

console.log('\n── freeze frame ─────────────────────────');
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
patchClick(win);
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.click('#homeNew'); await sleep(1000);
await win.setInputFiles('#filePicker', [SRC]);
for (let i = 0; i < 80; i++) {
  const ok = await win.evaluate(() => window.gc.store.doc.tracks.some(t => t.clips.some(c => c.type === 'video'))
    && window.gc.assets.all().some(a => a.peaks?.buffer));
  if (ok) break;
  await sleep(300);
}
const layout = () => win.evaluate(() => window.gc.store.doc.tracks.flatMap(t => t.clips.map(c => ({
  type: c.type, start: +c.start.toFixed(3), dur: +c.duration.toFixed(3), inPoint: +(c.inPoint || 0).toFixed(3),
  crop: c.crop, assetId: c.assetId, fit: c.fit }))).sort((a, b) => a.start - b.start));

await step('Shift+F at 3 s makes clip | 2 s still | rest of clip', async () => {
  await win.evaluate(() => {
    const { store } = window.gc;
    const v = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    v.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };      // the still must keep this
    store.docChanged('test crop');
    window.gc.playback.seek(3);
    store.select([]);
  });
  await win.mouse.click(5, 300);                       // focus the editor, not a field
  await win.evaluate(() => document.activeElement?.blur?.());
  await win.keyboard.press('Shift+F');
  let L = [];
  for (let i = 0; i < 40; i++) { L = await layout(); if (L.some(c => c.type === 'image')) break; await sleep(250); }
  const vids = L.filter(c => c.type === 'video'), still = L.find(c => c.type === 'image');
  if (!still) throw new Error('no still was made: ' + JSON.stringify(L));
  if (vids.length !== 2) throw new Error('expected the clip cut in two: ' + JSON.stringify(L));
  if (Math.abs(vids[0].dur - 3) > 0.05) throw new Error('first part is ' + vids[0].dur + 's');
  if (Math.abs(still.start - 3) > 0.05 || Math.abs(still.dur - 2) > 0.05) throw new Error(`still at ${still.start} for ${still.dur}s`);
  if (Math.abs(vids[1].start - 5) > 0.05 || Math.abs(vids[1].inPoint - 3) > 0.05) throw new Error(`rest starts ${vids[1].start}, from ${vids[1].inPoint}s in`);
  if (JSON.stringify(still.crop) !== JSON.stringify({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })) throw new Error('the crop was not carried over: ' + JSON.stringify(still.crop));
  if (still.fit !== vids[0].fit) throw new Error(`fit ${still.fit} vs ${vids[0].fit}`);
});

await step('the still is a real PNG file, so a saved project keeps it', async () => {
  const a = await win.evaluate(() => { const x = window.gc.assets.all().find(a => a.kind === 'image'); return { path: x.path, url: x.url, w: x.width, h: x.height }; });
  if (!a.path || !/\.png$/.test(a.path)) throw new Error('no file: ' + JSON.stringify(a));
  const st = await stat(a.path);
  if (st.size < 1000) throw new Error('file is ' + st.size + ' bytes');
  if (a.w !== 640 || a.h !== 360) throw new Error(`still is ${a.w}x${a.h}, not the video's 640x360`);
});

await step('the export pauses on exactly that frame, and the sound pauses with it', async () => {
  await win.evaluate(() => {   // judge the picture without the crop
    for (const t of window.gc.store.doc.tracks) for (const c of t.clips) c.crop = null;
    window.gc.store.docChanged('test');
  });
  const b64 = await win.evaluate(async () => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    const bytes = await renderToMp4({ store: window.gc.store, width: 640, height: 360, fps: 30,
      vBitrate: 4_000_000, aBitrate: 128_000, onProgress: () => {}, shouldCancel: () => false });
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const file = path.join(OUT, 'freeze-export.mp4');
  await writeFile(file, Buffer.from(b64, 'base64'));
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));
  if (Math.abs(dur - 10) > 0.2) throw new Error(`export is ${dur}s, expected 10`);
  const p = (n) => path.join(OUT, `freeze-${n}.png`);
  frameAt(SRC, 3.0, p('src3')); frameAt(file, 3.5, p('a')); frameAt(file, 4.7, p('b')); frameAt(file, 2.0, p('before'));
  const still = diff(p('a'), p('b')), match = diff(p('a'), p('src3')), moving = diff(p('before'), p('a'));
  console.log(`     pause holds still (Δ ${still.toFixed(2)}), matches the 3 s frame (Δ ${match.toFixed(2)}), vs 2 s (Δ ${moving.toFixed(2)})`);
  if (still > 1) throw new Error('the picture moves during the pause');
  if (match > moving / 2) throw new Error('the still is not the frame at 3 s');
  const vol = (ss, t) => {
    const out = execFileSync('sh', ['-c', `ffmpeg -hide_banner -ss ${ss} -t ${t} -i "${file}" -af volumedetect -f null - 2>&1 | grep max_volume || true`], { encoding: 'utf8' });
    return parseFloat((/max_volume:\s*(-?[\d.]+)/.exec(out) || [0, -999])[1]);
  };
  const during = vol(3.3, 1.4), after = vol(6, 2);
  console.log(`     sound during the pause ${during} dB, after ${after} dB`);
  if (during > -50) throw new Error('the video kept talking during the pause');
  if (after < -30) throw new Error('the sound did not come back after the pause');
});

await step('one Undo takes it all back', async () => {
  await win.evaluate(() => window.gc.cmds.undo());
  const L = await layout();
  if (L.length !== 1 || L[0].type !== 'video' || Math.abs(L[0].dur - 8) > 0.1) throw new Error(JSON.stringify(L));
});

await step('right-click offers it, and the crop screen has the button', async () => {
  const has = await win.evaluate(async () => {
    const src = await (await fetch('app://gamecut/src/ui/timeline/context-menu.js')).text();
    const cs = await (await fetch('app://gamecut/src/ui/preview/crop-studio.js')).text();
    return { menu: src.includes('Freeze frame (pause the video here)'), btn: cs.includes('id="cstFreeze"') };
  });
  if (!has.menu || !has.btn) throw new Error(JSON.stringify(has));
});

await app.close();
await rm(PROFILE, { recursive: true, force: true });
console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`FREEZE FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('FREEZE PASSED — Shift+F pauses the video on the exact frame and plays on.');
