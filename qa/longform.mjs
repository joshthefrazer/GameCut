/**
 * Long-recording suite.
 *
 * The app is used with hour-long captures cut down to timelapses, and every
 * bug in this file came from testing against five-second clips instead. The
 * fixture is 12.5 minutes — past the point where decoding a clip's audio into
 * memory stops being affordable.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const LONG = `${ROOT}/qa/fixtures/long-clip.mp4`;
const SHORT = `${ROOT}/qa/fixtures/test-clip.mp4`;
const TONE = `${ROOT}/qa/fixtures/test-tone.mp3`;

const problems = [];
const log = (t, m) => { problems.push(`${t}: ${m}`); console.log(`  !! ${t}: ${m}`); };
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { log('THREW in ' + name, e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── long recordings ──────────────────────');

const PROFILE = `/tmp/gc-long-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({
  args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60_000,
});
const win = await app.firstWindow();
win.on('pageerror', e => log('pageerror', e.message));
win.on('console', m => { if (m.type() === 'error') log('console.error', m.text()); });
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


const poll = async (fn, ms = 40_000) => {
  for (let i = 0; i < ms / 400; i++) {
    const v = await win.evaluate(fn);
    if (v) return v;
    await sleep(400);
  }
  return null;
};

await step('a 12-minute clip imports without decoding its audio', async () => {
  await win.setInputFiles('#filePicker', [LONG]);
  const a = await poll(async () => {
    const m = await import('app://gamecut/src/media/asset-store.js');
    const x = m.assets.all().find(v => v.name.includes('long-clip'));
    return x ? { dur: x.duration, buf: !!x.peaks?.buffer, stream: !!x.streamAudio } : null;
  });
  if (!a) throw new Error('long clip never imported');
  if (!(a.dur > 700)) throw new Error('duration wrong: ' + a.dur);
  // The whole point: 12.5 min of audio in RAM would be ~290 MB.
  if (a.buf) throw new Error('decoded the audio into memory anyway — the duration guard did not fire');
  if (!a.stream) throw new Error('not flagged for streaming playback, so it would be silent');
});

await step('a short clip still gets its waveform', async () => {
  await win.setInputFiles('#filePicker', [SHORT, TONE]);
  const ok = await poll(async () => {
    const m = await import('app://gamecut/src/media/asset-store.js');
    const s = m.assets.all().filter(v => !v.name.includes('long-clip'));
    return s.length >= 2 && s.every(v => v.peaks?.buffer) ? true : null;
  });
  if (!ok) throw new Error('short media lost its decoded buffer — the guard is too aggressive');
});

await step('heap stays sane after importing all of it', async () => {
  const mb = await win.evaluate(() => performance.memory
    ? performance.memory.usedJSHeapSize / 1048576 : 0);
  // 12.5 min decoded would add ~290 MB on its own.
  if (mb > 220) throw new Error(`JS heap at ${mb.toFixed(0)} MB — audio is being held after all`);
  console.log(`     heap ${mb.toFixed(0)} MB`);
});

await step('long clip is audible through its decoder', async () => {
  const r = await win.evaluate(async () => {
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
    const { audibleClips } = await import('app://gamecut/src/audio/graph.js');
    const { store, cmds, playback } = window.gc;
    store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
    cmds.removeSelected();
    const long = assets.all().find(a => a.name.includes('long-clip'));
    placeAsset(store, cmds, long.id, { start: 0 });

    const list = audibleClips(store);
    playback.seek(1);
    playback.play();
    await new Promise(r => setTimeout(r, 900));
    const els = [...document.querySelectorAll('#gc-decoder-host video')];
    const unmuted = els.filter(e => !e.muted).length;
    playback.pause();
    const stillMuted = [...document.querySelectorAll('#gc-decoder-host video')]
      .filter(e => !e.muted).length;
    return { streamed: list.filter(c => c.stream).length, unmuted, stillMuted };
  });
  if (!r.streamed) throw new Error('clip not treated as streaming audio');
  if (!r.unmuted) throw new Error('decoder stayed muted during playback — no sound');
  if (r.stillMuted) throw new Error('decoder left unmuted after pause — audio would leak');
});

// Regression: playbackRate above 16 throws NotSupportedError, and the pool used
// to assign it unguarded on every frame — which would break a timelapse.
await step('a 30x timelapse plays without throwing', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, playback } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    clip.speed = 30;
    store.emit('doc', {});
    playback.seek(0);
    playback.play();
    let threw = null;
    try {
      for (let i = 0; i < 30; i++) {
        comp.render(i / 30, true);
        await new Promise(r => setTimeout(r, 30));
      }
    } catch (e) { threw = String(e.name + ': ' + e.message); }
    playback.pause();
    const el = document.querySelector('#gc-decoder-host video');
    const rate = el ? el.playbackRate : -1;
    clip.speed = 1;
    store.emit('doc', {});
    return { threw, rate };
  });
  if (r.threw) throw new Error('render threw at 30x: ' + r.threw);
  if (r.rate > 16) throw new Error(`playbackRate left at ${r.rate}, above the 16x limit`);
});

// Regression: an unready frame used to be painted as a dark rectangle, so a
// struggling decoder showed as a black screen.
await step('a starved decoder holds the last frame instead of going black', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, playback } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    playback.seek(clip.start + 5);
    await new Promise(r => setTimeout(r, 2500));
    comp.render(clip.start + 5, false);

    const sig = () => {
      const c = comp.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 313) { if (d[i] + d[i + 1] + d[i + 2] > 40) lit++; n++; }
      return { lit, n };
    };
    const before = sig();

    // Jump somewhere the decoder cannot possibly have ready yet and render
    // immediately — exactly the situation that used to paint black.
    const painted = comp.render(clip.start + 600, false);
    const after = sig();
    return { before, after, painted };
  });
  if (r.before.lit < r.before.n * 0.2) throw new Error('reference frame was not lit to begin with');
  if (r.painted !== false) {
    console.log('     (decoder kept up; nothing to hold)');
    return;
  }
  if (r.after.lit < r.before.lit * 0.8) {
    throw new Error(`canvas went dark on a starved frame (${r.before.lit} → ${r.after.lit} lit)`);
  }
});

await step('decoders are capped, not accumulated', async () => {
  const n = await win.evaluate(async () => {
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
    // The cap is read from the pool rather than written down twice — the number
    // is a judgement call that has moved once already, and a test asserting a
    // stale copy of it fails for no reason anyone cares about.
    const { MAX_DECODERS } = await import('app://gamecut/src/engine/decoder-pool.js');
    const { store, cmds, comp } = window.gc;
    const long = assets.all().find(a => a.name.includes('long-clip'));
    // Eight clips back to back, then walk the playhead through all of them.
    for (let i = 1; i <= 8; i++) placeAsset(store, cmds, long.id, { start: i * 20, allowShift: false });
    for (let i = 0; i <= 8; i++) {
      comp.pool.frameFor(store.doc.tracks.flatMap(t => t.clips)[i] || {}, i * 20 + 1, false);
      await new Promise(r => setTimeout(r, 60));
    }
    return { live: document.querySelectorAll('#gc-decoder-host video').length, cap: MAX_DECODERS };
  });
  if (n.live > n.cap) throw new Error(`${n.live} decoders alive at once — the cap is ${n.cap}`);
  console.log(`     ${n.live} decoders alive (cap ${n.cap})`);
});

await step('preview quality changes the canvas, not the project', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp } = window.gc;
    const sel = document.getElementById('previewQuality');
    const out = {};
    for (const q of ['1', '0.5', '0.25']) {
      sel.value = q;
      sel.dispatchEvent(new Event('change'));
      await new Promise(r => requestAnimationFrame(r));
      out[q] = { canvas: comp.canvas.width, docW: store.doc.width };
    }
    sel.value = '0.5'; sel.dispatchEvent(new Event('change'));
    return out;
  });
  if (!(r['1'].canvas > r['0.5'].canvas && r['0.5'].canvas > r['0.25'].canvas)) {
    throw new Error('quality did not change the canvas size: ' + JSON.stringify(r));
  }
  if (r['0.25'].docW !== 1920) throw new Error('preview quality altered the project resolution');
  console.log(`     full ${r['1'].canvas}px · half ${r['0.5'].canvas}px · quarter ${r['0.25'].canvas}px`);
});

// Regression: the transport painted on every display tick even when the
// decoder had produced nothing new, so half the paints redrew an identical
// picture and competed for the GPU the decoder was waiting on.
await step('skips painting when there is no new frame', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, cmds } = window.gc;
    // A moment containing only video — text and shapes animate on their own
    // and must still force a paint.
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    if (!clip) return { error: 'no video clip' };
    const t = clip.start + 1;

    // Park and let the decoder actually deliver, or `render` bails as starved
    // and this measures nothing.
    window.gc.playback.seek(t);
    for (let i = 0; i < 40 && !comp.render(t, false); i++) {
      await new Promise(r => setTimeout(r, 150));
    }

    comp.fresh = true;
    const first = comp.needsPaint(t);
    comp.render(t, false);
    const afterPaint = comp.needsPaint(t);   // nothing new since
    comp.fresh = true;
    const afterFrame = comp.needsPaint(t);   // decoder delivered

    // With a text clip present it must always repaint.
    cmds.addTextClip(t);
    const withText = comp.needsPaint(t);
    return { first, afterPaint, afterFrame, withText };
  });
  if (r.error) throw new Error(r.error);
  if (!r.first) throw new Error('refused to paint a fresh frame');
  if (r.afterPaint) throw new Error('still asks to repaint an unchanged picture — the whole point');
  if (!r.afterFrame) throw new Error('ignored a newly decoded frame');
  if (!r.withText) throw new Error('would freeze text and shape animation');
});

await step('quality drops automatically when paints overrun', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, playback } = window.gc;
    store.ui.previewScale = 1;
    store.rt.renderScale = null;
    comp.resize();
    const before = comp.canvas.width;

    // Pretend every paint is far over budget.
    store.setRT({ playing: true });
    for (let i = 0; i < 40; i++) playback.onTick(store.rt.playhead, 40);
    const dropped = store.rt.renderScale;
    const during = comp.canvas.width;

    // Stopping gives the chosen quality back.
    store.setRT({ playing: false });
    await new Promise(r => setTimeout(r, 60));
    const after = comp.canvas.width;

    store.ui.previewScale = 0.5; store.rt.renderScale = null; comp.resize();
    return { before, dropped, during, after };
  });
  if (!r.dropped) throw new Error('governor never lowered the quality');
  if (!(r.during < r.before)) throw new Error(`canvas did not shrink (${r.before} → ${r.during})`);
  if (r.after !== r.before) throw new Error(`did not restore on pause (${r.before} → ${r.after})`);
  console.log(`     ${r.before}px → ${r.during}px under load → ${r.after}px on pause`);
});

await step('quality climbs back without having to stop playing', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, playback } = window.gc;
    store.ui.previewScale = 1;
    store.rt.renderScale = null;
    comp.resize();
    const full = comp.canvas.width;

    // The governor rate-limits itself; the previous test just used its budget.
    await new Promise(r => setTimeout(r, 1700));
    store.setRT({ playing: true });
    for (let i = 0; i < 40; i++) playback.onTick(store.rt.playhead, 40, true);
    const dropped = comp.canvas.width;

    // Recovery is behind a deliberate cooldown so a drop and a climb can never
    // ping-pong; wait it out, then feed it paints that are comfortably cheap.
    await new Promise(r => setTimeout(r, 4200));
    for (let i = 0; i < 40; i++) playback.onTick(store.rt.playhead, 1, true);
    const recovered = comp.canvas.width;

    store.setRT({ playing: false });
    store.ui.previewScale = 0.5; store.rt.renderScale = null; comp.resize();
    return { full, dropped, recovered };
  });
  if (!(r.dropped < r.full)) throw new Error('never dropped, so recovery proves nothing');
  if (!(r.recovered > r.dropped))
    throw new Error(`stayed at ${r.dropped}px while playing instead of climbing back`);
  console.log(`     ${r.full}px → ${r.dropped}px under load → ${r.recovered}px once cheap again`);
});

await step('fps readout shows the real rate and the active quality', async () => {
  const txt = await win.evaluate(async () => {
    const { store, comp, playback } = window.gc;
    store.ui.previewScale = 0.5; store.rt.renderScale = null; comp.resize();
    playback.onTick(store.rt.playhead, 5);
    return document.getElementById('fpsChip').textContent;
  });
  if (!/fps/.test(txt)) throw new Error('no fps readout: ' + txt);
  if (!/half/.test(txt)) throw new Error('does not say which quality is active: ' + txt);
  console.log(`     reads "${txt}"`);
});

await step('export warns that long audio will be silent', async () => {
  const txt = await win.evaluate(() => {
    document.getElementById('btnExport').click();
    return document.querySelector('#exportModal .modal__warn')?.textContent || '';
  });
  if (!/silent/i.test(txt)) throw new Error('no warning shown for unmixable audio');
  await win.evaluate(() => document.querySelector('#exportModal [data-close]')?.click());
});

await rm(PROFILE, { recursive: true, force: true });
await app.close();

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`LONGFORM FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
} else {
  console.log('LONGFORM PASSED — long recordings import, play and stay within memory.');
}
