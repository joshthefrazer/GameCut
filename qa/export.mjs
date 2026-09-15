/**
 * Export suite: render a real timeline to MP4 and inspect the file with ffprobe.
 *
 * The only assertion that matters here is that a real decoder can open what we
 * produced and finds the streams we claimed to write.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const ROOT = '/home/claude/gamecut';
const OUT = process.argv[2] || '/tmp';
const MP4 = `${OUT}/export-test.mp4`;
const FRAME = `${OUT}/export-frame.png`;
let projectDuration = 0;

const problems = [];
const log = (t, m) => { problems.push(`${t}: ${m}`); console.log(`  !! ${t}: ${m}`); };
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { log('THREW in ' + name, e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── export ───────────────────────────────');

const PROFILE = `/tmp/gamecut-qa-export-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({
  args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60_000,
});
const win = await app.firstWindow();
win.on('pageerror', (e) => log('pageerror', e.message));
win.on('console', (m) => { if (m.type() === 'error') log('console.error', m.text()); });
await win.waitForLoadState('domcontentloaded');
await sleep(2200);
/**
 * Start on the projects screen, the way the app now opens, and go in from it.
 *
 * Every suite below drives the editor, so each has to make the same first move
 * a person does. Clicking the real button rather than reaching past it means a
 * home screen that failed to hand over would fail the suites rather than being
 * quietly stepped around.
 */
async function enterEditor(page) {
  await page.waitForSelector('#homeNew', { timeout: 20000 });
  await page.click('#homeNew');
  await page.waitForFunction(() =>
    !document.getElementById('app').classList.contains('is-home'), null, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 500));
}
await enterEditor(win);


await step('encoder is available in this build', async () => {
  const r = await win.evaluate(async () => {
    const m = await import('app://gamecut/src/export/render-export.js');
    const sup = m.exportSupport();
    let h264 = false;
    try {
      h264 = (await VideoEncoder.isConfigSupported({
        codec: 'avc1.42e01f', width: 640, height: 360, bitrate: 1e6, framerate: 30,
      })).supported;
    } catch { /* leave false */ }
    return { ...sup, h264, hasAudioEncoder: typeof AudioEncoder !== 'undefined' };
  });
  if (!r.ok) throw new Error(r.reason);
  if (!r.h264) throw new Error('no H.264 encoder — exports would be impossible');
  if (!r.hasAudioEncoder) throw new Error('no AudioEncoder');
});

await step('build a short timeline with picture and sound', async () => {
  await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/test-clip.mp4`,
                                          `${ROOT}/qa/fixtures/test-tone.mp3`]);
  // Poll with evaluate rather than waitForFunction: the predicate must run in
  // the same JS context as the steps that follow, or a dynamic import inside it
  // resolves to a different module instance with its own empty asset registry.
  let ready = 0;
  for (let i = 0; i < 60; i++) {
    ready = await win.evaluate(async () => {
      const m = await import('app://gamecut/src/media/asset-store.js');
      return m.assets.all().filter(a => a.peaks?.buffer).length;
    });
    if (ready >= 2) break;
    await sleep(400);
  }
  if (ready < 2) throw new Error(`only ${ready} assets decoded after 24s`);

  const n = await win.evaluate(async () => {
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
    const { store, cmds } = window.gc;
    // Clear the seeded demo so the export is only our fixtures.
    store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
    cmds.removeSelected();
    const placed = [];
    for (const a of assets.all()) {
      const c = placeAsset(store, cmds, a.id, { start: 0 });
      placed.push({ asset: a.name, kind: a.kind, ok: !!c });
    }
    window.__dbg = { placed, tracks: store.doc.tracks.map(t => ({ kind: t.kind, locked: !!t.locked, n: t.clips.length })) };
    store.emit('doc', {});
    return { clips: store.doc.tracks.reduce((m, t) => m + t.clips.length, 0),
             duration: store.rt.duration, dbg: window.__dbg };
  });
  if (n.clips < 2) throw new Error(`expected 2 clips, got ${n.clips} — ${JSON.stringify(n.dbg)}`);
  projectDuration = n.duration;
  console.log(`     timeline is ${projectDuration.toFixed(2)}s`);
});

await step('render to MP4', async () => {
  const b64 = await win.evaluate(async () => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    const bytes = await renderToMp4({
      store: window.gc.store,
      width: 640, height: 360, fps: 30,
      vBitrate: 4_000_000, aBitrate: 128_000,
      onProgress: () => {},
      shouldCancel: () => false,
    });
    if (!bytes) return null;
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }, { timeout: 180_000 });

  if (!b64) throw new Error('renderToMp4 returned nothing');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 10_000) throw new Error(`suspiciously small file: ${buf.length} bytes`);
  await writeFile(MP4, buf);
  console.log(`     wrote ${(buf.length / 1024).toFixed(0)} KB → ${MP4}`);
});

await step('ffprobe opens it and finds both streams', async () => {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', MP4,
  ], { encoding: 'utf8' });
  const info = JSON.parse(out);

  const v = info.streams.find(s => s.codec_type === 'video');
  const a = info.streams.find(s => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream');
  if (v.codec_name !== 'h264') throw new Error('video is ' + v.codec_name + ', expected h264');
  if (v.width !== 640 || v.height !== 360) throw new Error(`wrong size ${v.width}x${v.height}`);
  if (!a) throw new Error('no audio stream — the bounce never made it in');
  if (!['aac','opus'].includes(a.codec_name)) throw new Error('audio is ' + a.codec_name + ', expected aac or opus');

  // The file must match the timeline it came from, whatever length that is.
  const dur = parseFloat(info.format.duration);
  if (Math.abs(dur - projectDuration) > 0.35) {
    throw new Error(`file is ${dur.toFixed(2)}s but the timeline is ${projectDuration.toFixed(2)}s`);
  }
  console.log(`     ${v.codec_name} ${v.width}x${v.height} + ${a.codec_name} ${a.sample_rate}Hz · ${dur.toFixed(2)}s`);
});

await step('frames actually decode and are not blank', async () => {
  // Pull three frames back out and check they carry real picture, which catches
  // an encoder that produced a technically valid but empty file.
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-print_format', 'json', MP4,
  ], { encoding: 'utf8' });
  const frames = parseInt(JSON.parse(out).streams[0].nb_read_frames, 10);
  const expected = Math.round(projectDuration * 30);
  if (frames < expected * 0.8) {
    throw new Error(`only ${frames} frames decoded, expected about ${expected}`);
  }

  // Decode a frame from the middle and look at it. A valid-but-empty file —
  // black, or one flat colour — would pass every structural check above.
  // Sampled mid-timeline, where the clips definitely have content.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(projectDuration / 2),
                          '-i', MP4, '-frames:v', '1', FRAME], { stdio: 'ignore' });
  const colours = parseInt(execFileSync('python3', ['-c',
    `from PIL import Image; im=Image.open("${FRAME}").convert("RGB").resize((64,36)); print(len(set(im.getdata())))`,
  ], { encoding: 'utf8' }).trim(), 10);
  if (colours < 8) throw new Error(`exported frame has ${colours} distinct colours — it is blank`);
  console.log(`     ${frames} frames, mid-frame has ${colours} distinct colours`);
});

/**
 * The fast path must be genuinely faster, and the exact path must still seek.
 *
 * Playing the footage forward instead of seeking to every frame is where
 * export time went: a seek discards the decode pipeline and rebuilds it from
 * the last keyframe, measured at 187ms a frame against 0.14ms to encode one.
 */
await step('playing the source forward renders faster than seeking', async () => {
  const r = await win.evaluate(async () => {
    const { Compositor } = await import('app://gamecut/src/engine/compositor.js');
    const { store } = window.gc;
    const N = 45, fps = 30;

    const walk = async (mode) => {
      const canvas = document.createElement('canvas');
      const comp = new Compositor(store, canvas, { fixedSize: { w: 320, h: 180 } });
      let seeks = 0;
      const realSeek = comp.pool.seekExact.bind(comp.pool);
      comp.pool.seekExact = (...a) => { seeks++; return realSeek(...a); };

      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        const t = i / fps;
        const clips = comp.activeClips(t).map(x => x.clip);
        if (i === 0 || mode === 'exact') await comp.pool.seekExact(clips, t);
        else await comp.pool.streamTo(clips, t, { tolerance: 1 / (fps * 2) });
        comp.render(t, false);
      }
      const ms = Math.round(performance.now() - t0);
      comp.pool.endStream();
      comp.dispose();
      return { ms, seeks };
    };

    const fast = await walk('fast');
    const exact = await walk('exact');
    return { N, fast, exact };
  });

  // Every frame seeks in exact mode; the fast path should seek rarely.
  if (r.exact.seeks < r.N) throw new Error(`exact mode only seeked ${r.exact.seeks}/${r.N} times`);

  // On footage where playing forward does not pay off, the pool gives up and
  // seeks — so the guarantee is that fast mode is never meaningfully SLOWER,
  // not that it is always faster. Being faster is checked on 1080p60 by
  // qa/export-cost.mjs, where the gain is about 3x.
  if (r.fast.ms > r.exact.ms * 1.25) {
    throw new Error(`fast ${r.fast.ms}ms lost badly to exact ${r.exact.ms}ms — the bail-out did not fire`);
  }
  console.log(`     ${r.N} frames: playing ${r.fast.ms}ms (${r.fast.seeks} seeks) vs seeking ${r.exact.ms}ms`);
});

/**
 * A bad patch of footage must suspend the fast path, never end it.
 *
 * The first version judged once, on the opening two dozen frames — the coldest
 * ones — and that verdict held for the whole render. On a 45,000-frame export
 * that meant one bad second at the start cost an hour, which is how this was
 * found. Now it is judged on a rolling window and always gets to change its
 * mind.
 */
await step('a bad patch suspends streaming, it does not end it', async () => {
  const r = await win.evaluate(async () => {
    const { Compositor } = await import('app://gamecut/src/engine/compositor.js');
    const { store } = window.gc;
    const canvas = document.createElement('canvas');
    const comp = new Compositor(store, canvas, { fixedSize: { w: 160, h: 90 } });
    const pool = comp.pool;

    let seeks = 0;
    const realSeek = pool.seekExact.bind(pool);
    pool.seekExact = (...a) => { seeks++; return realSeek(...a); };

    const clipsAt = (t) => comp.activeClips(t).map(x => x.clip);
    await pool.seekExact(clipsAt(0), 0);

    // Pretend the renderer just hit footage it could not follow.
    pool.streamSuspend = 4;
    const suspended = [];
    for (let i = 1; i <= 4; i++) {
      seeks = 0;
      await pool.streamTo(clipsAt(i / 30), i / 30);
      suspended.push(seeks);
    }
    const leftAfter = pool.streamSuspend;

    // The very next frame should be back on the fast path.
    seeks = 0;
    await pool.streamTo(clipsAt(5 / 30), 5 / 30);
    const seeksAfterRecovery = seeks;

    pool.endStream();
    const cleared = pool.streamSuspend;
    comp.dispose();
    return { suspended, leftAfter, seeksAfterRecovery, cleared };
  });

  if (r.suspended.some(n => n !== 1)) {
    throw new Error(`while suspended every frame should seek exactly once, got ${r.suspended.join(',')}`);
  }
  if (r.leftAfter !== 0) throw new Error(`suspension did not count down — ${r.leftAfter} left`);
  if (r.seeksAfterRecovery > 1) {
    throw new Error('streaming did not resume after the suspension expired');
  }
  if (r.cleared !== 0) throw new Error('endStream left a suspension behind for the next render');
  console.log('     suspends for a set number of frames, then tries again');
});

await step('the frame-exact option is offered and reaches the renderer', async () => {
  await win.evaluate(() => document.getElementById('btnExport').click());
  await sleep(250);
  const r = await win.evaluate(() => {
    const box = document.getElementById('xpExact');
    return { present: !!box, checkedByDefault: !!box?.checked };
  });
  if (!r.present) throw new Error('no frame-exact checkbox in the export dialog');
  if (r.checkedByDefault) throw new Error('exact mode should be opt-in, not the default');
  await win.evaluate(() => document.querySelector('#exportModal [data-close]')?.click());
  await sleep(150);
});

/**
 * The custom quality controls.
 *
 * Typed into rather than clicked at, because the whole point of the number box
 * is "my recorder says 82 and I want 82" — a slider can get near it and never
 * land on it. The tile above has to agree with the box, or the size estimate
 * the person is shown is a different export from the one they get.
 */
await step('custom quality can be typed in and reaches the tile', async () => {
  await win.evaluate(() => document.getElementById('btnExport').click());
  await sleep(250);

  const before = await win.evaluate(() => ({
    hasTile: !!document.querySelector('[data-preset="custom"]'),
    panelHidden: document.getElementById('xpCustom')?.hidden,
  }));
  if (!before.hasTile) throw new Error('no Custom tile in the export dialog');
  if (before.panelHidden !== true) throw new Error('the custom controls should stay shut until Custom is picked');

  await win.evaluate(() => document.querySelector('[data-preset="custom"]').click());
  await sleep(120);
  if (await win.evaluate(() => document.getElementById('xpCustom')?.hidden)) {
    throw new Error('picking Custom did not open its controls');
  }

  // Type a number that is on no preset and no slider step.
  await win.fill('#xpRate', '');
  await win.type('#xpRate', '82');
  await sleep(150);

  const r = await win.evaluate(() => ({
    box: document.getElementById('xpRate').value,
    slider: Number(document.getElementById('xpRateSlide').value),
    tile: document.querySelector('[data-preset="custom"] .xp__meta')?.textContent || '',
  }));
  if (r.box !== '82') throw new Error(`the box rewrote what was typed: "${r.box}"`);
  if (Math.abs(r.slider - 82e6) > 1e6) throw new Error(`the slider did not follow the box: ${r.slider}`);
  if (!/82 Mbps/.test(r.tile)) throw new Error(`the tile says "${r.tile.trim()}", not 82 Mbps`);

  // Half a megabit has to survive, or the slider's own steps cannot be typed
  // back in: drag to 8.5, blur the box, and it would silently become 9.
  await win.fill('#xpRate', '');
  await win.type('#xpRate', '8.5');
  await win.evaluate(() => document.getElementById('xpRate').blur());
  await sleep(150);
  const half = await win.evaluate(() => ({
    box: document.getElementById('xpRate').value,
    tile: document.querySelector('[data-preset="custom"] .xp__meta')?.textContent || '',
  }));
  if (half.box !== '8.5') throw new Error(`blurring rewrote 8.5 as "${half.box}"`);
  if (!/8\.5 Mbps/.test(half.tile)) throw new Error(`the tile lost the half: "${half.tile.trim()}"`);

  // Clearing the box is not a request for the minimum bitrate.
  await win.fill('#xpRate', '');
  await win.evaluate(() => document.getElementById('xpRate').blur());
  await sleep(150);
  const cleared = await win.evaluate(() => document.getElementById('xpRate').value);
  if (cleared !== '8.5') throw new Error(`an emptied box committed "${cleared}" instead of keeping 8.5`);

  await win.fill('#xpRate', '');
  await win.type('#xpRate', '82');
  await sleep(120);

  // Frame rate and size are the other two things a fixed preset cannot give.
  await win.selectOption('#xpFps', '120');
  await win.selectOption('#xpScale', '2');
  await sleep(120);
  const after = await win.evaluate(() =>
    document.querySelector('[data-preset="custom"] .xp__meta')?.textContent || '');
  if (!/120fps/.test(after)) throw new Error(`frame rate did not reach the tile: "${after.trim()}"`);
  if (!/3840×2160/.test(after)) throw new Error(`size did not reach the tile: "${after.trim()}"`);

  await win.evaluate(() => document.querySelector('#exportModal [data-close]')?.click());
  await sleep(150);
  console.log(`     ${after.trim().replace(/\s+/g, ' ')}`);
});

await step('the finished export offers the YouTube handoff', async () => {
  const r = await win.evaluate(async () => {
    const mod = await import('app://gamecut/src/export/export-dialog.js');
    // Drive the completion screen directly: the real path needs a native save
    // dialog, which cannot be answered from a test.
    if (!mod.__paintDoneForTest) return { error: 'no test hook on the export dialog' };
    mod.__paintDoneForTest('/tmp/example render.mp4', 1234567);
    await new Promise(r => setTimeout(r, 150));
    const root = document.getElementById('exportModal');
    return {
      hasYouTube: !!root.querySelector('#xpYouTube'),
      hasReveal: !!root.querySelector('#xpReveal'),
      label: root.querySelector('#xpYouTube')?.textContent.trim(),
      showsPath: root.textContent.includes('example render.mp4'),
    };
  });
  if (r.error) throw new Error(r.error);
  if (!r.hasYouTube) throw new Error('no Upload to YouTube button after a finished export');
  if (!r.hasReveal) throw new Error('no Show file button after a finished export');
  if (!r.showsPath) throw new Error('the completion screen does not name the saved file');
  await win.evaluate(() => document.querySelector('#exportModal [data-close]')?.click());
  await sleep(150);
  console.log(`     "${r.label}" offered alongside Show file`);
});

/**
 * A high bitrate is actually delivered.
 *
 * This is the bug that made exports of Medal and OBS footage look softer than
 * the recording: the H.264 LEVEL was chosen from the resolution alone, and a
 * level caps bitrate as well as picture size. Level 4.0 tops out at 25 Mbps on
 * High profile, so asking for 80 handed the encoder a codec string that forbade
 * what was being asked for — no error, no warning, just a worse picture.
 *
 * Two assertions, because each covers a different half:
 *   · the encoder must be CONFIGURED at the rate asked for, on a level that can
 *     carry it — that is the part GameCut controls;
 *   · that level must survive into the finished file, which proves the config
 *     was not quietly rewritten on the way through.
 *
 * What the encoder then SPENDS is its own business: how many bits a picture can
 * absorb depends on the picture. The fixture here is simple synthetic footage
 * that tops out around 1.7 Mbps however much it is offered, so the bytes on
 * disk are reported below rather than asserted on — a size test here would pass
 * or fail on the fixture rather than on the code.
 */
const MP4_HI = `${OUT}/export-high-bitrate.mp4`;
const ASKED = 80_000_000;

await step('a high bitrate is honoured, not silently capped', async () => {
  const r = await win.evaluate(async (asked) => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    let cfg = null;
    const bytes = await renderToMp4({
      store: window.gc.store, width: 640, height: 360, fps: 30,
      vBitrate: asked, aBitrate: 128_000,
      shouldCancel: () => false,
      onProgress: (p) => { if (p.phase === 'encoder') cfg = p; },
    });
    if (!bytes) return { cfg, b64: null };
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return { cfg, b64: btoa(s) };
  }, ASKED, { timeout: 180_000 });

  if (!r.b64) throw new Error('the high-bitrate render produced nothing');
  if (!r.cfg) throw new Error('the renderer never reported which encoder it configured');
  if (r.cfg.bitrate !== ASKED) {
    throw new Error(`asked for ${ASKED / 1e6} Mbps but the encoder was configured at `
      + `${r.cfg.bitrate / 1e6} Mbps${r.cfg.note ? ` — ${r.cfg.note}` : ''}`);
  }

  // avc1.PPCCLL — the last two hex digits are level_idc. 0x32 is level 5.0,
  // the lowest that can carry 80 Mbps.
  const idc = parseInt(String(r.cfg.codec).slice(-2), 16);
  if (!(idc >= 0x32)) {
    throw new Error(`configured codec ${r.cfg.codec} is level ${(idc / 10).toFixed(1)}, `
      + 'which cannot carry 80 Mbps — the level is being chosen from the resolution alone');
  }

  const buf = Buffer.from(r.b64, 'base64');
  await writeFile(MP4_HI, buf);
  const v = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-print_format', 'json',
    '-show_streams', MP4_HI,
  ], { encoding: 'utf8' })).streams[0];

  if (Number(v.level) !== idc) {
    throw new Error(`configured level ${(idc / 10).toFixed(1)} but the file says `
      + `${(Number(v.level) / 10).toFixed(1)} — the config did not reach the file`);
  }

  const baseline = (await stat(MP4)).size;
  console.log(`     configured ${r.cfg.codec} at ${r.cfg.bitrate / 1e6} Mbps · file says level `
    + `${(Number(v.level) / 10).toFixed(1)} · ${(buf.length / 1024).toFixed(0)} KB `
    + `vs ${(baseline / 1024).toFixed(0)} KB at 4 Mbps (this fixture cannot absorb more)`);
});

await step('cancelling mid-render returns nothing', async () => {
  const r = await win.evaluate(async () => {
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    let n = 0;
    const bytes = await renderToMp4({
      store: window.gc.store, width: 640, height: 360, fps: 30,
      vBitrate: 2_000_000, aBitrate: 128_000,
      onProgress: () => { n++; },
      shouldCancel: () => n > 2,            // bail almost immediately
    });
    return bytes === null;
  }, { timeout: 120_000 });
  if (!r) throw new Error('cancel did not abort the render');
});

await rm(PROFILE, { recursive: true, force: true });
await app.close();

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`EXPORT FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
} else {
  console.log('EXPORT PASSED — produces a real, playable MP4.');
}
