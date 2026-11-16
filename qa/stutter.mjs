/**
 * Sound must play without stutters.
 *
 * A 30 s 440 Hz tone in an MP4 is imported through the real picker and
 * exported. A pure sine changes smoothly from sample to sample; a gap, a
 * repeated stretch or a jump between two decoded pieces shows as a spike in
 * the second difference far above what the tone (and AAC's own noise) makes.
 * Checked twice: the decoded sound the preview plays from, and the exported
 * file.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || '/tmp');
const PROFILE = `/tmp/gc-stutter-${process.pid}`;
const SRC = path.join(OUT, 'sine30.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=60', '-f', 'lavfi',
  '-i', 'sine=frequency=440:sample_rate=48000', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', SRC]);
const problems = [];
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};
/** Spikes in the second difference of a mono float signal, skipping the edges. */
const clicks = (x, sr) => {
  const out = [];
  for (let i = sr; i < x.length - sr; i++) {
    const d2 = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]);
    if (d2 > 0.03) { out.push((i / sr).toFixed(3)); i += sr / 20; }
  }
  return out;
};

console.log('\n── sound without stutters ───────────────');
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.click('#homeNew'); await sleep(1000);
await win.setInputFiles('#filePicker', [SRC]);
for (let i = 0; i < 80; i++) {
  const ok = await win.evaluate(() => window.gc.assets.all().some(a => a.peaks?.buffer));
  if (ok) break;
  await sleep(300);
}

await step('the decoded sound (what the preview plays) is continuous', async () => {
  const r = await win.evaluate(async () => {
    const { readerOf } = await import('app://gamecut/src/audio/pcm.js');
    const a = window.gc.assets.all().find(x => x.peaks?.buffer);
    const src = readerOf(a.peaks.buffer);
    const n = src.length, L = new Float32Array(n), R = new Float32Array(n);
    src.read(0, n, L, R);
    const sr = src.sampleRate, out = [];
    for (let i = sr; i < n - sr; i++) {
      const d2 = Math.abs(L[i] - 2 * L[i - 1] + L[i - 2]);
      if (d2 > 0.03) { out.push((i / sr).toFixed(3)); i += sr / 20; }
    }
    let peak = 0; for (let i = 0; i < n; i += 7) peak = Math.max(peak, Math.abs(L[i]));
    return { kind: a.peaks.buffer.constructor.name, sr, secs: n / sr, out, peak };
  });
  console.log(`     ${r.kind} ${r.sr} Hz, ${r.secs.toFixed(2)} s, peak ${r.peak.toFixed(2)}, ${r.out.length} clicks`);
  if (r.peak < 0.1) throw new Error('no sound decoded');
  if (r.out.length) throw new Error(`${r.out.length} jumps in the decoded sound at ${r.out.slice(0, 8).join(', ')} s`);
});

await step('the exported file is continuous', async () => {
  const b64 = await win.evaluate(async () => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    const bytes = await renderToMp4({ store: window.gc.store, width: 320, height: 180, fps: 30,
      vBitrate: 1_000_000, aBitrate: 192_000, onProgress: () => {}, shouldCancel: () => false });
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const file = path.join(OUT, 'stutter-export.mp4'), raw = path.join(OUT, 'stutter-export.f32');
  await writeFile(file, Buffer.from(b64, 'base64'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', raw]);
  const buf = await readFile(raw);
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const c = clicks(x, 48000);
  console.log(`     ${(x.length / 48000).toFixed(2)} s exported, ${c.length} clicks`);
  if (x.length / 48000 < 29) throw new Error(`only ${(x.length / 48000).toFixed(1)} s of sound`);
  if (c.length) throw new Error(`${c.length} jumps in the exported sound at ${c.slice(0, 8).join(', ')} s`);
});

await app.close();
await rm(PROFILE, { recursive: true, force: true });
console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`STUTTER FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('STUTTER PASSED — decoded and exported sound is continuous.');
