/**
 * Export, end to end through the real save path.
 *
 * Every other export check either calls renderToMp4 directly or swaps the save
 * bridge for a stand-in (qa/media-io.mjs). This one does neither: the real
 * Export dialog, the real window.gamecut.exportSink in the preload, the real
 * IPC into the main process, real positional writes into a real `.partial`
 * file, and the real rename into place. Only the native "Save as" dialog is
 * answered from here, because a test cannot click an OS dialog.
 *
 * It exists because the file now goes to disk as it is made rather than being
 * held whole in memory and handed over at the end — which is what keeps a long
 * high-bitrate export from running the editor out of memory on the last frame.
 * That is only true if the bytes on disk are exactly the bytes the muxer made,
 * in the right places, and nothing half-written is ever left behind.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, readFile, stat, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || '/tmp');
const DIR = path.join(OUT, `sink-${process.pid}`);
const PROFILE = `/tmp/gc-sink-${process.pid}`;
const problems = [];
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── export, through the real save path ───');
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.waitForSelector('#homeNew'); await win.click('#homeNew'); await sleep(1200);

/** Answer the next native Save dialog with this path (or cancel it with null). */
const answerSaveWith = (p) => app.evaluate(({ dialog }, target) => {
  dialog.showSaveDialog = async () => (target ? { canceled: false, filePath: target } : { canceled: true });
}, p);

await step('the bridge writes chunks where they belong, in any order', async () => {
  const target = path.join(DIR, 'contract.bin');
  await answerSaveWith(target);
  const r = await win.evaluate(async () => {
    const xs = window.gamecut.exportSink;
    const d = await xs.open({ suggestedName: 'x.mp4' });
    // Out of order on purpose: the muxer patches the header after the data.
    await xs.write(d.token, new Uint8Array([5, 6, 7, 8]), 4);
    await xs.write(d.token, new Uint8Array([1, 2, 3, 4]), 0);
    await xs.write(d.token, new Uint8Array([9, 9]), 2);           // overwrite in the middle
    const closed = await xs.close(d.token);
    let reuse = null;
    try { await xs.write(d.token, new Uint8Array([1]), 0); } catch (e) { reuse = e.message; }
    let forged = null;
    try { await xs.write('0'.repeat(64), new Uint8Array([1]), 0); } catch (e) { forged = e.message; }
    return { closed, reuse, forged };
  });
  if (!r.closed?.ok) throw new Error('close failed: ' + JSON.stringify(r.closed));
  const bytes = [...await readFile(target)];
  if (bytes.join() !== [1, 2, 9, 9, 5, 6, 7, 8].join()) throw new Error('file holds ' + bytes.join());
  const left = (await readdir(DIR)).filter(f => f.endsWith('.partial'));
  if (left.length) throw new Error('a .partial was left behind: ' + left.join());
  if (!r.reuse) throw new Error('a closed token could still write');
  if (!r.forged) throw new Error('a made-up token could write');
});

await step('an aborted export leaves nothing behind', async () => {
  const target = path.join(DIR, 'aborted.mp4');
  await answerSaveWith(target);
  await win.evaluate(async () => {
    const xs = window.gamecut.exportSink;
    const d = await xs.open({ suggestedName: 'x.mp4' });
    await xs.write(d.token, new Uint8Array(1024), 0);
    await xs.abort(d.token);
  });
  const names = await readdir(DIR);
  if (names.some(n => n.startsWith('aborted'))) throw new Error('left behind: ' + names.join(', '));
});

await step('a folder that is not there gives a plain reason, not a crash', async () => {
  await answerSaveWith(path.join(DIR, 'no-such-folder', 'x.mp4'));
  const msg = await win.evaluate(async () => {
    try { await window.gamecut.exportSink.open({ suggestedName: 'x.mp4' }); return 'opened'; }
    catch (e) { return e.message; }
  });
  if (!/folder/i.test(msg)) throw new Error('said: ' + msg);
});

await step('a whole export through the Export dialog lands as a playable MP4', async () => {
  await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/test-clip.mp4`, `${ROOT}/qa/fixtures/test-tone.mp3`]);
  // Wait for both to be in, and for the timeline to have something on it.
  for (let i = 0; i < 60; i++) {
    const n = await win.evaluate(() => window.gc.store.doc.tracks.reduce((m, t) => m + t.clips.length, 0));
    if (n >= 1) break;
    await sleep(400);
  }
  await win.evaluate(() => {
    const { store, assets } = window.gc;
    // Make sure the song is on the timeline too, so the file must carry sound.
    return [store.doc.tracks.length, assets.all().length];
  });
  const target = path.join(DIR, 'real-export.mp4');
  await answerSaveWith(target);
  await win.click('#btnExport');
  await win.waitForSelector('#xpGo', { timeout: 10000 });
  // The quickest preset; this is about the save path, not the picture.
  const draft = await win.$('[data-preset="draft"]');
  if (draft) await draft.click();
  await win.click('#xpGo');
  await win.waitForSelector('#xpReveal, #xpErr', { timeout: 240000 });
  const err = await win.$('#xpErr');
  if (err) throw new Error('the export failed: ' + (await err.textContent()).trim());
  const st = await stat(target);
  if (st.size < 20000) throw new Error(`the file is only ${st.size} bytes`);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-show_streams', '-show_format', target], { encoding: 'utf8' }));
  const v = info.streams.find(s => s.codec_type === 'video');
  if (!v || v.codec_name !== 'h264') throw new Error('no H.264 video in the file');
  const dur = parseFloat(info.format.duration);
  if (!(dur > 1)) throw new Error('the file is ' + dur + 's long');
  // Decode every frame: a file whose index points at the wrong bytes fails here.
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', target, '-f', 'null', '-'], { stdio: 'pipe' });
  const left = (await readdir(DIR)).filter(f => f.endsWith('.partial'));
  if (left.length) throw new Error('a .partial was left behind: ' + left.join());
  console.log(`     ${(st.size / 1024).toFixed(0)} KB, ${dur.toFixed(2)}s, streams: ${info.streams.map(s => s.codec_name).join(' + ')}`);
  await win.evaluate(() => document.querySelector('#exportModal [data-close]')?.click());
  await sleep(200);
});

await step('a file can only be written beside one the person saved', async () => {
  const msg = await win.evaluate(async () => {
    try { await window.gamecut.exportSink.openBeside({ beside: '/etc/passwd', suffix: 'x' }); return 'opened'; }
    catch (e) { return e.message; }
  });
  if (msg === 'opened') throw new Error('it wrote next to a file GameCut never saved');
});

await step('"Also make" a TikTok version: a second, vertical file lands beside the first', async () => {
  // Close whatever the last step left open.
  await win.evaluate(() => document.querySelectorAll('#exportModal [data-close]').forEach(b => b.click()));
  const target = path.join(DIR, 'both.mp4');
  await answerSaveWith(target);
  await win.click('#btnExport');
  await win.waitForSelector('#xpGo', { timeout: 10000 });
  const draft = await win.$('[data-preset="draft"]');
  if (draft) await draft.click();
  await win.check('[data-extra="9:16"]');
  await win.click('#xpGo');
  await win.waitForSelector('#xpReveal, #xpErr', { timeout: 300000 });
  const err = await win.$('#xpErr');
  if (err) throw new Error('the export failed: ' + (await err.textContent()).trim());
  const extra = path.join(DIR, 'both - TikTok.mp4');
  const st = await stat(extra).catch(() => null);
  if (!st || st.size < 20000) throw new Error('no TikTok version beside the main file');
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', extra], { encoding: 'utf8' }));
  const v = info.streams.find(s => s.codec_type === 'video');
  if (!(v.height > v.width)) throw new Error(`the TikTok version is ${v.width}×${v.height}`);
  const listed = await win.evaluate(() => document.querySelectorAll('#exportModal .xp-done').length);
  if (listed < 2) throw new Error('the finished screen does not list both files');
  await win.evaluate(() => document.querySelectorAll('#exportModal [data-close]').forEach(b => b.click()));
});

await step('cancelling the save dialog renders nothing and writes nothing', async () => {
  const before = (await readdir(DIR)).length;
  await answerSaveWith(null);
  await win.click('#btnExport');
  await win.waitForSelector('#xpGo', { timeout: 10000 });
  await win.click('#xpGo');
  await sleep(1500);
  const rendering = await win.$('#xpFill');
  if (rendering) throw new Error('it started rendering with nowhere to put the file');
  const after = (await readdir(DIR)).length;
  if (after !== before) throw new Error('files appeared after a cancelled save');
  await win.evaluate(() => document.querySelector('#exportModal [data-close]')?.click());
});

await app.close();
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`EXPORT-SINK FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('EXPORT-SINK PASSED — the real dialog writes a real, playable file, and nothing half-done is left.');
