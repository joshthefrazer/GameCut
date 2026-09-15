/**
 * Real-media suite, run inside the Electron shell — the environment the user
 * actually has, and the only one here with H.264/AAC. Playwright's Chromium
 * ships without proprietary codecs, so an mp4 test in the browser suite would
 * fail for reasons that have nothing to do with this app.
 *
 * Covers the path that was broken: import a video, get it onto the timeline
 * without drag-and-drop, see it in the preview, and hear it.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const OUT = process.argv[2] || '.';
const F = `${ROOT}/qa/fixtures`;

const problems = [];
const log = (t, m) => { problems.push(`${t}: ${m}`); console.log(`  !! ${t}: ${m}`); };
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { log('THREW in ' + name, e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── real media (electron) ────────────────');

// Throwaway profile — a stale Chromium SingletonLock from an unclean exit
// makes the next launch quit before opening a window.
const PROFILE = `/tmp/gamecut-qa-media-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
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


await step('shell has the codecs real footage needs', async () => {
  const c = await win.evaluate(() => {
    const v = document.createElement('video');
    return { h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
             vp8: v.canPlayType('video/webm; codecs="vp8"') };
  });
  if (!c.h264) throw new Error('no H.264 — most gameplay captures will not open');
  if (!c.vp8) throw new Error('no VP8');
});

await step('import mp4 / webm / mp3', async () => {
  await win.setInputFiles('#filePicker',
    [`${F}/test-clip.mp4`, `${F}/test-clip.webm`, `${F}/test-tone.mp3`]);
  await sleep(5000);
  const a = await win.evaluate(async () => {
    const { assets } = await import('/src/media/asset-store.js');
    return assets.all().map(x => ({ name: x.name, kind: x.kind, dur: x.duration,
                                    w: x.width, thumb: !!x.thumb, buf: !!x.peaks?.buffer }));
  });
  const mp4 = a.find(x => x.name.endsWith('.mp4'));
  if (!mp4) throw new Error('mp4 produced no asset: ' + JSON.stringify(a));
  if (mp4.kind !== 'video') throw new Error('mp4 imported as ' + mp4.kind);
  if (!(mp4.dur > 4)) throw new Error('mp4 duration wrong: ' + mp4.dur);
  if (mp4.w !== 640) throw new Error('mp4 dimensions wrong: ' + mp4.w);
  if (!mp4.thumb) throw new Error('no thumbnail generated');
  if (!mp4.buf) throw new Error('video audio never decoded — it will be silent');
});

// The bug the user hit: drag-and-drop was the only route to the timeline.
await step('+ button puts a video on the timeline', async () => {
  await win.click('#leftTabs [data-tab="media"]');
  await sleep(300);
  const before = await win.evaluate(() =>
    window.gc.store.doc.tracks.reduce((n, t) => n + t.clips.length, 0));

  const tile = win.locator('.asset', { hasText: 'test-clip.mp4' }).first();
  await tile.hover();
  await tile.locator('.asset__add').click();
  await sleep(500);

  const after = await win.evaluate(() => {
    const { store } = window.gc;
    const clips = store.doc.tracks.flatMap(t => t.clips.map(c => ({ type: c.type, name: c.name })));
    return { total: clips.length, video: clips.filter(c => c.type === 'video') };
  });
  if (after.total <= before) throw new Error('+ button added nothing');
  if (!after.video.length) throw new Error('no video clip created');
});

await step('double-click also adds, without stacking', async () => {
  const tile = win.locator('.asset', { hasText: 'test-clip.webm' }).first();
  await tile.dblclick();
  await sleep(500);
  const overlap = await win.evaluate(() => {
    for (const t of window.gc.store.doc.tracks) {
      const s = [...t.clips].sort((a, b) => a.start - b.start);
      for (let i = 1; i < s.length; i++) {
        if (s[i].start < s[i - 1].start + s[i - 1].duration - 1e-6) {
          return `${s[i - 1].name} and ${s[i].name} overlap on ${t.name}`;
        }
      }
    }
    return null;
  });
  if (overlap) throw new Error(overlap);
});

await step('the video actually paints in the preview', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, playback } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    if (!clip) return { error: 'no video clip' };
    const t = clip.start + Math.min(1.5, clip.duration / 2);
    playback.seek(t);
    await new Promise(r => setTimeout(r, 2200));
    comp.render(t, false);

    const c = comp.canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // A decoded frame has colour variety; a blank fill does not.
    const seen = new Set();
    let lit = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 89) {
      const [R, G, B] = [d[i], d[i + 1], d[i + 2]];
      if (R + G + B > 40) lit++;
      seen.add(`${R >> 5},${G >> 5},${B >> 5}`);
      n++;
    }
    return { lit, n, distinctColours: seen.size,
             src: comp.pool.frameFor(clip, t, false)?.tagName || null };
  });
  if (r.error) throw new Error(r.error);
  if (r.src !== 'VIDEO') throw new Error('decoder returned ' + r.src);
  if (r.lit < r.n * 0.2) throw new Error(`preview mostly black (${r.lit}/${r.n} lit)`);
  if (r.distinctColours < 8) {
    throw new Error(`preview is a flat fill, not a decoded frame (${r.distinctColours} colours)`);
  }
});

// Regression: AudioGraph skipped every track whose kind wasn't 'audio', while
// the decoder pool muted the <video> element — so video sound played nowhere.
/**
 * Cropping lifts a region onto its own layer and leaves the source alone.
 *
 * Checked against real footage rather than a stub, because the whole thing
 * hinges on drawImage's nine-argument form addressing the right pixels: a crop
 * that silently drew the whole frame would look almost right in a screenshot
 * and be completely wrong.
 */
await step('cropping a region makes a layer and leaves the original', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, cmds, playback } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    if (!clip) return { error: 'no video clip' };

    const t = clip.start + Math.min(1.5, clip.duration / 2);
    playback.seek(t);
    await new Promise(r => setTimeout(r, 2200));

    const src = comp.pool.peek(clip);
    const before = store.doc.tracks.reduce((a, tr) => a + tr.clips.length, 0);
    const srcTransform = JSON.stringify(clip.transform);

    // The top-right quarter — where a game's counters usually sit.
    const crop = { x: 0.6, y: 0.05, w: 0.3, h: 0.2 };
    const made = cmds.cropClip(clip.id, {
      crop, transform: { x: 0.75, y: 0.15, scale: 1, rotation: 0, opacity: 1 },
    });
    if (!made) return { error: 'cropClip returned nothing' };

    await new Promise(r => setTimeout(r, 400));
    comp.render(t, false);

    const { track } = (() => {
      for (const tr of store.doc.tracks)
        if (tr.clips.some(c => c.id === made.id)) return { track: tr };
      return { track: null };
    })();

    const idxOf = (id) => store.doc.tracks.findIndex(tr => tr.clips.some(c => c.id === id));
    const box = comp.bounds(made, t);

    return {
      after: store.doc.tracks.reduce((a, tr) => a + tr.clips.length, 0),
      before,
      sourceUnchanged: JSON.stringify(clip.transform) === srcTransform && !clip.crop,
      // Earlier in the array paints later, i.e. on top.
      cropIsAbove: idxOf(made.id) < idxOf(clip.id),
      silent: made.silent === true,
      onVideoTrack: track?.kind === 'video',
      // The box the gizmo would draw must match the crop's shape, not the
      // whole frame's — that is the test that the two agree.
      boxAspect: +(box.w * store.doc.width / (box.h * store.doc.height)).toFixed(2),
      wantAspect: +((crop.w * (src?.videoWidth || 1)) / (crop.h * (src?.videoHeight || 1))).toFixed(2),
      madeId: made.id,
    };
  });

  if (r.error) throw new Error(r.error);
  if (r.after !== r.before + 1) throw new Error(`expected one new clip, went ${r.before} → ${r.after}`);
  if (!r.sourceUnchanged) throw new Error('the source clip was modified — it must be left alone');
  if (!r.cropIsAbove) throw new Error('the cropped layer is not above the clip it came from');
  if (!r.onVideoTrack) throw new Error('the cropped layer did not land on a video track');
  if (!r.silent) throw new Error('the cropped copy is not silent — its audio would double up');
  if (Math.abs(r.boxAspect - r.wantAspect) > 0.05) {
    throw new Error(`selection box is the wrong shape: ${r.boxAspect} vs crop's ${r.wantAspect}`);
  }
  console.log(`     crop layer above source, box aspect ${r.boxAspect} matches region`);
});

/**
 * A crop must not cost a second decoder.
 *
 * The pool is capped at three, so a couple of cropped layers would evict the
 * footage they were lifted from and the preview would freeze — the exact
 * failure this editor spent a long time getting rid of. Clips wanting the same
 * footage at the same moment share one <video>.
 */
await step('a cropped layer shares its source clip decoder', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp } = window.gc;
    const t = store.rt.playhead;
    const src = store.doc.tracks.flatMap(tr => tr.clips).find(c => c.type === 'video' && !c.crop);
    const crop = store.doc.tracks.flatMap(tr => tr.clips).find(c => c.crop);
    if (!src || !crop) return { error: 'need both a source clip and a cropped one' };

    comp.sync(t, false);
    await new Promise(r => setTimeout(r, 300));
    return {
      same: comp.pool.elementFor(src) === comp.pool.elementFor(crop),
      hostElements: document.querySelectorAll('#gc-decoder-host video').length,
    };
  });
  if (r.error) throw new Error(r.error);
  if (!r.same) throw new Error('the cropped layer got its own decoder — two decodes of identical footage');
  console.log(`     one decoder shared · ${r.hostElements} live in total`);
});

await step('a cropped layer draws different pixels from the full frame', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, playback } = window.gc;
    const t = store.rt.playhead;

    const sample = () => {
      comp.render(t, false);
      const c = comp.canvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 37) { sum += d[i] + d[i + 1] + d[i + 2]; n++; }
      return Math.round(sum / n);
    };

    const cropClip = store.doc.tracks.flatMap(tr => tr.clips).find(c => c.crop);
    if (!cropClip) return { error: 'no cropped clip present' };

    const withCrop = sample();
    // Blow the same layer up to fill the frame: now the canvas is almost
    // entirely the cropped region, so if the crop addresses the right pixels
    // the picture must change.
    const keep = { ...cropClip.transform };
    cropClip.transform = { ...keep, x: .5, y: .5, scale: 6 };
    const magnified = sample();
    cropClip.transform = keep;

    // And a crop of a different part of the frame must differ again.
    const keepCrop = { ...cropClip.crop };
    cropClip.transform = { ...keep, x: .5, y: .5, scale: 6 };
    cropClip.crop = { x: 0.05, y: 0.7, w: 0.3, h: 0.2 };
    const elsewhere = sample();
    cropClip.crop = keepCrop;
    cropClip.transform = keep;
    comp.render(t, false);

    return { withCrop, magnified, elsewhere };
  });

  if (r.error) throw new Error(r.error);
  if (r.withCrop === r.magnified) {
    throw new Error('magnifying the cropped layer changed nothing — the crop is not being drawn');
  }
  if (r.magnified === r.elsewhere) {
    throw new Error('cropping a different region drew the same pixels — the source rect is ignored');
  }
  console.log(`     brightness: as placed ${r.withCrop} · magnified ${r.magnified} · other region ${r.elsewhere}`);
});

/**
 * A painted crop mask actually reaches the screen.
 *
 * Everything else about the crop studio can be checked in the DOM, but whether
 * the brush stroke survives into the compositor can only be answered by looking
 * at pixels. A mask that silently did nothing would leave the app feeling
 * exactly as broken as the tool it replaced, with every test still green.
 */
await step('a painted mask hides the part it was painted over', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp } = window.gc;
    const t = store.rt.playhead;
    const clip = store.doc.tracks.flatMap(tr => tr.clips).find(c => c.crop);
    if (!clip) return { error: 'no cropped clip present' };

    // Fill the frame with this one layer so the sums are about it and nothing
    // else, and nothing underneath can stand in for what the mask removed.
    const hidden = [];
    for (const tr of store.doc.tracks) {
      if (!tr.clips.some(c => c.id === clip.id) && !tr.hidden) { tr.hidden = true; hidden.push(tr); }
    }
    const keep = { ...clip.transform };
    clip.transform = { ...keep, x: .5, y: .5, scale: 3 };

    const lit = () => {
      comp.render(t, false);
      const c = comp.canvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 11) {
        if (d[i] + d[i + 1] + d[i + 2] > 40) n++;
      }
      return n;
    };

    const before = lit();

    // Left half opaque, right half clear.
    const m = document.createElement('canvas');
    m.width = 200; m.height = 200;
    const mc = m.getContext('2d');
    mc.fillStyle = '#fff';
    mc.fillRect(0, 0, 100, 200);
    const url = m.toDataURL('image/png');

    clip.crop = { ...clip.crop, mask: url };
    // The compositor decodes the mask lazily; give it a moment and a couple of
    // frames rather than asserting against a half-loaded image.
    await new Promise(res => setTimeout(res, 500));
    comp.render(t, false);
    await new Promise(res => setTimeout(res, 120));
    const masked = lit();

    // And a mask that keeps everything must put the picture back.
    mc.fillRect(0, 0, 200, 200);
    clip.crop = { ...clip.crop, mask: m.toDataURL('image/png') };
    await new Promise(res => setTimeout(res, 500));
    comp.render(t, false);
    const full = lit();

    const { mask, ...plain } = clip.crop;
    void mask;
    clip.crop = plain;
    clip.transform = keep;
    for (const tr of hidden) tr.hidden = false;
    comp.render(t, false);

    return { before, masked, full };
  });

  if (r.error) throw new Error(r.error);
  if (!r.before) throw new Error('the layer was not visible to begin with, so this proves nothing');
  const ratio = r.masked / r.before;
  if (ratio > 0.75)
    throw new Error(`the mask removed almost nothing: ${r.masked} of ${r.before} pixels still lit (${ratio.toFixed(2)}) — the brush is not reaching the screen`);
  if (ratio < 0.2)
    throw new Error(`the mask removed far too much: only ${r.masked} of ${r.before} pixels left (${ratio.toFixed(2)})`);
  if (r.full < r.before * 0.8)
    throw new Error(`a fully opaque mask still hid the picture: ${r.full} vs ${r.before}`);
  console.log(`     lit pixels: open ${r.before} · half-masked ${r.masked} · mask-all ${r.full}`);

});

/**
 * The tool as a person uses it: press Crop, drag a box, get a layer.
 *
 * Driving the real pointer rather than calling the command directly is the
 * only way to catch the things that actually break here — the rectangle being
 * measured against the wrong element, or the crop landing somewhere other than
 * where it was drawn. It runs against real footage because the conversion from
 * screen to source is the whole point and a stub has no source to convert to.
 */
await step('the Crop button opens the studio and a drag crops that region', async () => {
  const ids = await win.evaluate(() =>
    window.gc.store.doc.tracks.flatMap(t => t.clips).map(c => c.id));
  const before = ids.length;

  await win.evaluate(async () => {
    const { store, playback } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video' && !c.crop);
    store.select([clip.id]);
    playback.seek(clip.start + Math.min(1, clip.duration / 2));
    await new Promise(r => setTimeout(r, 1200));
  });

  await win.click('#btnCrop');
  await sleep(350);
  if (!(await win.evaluate(() => !!document.querySelector('.cropst'))))
    throw new Error('Crop button did not open the studio');

  await win.click('.cst[data-tool="box"]');
  await sleep(120);

  // Where the frame actually is on screen, rather than where the layout
  // suggests it might be.
  const f = await win.evaluate(() => {
    const cv = document.querySelector('.cropst__cv');
    const b = cv.getBoundingClientRect();
    const fr = cv.__frame;
    return fr && { x: b.x + fr.x, y: b.y + fr.y, w: fr.w, h: fr.h };
  });
  if (!f) throw new Error('the studio never reported where the frame is');

  const x0 = f.x + f.w * 0.60, y0 = f.y + f.h * 0.10;
  const x1 = f.x + f.w * 0.90, y1 = f.y + f.h * 0.32;
  await win.mouse.move(x0, y0);
  await win.mouse.down();
  await win.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 });
  await win.mouse.move(x1, y1, { steps: 6 });
  await win.mouse.up();
  await sleep(160);

  await win.click('#cstApply');
  await sleep(500);

  const r = await win.evaluate((known) => {
    const { store } = window.gc;
    const all = store.doc.tracks.flatMap(t => t.clips);
    const made = all.find(c => !known.includes(c.id));
    return {
      total: all.length,
      crop: made?.crop || null,
      tx: made?.transform?.x, ty: made?.transform?.y,
      stillOpen: !!document.querySelector('.cropst'),
      selected: store.rt.selection.includes(made?.id),
    };
  }, ids);

  if (r.total !== before + 1) throw new Error(`expected one new clip, got ${r.total - before}`);
  if (!r.crop) throw new Error('the new clip has no crop rectangle');
  if (r.stillOpen) throw new Error('the studio stayed open after Apply');
  if (!r.selected) throw new Error('the new layer was not selected, so it cannot be dragged straight away');

  // Drawn over the top-right, so it must have landed there — this is what
  // fails if the screen-to-source conversion is wrong.
  if (!(r.crop.x > 0.4 && r.crop.y < 0.4)) {
    throw new Error(`crop landed at ${JSON.stringify(r.crop)}, not the top-right`);
  }
  if (!(r.tx > 0.5 && r.ty < 0.5)) {
    throw new Error(`layer placed at ${r.tx?.toFixed(2)},${r.ty?.toFixed(2)} — not over the drawn box`);
  }
  console.log(`     drew top-right \u2192 crop ${(r.crop.w * 100).toFixed(0)}%\u00d7${(r.crop.h * 100).toFixed(0)}% at ${(r.crop.x * 100).toFixed(0)}%,${(r.crop.y * 100).toFixed(0)}%`);
});

await step('Esc leaves the studio without making anything', async () => {
  const before = await win.evaluate(() =>
    window.gc.store.doc.tracks.reduce((a, t) => a + t.clips.length, 0));
  await win.click('#btnCrop');
  await sleep(300);
  await win.keyboard.press('Escape');
  await sleep(250);
  const r = await win.evaluate(() => ({
    total: window.gc.store.doc.tracks.reduce((a, t) => a + t.clips.length, 0),
    open: !!document.querySelector('.cropst'),
  }));
  if (r.open) throw new Error('Esc did not close the studio');
  if (r.total !== before) throw new Error('cancelling still created a clip');
});

await step('undo removes a cropped layer cleanly', async () => {
  const r = await win.evaluate(async () => {
    const { store, history } = window.gc;
    const before = store.doc.tracks.reduce((a, t) => a + t.clips.length, 0);
    history.undo();
    await new Promise(r => setTimeout(r, 150));
    const after = store.doc.tracks.reduce((a, t) => a + t.clips.length, 0);
    history.redo();
    await new Promise(r => setTimeout(r, 150));
    return { before, after, redone: store.doc.tracks.reduce((a, t) => a + t.clips.length, 0) };
  });
  if (r.after !== r.before - 1) throw new Error(`undo removed ${r.before - r.after} clips, expected 1`);
  if (r.redone !== r.before) throw new Error('redo did not put the cropped layer back');
});

await step('video clips get their audio scheduled', async () => {
  const r = await win.evaluate(async () => {
    const { store, playback } = window.gc;
    const graph = playback.audio;
    // Isolate: mute the audio tracks so anything scheduled must be the video's.
    for (const t of store.doc.tracks) if (t.kind === 'audio') t.muted = true;
    playback.seek(0);
    await new Promise(r => setTimeout(r, 120));
    playback.play();
    await new Promise(r => setTimeout(r, 700));
    const n = graph ? graph.nodes.length : -1;
    playback.pause();
    for (const t of store.doc.tracks) if (t.kind === 'audio') t.muted = false;
    return { scheduled: n, hasGraph: !!graph };
  });
  if (!r.hasGraph) throw new Error('no audio graph handle on playback');
  if (r.scheduled <= 0) throw new Error('video audio still scheduled nowhere');
});

/**
 * Speed has to change the clip's length, not just how fast it plays.
 *
 * Left alone, an 8x clip kept its original slot on the timeline, ran out of
 * footage a fraction of the way in, and looped for the rest of it.
 */
await step('speeding a clip up makes it shorter', async () => {
  const r = await win.evaluate(async () => {
    const { store, cmds } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video' && !c.crop);
    if (!clip) return { error: 'no video clip' };

    cmds.setClipSpeed(clip.id, 1);
    const base = clip.duration;
    const consumed = clip.duration * clip.speed;

    cmds.setClipSpeed(clip.id, 8);
    const fast = { dur: clip.duration, speed: clip.speed, consumed: clip.duration * clip.speed };

    cmds.setClipSpeed(clip.id, 0.5);
    const slow = { dur: clip.duration, speed: clip.speed };

    cmds.setClipSpeed(clip.id, 1);
    const back = clip.duration;

    // Well past what a media element will accept as a playbackRate: a timelapse
    // of an hour-long recording needs it, and it used to be refused outright.
    cmds.setClipSpeed(clip.id, 50);
    const timelapse = { dur: clip.duration, speed: clip.speed };
    cmds.setClipSpeed(clip.id, 1);

    return { base, consumed, fast, slow, back, timelapse,
             sourceDuration: clip.sourceDuration };
  });

  if (r.error) throw new Error(r.error);
  // Eight times faster, one eighth as long — to within a frame of quantizing.
  if (Math.abs(r.fast.dur - r.base / 8) > 0.05) {
    throw new Error(`8x left the clip ${r.fast.dur.toFixed(2)}s, expected ${(r.base / 8).toFixed(2)}s`);
  }
  // The same stretch of footage, which is what stops it looping.
  if (Math.abs(r.fast.consumed - r.consumed) > 0.1) {
    throw new Error(`8x now covers ${r.fast.consumed.toFixed(2)}s of source, was ${r.consumed.toFixed(2)}s`);
  }
  if (!(r.slow.dur > r.base * 1.5)) {
    throw new Error(`half speed should roughly double the clip, got ${r.slow.dur.toFixed(2)}s`);
  }
  // Not exact, and it cannot be: clip lengths sit on frame boundaries, so half
  // a frame lost while quantizing at 8x is four frames of source. Round-tripping
  // through high speeds costs a few frames, which is honest rather than a bug.
  if (Math.abs(r.back - r.base) > 0.12) {
    throw new Error(`back to 1x gave ${r.back.toFixed(2)}s, expected about ${r.base.toFixed(2)}s`);
  }
  if (r.timelapse.speed !== 50) throw new Error(`50x was clamped to ${r.timelapse.speed}`);
  console.log(`     ${r.base.toFixed(2)}s at 1x → ${r.fast.dur.toFixed(2)}s at 8x → ${r.slow.dur.toFixed(2)}s at 0.5x`);
});

await step('a sped-up clip never asks for footage past the end', async () => {
  const bad = await win.evaluate(() => {
    const { store, cmds } = window.gc;
    const out = [];
    for (const clip of store.doc.tracks.flatMap(t => t.clips)) {
      if (clip.type !== 'video' || !Number.isFinite(clip.sourceDuration)) continue;
      for (const speed of [0.25, 1, 4, 16]) {
        cmds.setClipSpeed(clip.id, speed);
        const needed = clip.inPoint + clip.duration * clip.speed;
        // A frame of slack for quantizing; more than that and the tail of the
        // clip has no footage behind it and would loop.
        if (needed > clip.sourceDuration + 1 / store.doc.fps) {
          out.push(`${clip.name} at ${speed}x wants ${needed.toFixed(2)}s of a ${clip.sourceDuration.toFixed(2)}s source`);
        }
      }
      cmds.setClipSpeed(clip.id, 1);
    }
    return out;
  });
  if (bad.length) throw new Error(bad.join('; '));
});

await step('muting a video track silences it', async () => {
  const r = await win.evaluate(async () => {
    const { store, playback } = window.gc;
    for (const t of store.doc.tracks) t.muted = true;
    playback.seek(0);
    playback.play();
    await new Promise(r => setTimeout(r, 500));
    const n = playback.audio.nodes.length;
    playback.pause();
    for (const t of store.doc.tracks) t.muted = false;
    return n;
  });
  if (r !== 0) throw new Error(`muted every track but ${r} nodes were scheduled`);
});

/**
 * Regression: playback used to run at ~3fps because `frameFor()` doubles as
 * transport control, and `compositor.bounds()` — which the gizmo calls on every
 * playhead tick — invoked it with playing=false, pausing and re-seeking the
 * element several times a second. Asserted on seek/stall counts rather than
 * fps, because the frame rate of a software-rendered CI box means nothing.
 */
await step('playback does not thrash the decoder', async () => {
  const r = await win.evaluate(async () => {
    const { comp, playback, store } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    if (!clip) return { error: 'no video clip' };

    // Park the transport and wait on the element, rather than polling
    // frameFor(): that call re-seeks on every invocation, so a loop of them can
    // keep an element permanently mid-seek and it never reports ready.
    playback.seek(clip.start);
    const el = comp.pool.elementFor(clip);
    if (!el) return { error: 'no decoder element for the clip' };
    for (let i = 0; i < 60 && el.readyState < 2; i++) {
      await new Promise(r => setTimeout(r, 150));
    }
    if (el.readyState < 2) {
      return { error: `decoder never became ready: readyState=${el.readyState} networkState=${el.networkState}` };
    }

    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    let seeks = 0, waiting = 0;
    Object.defineProperty(el, 'currentTime', {
      get() { return desc.get.call(el); },
      set(v) { seeks++; desc.set.call(el, v); },
      configurable: true,
    });
    const onWait = () => waiting++;
    el.addEventListener('waiting', onWait);

    playback.seek(clip.start);
    await new Promise(r => setTimeout(r, 400));
    seeks = 0; waiting = 0;

    const pausedSamples = [];
    playback.play();
    const iv = setInterval(() => pausedSamples.push(el.paused), 200);
    await new Promise(r => setTimeout(r, 3000));
    clearInterval(iv);
    playback.pause();

    el.removeEventListener('waiting', onWait);
    delete el.currentTime;
    return { seeks, waiting, pausedSamples,
             pausedCount: pausedSamples.filter(Boolean).length,
             inDom: document.contains(el) };
  });

  if (r.error) throw new Error(r.error);
  if (!r.inDom) throw new Error('decoder element is detached — Chromium throttles those');
  if (r.pausedCount > 1) {
    throw new Error(`element was paused in ${r.pausedCount}/${r.pausedSamples.length} samples during playback`);
  }
  // One corrective seek over three seconds is fine; a handful means thrash.
  if (r.seeks > 3) throw new Error(`${r.seeks} seeks during 3s of playback (was 12 when broken)`);
  if (r.waiting > 2) throw new Error(`${r.waiting} re-buffer stalls during playback`);
});

/**
 * The other way to disrupt a decoder is to keep changing playbackRate.
 *
 * Each change reconfigures the media pipeline, and long clips carry their audio
 * on this very element, so a rate nudge lands on the decode path. Correcting a
 * few milliseconds of drift several times a second is what turned smooth
 * playback into 60fps punctuated by a crawl. A wide dead zone plus hysteresis
 * should mean a steady clip is left completely alone.
 */
await step('playback does not keep bending the rate', async () => {
  const r = await win.evaluate(async () => {
    const { comp, playback, store } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    if (!clip) return { error: 'no video clip' };

    // Park the transport and let the decoder settle. Polling frameFor() in a
    // loop is the wrong way to wait: it re-seeks the element on every call, so
    // it can sit in a seek indefinitely and never report ready.
    playback.seek(clip.start);
    const el = comp.pool.elementFor(clip);
    if (!el) return { error: 'no decoder element for the clip' };
    for (let i = 0; i < 40 && el.readyState < 2; i++) {
      await new Promise(r => setTimeout(r, 150));
    }
    if (el.readyState < 2) {
      return { error: `decoder never became ready: readyState=${el.readyState} `
        + `networkState=${el.networkState} err=${el.error?.code ?? 'none'}` };
    }

    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    let changes = 0;
    Object.defineProperty(el, 'playbackRate', {
      get() { return desc.get.call(el); },
      set(v) { changes++; desc.set.call(el, v); },
      configurable: true,
    });

    playback.seek(clip.start);
    await new Promise(r => setTimeout(r, 500));
    changes = 0;                       // the start itself legitimately sets one

    playback.play();
    await new Promise(r => setTimeout(r, 4000));
    playback.pause();

    const pitch = el.preservesPitch;
    delete el.playbackRate;
    return { changes, pitch };
  });

  if (r.error) throw new Error(r.error);
  // Pitch preservation would put a resampler on every one of these.
  if (r.pitch !== false) throw new Error('preservesPitch is still on');
  if (r.changes > 6) throw new Error(`${r.changes} playbackRate changes in 4s — the rate is being thrashed`);
  console.log(`     ${r.changes} rate changes in 4s of playback`);
});

await step('preview shows fresh frames while playing', async () => {
  const r = await win.evaluate(async () => {
    const { comp, playback, store } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    playback.seek(clip.start);
    await new Promise(r => setTimeout(r, 600));

    // Fingerprint the preview repeatedly during playback. Distinct signatures
    // mean the decoder really is handing over new pictures, which is true
    // regardless of how fast this machine can composite.
    const sig = () => {
      const c = comp.canvas, g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4 * 997) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
      return h;
    };

    playback.play();
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 220));
      comp.render(store.rt.playhead, true);
      seen.add(sig());
    }
    playback.pause();
    return { distinct: seen.size };
  });
  if (r.distinct < 4) {
    throw new Error(`preview produced only ${r.distinct} distinct frames over ~2.6s — it is frozen`);
  }
});

await step('video track exposes a mute button', async () => {
  const n = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#trackHeaders .th')];
    return rows.filter(r => /video/i.test(r.querySelector('.th__kind')?.textContent || '')
                         && r.querySelector('[data-flag="muted"]')).length;
  });
  if (!n) throw new Error('no mute control on any video track');
});

await win.screenshot({ path: `${OUT}/media-electron.png` });
/**
 * The whole point of the projects screen: work survives being closed.
 *
 * Saving the footage itself is not an option — these are hour-long recordings —
 * so a project records where each file lives and reopens it from there. This
 * saves a real timeline with real video on it, throws the document away, and
 * checks that reopening brings back the clips AND footage that still decodes.
 */
/**
 * Transitions really composite two shots, not one shot and a guess.
 *
 * Mid-transition the outgoing clip is still being decoded past its own cut, so
 * the frame is a genuine blend. Each style has to look different from a hard
 * cut AND from the others, or they are decoration rather than transitions.
 */
/**
 * A decoder asked for while the pool is full has to survive being asked for.
 *
 * The eviction pass picks the least recently used decoder. A record created
 * with lastUsed:0 is, by that measure, the oldest thing in the pool — so once
 * the pool was full it destroyed each new decoder immediately after building
 * it, and the clip that needed it never showed a frame. From the outside that
 * is indistinguishable from footage that will not decode.
 */
await step('a new clip still decodes when the pool is already full', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp } = window.gc;
    const src = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    if (!src) return { error: 'no video clip' };

    // Six distinct transports off one asset — more than the pool holds, so the
    // last few are all asked for with the pool already at its ceiling.
    const made = [];
    for (let i = 0; i < 6; i++) {
      made.push({ ...JSON.parse(JSON.stringify(src)), id: 'pool_' + i, start: i * 0.37, duration: 1 });
    }
    for (const c of made) comp.pool.frameFor(c, c.start + 0.1, false);

    const last = made[made.length - 1];
    const el = comp.pool.elementFor(last);
    const hasSrc = !!(el && el.getAttribute('src'));

    // And it actually arrives, rather than merely being pointed at a file.
    let ready = el?.readyState || 0;
    for (let i = 0; i < 40 && ready < 2; i++) {
      await new Promise(res => setTimeout(res, 100));
      comp.pool.frameFor(last, last.start + 0.1, false);
      ready = comp.pool.elementFor(last)?.readyState || 0;
    }
    for (const c of made) comp.pool.release(c);
    return { hasSrc, ready, live: document.querySelectorAll('#gc-decoder-host video').length };
  });
  if (r.error) throw new Error(r.error);
  if (!r.hasSrc) throw new Error('the newest decoder was stripped of its source — it was evicted on creation');
  if (r.ready < 2) throw new Error('the newest decoder never became ready (readyState ' + r.ready + ')');
});

await step('the three transitions each render differently', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, cmds, playback } = window.gc;
    const vids = store.doc.tracks.flatMap(tr => tr.clips.map(c => ({ c, tr })))
      .filter(x => x.c.type === 'video' && !x.c.crop);
    if (vids.length < 1) return { error: 'no video clips' };

    // Two shots, cut flush together on one track, so there is something to
    // transition FROM.
    const track = vids[0].tr;
    const a = vids[0].c;
    a.start = 0; a.duration = 2;

    // Only this track is on screen. By this point the suite has left cropped
    // layers and spare clips lying around on other tracks; with more live
    // decoders than the pool keeps, a frame can be abandoned for a starved
    // layer that has nothing to do with the transition, and an abandoned frame
    // leaves the canvas showing the previous sample — which reads as "these two
    // transitions drew the same thing" when neither of them drew at all.
    const hidden = [];
    for (const tr of store.doc.tracks) {
      if (tr === track || tr.kind === 'audio') continue;
      if (!tr.hidden) { tr.hidden = true; hidden.push(tr); }
    }
    const b = JSON.parse(JSON.stringify(a));
    b.id = 'clip_trans_b'; b.start = 2; b.duration = 2; b.transIn = null;
    track.clips = track.clips.filter(c => c.id !== b.id);
    track.clips.push(b);
    track.clips.sort((x, y) => x.start - y.start);
    store.docChanged();

    const { assets: A } = await import('/src/media/asset-store.js');
    const asset = (c) => A.get(c.assetId);
    const allAssets = () => A.all().map(x => ({ id: x.id, name: x.name, url: (x.url || '').slice(0, 14), missing: !!x.missing }));

    // A transition straddles its cut, so the moment of the cut IS its midpoint:
    // half the outgoing shot, half the incoming one, and for a dip, black.
    const t = 2.0;
    const sample = async (kind, dir) => {
      b.transIn = kind === 'none' ? null : { kind, dur: 0.45, dir: dir || 'left' };
      playback.seek(t);
      await new Promise(r => setTimeout(r, 1400));
      // A render that gets abandoned leaves the last picture up, and comparing
      // two of those would pass or fail for reasons nothing to do with the
      // transition. Insist on a real paint.
      let painted = comp.render(t, false);
      for (let i = 0; i < 40 && !painted; i++) {
        await new Promise(r => setTimeout(r, 120));
        painted = comp.render(t, false);
      }
      if (!painted) {
        const el = comp.pool.elementFor(b);
        const act = comp.activeClips(t).map(x => ({ id: x.c?.id || x.clip.id, type: x.clip.type,
          track: x.track.name, hidden: x.track.hidden }));
        throw new Error('the compositor never painted a ' + kind + ' frame — ' + JSON.stringify({
          ready: el?.readyState, net: el?.networkState, err: el?.error?.code,
          src: (el?.currentSrc || '').slice(0, 28), ct: el?.currentTime,
          assetId: b.assetId, assetUrl: (asset(b) || {}).url || null,
          assetMissing: (asset(b) || {}).missing || false,
          knownAssets: allAssets(), active: act,
          liveEls: document.querySelectorAll('#gc-decoder-host video').length,
          allVideoEls: document.querySelectorAll('video').length,
          fetchStatus: await fetch((asset(b) || {}).url, { headers: { Range: 'bytes=0-99' } })
            .then(r => r.status).catch(e => 'THREW ' + e.message),
        }));
      }
      const c = comp.canvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261, lum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 11) {
        h ^= d[i] + d[i+1] * 3 + d[i+2] * 7; h = Math.imul(h, 16777619);
        lum += d[i] + d[i+1] + d[i+2]; n++;
      }
      return { hash: h >>> 0, lum: Math.round(lum / n) };
    };

    const out = {};
    out.cut = await sample('none');
    out.dissolve = await sample('dissolve');
    out.slide = await sample('slide', 'left');
    // Sampled at the cut itself, which is where a dip must be at its darkest.
    b.transIn = { kind: 'dip', dur: 0.45 };
    playback.seek(t);
    await new Promise(r => setTimeout(r, 1400));
    let dipPainted = comp.render(t, false);
    for (let i = 0; i < 40 && !dipPainted; i++) {
      await new Promise(r => setTimeout(r, 120));
      dipPainted = comp.render(t, false);
    }
    const dd = comp.canvas.getContext('2d')
      .getImageData(0, 0, comp.canvas.width, comp.canvas.height).data;
    let dl = 0, dn = 0;
    for (let i = 0; i < dd.length; i += 4 * 11) { dl += dd[i] + dd[i+1] + dd[i+2]; dn++; }
    out.dipMid = Math.round(dl / dn);

    b.transIn = null;
    for (const tr of hidden) tr.hidden = false;
    store.docChanged();
    return out;
  });

  if (r.error) throw new Error(r.error);
  if (r.dissolve.hash === r.cut.hash) throw new Error('dissolve drew the same frame as a hard cut');
  if (r.slide.hash === r.cut.hash) throw new Error('slide drew the same frame as a hard cut');
  if (r.slide.hash === r.dissolve.hash) throw new Error('slide and dissolve drew the same frame');
  if (!(r.dipMid < r.cut.lum * 0.5)) {
    throw new Error(`dip to black is not dark at its midpoint (${r.dipMid} vs cut ${r.cut.lum})`);
  }
  console.log(`     cut ${r.cut.lum} · dissolve/slide distinct · dip midpoint ${r.dipMid}`);
});

/**
 * Export prepares the outgoing side of a transition too.
 *
 * The export loop decodes each frame before painting it, off a list of clips.
 * That list used to be "what is active now", which excludes the shot being cut
 * away from — so the preview looked right and the exported file did not. This
 * asserts the list the renderer actually asks for.
 */
await step('a transition tells the renderer about both shots', async () => {
  const r = await win.evaluate(() => {
    const { store, comp } = window.gc;
    const track = store.doc.tracks.find(t => t.clips.filter(c => c.type === 'video').length >= 2);
    if (!track) return { error: 'need two video clips on one track' };
    const [a, b] = [...track.clips].filter(c => c.type === 'video').sort((x, y) => x.start - y.start);
    a.start = 0; a.duration = 2;
    b.start = 2; b.duration = 2;
    b.transIn = { kind: 'dissolve', dur: 0.45 };
    store.docChanged();
    const mid = comp.clipsNeededAt(2.2).map(c => c.id);
    const after = comp.clipsNeededAt(3.0).map(c => c.id);
    b.transIn = null;
    store.docChanged();
    return { mid, after, a: a.id, b: b.id };
  });
  if (r.error) throw new Error(r.error);
  if (!r.mid.includes(r.b)) throw new Error('the incoming clip is not in the render list');
  if (!r.mid.includes(r.a)) throw new Error('the outgoing clip is missing mid-transition');
  if (r.after.includes(r.a)) throw new Error('the outgoing clip is still asked for after the transition ends');
});

/**
 * The transition preview shows your footage, not a diagram.
 *
 * Everything about this feature is only worth having if the two pictures in it
 * are the two shots either side of your own cut. A preview that quietly fell
 * back to coloured panels would still animate, still look plausible, and tell
 * you nothing — so this checks the captured frames came from the video and that
 * the picture genuinely changes across the transition.
 */
await step('the transition preview runs on the real frames of the cut', async () => {
  const setup = await win.evaluate(async () => {
    const { store, cmds, playback, transitions } = window.gc;
    const src = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video' && !c.crop);
    if (!src) return { error: 'no video clip' };

    // Two shots off the same footage, cut flush, taken from far apart in the
    // file so their frames cannot look the same by accident.
    const track = store.doc.tracks.find(t => t.clips.includes(src));
    for (const t of store.doc.tracks) t.clips.length = 0;
    const mk = (name, start, inPoint) => ({
      ...JSON.parse(JSON.stringify(src)),
      id: 'prev_' + name, name, start, duration: 2, inPoint, transIn: null, crop: null,
    });
    const a = mk('Shot A', 0, 0);
    const b = mk('Shot B', 2, Math.max(0, Math.min(4, (src.sourceDuration || 5) - 1.5)));
    b.transIn = { kind: 'dissolve', dur: 0.6, dir: 'left' };
    track.clips.push(a, b);
    store.docChanged('preview test');
    store.setRT({ junction: b.id });
    playback.seek(2);
    // The panel deliberately does not fetch frames while its tab is hidden —
    // seeking a decoder for a canvas nobody can see is exactly the kind of work
    // that used to freeze playback. So open it, the way a person would.
    document.querySelector('#leftTabs [data-tab="trans"]')?.click();
    transitions.refresh();
    await new Promise(r => setTimeout(r, 2500));
    return { ok: true, onScreen: !!document.querySelector('#leftPanel .tabpane[data-pane="trans"]')?.classList.contains('is-active') };
  });
  if (setup.error) throw new Error(setup.error);
  if (!setup.onScreen) throw new Error('the transitions tab did not come forward');

  const r = await win.evaluate(async () => {
    const cv = document.getElementById('transPreview');
    if (!cv) return { error: 'no preview canvas' };
    const has = window.gc.transitions.preview.hasFrames;
    const captured = window.gc.transitions.preview.captured;

    // Sample the canvas while it is holding the first shot, then again once the
    // loop has carried it all the way to the second.
    const grab = () => {
      const c = document.createElement('canvas');
      c.width = cv.width; c.height = cv.height;
      c.getContext('2d').drawImage(cv, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0, n = 0, lit = 0;
      for (let i = 0; i < d.length; i += 4 * 13) {
        sum += d[i] + d[i + 1] + d[i + 2]; n++;
        if (d[i] + d[i + 1] + d[i + 2] > 40) lit++;
      }
      return { avg: Math.round(sum / n), lit };
    };

    const shots = [];
    for (let i = 0; i < 16; i++) {
      shots.push(grab());
      await new Promise(res => setTimeout(res, 90));
    }
    return { has, captured, shots, w: cv.width, h: cv.height };
  });

  if (r.error) throw new Error(r.error);
  if (!r.has) throw new Error('the preview never captured any frames from the cut');
  if (!r.captured.a) throw new Error('the outgoing shot was never captured — the preview is running on one frame');
  if (!r.captured.b) throw new Error('the incoming shot was never captured — the preview is running on one frame');
  if (!r.w || !r.h) throw new Error(`preview canvas is ${r.w}x${r.h}`);

  const lit = r.shots.filter(s => s.lit > 0).length;
  if (!lit) throw new Error('the preview canvas stayed blank for the whole loop');

  const avgs = r.shots.map(s => s.avg);
  const spread = Math.max(...avgs) - Math.min(...avgs);
  if (spread < 3)
    throw new Error(`the preview never changed across a 1.4s window (brightness ${avgs.join(',')}) — it is not animating`);
  console.log(`     preview ${r.w}\u00d7${r.h} \u00b7 brightness moved ${Math.min(...avgs)}\u2192${Math.max(...avgs)} over the loop`);
});

/**
 * Taking a clip's audio out onto its own track.
 *
 * The sound and the picture were welded together: there was no way to fade the
 * audio of one shot under the next, or to keep a moment's sound while cutting
 * away from it. This checks the real thing — a real audio clip on a real audio
 * track, pointing at the same imported file with the same in-point — and that
 * the video clip goes silent so the two do not play over each other slightly
 * out of phase, which sounds like a broken file rather than a doubled one.
 */
await step('a clip\'s audio can be lifted onto its own track', async () => {
  const r = await win.evaluate(async () => {
    const { audibleClips } = await import('/src/audio/graph.js');
    const { store, cmds } = window.gc;
    const src = store.doc.tracks.flatMap(t => t.clips)
      .find(c => c.type === 'video' && !c.crop && !c.silent);
    if (!src) return { error: 'no ordinary video clip to work with' };

    const before = audibleClips(store).filter(c => c.clip.id === src.id).length;
    const res = cmds.extractAudio(src.id);
    if (!res?.ok) return { error: 'extractAudio said: ' + (res?.reason || 'nothing') };

    const made = res.clip;
    const host = store.doc.tracks.find(t => t.id === made.trackId);
    const audible = audibleClips(store);
    return {
      before,
      madeType: made.type,
      hostKind: host?.kind,
      sameAsset: made.assetId === src.assetId,
      sameStart: Math.abs(made.start - src.start) < 1e-6,
      sameIn: Math.abs(made.inPoint - src.inPoint) < 1e-6,
      sameLen: Math.abs(made.duration - src.duration) < 1e-6,
      videoSilent: !!src.silent,
      videoStillAudible: audible.some(c => c.clip.id === src.id),
      newIsAudible: audible.some(c => c.clip.id === made.id),
      selected: store.rt.selection.includes(made.id),
      srcId: src.id, madeId: made.id,
    };
  });
  if (r.error) throw new Error(r.error);
  if (!r.before) throw new Error('the video clip was not audible to begin with — nothing to prove');
  if (r.madeType !== 'audio') throw new Error('made a ' + r.madeType + ' clip');
  if (r.hostKind !== 'audio') throw new Error('it landed on a ' + r.hostKind + ' track');
  if (!r.sameAsset) throw new Error('it points at a different file');
  if (!r.sameStart || !r.sameIn || !r.sameLen) throw new Error('it is not lined up with the picture');
  if (!r.videoSilent) throw new Error('the video clip was not silenced — the sound would double');
  if (r.videoStillAudible) throw new Error('the video clip is still being scheduled');
  if (!r.newIsAudible) throw new Error('the new audio clip makes no sound');
  if (!r.selected) throw new Error('the new clip was not selected, so it is hard to find');

  // And it undoes in one step, like everything else.
  const undone = await win.evaluate(async () => {
    window.gc.history.undo();
    await new Promise(res => setTimeout(res, 150));
    const { store } = window.gc;
    const all = store.doc.tracks.flatMap(t => t.clips);
    const src = all.find(c => c.type === 'video' && !c.crop);
    return { gone: !all.some(c => c.type === 'audio' && c.name.endsWith('audio')),
             loud: !src?.silent };
  });
  if (!undone.gone) throw new Error('undo left the extracted audio behind');
  if (!undone.loud) throw new Error('undo left the video clip silenced');

  // Put it back so the rest of the suite sees a normal clip.
  await win.evaluate(() => window.gc.history.redo());
  await win.evaluate(() => window.gc.history.undo());
});

/**
 * A drawn crop masks to the shape, not the box around it.
 *
 * The shape is stored beside the rectangle rather than instead of it, so this
 * checks the two disagree in the picture: a triangle inside a box must paint
 * fewer pixels than the box alone.
 */
await step('a drawn crop shape masks the picture', async () => {
  const r = await win.evaluate(async () => {
    const { store, comp, cmds, playback } = window.gc;
    const src = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video' && !c.crop);
    if (!src) return { error: 'no source clip' };

    const made = cmds.cropClip(src.id, {
      crop: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 },
      transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
    });
    if (!made) return { error: 'crop failed' };

    playback.seek(src.start + 0.4);
    await new Promise(r => setTimeout(r, 1600));

    // Hide everything else so only the cropped layer is on the canvas.
    const hidden = [];
    for (const tr of store.doc.tracks) {
      if (tr.clips.some(c => c.id === made.id)) continue;
      if (!tr.hidden) { tr.hidden = true; hidden.push(tr); }
    }

    const lit = () => {
      comp.render(store.rt.playhead, false);
      const c = comp.canvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) if (d[i] + d[i+1] + d[i+2] > 60) n++;
      return n;
    };

    const box = lit();
    // A triangle covering roughly half the crop box.
    made.crop.shape = [[0.2, 0.2], [0.7, 0.2], [0.2, 0.7]];
    const shaped = lit();

    for (const tr of hidden) tr.hidden = false;
    return { box, shaped };
  });

  if (r.error) throw new Error(r.error);
  if (!(r.box > 0)) throw new Error('the cropped layer painted nothing to begin with');
  if (!(r.shaped < r.box * 0.85)) {
    throw new Error(`the drawn shape did not mask anything (${r.shaped} lit vs ${r.box} for the box)`);
  }
  console.log(`     box ${r.box} lit → triangle ${r.shaped} lit`);
});

await step('a project saves and reopens with its footage', async () => {
  const saved = await win.evaluate(async () => {
    const { library, store } = window.gc;
    store.doc.name = 'Round Trip Test';
    const before = {
      clips: store.doc.tracks.reduce((n, t) => n + t.clips.length, 0),
      videos: store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'video').length,
    };
    const r = await library.save({ silent: true });
    return { ok: !!r?.ok, id: library.id, before };
  });
  if (!saved.ok) throw new Error('save failed');
  if (!saved.before.videos) throw new Error('nothing worth round-tripping on the timeline');

  // It has to be listed, or the home screen could never show it.
  const listed = await win.evaluate(async () => {
    const list = await window.gamecut.listProjects();
    return list.map(p => ({ id: p.id, name: p.name, clips: p.clips, thumb: !!p.thumb }));
  });
  const mine = listed.find(p => p.id === saved.id);
  if (!mine) throw new Error('saved project is not in the library listing');
  if (mine.name !== 'Round Trip Test') throw new Error('wrong name stored: ' + mine.name);
  if (!mine.thumb) throw new Error('no preview picture saved for the card');

  // Wipe the document the way opening something else would, then reopen.
  const after = await win.evaluate(async (id) => {
    const { library, store, comp, playback } = window.gc;
    const { makeProject } = await import('app://gamecut/src/core/schema.js');
    const { ASPECTS } = await import('app://gamecut/src/project/presets.js');
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    store.replaceDoc(makeProject(ASPECTS['16:9']));
    assets.clear();

    const r = await library.open(id);
    if (!r.ok) return { error: r.reason };

    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    if (!clip) return { error: 'no video clip came back' };
    const a = assets.get(clip.assetId);

    // And the footage must actually decode again, not merely be listed.
    playback.seek(clip.start + Math.min(1, clip.duration / 2));
    await new Promise(r => setTimeout(r, 2500));
    const t = store.rt.playhead;
    comp.render(t, false);
    const c = comp.canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 89) seen.add(`${d[i] >> 5},${d[i+1] >> 5},${d[i+2] >> 5}`);

    return {
      name: r.name, missing: r.missing,
      clips: store.doc.tracks.reduce((n, tr) => n + tr.clips.length, 0),
      url: String(a?.url || ''),
      path: !!a?.path,
      colours: seen.size,
    };
  }, saved.id);

  if (after.error) throw new Error(after.error);
  if (after.missing) throw new Error(`${after.missing} file(s) went missing across the round trip`);
  if (after.clips !== saved.before.clips) {
    throw new Error(`came back with ${after.clips} clips, saved ${saved.before.clips}`);
  }
  if (!after.url.startsWith('gcmedia://')) throw new Error('reopened media is not streamed from disk: ' + after.url);
  if (!after.path) throw new Error('the asset lost the path to its file');
  if (after.colours < 8) {
    throw new Error(`reopened footage did not decode — ${after.colours} distinct colours on the canvas`);
  }
  console.log(`     saved, wiped, reopened: ${after.clips} clips · footage decoding (${after.colours} colours)`);
});

await step('moved footage is reported, not silently dropped', async () => {
  const r = await win.evaluate(async () => {
    const { library } = window.gc;
    const before = library.id;
    // Save a project whose asset points at a file that is not there.
    const fake = {
      id: 'gone_' + Date.now().toString(36),
      name: 'Missing Media Test',
      doc: window.gc.store.doc,
      assets: [{ id: 'a_gone', kind: 'video', name: 'deleted.mp4',
                 path: '/definitely/not/here/deleted.mp4', duration: 5, width: 640, height: 360 }],
      duration: 5, clips: 1, thumb: null,
    };
    await window.gamecut.saveProject(fake);
    const opened = await library.open(fake.id);
    await window.gamecut.deleteProject(fake.id);
    return { missing: opened.missing, ok: opened.ok, before };
  });
  if (!r.ok) throw new Error('a project with missing media should still open');
  if (r.missing !== 1) throw new Error(`expected 1 missing file, got ${r.missing}`);
});

await step('closes cleanly', () => app.close());

await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`MEDIA FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
} else {
  console.log('MEDIA PASSED — video imports, places, paints and plays its sound.');
}
