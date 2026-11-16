/**
 * Media in, video out — through the front door, with the files people really have.
 *
 * Every earlier export check used a five-second, half-megabyte fixture and
 * called renderToMp4 directly. That skipped everything that broke for real:
 * a 60 fps Medal/OBS recording is hundreds of megabytes, which crossed the
 * importer's 400 MB decode cap, so its sound was never decoded and every export
 * of it was SILENT — and no test noticed, because no test had a big file.
 *
 * So this suite makes realistic files with ffmpeg (a >400 MiB high-bitrate
 * H.264 + AAC recording with a tone on it, an OBS-style multi-track recording,
 * a live WebM with no duration, HEVC, MKV, AC-3, a long MP3, a font), imports
 * them through the file picker, puts them on the timeline with the media
 * pool's own + button, exports through the real Export dialog, and checks what
 * came out with ffprobe/ffmpeg: is there a sound stream, is the tone in it, is
 * the second track in it.
 *
 * The save step goes through a stand-in for window.gamecut.exportSink that
 * writes a real file on this machine at the positions it is given — the same
 * contract the desktop bridge implements — so streaming, failures and
 * cancelling the save dialog can all be exercised without a native dialog.
 *
 *   xvfb-run -a node qa/media-io.mjs qa/out
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, mkdir, copyFile, open as fsOpen, rename, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { waitFor as pollFor } from './wait.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || '/tmp');
const FX = path.join(OUT, 'media-io-fixtures');
const PROFILE = `/tmp/gc-mediaio-${process.pid}`;
const problems = [];
/**
 * Each step starts from a closed dialog, so one failure cannot make the next
 * step fail for an unrelated reason (a modal left open blocks every click).
 */
let win = null;
const resetUi = () => win?.evaluate(() => {
  const m = document.getElementById('exportModal');
  if (m && !m.hidden) m.querySelector('.modal__actions [data-close]')?.click();
  if (m && !m.hidden && !window.gc.store.rt.exporting) m.hidden = true;
}).catch(() => {});
const step = async (name, fn) => {
  const before = problems.length;
  await resetUi();
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

/* ── Fixtures ─────────────────────────────────────────────────── */
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const fx = (n) => path.join(FX, n);

async function makeFixtures() {
  await mkdir(FX, { recursive: true });
  const sine = (f, extra = '') => ['-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=48000${extra}`];
  const pic = (s = '640x360', r = 30) => ['-f', 'lavfi', '-i', `testsrc2=size=${s}:rate=${r}`];

  // A recording as Medal/OBS make them: 60 fps, very high bitrate, sound on
  // it, index (moov) at the END. Picture noise so it really is >400 MiB.
  if (!existsSync(fx('big.mp4'))) {
    console.log('     making a >400 MiB recording (once)…');
    ff(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '640x360', '-r', '60', '-i', '/dev/urandom',
        ...sine(440), '-t', '24', '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '1', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', fx('big.mp4')]);
  }
  // OBS with game and microphone on separate tracks: 440 Hz on track 1,
  // 1000 Hz on track 2.
  if (!existsSync(fx('multitrack.mp4'))) {
    ff([...pic(), ...sine(440), ...sine(1000), '-t', '6', '-map', '0:v', '-map', '1:a', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k',
        '-ac:a:0', '2', '-ac:a:1', '1', fx('multitrack.mp4')]);
  }
  // A WebM written live: no duration in the header.
  if (!existsSync(fx('live.webm'))) {
    ff([...pic(), ...sine(440), '-t', '6', '-c:v', 'libvpx', '-b:v', '500k', '-c:a', 'libopus',
        '-live', '1', '-f', 'webm', fx('live.webm')]);
  }
  if (!existsSync(fx('hevc.mp4'))) {
    ff([...pic(), ...sine(440), '-t', '4', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1',
        '-c:a', 'aac', fx('hevc.mp4')]);
  }
  // An MKV this browser cannot show (MPEG-4 Part 2 video).
  if (!existsSync(fx('asp.mkv'))) {
    ff([...pic(), ...sine(440), '-t', '4', '-c:v', 'mpeg4', '-c:a', 'aac', fx('asp.mkv')]);
  }
  // OBS's default container with ordinary H.264 + AAC.
  if (!existsSync(fx('obs.mkv'))) {
    ff([...pic(), ...sine(440), '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', fx('obs.mkv')]);
  }
  // An 11-minute MKV: past what can be decoded whole, and not an MP4.
  if (!existsSync(fx('long.mkv'))) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5', ...sine(440), '-t', '660',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', fx('long.mkv')]);
  }
  // An MP4 whose sound is AC-3 — there is sound, this computer can't read it.
  if (!existsSync(fx('ac3.mp4'))) {
    ff([...pic(), ...sine(440), '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'ac3', fx('ac3.mp4')]);
  }
  // An 11-minute MP3: the preview plays it off an <audio> element.
  if (!existsSync(fx('long.mp3'))) {
    ff([...sine(440), '-t', '660', '-c:a', 'libmp3lame', '-b:a', '32k', '-ac', '1', fx('long.mp3')]);
  }
  if (!existsSync(fx('GCTestFont.ttf'))) {
    const fonts = ['/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf',
                   '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
    const f = fonts.find(existsSync);
    if (f) await copyFile(f, fx('GCTestFont.ttf'));
  }
}

/** Mean level (dB) of the sound around one frequency, from ffmpeg's volumedetect. */
function levelAt(file, freq) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:a:0',
    '-af', `bandpass=f=${freq}:width_type=q:w=8,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr || ''));
  return m ? Number(m[1]) : -200;
}

function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file], { encoding: 'utf8' }));
}

/* ── The app ──────────────────────────────────────────────────── */
console.log('\n── media in, video out ──────────────────');
await makeFixtures();
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
win = await app.firstWindow();
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
win.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.waitForSelector('#homeNew'); await win.click('#homeNew');
await pollFor(win, () => !document.getElementById('app').classList.contains('is-home'), null, { timeout: 20000 });
await sleep(800);

/**
 * The stand-in save bridge: the exportSink contract, implemented on this
 * machine's disk. `mode` decides how the next export's save goes.
 */
const sinkState = { mode: 'ok', files: new Map(), writes: 0, seq: 0, last: null, aborted: 0 };
await win.exposeFunction('__qaSinkOpen', async () => {
  if (sinkState.mode === 'cancel') return null;
  const p = path.join(OUT, `media-io-export-${++sinkState.seq}.mp4`);
  const fh = await fsOpen(`${p}.partial`, 'w');
  const token = `t${sinkState.seq}`;
  sinkState.files.set(token, { fh, path: p, bytes: 0 });
  sinkState.writes = 0;
  return { token, path: p };
});
await win.exposeFunction('__qaSinkWrite', async (token, b64, position) => {
  const f = sinkState.files.get(token);
  if (!f) throw new Error('unknown token');
  sinkState.writes++;
  if (sinkState.mode === 'disk-full' && sinkState.writes >= 2) throw new Error('The disk is full');
  const buf = Buffer.from(b64, 'base64');
  await f.fh.write(buf, 0, buf.length, position);
  f.bytes = Math.max(f.bytes, position + buf.length);
  return true;
});
await win.exposeFunction('__qaSinkClose', async (token) => {
  const f = sinkState.files.get(token);
  await f.fh.sync(); await f.fh.close();
  await rename(`${f.path}.partial`, f.path);
  sinkState.files.delete(token);
  sinkState.last = f.path;
  return { ok: true, path: f.path, bytes: f.bytes };
});
await win.exposeFunction('__qaSinkAbort', async (token) => {
  const f = sinkState.files.get(token);
  if (!f) return;
  sinkState.aborted++;
  try { await f.fh.close(); } catch { /* closed */ }
  await unlink(`${f.path}.partial`).catch(() => {});
  sinkState.files.delete(token);
});

await win.evaluate(async () => {
  const { bus } = await import('app://gamecut/src/core/events.js');
  window.__toasts = [];
  bus.on('toast', t => window.__toasts.push(t.msg));
  const dlg = await import('app://gamecut/src/export/export-dialog.js');
  window.__writeLog = [];
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  dlg.__setExportSinkForTest({
    open: (o) => window.__qaSinkOpen(o),
    write: (t, chunk, pos) => {
      window.__writeLog.push({ pct: document.getElementById('xpPct')?.textContent || null, n: chunk.byteLength });
      return window.__qaSinkWrite(t, b64(chunk), pos);
    },
    close: (t) => window.__qaSinkClose(t),
    abort: (t) => window.__qaSinkAbort(t),
  });
});

const clearTimeline = () => win.evaluate(() => {
  const { store, cmds } = window.gc;
  store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
  if (store.rt.selection.length) cmds.removeSelected();
  window.gc.playback.seek(0);
});
const toasts = () => win.evaluate(() => window.__toasts.slice());
const assetInfo = (name) => win.evaluate((n) => {
  const a = window.gc.assets.all().find(x => x.name === n);
  return a ? { id: a.id, kind: a.kind, duration: a.duration, w: a.width, h: a.height,
    peaks: !!a.peaks?.buffer, audioState: a.audioState ?? null, hasAudio: a.hasAudio ?? null,
    streamAudio: !!a.streamAudio, url: a.url, path: a.path, missing: !!a.missing,
    family: a.family || null, tracks: a.audioTracks || 0 } : null;
}, name);
async function importFiles(files) {
  await win.evaluate(() => { window.__toasts.length = 0; });
  await win.setInputFiles('#filePicker', files);
}
async function waitFor(fn, what, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
/** Put an asset on the timeline the way a person does: the pool's + button. */
async function addToTimeline(name) {
  const a = await waitFor(() => assetInfo(name), `${name} in the media pool`);
  // The first import into an empty project now places itself on the timeline
  // (pool-panel startTimeline). These steps each want exactly the one clip they
  // add, so let that land and take it off again — otherwise a 12-minute fixture
  // imported alongside rides into a two-second export.
  await sleep(600);
  await clearTimeline();
  await win.click('#leftTabs [data-tab="media"]').catch(() => {});
  // Double-click the tile — the pool's own "put it on the timeline" gesture
  // (the + button only shows on hover).
  const sel = `.asset[data-asset="${a.id}"]`;
  await win.waitForSelector(sel, { timeout: 10000 });
  await win.dblclick(`${sel} .asset__name`);
  await sleep(300);
  return a;
}
/** Close the dialog with its own visible Cancel / Done / Close button. */
const closeDialog = () => win.click('#exportModal .modal__actions [data-close]');

/** Keep the export short: only the first `secs` of every clip. */
const trimTo = (secs) => win.evaluate((s) => {
  const { store } = window.gc;
  for (const t of store.doc.tracks) for (const c of t.clips) c.duration = Math.min(c.duration, s);
  store.docChanged?.('test trim'); store.recompute?.(); store.emit('doc', {});
}, secs);

/** Open the dialog, choose a small custom export, press Export. */
async function startExport({ scale = '0.5', fps = '30', rate = '3' } = {}) {
  await win.click('#btnExport');
  await win.waitForSelector('#xpList', { timeout: 10000 });
  await win.click('[data-preset="custom"]');
  await win.selectOption('#xpScale', scale);
  await win.selectOption('#xpFps', fps);
  await win.fill('#xpRate', rate);
  await win.click('#xpGo');
}
async function waitExportDone(ms = 240000) {
  await win.waitForSelector('#exportModal .modal__panel--ok, #exportModal #xpErr', { timeout: ms });
  const err = await win.$('#exportModal #xpErr');
  if (err) throw new Error('export failed: ' + await err.textContent());
  const file = sinkState.last;
  await closeDialog();
  return file;
}

/* ── X1/X2/X14: big recordings, queued sound, and waiting for it ── */
await step('sound is decoded one file at a time, and Export waits for it', async () => {
  await clearTimeline();
  // A 12.5-minute clip first, so the next file's sound is queued behind it.
  await importFiles([`${ROOT}/qa/fixtures/long-clip.mp4`, fx('multitrack.mp4')]);
  const started = new Set();
  let maxConcurrent = 0;
  const watch = (async () => {
    for (let i = 0; i < 400; i++) {
      const p = await win.evaluate(async () =>
        (await import('app://gamecut/src/media/audio-jobs.js')).pendingAudio());
      const running = p.filter(j => j.started);
      maxConcurrent = Math.max(maxConcurrent, running.length);
      running.forEach(j => started.add(j.name));
      if (!p.length && i > 4) break;
      await sleep(50);
    }
  })();
  await addToTimeline('multitrack.mp4');
  await win.click('#btnExport');
  await win.waitForSelector('#xpGo', { timeout: 10000 });
  sinkState.mode = 'ok';
  await win.click('[data-preset="custom"]');
  await win.selectOption('#xpScale', '0.5');
  await win.selectOption('#xpFps', '30');
  await win.click('#xpGo');
  const waited = await win.waitForSelector('[aria-label="Preparing sound"]', { timeout: 4000 })
    .then(() => true).catch(() => false);
  const label = waited ? await win.textContent('#xpSoundCount') : '';
  await watch;
  if (maxConcurrent > 1) throw new Error(`${maxConcurrent} sound decodes ran at once — they should queue`);
  if (!waited) throw new Error('Export did not wait for the sound still being prepared');
  const file = await waitExportDone();
  const info = probe(file);
  if (!info.streams.some(s => s.codec_type === 'audio')) throw new Error('the export has no audio stream');
  console.log(`     waited ("${label}"), at most ${maxConcurrent} decode at a time, file has sound`);
});

// Two separate sounds on two tracks (game on 1, mic on 2, as Medal does): both
// are kept. (A track that is already inside track 1, as OBS does, is left out:
// see qa/strike.mjs.)
await step('X9: a recording with separate sounds on its tracks exports all of them', async () => {
  const a = await assetInfo('multitrack.mp4');
  if (a.tracks !== 2) throw new Error(`asset says ${a.tracks} sound tracks were mixed, expected 2`);
  const file = sinkState.last;
  const t1 = levelAt(file, 440), t2 = levelAt(file, 1000);
  if (t1 < -40) throw new Error(`track 1's 440 Hz tone is missing (${t1} dB)`);
  if (t2 < -40) throw new Error(`track 2's 1000 Hz tone is missing (${t2} dB) — only the first track was used`);
  console.log(`     440 Hz ${t1} dB, 1000 Hz ${t2} dB`);
});

await step('X1: a >400 MiB 60 fps recording exports WITH its sound', async () => {
  const size = (await stat(fx('big.mp4'))).size;
  if (size < 400 * 1024 * 1024) throw new Error(`fixture is only ${(size / 2 ** 20).toFixed(0)} MiB`);
  await clearTimeline();
  await importFiles([fx('big.mp4')]);
  await waitFor(async () => (await assetInfo('big.mp4'))?.audioState === 'ready'
    || (await assetInfo('big.mp4'))?.audioState === 'stream', 'big.mp4 sound', 90000);
  const a = await assetInfo('big.mp4');
  if (!a.peaks || a.streamAudio) throw new Error(`big.mp4 sound was not decoded (state ${a.audioState})`);
  await addToTimeline('big.mp4');
  await trimTo(12);
  await win.evaluate(() => { window.__writeLog.length = 0; });
  // A high figure on noise footage, so the file is big enough (tens of MB)
  // that streaming it shows: it is written in 8 MB pieces as it is made.
  await startExport({ rate: '40' });
  const file = await waitExportDone();
  const info = probe(file);
  const aud = info.streams.find(s => s.codec_type === 'audio');
  if (!aud) throw new Error('the export of the big recording has no audio stream');
  const lvl = levelAt(file, 440);
  if (lvl < -35) throw new Error(`the 440 Hz tone is missing from the export (${lvl} dB)`);
  console.log(`     ${(size / 2 ** 20).toFixed(0)} MiB in → ${aud.codec_name} sound out, tone at ${lvl} dB`);
});

/**
 * Reopening a project: the function library.js is to call for each asset.
 *
 * Done the way the library will do it — load the saved project through the
 * bridge, rebuild the asset from its record, call restoreAssetAudio — and
 * every gcmedia:// read is counted, because the old reopen path fetched the
 * WHOLE file to decode it (a multi-GB recording, straight into memory).
 */
await step('X1: reopening restores a big recording\'s sound from a few MB of reads', async () => {
  const r = await win.evaluate(async () => {
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    const { restoreAssetAudio } = await import('app://gamecut/src/media/importer.js');
    const { library } = window.gc;
    await library.save({ silent: true });
    const loaded = await window.gamecut.loadProject(library.id);
    const rec = loaded.project.assets.find(a => a.name === 'big.mp4');
    let read = 0;
    const realFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await realFetch(...args);
      if (String(args[0]).startsWith('gcmedia:')) read += Number(res.headers.get('Content-Length') || 0);
      return res;
    };
    try {
      const a = assets.add({ ...rec, id: rec.id + '-reopened', file: null, peaks: null,
                             url: `gcmedia://${rec.mediaId}` });
      const p = restoreAssetAudio(a);
      const pendingAtOnce = a.audioState === 'pending';
      await p;
      const back = assets.get(a.id);
      const out = { pendingAtOnce, state: back.audioState, kind: back.peaks?.buffer?.constructor?.name,
                    seconds: back.peaks?.buffer?.duration || 0, read, size: rec.bytes };
      assets.remove(a.id);
      return out;
    } finally { window.fetch = realFetch; }
  });
  if (!r.pendingAtOnce) throw new Error('restoreAssetAudio did not mark the asset pending straight away');
  if (r.state !== 'ready' || r.kind !== 'PcmStore') throw new Error(`sound not restored: ${r.state} / ${r.kind}`);
  if (Math.abs(r.seconds - 24) > 0.5) throw new Error(`restored ${r.seconds}s of sound, expected 24`);
  if (r.read > 20 * 1024 * 1024) {
    throw new Error(`read ${(r.read / 2 ** 20).toFixed(0)} MiB of a ${(r.size / 2 ** 20).toFixed(0)} MiB file to get its sound`);
  }
  console.log(`     ${(r.read / 2 ** 20).toFixed(1)} MiB read of ${(r.size / 2 ** 20).toFixed(0)} MiB`);
});

await step('X4: the file is written to disk while it renders, never held whole', async () => {
  const log = await win.evaluate(() => window.__writeLog.slice());
  if (!log.length) throw new Error('nothing went through the save bridge');
  const during = log.filter(w => w.pct && w.pct !== '100%');
  if (!during.length) throw new Error('every write happened after the render finished');
  const biggest = Math.max(...log.map(w => w.n));
  if (biggest > 16 * 1024 * 1024) throw new Error(`a single write was ${biggest} bytes — the file is being buffered`);
  const info = probe(sinkState.last);
  if (!info.streams.some(s => s.codec_type === 'video')) throw new Error('streamed file has no video');
  console.log(`     ${log.length} writes, ${during.length} while rendering, largest ${(biggest / 2 ** 20).toFixed(1)} MiB`);
});

await step('X5: a full disk stops the export early, in plain words, with nothing left behind', async () => {
  sinkState.mode = 'disk-full';
  sinkState.aborted = 0;
  await win.evaluate(() => { window.__writeLog.length = 0; });
  await startExport({ rate: '40' });
  await win.waitForSelector('#exportModal #xpErr', { timeout: 120000 });
  const r = await win.evaluate(() => ({
    title: document.querySelector('#exportModal .modal__head b')?.textContent,
    err: document.getElementById('xpErr')?.textContent,
    hint: document.getElementById('xpErrHint')?.textContent,
  }));
  if (!/disk is full/i.test(r.err)) throw new Error(`the error does not say the disk is full: "${r.err}"`);
  if (/720p|resolution|draft/i.test(r.hint)) throw new Error(`a save failure was blamed on resolution: "${r.hint}"`);
  if (!sinkState.aborted) throw new Error('the half-written file was not aborted');
  const leftovers = (await import('node:fs')).readdirSync(OUT).filter(f => f.endsWith('.partial'));
  if (leftovers.length) throw new Error('a .partial file was left behind: ' + leftovers.join(', '));
  await win.click('#xpRetry');
  await win.waitForSelector('#xpList', { timeout: 5000 });
  await closeDialog();
  sinkState.mode = 'ok';
  console.log(`     "${r.title}": ${r.err.trim()}`);
});

await step('X5: cancelling the save dialog renders nothing and goes back to the choices', async () => {
  sinkState.mode = 'cancel';
  await win.evaluate(() => { window.__writeLog.length = 0; });
  await startExport();
  await win.waitForSelector('#xpList', { timeout: 10000 });
  const r = await win.evaluate(() => ({
    progress: !!document.getElementById('xpFill'), writes: window.__writeLog.length,
    exporting: !!window.gc.store.rt.exporting,
  }));
  if (r.progress) throw new Error('a render started even though no save location was chosen');
  if (r.exporting) throw new Error('the editor still thinks it is exporting');
  await closeDialog();
  sinkState.mode = 'ok';
});

/* ── X13: no sound vs sound we can't read ───────────────────── */
await step('X13: a video with no sound track is "no sound", not "streamed" or "can\'t decode"', async () => {
  await clearTimeline();
  await importFiles([`${ROOT}/qa/fixtures/hd1080p60.mp4`]);
  await waitFor(async () => (await assetInfo('hd1080p60.mp4'))?.audioState, 'hd1080p60 state');
  const a = await waitFor(async () => {
    const x = await assetInfo('hd1080p60.mp4');
    return x && x.audioState !== 'pending' ? x : null;
  }, 'hd1080p60 sound check');
  if (a.hasAudio !== false) throw new Error(`hasAudio is ${a.hasAudio}, expected false`);
  if (a.streamAudio) throw new Error('a silent video is flagged streamAudio (offered "Extract audio")');
  await addToTimeline('hd1080p60.mp4');
  await win.click('#btnExport');
  await win.waitForSelector('#xpList');
  const warns = await win.textContent('#xpWarns');
  if (/sound/i.test(warns)) throw new Error('the dialog warns about sound for a clip that has none: ' + warns.trim());
  await closeDialog();
});

await step('X13: sound in a format this computer can\'t read is named as such', async () => {
  await clearTimeline();
  await importFiles([fx('ac3.mp4')]);
  const a = await waitFor(async () => {
    const x = await assetInfo('ac3.mp4');
    return x && x.audioState && x.audioState !== 'pending' ? x : null;
  }, 'ac3.mp4 sound check');
  if (a.audioState !== 'unreadable') throw new Error(`state is ${a.audioState}, expected unreadable`);
  await addToTimeline('ac3.mp4');
  await win.click('#btnExport');
  await win.waitForSelector('#xpList');
  const warns = await win.textContent('#xpWarns');
  if (!/can't read/i.test(warns) || !/ac3\.mp4/.test(warns)) throw new Error('no "can\'t read its sound" warning: ' + warns.trim());
  if (/long|too long/i.test(warns)) throw new Error('blamed on length: ' + warns.trim());
  await closeDialog();
});

/* ── X6: no duration in the header ──────────────────────────── */
await step('X6: a WebM with no duration gets its real length, never Infinity', async () => {
  await clearTimeline();
  await importFiles([fx('live.webm')]);
  const a = await waitFor(() => assetInfo('live.webm'), 'live.webm');
  if (!Number.isFinite(a.duration) || Math.abs(a.duration - 6) > 0.6) throw new Error(`duration is ${a.duration}`);
  await addToTimeline('live.webm');
  const d = await win.evaluate(() => window.gc.store.rt.duration);
  if (!Number.isFinite(d)) throw new Error(`the timeline is ${d} long`);
  await win.click('#btnExport');
  await win.waitForSelector('#xpList');
  const text = await win.textContent('#exportModal');
  if (/Infinity|NaN/.test(text)) throw new Error('the dialog shows Infinity/NaN');
  const t = (await toasts()).join(' | ');
  if (/Infinity|NaN/.test(t)) throw new Error('a toast said ' + t);
  await closeDialog();
});

/* ── X8 / X10: footage this computer can't show ─────────────── */
await step('X8: HEVC footage is refused with what to change in Medal/OBS', async () => {
  await importFiles([fx('hevc.mp4')]);
  const t = await waitFor(async () => (await toasts()).find(m => /hevc\.mp4/.test(m)), 'a message about hevc.mp4', 20000);
  if (!/HEVC/.test(t) || !/H\.264/.test(t)) throw new Error('message does not explain HEVC → H.264: ' + t);
  if (await assetInfo('hevc.mp4')) throw new Error('a black 0×0 clip was imported anyway');
});

await step('X10: an MKV the browser can\'t play explains OBS\'s Remux; a playable one just works', async () => {
  await importFiles([fx('asp.mkv')]);
  const t = await waitFor(async () => (await toasts()).find(m => /asp\.mkv/.test(m)), 'a message about asp.mkv', 20000);
  if (!/Remux Recordings/.test(t)) throw new Error('no Remux instructions: ' + t);
  await importFiles([fx('obs.mkv')]);
  const a = await waitFor(async () => {
    const x = await assetInfo('obs.mkv');
    return x && x.audioState && x.audioState !== 'pending' ? x : null;
  }, 'obs.mkv');
  if (!a.w || a.audioState !== 'ready') throw new Error(`obs.mkv: ${JSON.stringify(a)}`);
});

// 2.0.1: MKV sound is read straight out of the file however long it is, so a
// long OBS .mkv now plays in step and goes into the export like an MP4.
await step('X10: a long MKV\'s sound is read whole: ready, no warning, nothing missing in Export', async () => {
  await clearTimeline();
  await importFiles([fx('long.mkv')]);
  const a = await waitFor(async () => {
    const x = await assetInfo('long.mkv');
    return x && x.audioState && x.audioState !== 'pending' ? x : null;
  }, 'long.mkv');
  if (a.audioState !== 'ready') throw new Error(`state ${a.audioState}`);
  const t = (await toasts()).find(m => /long\.mkv/.test(m) && /export/i.test(m)) || '';
  if (t) throw new Error('still warns: ' + t);
  await addToTimeline('long.mkv');
  await win.click('#btnExport');
  await win.waitForSelector('#xpList');
  const warns = await win.textContent('#xpWarns');
  if (/no sound from long\.mkv/.test(warns)) throw new Error('dialog: ' + warns.trim());
  await closeDialog();
});

/* ── X7: preview gain = export gain ─────────────────────────── */
await step('X7: preview honours track volume under a fade, and ramps when started mid-fade', async () => {
  await clearTimeline();
  await importFiles([`${ROOT}/qa/fixtures/test-tone.mp3`]);
  await waitFor(async () => (await assetInfo('test-tone.mp3'))?.peaks, 'test-tone decoded');
  await addToTimeline('test-tone.mp3');
  const r = await win.evaluate(async () => {
    const { store, playback } = window.gc;
    const { gainPoints, gainAt } = await import('app://gamecut/src/audio/graph.js');
    const track = store.doc.tracks.find(t => t.clips.some(c => c.type === 'audio'));
    const clip = track.clips.find(c => c.type === 'audio');
    track.volume = 0.5; clip.volume = 0.8; clip.fadeOut = 2; clip.fadeIn = 0.3;
    store.emit('doc', {});
    const from = clip.start + clip.duration - 1.5;   // inside the fade-out
    playback.seek(from);
    await new Promise(r => setTimeout(r, 150));
    playback.play();
    const samples = [];
    const pts = gainPoints(clip, 0.8 * 0.5);
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 180));
      const g = playback.audio.gains.get(clip.id);
      const ctx = g.context;
      const t = playback.audio.startTime + (ctx.currentTime - playback.audio.startedAt);
      samples.push({ got: g.gain.value, want: gainAt(pts, t), t });
    }
    playback.pause();
    return samples;
  });
  const bad = r.filter(s => Math.abs(s.got - s.want) > 0.06);
  if (bad.length) throw new Error('preview gain off: ' + bad.map(s => `${s.got.toFixed(3)} vs ${s.want.toFixed(3)}`).join(', '));
  if (!(r[0].got > r[r.length - 1].got + 0.05)) throw new Error('no fade-out ramp when started inside the fade');
  console.log(`     ${r.map(s => s.got.toFixed(2)).join(' → ')}`);
});

/* ── X12: long streamed audio starts and stops on time ──────── */
await step('X12: a long streamed audio clip starts at its start and stops at its end', async () => {
  await clearTimeline();
  await importFiles([fx('long.mp3')]);
  await waitFor(async () => (await assetInfo('long.mp3'))?.audioState === 'stream', 'long.mp3 streamed');
  await addToTimeline('long.mp3');
  const r = await win.evaluate(async () => {
    const { store, playback } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'audio');
    clip.start = 1.2; clip.duration = 1.5; clip.inPoint = 30;
    store.recompute?.(); store.emit('doc', {});
    playback.seek(0);
    await new Promise(r => setTimeout(r, 150));
    playback.play();
    const at = async (ms) => { await new Promise(r => setTimeout(r, ms)); };
    const el = () => playback.audio.streamEls.get(clip.id);
    await at(600);
    const before = el() ? !el().paused : false;
    await at(1300);                       // ~1.9s: inside the clip
    const inside = { playing: el() && !el().paused, t: el()?.currentTime };
    await at(1500);                       // ~3.4s: past its end at 2.7
    const after = el() ? !el().paused : false;
    playback.pause();
    return { before, inside, after };
  });
  if (r.before) throw new Error('it started before its clip begins');
  if (!r.inside.playing) throw new Error('it never started — a clip later on the timeline stays silent');
  if (!(Math.abs(r.inside.t - 30.7) < 0.6)) throw new Error(`it is at ${r.inside.t?.toFixed(2)}s of the file, expected ~30.7`);
  if (r.after) throw new Error('it kept playing past the end of its clip');
});

/* ── X3: offline clips are named before rendering ───────────── */
await step('X3: a clip whose file was deleted is named before rendering', async () => {
  await clearTimeline();
  const moved = path.join(FX, 'will-be-deleted.mp4');
  await copyFile(`${ROOT}/qa/fixtures/test-clip.mp4`, moved);
  await importFiles([moved]);
  await addToTimeline('will-be-deleted.mp4');
  const id = await win.evaluate(async () => {
    await window.gc.library.save({ silent: true });
    return window.gc.library.id;
  });
  await unlink(moved);
  await win.evaluate(async (pid) => { await window.gc.library.open(pid); }, id);
  await sleep(500);
  await win.click('#btnExport');
  await win.waitForSelector('#xpList');
  const warns = await win.textContent('#xpWarns');
  if (!/will-be-deleted\.mp4/.test(warns) || !/missing|moved or deleted/i.test(warns)) {
    throw new Error('the offline clip is not named: ' + warns.trim());
  }
  await closeDialog();
});

/* ── X11: fonts survive a reopen ────────────────────────────── */
await step('X11: a custom font has a path and url, and comes back on reopen', async () => {
  if (!existsSync(fx('GCTestFont.ttf'))) throw new Error('no font fixture on this machine');
  await importFiles([fx('GCTestFont.ttf')]);
  const a = await waitFor(() => assetInfo('GCTestFont.ttf'), 'font asset');
  if (!a.path || !/^gcmedia:/.test(a.url || '')) throw new Error(`font asset has path ${a.path}, url ${a.url}`);
  const id = await win.evaluate(async () => { await window.gc.library.save({ silent: true }); return window.gc.library.id; });
  await win.evaluate(async (pid) => { await window.gc.library.open(pid); }, id);
  const back = await assetInfo('GCTestFont.ttf');
  if (!back || back.missing) throw new Error('the font is reported missing after reopening');
  const ok = await win.evaluate(async ({ url }) => {
    const { registerFontUrl, fontList } = await import('app://gamecut/src/media/fonts.js');
    const fam = await registerFontUrl(url, 'GC Reopened Font');
    return { fam, listed: fontList().includes('GC Reopened Font'),
             check: document.fonts.check('16px "GC Reopened Font"') };
  }, { url: back.url });
  if (ok.fam !== 'GC Reopened Font' || !ok.listed || !ok.check) throw new Error('registerFontUrl did not load it: ' + JSON.stringify(ok));
});

/* ── X15 / Q1 / Q2: the dialog itself ───────────────────────── */
await step('X15: the Sound list offers only bitrates this computer\'s encoder takes', async () => {
  await clearTimeline();
  await addToTimeline('obs.mkv');
  await win.click('#btnExport');
  await win.waitForSelector('#xpList');
  await win.click('[data-preset="custom"]');
  const r = await win.evaluate(async () => {
    const offered = [...document.querySelectorAll('#xpARate option')].map(o => Number(o.value));
    const ok = [];
    for (const codec of ['mp4a.40.2', 'opus']) {
      const rates = [];
      for (const b of [96000, 128000, 160000, 192000, 256000, 320000]) {
        try { if ((await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: b })).supported) rates.push(b); } catch {}
      }
      if (rates.length) { ok.push(...rates); break; }
    }
    return { offered, ok };
  });
  if (JSON.stringify(r.offered) !== JSON.stringify(r.ok)) throw new Error(`offered ${r.offered} but the encoder takes ${r.ok}`);
  await closeDialog();
});

await step('Q1/Q2: frame-exact sits under Advanced; the last choice is remembered per shape', async () => {
  await win.click('#btnExport');
  await win.waitForSelector('#xpList');
  const r = await win.evaluate(() => ({
    inAdvanced: !!document.querySelector('details#xpAdvanced #xpExact'),
    open: document.getElementById('xpAdvanced')?.open,
  }));
  if (!r.inAdvanced) throw new Error('frame-exact is not under an Advanced disclosure');
  if (r.open) throw new Error('Advanced should start closed');
  sinkState.mode = 'cancel';
  await win.click('[data-preset="draft"]');
  await win.click('#xpGo');                 // save dialog "cancelled" — choice still remembered
  await win.waitForSelector('#xpList');
  await closeDialog();
  await win.click('#btnExport');
  await win.waitForSelector('#xpList');
  const on = await win.getAttribute('.xp.is-on', 'data-preset');
  if (on !== 'draft') throw new Error(`reopened on ${on}, not the Quick draft chosen last time`);
  await closeDialog();
  sinkState.mode = 'ok';
});

await step('Q1: a vertical project\'s finished export offers Upload to TikTok', async () => {
  await win.click('#aspectSeg [data-ar="9:16"]');
  await sleep(300);
  const r = await win.evaluate(async () => {
    const mod = await import('app://gamecut/src/export/export-dialog.js');
    document.getElementById('exportModal').hidden = false;
    mod.__paintDoneForTest('/tmp/clip.mp4', 1234567);
    const root = document.getElementById('exportModal');
    return { tiktok: root.querySelector('#xpTikTok')?.textContent.trim(), yt: !!root.querySelector('#xpYouTube') };
  });
  if (!/TikTok/.test(r.tiktok || '')) throw new Error('no Upload to TikTok on a vertical project');
  await closeDialog();
  await win.click('#aspectSeg [data-ar="16:9"]');
});

await win.screenshot({ path: `${OUT}/media-io.png` });
await app.close();
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`MEDIA-IO FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('MEDIA-IO PASSED — big recordings keep their sound, and exports land on disk.');
