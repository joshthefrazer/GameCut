/**
 * Core application suite.
 *
 * Runs inside the real Electron shell. It used to drive a Chromium page against
 * a localhost dev server, but that server no longer ships — and testing a
 * configuration the user never runs is how an mp4 came to "fail" here while
 * working perfectly in the actual app. Same checks, real target.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const SHOT = process.argv[2] || '/tmp/gamecut-shots';

const problems = [];
const log = (t, m) => { problems.push(`${t}: ${m}`); console.log(`  !! ${t}: ${m}`); };

// Throwaway profile — a stale Chromium SingletonLock from an unclean exit makes
// the next launch quit before it opens a window.
const PROFILE = `/tmp/gamecut-qa-core-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
         `--user-data-dir=${PROFILE}`],
  cwd: ROOT,
  timeout: 60_000,
});
const page = await app.firstWindow();

// `willReadFrequently` is provoked by this harness reading pixels off the app's
// canvases to assert they painted — the app itself never calls getImageData.
const IGNORE = /deprecat|Autoplay|AudioContext|willReadFrequently/i;
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error') log('console.error', m.text());
  else if (t === 'warning' && !IGNORE.test(m.text())) log('console.warn', m.text());
});
page.on('pageerror', (e) => log('pageerror', e.message));
page.on('requestfailed', (r) => {
  if (!/favicon/.test(r.url())) log('requestfailed', `${r.url()} — ${r.failure()?.errorText}`);
});

const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { log('THREW in ' + name, e.message); }
  await sleep(120);
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── boot ─────────────────────────────────');
await page.waitForLoadState('domcontentloaded');
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
await enterEditor(page);

/**
 * Build a starting timeline.
 *
 * A new project is empty now — the app used to drop a demo title in every time,
 * which is noise once there is a real projects screen to open work from. The
 * suite therefore makes its own, through the same commands the interface uses.
 */
await page.evaluate(async () => {
  const { makeClip } = await import('app://gamecut/src/core/schema.js');
  const { store, cmds, history } = window.gc;
  const text = store.doc.tracks.filter(t => t.kind === 'text');
  const video = store.doc.tracks.find(t => t.kind === 'video');

  const title = makeClip('text', { name: 'Title', start: 0.4, duration: 2.6 });
  title.text.text = 'CLUTCH\nMOMENT';
  title.transform.y = 0.42;
  title.keys['transform.scale'] = [{ t: 0, v: 0.86, e: 'back' }, { t: 0.32, v: 1, e: 'ease' }];

  const sub = makeClip('text', { name: 'Subtitle', start: 0.9, duration: 2.1 });
  sub.text.text = 'roblox cinematic';
  sub.transform.y = 0.6;
  sub.fadeIn = 0.25; sub.fadeOut = 0.35;

  const strip = makeClip('shape', {
    name: 'Neon Strip', start: 0.9, duration: 2.1,
    shape: { kind: 'rect', fill: ['#22d3ee', '#2563eb'], radius: 0.004 },
  });
  strip.transform.y = 0.545; strip.transform.w = 0.22; strip.transform.h = 0.0035;

  cmds.addClip(text[0].id, title, { select: false, label: 'Seed' });
  cmds.addClip(text[1].id, sub, { select: false, label: 'Seed' });
  if (video) cmds.addClip(video.id, strip, { select: false, label: 'Seed' });
  history.reset();
  store.select([title.id]);
  window.gc.playback.seek(0.9);
  window.gc.timeline.repaint();
});
await sleep(400);


// Sanity: did the app actually mount?
await step('app mounted', async () => {
  const has = await page.evaluate(() => !!window.gc?.store);
  if (!has) throw new Error('window.gc.store missing — main.js did not run');
});

await step('theme loaded from tokens.css', async () => {
  const th = await page.evaluate(async () => {
    const m = await import('app://gamecut/src/ui/theme.js');
    return { lane: m.TH.lane, acc: m.TH.acc, playhead: m.TH.playhead };
  });
  if (!th.lane || !th.acc) throw new Error('TH not populated: ' + JSON.stringify(th));
  if (th.lane.includes('rgba(37,99,235') ) throw new Error('lane fell back unexpectedly');
});

/**
 * The interface must not cost anything per frame.
 *
 * The worst bug in this project was not in the decoder or the compositor: it
 * was three 120px-blurred circles animating forever behind five panels that
 * each carried a backdrop-filter. The window was blurring itself continuously,
 * at a price that grew with its own size, and the tell was that shrinking the
 * window made playback smooth. An empty rAF loop measured 5fps with all that
 * alive and 60fps without it.
 *
 * Both are the kind of thing that gets added back for the look of it, so they
 * are asserted against here rather than trusted to memory.
 */
await step('no live blur effects in the interface', async () => {
  const bad = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const name = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${el.className || '?'}`;

      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (bf && bf !== 'none') out.push(`${name} backdrop-filter:${bf}`);

      // A blur that animates can never be cached; a static one is rasterized
      // once and is fine.
      const animated = cs.animationName !== 'none' && cs.animationIterationCount === 'infinite';
      if (animated && /blur\(/.test(cs.filter || '')) out.push(`${name} animated ${cs.filter}`);

      // Any infinite animation on something large keeps the compositor awake
      // for the life of the app.
      if (animated) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height > 40000) out.push(`${name} infinite animation over ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
  if (bad.length) throw new Error(bad.join('; '));
});

/**
 * Every word on screen has to be readable against what is behind it.
 *
 * A retheme breaks this silently and in exactly one way: a surface keeps its
 * old colour while the text on it flips. The track names went white on a
 * leftover near-white strip that way — a contrast ratio of 1.06, which is
 * invisible, and nothing else would have caught it.
 */
await step('nothing is written in a colour you cannot read', async () => {
  const bad = await page.evaluate(() => {
    const lum = (c) => {
      const m = c.match(/[\d.]+/g);
      if (!m) return null;
      // Fully transparent text is deliberate — the gradient look paints its
      // letters through background-clip and has no text colour of its own.
      if (m.length > 3 && +m[3] < 0.1) return null;
      const f = m.slice(0, 3).map(v => {
        v = +v / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    };
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const b = getComputedStyle(n).backgroundColor;
        const m = b.match(/[\d.]+/g);
        if (m && (m.length < 4 || +m[3] > 0.6)) return b;
      }
      return getComputedStyle(document.body).backgroundColor;
    };

    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim()).join('');
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.3) continue;
      const a = lum(cs.color), b = lum(bgOf(el));
      if (a === null || b === null) continue;
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      // 2.5:1 is well below the accessibility bar and deliberately so — this is
      // catching "invisible", not grading the palette.
      if (ratio < 2.5) out.push(`"${own.slice(0, 20)}" on .${el.className || el.tagName} at ${ratio.toFixed(2)}:1`);
    }
    return [...new Set(out)];
  });
  if (bad.length) throw new Error(bad.slice(0, 6).join('; '));
});

await step('seed clips present', async () => {
  const n = await page.evaluate(() =>
    window.gc.store.doc.tracks.reduce((a, t) => a + t.clips.length, 0));
  if (n < 3) throw new Error(`expected >=3 seeded clips, got ${n}`);
});

await step('preview canvas painted (non-blank)', async () => {
  const px = await page.evaluate(() => {
    const c = document.getElementById('previewCanvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i+1] + d[i+2] > 24) nonBlack++;
    return nonBlack;
  });
  if (px < 5) throw new Error('preview looks blank (' + px + ' lit samples)');
});

await step('timeline canvas painted', async () => {
  const px = await page.evaluate(() => {
    const c = document.getElementById('timelineCanvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i+3] > 8) lit++;
    return lit;
  });
  if (px < 50) throw new Error('timeline looks blank');
});

console.log('\n── transport ────────────────────────────');
await step('play', async () => { await page.click('#btnPlay'); await sleep(700); });
await step('playhead advanced', async () => {
  const t = await page.evaluate(() => window.gc.store.rt.playhead);
  if (t <= 0.9) throw new Error('playhead did not advance: ' + t);
});
await step('pause', () => page.click('#btnPlay'));
await step('frame step fwd', () => page.click('#btnNextFrame'));
await step('frame step back', () => page.click('#btnPrevFrame'));
await step('go to end', () => page.click('#btnEnd'));
await step('go to start', () => page.click('#btnStart'));
await step('play/pause state is visible', async () => {
  // Read what is RENDERED, never the `hidden` property: these icons are <svg>,
  // and SVGElement has no `hidden` IDL member, so `el.hidden` reports a JS
  // expando that can disagree with the attribute and with the screen. Asserting
  // the property is how the broken icon swap passed this test once already.
  const read = () => page.evaluate(() => {
    const vis = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none';
    return {
      playing: window.gc.store.rt.playing,
      pressed: document.getElementById('btnPlay').getAttribute('aria-pressed'),
      chip: document.getElementById('playState')?.dataset.playing,
      label: document.getElementById('playState')?.querySelector('.playstate__label')?.textContent,
      playIcon: vis('#btnPlay .ico-play'),
      pauseIcon: vis('#btnPlay .ico-pause'),
      title: document.getElementById('btnPlay').getAttribute('aria-label') || document.getElementById('btnPlay').title,
    };
  });

  const idle = await read();
  if (idle.playing) throw new Error('expected to start paused');
  if (idle.pressed !== 'false' || idle.chip !== 'false') throw new Error('paused state not reflected: ' + JSON.stringify(idle));
  if (!idle.playIcon || idle.pauseIcon) throw new Error('wrong icon while paused');
  if (!/paused/i.test(idle.label)) throw new Error('label reads ' + idle.label);
  if (!/play/i.test(idle.title)) throw new Error('title reads ' + idle.title);

  await page.click('#btnPlay');
  await sleep(400);
  const on = await read();
  if (!on.playing) throw new Error('did not start playing');
  if (on.pressed !== 'true' || on.chip !== 'true') throw new Error('playing state not reflected: ' + JSON.stringify(on));
  if (on.playIcon || !on.pauseIcon) throw new Error('icon did not swap to pause');
  if (!/playing/i.test(on.label)) throw new Error('label reads ' + on.label);
  if (!/pause/i.test(on.title)) throw new Error('title reads ' + on.title);

  await page.click('#btnPlay');
  await sleep(300);
  const off = await read();
  if (off.playing || off.pressed !== 'false' || off.chip !== 'false') {
    throw new Error('did not return to paused: ' + JSON.stringify(off));
  }
});

// The actual enter/exit is asserted in the Electron suite, against a real
// window; headless Chromium's requestFullscreen can hang indefinitely. Here we
// only check the control is wired, which is cheap and catches a missing button.
await step('fullscreen control is wired', async () => {
  const r = await page.evaluate(() => {
    const b = document.getElementById('btnFullscreen');
    return {
      exists: !!b,
      enter: !!b?.querySelector('.ico-fsEnter'),
      exit: !!b?.querySelector('.ico-fsExit'),
      title: b?.getAttribute('aria-label') || b?.title || '',
      api: typeof document.getElementById('previewPanel')?.requestFullscreen === 'function',
    };
  });
  if (!r.exists) throw new Error('no fullscreen button');
  if (!r.enter || !r.exit) throw new Error('fullscreen icons missing');
  if (!/fullscreen/i.test(r.title)) throw new Error('button not labelled: ' + r.title);
  if (!r.api) throw new Error('preview panel cannot request fullscreen');
});

await step('loop toggle', () => page.click('#btnLoop'));
await step('mute toggle', () => page.click('#btnMute'));
await step('volume slider', () => page.fill('#masterVol', '40'));

console.log('\n── aspect ratios ────────────────────────');
for (const ar of ['9:16', '1:1', '4:5', '16:9']) {
  await step(`aspect → ${ar}`, async () => {
    await page.click(`#aspectSeg [data-ar="${ar}"]`);
    await sleep(320);
    const d = await page.evaluate(() => ({ w: window.gc.store.doc.width, h: window.gc.store.doc.height }));
    const want = { '16:9': [1920,1080], '9:16': [1080,1920], '1:1': [1080,1080], '4:5': [1080,1350] }[ar];
    if (d.w !== want[0] || d.h !== want[1]) throw new Error(`got ${d.w}x${d.h} want ${want}`);
  });
}

// Regression: the active pill used to be set at click time, so undoing a
// resolution change left the top bar claiming 9:16 on a 1920×1080 project.
await step('aspect pill follows undo/redo', async () => {
  await page.click('#aspectSeg [data-ar="16:9"]');
  await sleep(200);
  await page.click('#aspectSeg [data-ar="9:16"]');
  await sleep(250);
  await page.click('#btnUndo');
  await sleep(300);

  const r = await page.evaluate(() => ({
    aspect: window.gc.store.doc.aspect,
    w: window.gc.store.doc.width,
    lit: [...document.querySelectorAll('#aspectSeg .seg__btn')]
      .filter(b => b.classList.contains('is-active')).map(b => b.dataset.ar),
    chip: document.getElementById('resChip').textContent.trim(),
  }));
  if (r.lit.length !== 1 || r.lit[0] !== r.aspect) {
    throw new Error(`pill "${r.lit}" disagrees with doc.aspect "${r.aspect}"`);
  }
  if (!r.chip.startsWith(String(r.w))) {
    throw new Error(`res chip "${r.chip}" disagrees with doc width ${r.w}`);
  }
  await page.click('#btnRedo');
  await sleep(250);
  const after = await page.evaluate(() => ({
    aspect: window.gc.store.doc.aspect,
    lit: [...document.querySelectorAll('#aspectSeg .seg__btn')]
      .filter(b => b.classList.contains('is-active')).map(b => b.dataset.ar),
  }));
  if (after.lit[0] !== after.aspect) {
    throw new Error(`after redo: pill "${after.lit}" vs doc "${after.aspect}"`);
  }
  await page.click('#aspectSeg [data-ar="16:9"]');
  await sleep(200);
});

await step('text stays inside frame after reframe', async () => {
  const bad = await page.evaluate(() => {
    const { store, comp } = window.gc;
    const out = [];
    for (const tr of store.doc.tracks) for (const c of tr.clips) {
      if (c.type !== 'text') continue;
      const b = comp.bounds(c, c.start + 0.01);
      if (b.w > 1.6 || b.h > 1.6) out.push([c.name, +b.w.toFixed(2), +b.h.toFixed(2)]);
    }
    return out;
  });
  if (bad.length) throw new Error('text overflows frame: ' + JSON.stringify(bad));
});

console.log('\n── timeline ops ─────────────────────────');
await step('zoom slider', () => page.fill('#zoomRange', '700'));
await step('zoom fit', () => page.click('#btnZoomFit'));
await step('select first clip', async () => {
  await page.evaluate(() => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips)[0];
    window.gc.store.select([c.id]);
  });
});
await step('split at playhead', async () => {
  await page.evaluate(() => window.gc.playback.seek(1.4));
  await sleep(80);
  await page.click('#btnSplit');
});
await step('duplicate', () => page.click('#btnDuplicate'));
await step('add text clip', () => page.click('#btnAddText'));
await step('add marker', () => page.click('#btnMarker'));
await step('ripple toggle', () => page.click('#btnRipple'));
await step('magnet toggle', async () => { await page.click('#btnMagnet'); await page.click('#btnMagnet'); });
await step('beat grid on', () => page.click('#btnBeatGrid'));
await step('bpm change', async () => { await page.fill('#bpmInput', '174'); await page.press('#bpmInput', 'Enter'); });
await step('tap tempo x4', async () => {
  for (let i = 0; i < 4; i++) { await page.click('#btnTapTempo'); await sleep(90); }
});
await step('delete selection', () => page.click('#btnDelete'));

console.log('\n── text ─────────────────────────────────');

await step('text panel leads with looks, not numbers', async () => {
  await page.evaluate(() => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'text');
    window.gc.store.select([c.id]);
    window.gc.playback.seek(c.start + 0.05);
  });
  await sleep(320);
  const r = await page.evaluate(() => {
    const root = document.getElementById('inspectorRoot');
    const groups = [...root.querySelectorAll('.group__h')].map(g => g.textContent.trim());
    return {
      groups,
      looks: root.querySelectorAll('.look').length,
      firstTextGroup: groups.find(g => /Words|Looks/.test(g)),
      hasSave: [...root.querySelectorAll('button')].some(b => /Save this look/.test(b.textContent)),
    };
  });
  if (r.looks < 6) throw new Error(`only ${r.looks} looks offered`);
  if (!r.hasSave) throw new Error('no way to save your own look');
  if (!/Words|Looks/.test(r.firstTextGroup || '')) throw new Error('text panel does not lead with the words/looks');
  console.log(`     ${r.looks} looks · sections: ${r.groups.join(', ')}`);
});

await step('clicking a look changes the picture but keeps the words', async () => {
  const r = await page.evaluate(async () => {
    const { store, comp } = window.gc;
    const clip = store.selectedClips[0].clip;
    const words = clip.text.text;
    const t = clip.start + 0.05;

    const sample = () => {
      comp.render(t, false);
      const c = comp.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4 * 29) { h ^= d[i] + d[i+1] * 3 + d[i+2] * 7; h = Math.imul(h, 16777619); }
      return h >>> 0;
    };

    const before = sample();
    const looks = [...document.querySelectorAll('#inspectorRoot .look')];
    // "Neon" and "Subtitle" are visually about as far apart as the set goes.
    const pick = looks.find(b => /Neon/.test(b.textContent)) || looks[2];
    pick.click();
    await new Promise(r => setTimeout(r, 260));
    const after = sample();

    return { before, after, words, stillWords: clip.text.text,
             glow: clip.text.glow, anim: clip.text.anim };
  });
  if (r.before === r.after) throw new Error('applying a look changed nothing on screen');
  if (r.words !== r.stillWords) throw new Error('applying a look overwrote the words');
  console.log(`     look applied · glow ${r.glow} · entrance "${r.anim}" · words kept`);
});

await step('gradient, glow, plate and typewriter each change the frame', async () => {
  const r = await page.evaluate(async () => {
    const { store, comp } = window.gc;
    const clip = store.selectedClips[0].clip;
    const t = clip.start + 0.05;
    const keep = JSON.parse(JSON.stringify(clip.text));

    const sample = () => {
      comp.render(t, false);
      const c = comp.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4 * 29) { h ^= d[i] + d[i+1] * 3 + d[i+2] * 7; h = Math.imul(h, 16777619); }
      return h >>> 0;
    };

    const out = {};
    Object.assign(clip.text, keep, { fill: 'solid', glow: 0, bg: 'none', anim: 'none' });
    out.plain = sample();

    Object.assign(clip.text, { fill: 'gradient', color: '#ffffff', color2: '#ff0000' });
    out.gradient = sample();

    Object.assign(clip.text, { fill: 'solid', glow: 0.06, glowColor: '#00ff00' });
    out.glow = sample();

    Object.assign(clip.text, { glow: 0, bg: 'pill', bgColor: '#ff00ff' });
    out.plate = sample();

    // Typewriter: a slice of the word early on, all of it once it is done.
    Object.assign(clip.text, { bg: 'none', anim: 'type', animDur: 2, text: 'ABCDEFGHIJ' });
    // Count BRIGHT pixels, not opaque ones: the preview context is created
    // with alpha:false, so every pixel's alpha is 255 and counting that counts
    // the whole canvas whatever is drawn on it.
    const litPixels = () => {
      const d = comp.canvas.getContext('2d')
        .getImageData(0, 0, comp.canvas.width, comp.canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) {
        if (d[i] + d[i + 1] + d[i + 2] > 180) n++;
      }
      return n;
    };
    comp.render(clip.start + 0.1, false);
    out.typeEarly = litPixels();
    comp.render(clip.start + 1.9, false);
    out.typeLate = litPixels();

    clip.text = keep;
    comp.render(t, false);
    return out;
  });

  if (r.gradient === r.plain) throw new Error('gradient fill drew the same pixels as solid');
  if (r.glow === r.plain) throw new Error('glow drew nothing');
  if (r.plate === r.plain) throw new Error('background plate drew nothing');
  if (!(r.typeLate > r.typeEarly)) {
    throw new Error(`typewriter did not reveal letters over time (${r.typeEarly} → ${r.typeLate})`);
  }
  console.log(`     gradient, glow and plate all distinct · typed ${r.typeEarly} → ${r.typeLate} lit`);
});

await step('send down / bring up moves the text between tracks', async () => {
  const r = await page.evaluate(() => {
    const { store, cmds } = window.gc;
    const clip = store.selectedClips[0].clip;
    const trackOf = () => store.doc.tracks.findIndex(t => t.clips.some(c => c.id === clip.id));
    const before = trackOf();
    const moved = cmds.moveClipLayer(clip.id, 1);
    const after = trackOf();
    if (moved) cmds.moveClipLayer(clip.id, -1);
    return { before, after, moved, back: trackOf() };
  });
  if (!r.moved) throw new Error('could not send the text down a track');
  if (!(r.after > r.before)) throw new Error(`send down did not lower it (${r.before} → ${r.after})`);
  if (r.back !== r.before) throw new Error('bring up did not put it back');
});

console.log('\n── undo / redo ──────────────────────────');
await step('undo x6', async () => { for (let i = 0; i < 6; i++) { await page.click('#btnUndo'); await sleep(45); } });
await step('redo x6', async () => { for (let i = 0; i < 6; i++) { await page.click('#btnRedo'); await sleep(45); } });
await step('doc still coherent', async () => {
  const bad = await page.evaluate(() => {
    const out = [];
    for (const t of window.gc.store.doc.tracks)
      for (const c of t.clips) {
        if (!(c.duration > 0)) out.push(`${c.name} dur=${c.duration}`);
        if (!(c.start >= 0)) out.push(`${c.name} start=${c.start}`);
        if (!Number.isFinite(c.start + c.duration)) out.push(`${c.name} NaN`);
      }
    return out;
  });
  if (bad.length) throw new Error(bad.join('; '));
});

console.log('\n── pointer interaction ──────────────────');
const tl = await page.locator('#timelineView').boundingBox();
await step('scrub ruler', async () => {
  await page.mouse.move(tl.x + 300, tl.y + 12);
  await page.mouse.down(); await page.mouse.move(tl.x + 520, tl.y + 12, { steps: 12 }); await page.mouse.up();
});
await step('drag a clip', async () => {
  const pos = await page.evaluate(() => {
    const { store, timeline } = window.gc;
    const tr = store.doc.tracks.find(t => t.clips.length);
    if (!tr) return null;
    const c = tr.clips[0];
    const row = timeline.L.rowFor(tr.id);
    return { x: timeline.L.t2x(c.start + c.duration / 2), y: row.y + row.h / 2 };
  });
  if (!pos) return;
  await page.mouse.move(tl.x + pos.x, tl.y + pos.y);
  await page.mouse.down();
  await page.mouse.move(tl.x + pos.x + 90, tl.y + pos.y, { steps: 14 });
  await page.mouse.up();
});
await step('marquee select', async () => {
  await page.mouse.move(tl.x + 40, tl.y + 200);
  await page.mouse.down();
  await page.mouse.move(tl.x + 700, tl.y + 260, { steps: 12 });
  await page.mouse.up();
});
await step('clicking empty timeline moves the playhead', async () => {
  const x = 520;
  const want = await page.evaluate((px) => window.gc.timeline.L.x2t(px), x);
  await page.mouse.move(tl.x + x, tl.y + 220);
  await page.mouse.down(); await page.mouse.up();
  await sleep(80);
  const got = await page.evaluate(() => window.gc.store.rt.playhead);
  const tol = await page.evaluate(() => 10 / window.gc.store.pxPerSec);
  if (Math.abs(got - want) > tol)
    throw new Error(`clicked ${want.toFixed(3)}s but playhead is ${got.toFixed(3)}s`);
});
await step('clicking a clip moves the playhead and does not move the clip', async () => {
  const pos = await page.evaluate(() => {
    const { store, timeline } = window.gc;
    const tr = store.doc.tracks.find(t => t.clips.length);
    if (!tr) return null;
    const c = tr.clips[0];
    const row = timeline.L.rowFor(tr.id);
    return { id: c.id, start: c.start, x: timeline.L.t2x(c.start + c.duration / 2), y: row.y + row.h / 2 };
  });
  if (!pos) return;
  const want = await page.evaluate((px) => window.gc.timeline.L.x2t(px), pos.x);
  await page.mouse.move(tl.x + pos.x, tl.y + pos.y);
  await page.mouse.down(); await page.mouse.up();
  await sleep(80);
  const after = await page.evaluate((id) => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id);
    return { playhead: window.gc.store.rt.playhead, start: c?.start };
  }, pos.id);
  const tol = await page.evaluate(() => 10 / window.gc.store.pxPerSec);
  if (Math.abs(after.playhead - want) > tol)
    throw new Error(`clicked ${want.toFixed(3)}s but playhead is ${after.playhead.toFixed(3)}s`);
  if (Math.abs(after.start - pos.start) > 1e-6)
    throw new Error(`a click moved the clip from ${pos.start} to ${after.start}`);
});
await step('dragging still marquee-selects instead of seeking', async () => {
  const before = await page.evaluate(() => window.gc.store.rt.playhead);
  await page.mouse.move(tl.x + 60, tl.y + 210);
  await page.mouse.down();
  await page.mouse.move(tl.x + 640, tl.y + 265, { steps: 14 });
  await page.mouse.up();
  await sleep(80);
  const after = await page.evaluate(() => window.gc.store.rt.playhead);
  if (Math.abs(after - before) > 1e-6)
    throw new Error(`a marquee drag moved the playhead ${before} → ${after}`);
});
await step('ctrl+scroll zoom', async () => {
  await page.mouse.move(tl.x + 400, tl.y + 120);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
});
await step('shift+scroll vertical', async () => {
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 200);
  await page.keyboard.up('Shift');
});

console.log('\n── panels ───────────────────────────────');
/**
 * Every tab in the left panel has to DO something.
 *
 * This check exists because Effects, Transitions and Graphics were once three
 * tabs that stored a choice on a clip and rendered nothing at all — a menu of
 * promises, which is worse than an empty panel. Transitions has since come back
 * with a renderer behind it, so the rule is not "there is only one tab" but the
 * rule it was always standing in for: a tab has a pane, and the pane has
 * working controls in it.
 */
await step('every left-panel tab is backed by something real', async () => {
  const r = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('#leftTabs .tab')].map(t => t.dataset.tab),
    panes: [...document.querySelectorAll('#leftPanel .tabpane')].map(p => p.dataset.pane),
    stragglers: ['effectsRoot'].filter(id => document.getElementById(id)),
    transTiles: document.querySelectorAll('#transRoot .trs').length,
    transApplies: typeof window.gc?.transitions?.target === 'function',
    // Graphics has to be more than a heading: a way in, and looks to pick from.
    gfxAdd: !!document.getElementById('gfxAdd'),
    gfxLooks: document.querySelectorAll('#gfxRoot .gfxlook').length,
  }));
  if (r.stragglers.length) throw new Error('removed panels still in the DOM: ' + r.stragglers.join(', '));
  if (r.tabs.join() !== r.panes.join()) {
    throw new Error(`tabs (${r.tabs.join(', ')}) do not match panes (${r.panes.join(', ')})`);
  }
  if (r.tabs.join() !== 'media,trans,gfx') throw new Error('unexpected tabs: ' + r.tabs.join(', '));
  if (r.transTiles < 4) throw new Error('transitions panel has ' + r.transTiles + ' tiles');
  if (!r.transApplies) throw new Error('transitions panel exposes no way to apply anything');
  if (!r.gfxAdd) throw new Error('the Graphics tab offers no way to add one');
  if (r.gfxLooks < 5) throw new Error('the Graphics tab offers ' + r.gfxLooks + ' looks');
});

await step('media filters are the three that exist', async () => {
  const r = await page.evaluate(() => ({
    bins: [...document.querySelectorAll('#binList .bin')].map(b => b.dataset.bin),
    names: [...document.querySelectorAll('#binList .bin__name')].map(b => b.textContent),
  }));
  if (r.bins.join() !== 'all,video,audio') throw new Error('filters are: ' + r.bins.join(', '));
  if (r.names.join(' · ') !== 'All uploads · Video files · Audio files') {
    throw new Error('filter names are: ' + r.names.join(', '));
  }
});

await step('right tab → audio', () => page.click('#rightTabs [data-tab="audio"]'));
await step('right tab → inspector', () => page.click('#rightTabs [data-tab="inspect"]'));

await step('inspector renders for text clip', async () => {
  await page.evaluate(() => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'text');
    if (c) window.gc.store.select([c.id]);
  });
  await sleep(260);
  const n = await page.locator('#inspectorRoot .group').count();
  if (n < 2) throw new Error('inspector groups missing: ' + n);
});
await step('edit text content', async () => {
  const ta = page.locator('#inspectorRoot textarea').first();
  if (await ta.count()) { await ta.fill('QA RENDER TEST'); await ta.dispatchEvent('input'); }
});
await step('drag a numeric field', async () => {
  const num = page.locator('#inspectorRoot .num').first();
  if (!await num.count()) return;
  const b = await num.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
});
await step('toggle a keyframe', async () => {
  const kf = page.locator('#inspectorRoot .kf').first();
  if (await kf.count()) { await kf.click(); await sleep(120); await kf.click(); }
});

console.log('\n── tracks ───────────────────────────────');
await step('add video track', () => page.click('#trackHeaders [data-add="video"]'));
await step('add audio track', () => page.click('#trackHeaders [data-add="audio"]'));
await step('add text track', () => page.click('#trackHeaders [data-add="text"]'));
await step('toggle track flags', async () => {
  // Scroll the header stack home first — a control scrolled out of view is
  // legitimately unclickable, and we want to exercise the flags, not the scroll.
  await page.evaluate(() => { window.gc.store.ui.scrollY = 0; window.gc.timeline.repaint(); });
  await sleep(150);
  const btns = page.locator('#trackHeaders .th__b[data-flag]');
  const n = Math.min(await btns.count(), 5);
  for (let i = 0; i < n; i++) await btns.nth(i).click();
});
await step('vertical scrollbar appears', async () => {
  const hidden = await page.locator('#tlVScroll').isHidden();
  if (hidden) throw new Error('vscroll still hidden after adding 3 tracks');
});

// Regression: scrollY was clamped on input but never re-validated when the
// track stack shrank, stranding the lanes off-screen with no way back.
await step('scrollY re-clamps when tracks are removed', async () => {
  const res = await page.evaluate(async () => {
    const { store, cmds, timeline } = window.gc;
    store.ui.scrollY = 100000;                 // scroll far past the end
    timeline.repaint();
    await new Promise(r => requestAnimationFrame(r));
    const clamped = store.ui.scrollY;

    const before = store.doc.tracks.length;
    while (store.doc.tracks.length > 1) cmds.removeTrack(store.doc.tracks.at(-1).id);
    timeline.repaint();
    await new Promise(r => requestAnimationFrame(r));
    return { clamped, after: store.ui.scrollY, max: timeline.L.maxScrollY(), before,
             now: store.doc.tracks.length };
  });
  if (res.clamped > 100000 - 1) throw new Error('scrollY not clamped at all: ' + res.clamped);
  if (res.after > res.max + 0.5) {
    throw new Error(`scrollY ${res.after} exceeds max ${res.max} after removing tracks`);
  }
});
await step('headers visible again after shrink', async () => {
  const ok = await page.evaluate(() => {
    const th = document.querySelector('#trackHeaders .th');
    const host = document.getElementById('trackHeaders');
    if (!th || !host) return true;
    const a = th.getBoundingClientRect(), b = host.getBoundingClientRect();
    return a.bottom > b.top && a.top < b.bottom;    // overlaps its container
  });
  if (!ok) throw new Error('track headers left scrolled outside their container');
});

console.log('\n── import ───────────────────────────────');
await step('import png + font', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P4//8/AzYEEwxUMBAEAO7VBv/6z1MvAAAAAElFTkSuQmCC',
    'base64');
  await page.setInputFiles('#filePicker', [{ name: 'mc_test_capture.png', mimeType: 'image/png', buffer: png }]);
  await sleep(700);
  const n = await page.evaluate(async () => {
    const m = await import('app://gamecut/src/media/asset-store.js');
    return m.assets.all().length;
  });
  if (n < 1) throw new Error('asset not registered');
});
await step('asset tile rendered', async () => {
  await page.click('#leftTabs [data-tab="media"]');
  await sleep(250);
  const n = await page.locator('#poolRoot .asset').count();
  if (n < 1) throw new Error('no asset tiles');
});

// Regression: drag-and-drop onto the canvas used to be the ONLY way to get an
// imported asset onto the timeline, so importing looked like it did nothing.
await step('+ button places an asset on the timeline', async () => {
  const before = await page.evaluate(() =>
    window.gc.store.doc.tracks.reduce((n, t) => n + t.clips.length, 0));
  const tile = page.locator('#poolRoot .asset').first();
  await tile.hover();
  await tile.locator('.asset__add').click();
  await sleep(400);
  const after = await page.evaluate(() =>
    window.gc.store.doc.tracks.reduce((n, t) => n + t.clips.length, 0));
  if (after <= before) throw new Error('nothing was added');
});

await step('double-click places without stacking', async () => {
  await page.locator('#poolRoot .asset').first().dblclick();
  await sleep(400);
  const overlap = await page.evaluate(() => {
    for (const t of window.gc.store.doc.tracks) {
      const s = [...t.clips].sort((a, b) => a.start - b.start);
      for (let i = 1; i < s.length; i++) {
        if (s[i].start < s[i - 1].start + s[i - 1].duration - 1e-6) {
          return `${s[i - 1].name} / ${s[i].name} overlap on ${t.name}`;
        }
      }
    }
    return null;
  });
  if (overlap) throw new Error(overlap);
});

// Regression: AudioGraph skipped any track whose kind wasn't 'audio' while the
// decoder pool muted the <video> element, so video sound played nowhere.
await step('audio graph considers non-audio tracks', async () => {
  const r = await page.evaluate(async () => {
    const { store } = window.gc;
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    // A stand-in asset carrying a decoded buffer, on a VIDEO track.
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    const { audioCtx } = await import('app://gamecut/src/audio/waveform.js');
    const ctx = audioCtx();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const a = assets.add({ kind: 'video', name: 'synthetic.mp4', url: '', duration: 2,
                           peaks: { rate: 480, duration: 2, buffer: buf,
                                    min: new Float32Array(1), max: new Float32Array(1),
                                    rms: new Float32Array(1) } });
    const vt = store.doc.tracks.find(t => t.kind === 'video' && !t.locked);
    const c = makeClip('video', { name: 'synthetic', assetId: a.id, start: 40, duration: 2 });
    window.gc.cmds.addClip(vt.id, c, { select: false });

    window.gc.playback.seek(40);
    await new Promise(r => setTimeout(r, 100));
    window.gc.playback.play();
    await new Promise(r => setTimeout(r, 500));
    const n = window.gc.playback.audio.nodes.length;
    window.gc.playback.pause();
    return n;
  });
  if (r <= 0) throw new Error('a video clip with audio scheduled no nodes');
});

console.log('\n── keyboard ─────────────────────────────');
await page.locator('#timelineView').click({ position: { x: 500, y: 150 } });
for (const [k, label] of [['Space','play'],['Space','pause'],['s','split'],['t','text'],['m','marker'],
                          ['n','snap'],['b','beat'],['l','loop'],['ArrowRight','nudge'],['ArrowLeft','nudge back'],
                          ['Home','home'],['End','end'],['Control+d','duplicate'],['Control+a','select all'],
                          ['Control+z','undo'],['Control+Shift+z','redo']]) {
  await step(`key ${label}`, async () => { await page.keyboard.press(k); await sleep(70); });
}

console.log('\n── resilience ───────────────────────────');
await step('rapid aspect thrash', async () => {
  for (const ar of ['9:16','16:9','1:1','9:16','16:9']) {
    await page.click(`#aspectSeg [data-ar="${ar}"]`); await sleep(60);
  }
});
await step('extreme zoom in/out', async () => {
  await page.fill('#zoomRange', '1000'); await sleep(120);
  await page.fill('#zoomRange', '0'); await sleep(120);
  await page.click('#btnZoomFit');
});
await step('delete everything', async () => {
  await page.keyboard.press('Control+a');
  await sleep(80);
  await page.click('#btnDelete');
  await sleep(120);
});
await step('empty project still paints', async () => {
  const lit = await page.evaluate(() => {
    const c = document.getElementById('timelineCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i+3] > 8) n++;
    return n;
  });
  if (lit < 20) throw new Error('canvas blank when empty');
});
await step('undo restores', async () => { await page.click('#btnUndo'); await sleep(200); });

/* ── Help, hover tips and the right-click menu ───────────────────
   These exist because an icon-only toolbar is unreadable without them, so the
   checks are about the words being there and reachable, not about the styling.
*/
console.log('\n── help & discoverability ───────────────');

await step('every icon-only control says what it is', async () => {
  const bad = await page.evaluate(() => {
    const out = [];
    const scopes = ['.topbar', '.transport', '.tl-tools', '.tl-beat', '.tl-zoom', '.preview__topline'];
    for (const sel of scopes) {
      for (const b of document.querySelectorAll(`${sel} button, ${sel} input, ${sel} select`)) {
        const text = (b.textContent || '').trim();
        const name = b.getAttribute('aria-label') || b.title || '';
        if (!text && !name) out.push(`${sel} ${b.id || b.className}`);
      }
    }
    return out;
  });
  if (bad.length) throw new Error('unlabelled: ' + bad.join(', '));
});

await step('hovering a tool explains it in a sentence', async () => {
  await page.hover('#btnSplit');
  await sleep(700);
  const t = await page.evaluate(() => {
    const el = document.querySelector('.tip');
    if (!el || el.hidden) return null;
    return { title: el.querySelector('b')?.textContent || '',
             body: el.querySelector('span')?.textContent || '',
             on: el.classList.contains('is-on') };
  });
  if (!t) throw new Error('no tip appeared over the split tool');
  if (!t.on) throw new Error('tip never became visible');
  if (!/split/i.test(t.title)) throw new Error('tip titled ' + t.title);
  if (t.body.length < 30) throw new Error('tip body too thin to explain anything: ' + t.body);
  // And it has to get out of the way again.
  await page.hover('#tcCurrent');
  await sleep(300);
  const gone = await page.evaluate(() => !!document.querySelector('.tip')?.hidden);
  if (!gone) throw new Error('tip stayed up after the pointer left');
});

await step('? opens the help sheet, Esc closes it', async () => {
  await page.keyboard.press('?');
  await sleep(300);
  const open = await page.evaluate(() => {
    const el = document.getElementById('helpSheet');
    return { shown: el && !el.hidden,
             rows: el?.querySelectorAll('.help__row').length || 0,
             steps: el?.querySelectorAll('.help__step').length || 0 };
  });
  if (!open.shown) throw new Error('help did not open');
  if (open.steps < 4) throw new Error('no getting-started steps: ' + open.steps);
  if (open.rows < 30) throw new Error('help is missing most of the app: ' + open.rows + ' rows');

  // Searching narrows it rather than emptying it.
  await page.fill('#helpFind', 'crop');
  await sleep(200);
  const hits = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#helpSheet .help__row')];
    return { shown: rows.filter(r => !r.hidden).length, total: rows.length };
  });
  if (!hits.shown) throw new Error('search for "crop" found nothing');
  if (hits.shown >= hits.total) throw new Error('search did not filter anything');

  await page.click('#helpClose');
  await sleep(320);
  const closed = await page.evaluate(() => document.getElementById('helpSheet').hidden);
  if (!closed) throw new Error('help did not close');
});

await step('right-clicking a clip offers what can be done to it', async () => {
  /**
   * The view is reset first, on purpose.
   *
   * Twenty tests of zooming and scrolling run before this one, and a test that
   * works out screen coordinates from whatever scroll they happened to leave
   * behind is not testing the right-click menu — it is testing its own luck.
   * Zoom to fit and scroll to the top, then aim.
   */
  await page.evaluate(() => {
    const { store, timeline } = window.gc;
    store.ui.scrollX = 0;
    store.ui.scrollY = 0;
    store.select([]);
    document.getElementById('btnZoomFit').click();
    timeline.repaint();
  });
  // The row geometry is only rebuilt during a paint, and painting is
  // rAF-coalesced. Reading it in the same turn gives the layout from before the
  // reset, which is how this aimed at the wrong lane.
  await sleep(300);

  const box = await page.evaluate(() => {
    const { store, timeline } = window.gc;
    const track = store.doc.tracks.find(t => t.clips.length);
    if (!track) return null;
    const clip = track.clips[0];
    const row = timeline.L.rowFor(track.id);
    const r = document.getElementById('timelineView').getBoundingClientRect();
    return { x: r.left + timeline.L.t2x(clip.start + clip.duration / 2),
             y: r.top + row.y + row.h / 2, id: clip.id, name: clip.name,
             debug: { view: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
                      clip: { start: clip.start, dur: clip.duration, type: clip.type },
                      row: { y: Math.round(row.y), h: row.h, track: track.name },
                      pps: Math.round(store.pxPerSec), sx: store.ui.scrollX, sy: store.ui.scrollY } };
  });
  if (!box) throw new Error('no clip to right-click');

  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(250);
  const menu = await page.evaluate(() => {
    const el = document.querySelector('.ctx');
    if (!el) return null;
    return { items: [...el.querySelectorAll('.ctx__item span')].map(s => s.textContent),
             selection: window.gc.store.rt.selection };
  });
  if (!menu) throw new Error('no menu appeared');
  if (!menu.selection.includes(box.id)) {
    throw new Error('right-click did not select the clip under it: '
      + JSON.stringify({ menu, aimed: { x: Math.round(box.x), y: Math.round(box.y) }, ...box.debug }));
  }
  for (const want of ['Split', 'Duplicate', 'Delete']) {
    if (!menu.items.some(i => i.includes(want))) {
      throw new Error(`menu has no ${want}: ` + menu.items.join(' | '));
    }
  }

  // And an entry actually runs the command.
  const before = await page.evaluate(() =>
    window.gc.store.doc.tracks.reduce((n, t) => n + t.clips.length, 0));
  await page.evaluate(() => {
    [...document.querySelectorAll('.ctx__item')]
      .find(b => b.textContent.includes('Duplicate'))?.click();
  });
  await sleep(250);
  const after = await page.evaluate(() => ({
    clips: window.gc.store.doc.tracks.reduce((n, t) => n + t.clips.length, 0),
    menu: !!document.querySelector('.ctx'),
  }));
  if (after.clips !== before + 1) throw new Error('Duplicate from the menu did nothing');
  if (after.menu) throw new Error('menu stayed open after a click');
  await page.keyboard.press('Control+z');
  await sleep(200);
});

await step('Escape closes the right-click menu', async () => {
  const box = await page.evaluate(() => {
    const r = document.getElementById('timelineView').getBoundingClientRect();
    return { x: r.left + r.width * 0.7, y: r.top + r.height * 0.75 };
  });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(200);
  if (!await page.evaluate(() => !!document.querySelector('.ctx'))) {
    throw new Error('no menu on empty timeline');
  }
  await page.keyboard.press('Escape');
  await sleep(200);
  if (await page.evaluate(() => !!document.querySelector('.ctx'))) {
    throw new Error('Escape left the menu up');
  }
});

/* ── The updates panel ───────────────────────────────────────── */
console.log('\n── updates ──────────────────────────────');

await step('the version chip opens the updates panel', async () => {
  await page.click('#verChip');
  await sleep(350);
  const r = await page.evaluate(() => {
    const el = document.getElementById('updPanel');
    return {
      shown: el && !el.hidden,
      head: el?.querySelector('.upd__now b')?.textContent || '',
      facts: [...(el?.querySelectorAll('.upd__facts dt') || [])].map(d => d.textContent),
      fromFile: !!document.getElementById('updFromFile'),
    };
  });
  if (!r.shown) throw new Error('the panel did not open');
  if (!r.head) throw new Error('it does not say what state it is in');
  // A build with no key must say so rather than pretend to be up to date.
  if (!/off|up to date|check/i.test(r.head)) throw new Error('state reads: ' + r.head);
  if (!r.facts.includes('Editor version')) throw new Error('it does not say what is running');
  if (!r.fromFile) throw new Error('installing a file by hand is no longer offered');
});

await step('Escape closes it', async () => {
  await page.keyboard.press('Escape');
  await sleep(300);
  const open = await page.evaluate(() => {
    const el = document.getElementById('updPanel');
    return el && !el.hidden;
  });
  if (open) throw new Error('Escape left the panel up');
});

/**
 * The card that offers an update must never appear over a render.
 *
 * Reloading the editor mid-export throws away however many minutes of work, so
 * this is checked rather than remembered.
 */
await step('an update is never offered in the middle of an export', async () => {
  const r = await page.evaluate(async () => {
    const { store, updates } = window.gc;
    const wait = () => new Promise(res => setTimeout(res, 220));

    // With an export running, nothing may appear.
    store.setRT({ exporting: true });
    updates.__test_offer?.();
    await wait();
    const during = !!document.getElementById('updCard');

    // And with the export finished, it must — or this test proves nothing.
    store.setRT({ exporting: false });
    updates.__test_offer?.();
    await wait();
    const after = !!document.getElementById('updCard');
    const text = document.getElementById('updCard')?.textContent || '';
    document.getElementById('updCard')?.remove();
    return { during, after, text };
  });
  if (r.during) throw new Error('a card appeared over a running export');
  if (!r.after) throw new Error('no card appears even when nothing is rendering — the test proves nothing');
  if (!/99\.0\.0/.test(r.text)) throw new Error('the card does not name the version: ' + r.text);
});

/* ── Transitions, the way you actually reach them ────────────── */
console.log('\n── transitions ──────────────────────────');

/**
 * Build two clips cut flush together, wide enough to aim at, and return where
 * the badge on their seam is on screen.
 */
async function seamOnScreen() {
  await page.evaluate(async () => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { store, cmds, timeline } = window.gc;
    const track = store.doc.tracks.find(t => t.kind === 'video');
    for (const t of store.doc.tracks) t.clips.length = 0;
    const a = makeClip('image', { name: 'Shot A', start: 0, duration: 3 });
    const b = makeClip('image', { name: 'Shot B', start: 3, duration: 3 });
    cmds.addClip(track.id, a, { select: false, label: 'Seed' });
    cmds.addClip(track.id, b, { select: false, label: 'Seed' });
    store.select([]);
    store.setRT({ junction: null });
    store.ui.scrollX = 0; store.ui.scrollY = 0;
    document.getElementById('btnZoomFit').click();
    timeline.repaint();
  });
  await sleep(320);
  return page.evaluate(() => {
    const { store, timeline } = window.gc;
    const j = (timeline.L.junctions || [])[0];
    const r = document.getElementById('timelineView').getBoundingClientRect();
    const b = store.doc.tracks.flatMap(t => t.clips).find(c => c.name === 'Shot B');
    return j ? { x: r.left + j.x + j.w / 2, y: r.top + j.y + j.h / 2, bId: b.id } : null;
  });
}

await step('two clips cut together grow a transition button on the seam', async () => {
  const seam = await seamOnScreen();
  if (!seam) throw new Error('no badge appeared between two adjacent clips');
  const gone = await page.evaluate(() => {
    // Move one clip away and the cut — and its button — must stop existing.
    const { store, timeline } = window.gc;
    const b = store.doc.tracks.flatMap(t => t.clips).find(c => c.name === 'Shot B');
    b.start = 5;
    store.docChanged();
    timeline.repaint();
    return new Promise(res => setTimeout(() =>
      res((window.gc.timeline.L.junctions || []).length), 300));
  });
  if (gone !== 0) throw new Error('badge survived the clips being pulled apart');
});

await step('clicking the seam opens the transitions panel on that cut', async () => {
  const seam = await seamOnScreen();
  if (!seam) throw new Error('no seam to click');
  await page.mouse.click(seam.x, seam.y);
  await sleep(350);
  const r = await page.evaluate(() => ({
    tab: document.querySelector('#leftTabs .tab.is-active')?.dataset.tab,
    paneOpen: document.querySelector('#transRoot')?.classList.contains('is-active'),
    junction: window.gc.store.rt.junction,
    tiles: document.querySelectorAll('#transRoot .trs').length,
    enabled: [...document.querySelectorAll('#transRoot .trs')].filter(b => !b.disabled).length,
    first: document.querySelector('#transRoot .trs')?.textContent.trim(),
  }));
  if (r.tab !== 'trans') throw new Error('the transitions tab did not come forward: ' + r.tab);
  if (!r.paneOpen) throw new Error('the transitions pane is not the visible one');
  if (r.junction !== seam.bId) throw new Error('the wrong cut got picked');
  if (r.tiles < 6) throw new Error('only ' + r.tiles + ' transitions offered');
  if (r.enabled !== r.tiles) throw new Error('tiles are still disabled with a cut picked');
  if (!/dissolve/i.test(r.first)) throw new Error('Dissolve is not first: ' + r.first);
});

await step('picking Dissolve puts it on the cut and shows it there', async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('#transRoot .trs')]
      .find(b => /dissolve/i.test(b.textContent))?.click();
  });
  await sleep(350);
  const r = await page.evaluate(() => {
    const { store, timeline } = window.gc;
    const b = store.doc.tracks.flatMap(t => t.clips).find(c => c.name === 'Shot B');
    const j = (timeline.L.junctions || [])[0];
    return {
      kind: b.transIn?.kind, dur: b.transIn?.dur,
      lit: !!j?.on,
      on: document.querySelector('#transRoot .trs.is-on')?.textContent.trim(),
      hasLength: !!document.getElementById('transDur'),
      hasRemove: !!document.getElementById('transRemove'),
    };
  });
  if (r.kind !== 'dissolve') throw new Error('the clip did not get a dissolve: ' + r.kind);
  if (!(r.dur > 0)) throw new Error('no length was set');
  if (!r.lit) throw new Error('the badge on the timeline does not show it is set');
  if (!/dissolve/i.test(r.on || '')) throw new Error('the tile is not marked as chosen');
  if (!r.hasLength || !r.hasRemove) throw new Error('no way to change the length or take it off');
});

await step('a transition sits across the cut, not after it', async () => {
  const r = await page.evaluate(async () => {
    const { transitionSpan, transitionAt } = await import('app://gamecut/src/engine/transitions.js');
    const { store } = window.gc;
    const track = store.doc.tracks.find(t => t.clips.some(c => c.name === 'Shot B'));
    const a = track.clips.find(c => c.name === 'Shot A');
    const b = track.clips.find(c => c.name === 'Shot B');
    b.transIn = { kind: 'dissolve', dur: 1 };
    const span = transitionSpan(a, b);
    return {
      cut: b.start, from: span.from, to: span.to,
      justBefore: !!transitionAt(track, b.start - 0.4),
      justAfter: !!transitionAt(track, b.start + 0.4),
      wellBefore: !!transitionAt(track, b.start - 0.9),
      wellAfter: !!transitionAt(track, b.start + 0.9),
    };
  });
  if (Math.abs(r.from - (r.cut - 0.5)) > 1e-6) throw new Error('it does not start half a length before the cut');
  if (Math.abs(r.to - (r.cut + 0.5)) > 1e-6) throw new Error('it does not end half a length after the cut');
  if (!r.justBefore) throw new Error('nothing is happening before the cut — it is not centred');
  if (!r.justAfter) throw new Error('nothing is happening after the cut');
  if (r.wellBefore || r.wellAfter) throw new Error('it runs on outside its own length');
});

await step('Remove puts the cut back to a hard cut', async () => {
  await page.evaluate(() => document.getElementById('transRemove')?.click());
  await sleep(300);
  const r = await page.evaluate(() => {
    const b = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.name === 'Shot B');
    return { kind: b.transIn?.kind ?? null, lit: !!(window.gc.timeline.L.junctions || [])[0]?.on };
  });
  if (r.kind !== null) throw new Error('the transition is still there: ' + r.kind);
  if (r.lit) throw new Error('the badge still says a transition is set');
});

await step('the transitions panel has a preview stage', async () => {
  const seam = await seamOnScreen();
  await page.mouse.click(seam.x, seam.y);
  await sleep(300);
  const r = await page.evaluate(() => {
    const cv = document.getElementById('transPreview');
    const cap = document.getElementById('transPreviewCap');
    return { cv: !!cv, cap: cap?.textContent.trim() || '', w: cv?.width, h: cv?.height };
  });
  if (!r.cv) throw new Error('no preview canvas in the transitions panel');
  if (!r.cap) throw new Error('the preview says nothing at all');
  if (!r.w || !r.h) throw new Error(`preview canvas is ${r.w}x${r.h}`);
});

await step('hovering a transition says what it would do', async () => {
  const seam = await seamOnScreen();
  await page.mouse.click(seam.x, seam.y);
  await sleep(300);
  const before = await page.evaluate(() =>
    document.getElementById('transPreviewCap')?.textContent.trim());
  await page.hover('.trs[data-pick="slide-up"]');
  await sleep(160);
  const after = await page.evaluate(() =>
    document.getElementById('transPreviewCap')?.textContent.trim());
  if (after === before) throw new Error(`hovering changed nothing — still "${after}"`);
  if (!/slide up/i.test(after)) throw new Error(`hovering Slide up said "${after}"`);

  // And moving away puts it back to whatever the cut is actually set to.
  await page.mouse.move(4, 4);
  await sleep(200);
  const back = await page.evaluate(() =>
    document.getElementById('transPreviewCap')?.textContent.trim());
  if (/slide up/i.test(back)) throw new Error('the preview stayed on the hovered transition after leaving');
});

await step('the top bar says whether your work is saved', async () => {
  const r = await page.evaluate(async () => {
    const chip = document.getElementById('saveChip');
    window.gc.store.docChanged?.('test');
    await new Promise(res => setTimeout(res, 60));
    return { state: chip?.dataset.state, text: chip?.textContent.trim() };
  });
  if (!r.state) throw new Error('no save chip');
  if (r.state !== 'dirty') throw new Error('a changed project reads as ' + r.state);
  if (!/unsaved/i.test(r.text)) throw new Error('chip reads ' + r.text);
});

/* ── The mixer ───────────────────────────────────────────────────
   For a long time the Audio tab asked what *track* a clip sat on, which meant
   the soundtrack of every piece of gameplay footage was unreachable — the one
   thing people most want to turn down. These checks are written against a
   video clip on a video track on purpose. */
console.log('\n── mixing ───────────────────────────────');

/** A video clip whose asset claims to carry sound, selected, Audio tab open. */
async function selectNoisyVideo() {
  return page.evaluate(async () => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { store, assets } = window.gc;
    for (const t of store.doc.tracks) t.clips.length = 0;
    const asset = assets.add({
      kind: 'video', name: 'loud.mp4', url: '', duration: 10,
      // Enough for the panel to know there is sound without decoding anything.
      streamAudio: true,
    });
    const track = store.doc.tracks.find(t => t.kind === 'video');
    const clip = makeClip('video', {
      trackId: track.id, assetId: asset.id, name: 'loud.mp4',
      start: 0, duration: 5, sourceDuration: 10,
    });
    track.clips.push(clip);
    store.docChanged('test clip');
    store.select([clip.id]);
    document.querySelector('#rightTabs [data-tab="audio"]')?.click();
    return clip.id;
  });
}

/**
 * Wait until the mixer is actually showing `clipId`.
 *
 * The panel rebuilds on a frame, and under xvfb frames are not guaranteed to be
 * prompt — so a fixed sleep leaves the previous selection's controls on screen
 * and every click lands on a clip that no longer exists.
 */
async function mixerReady(page, clipId) {
  await page.waitForFunction(
    (id) => document.getElementById('audioRoot')?.dataset.clip === id,
    clipId, { timeout: 8000, polling: 80 });
  await sleep(60);
}

await step('a video clip can be mixed, not just music', async () => {
  await mixerReady(page, await selectNoisyVideo());
  const r = await page.evaluate(() => {
    const root = document.getElementById('audioRoot');
    return {
      empty: !!root.querySelector('.empty'),
      faders: root.querySelectorAll('.sldr').length,
      text: root.textContent.slice(0, 120),
    };
  });
  if (r.empty) throw new Error('the Audio tab refused a video clip: ' + r.text);
  if (r.faders < 2) throw new Error(`expected a clip fader and a track fader, found ${r.faders}`);
});

await step('dragging the volume fader changes the clip', async () => {
  const id = await selectNoisyVideo();
  await mixerReady(page, id);
  const box = await page.locator('#audioRoot .sldr .sldr__track').first().boundingBox();
  if (!box) throw new Error('no fader on screen');
  const at = { x: box.x + box.width * 0.25, y: box.y + box.height / 2 };
  // A quarter of the way along a 0–200% fader is 50%.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(80);
  const r = await page.evaluate(([cid, pt]) => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    const el = document.elementFromPoint(pt.x, pt.y);
    return {
      v: c?.volume,
      readout: document.querySelector('#audioRoot .sldr__val')?.textContent,
      // If the click missed, this says what it actually landed on, which is
      // the only fact that shortens the hunt.
      hit: el ? (el.className || el.tagName) : 'nothing',
    };
  }, [id, at]);
  if (r.v == null) throw new Error('clip vanished');
  if (Math.abs(r.v - 0.5) > 0.12)
    throw new Error(`fader set volume to ${r.v} (readout "${r.readout}"), expected about 0.5; `
      + `the pointer was over ${r.hit} at ${Math.round(at.x)},${Math.round(at.y)} `
      + `and the fader box was ${JSON.stringify(box)}`);
});

await step('muting a clip is remembered and undoable', async () => {
  const id = await selectNoisyVideo();
  await mixerReady(page, id);
  const r = await page.evaluate(async (cid) => {
    const find = () => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    const btn = [...document.querySelectorAll('#audioRoot .tgl')]
      .find(b => /mute/i.test(b.textContent));
    btn?.click();
    await new Promise(r => setTimeout(r, 80));
    const after = find()?.muted;
    window.gc.history.undo();
    await new Promise(r => setTimeout(r, 80));
    return { had: !!btn, after, undone: find()?.muted };
  }, id);
  if (!r.had) throw new Error('no mute button in the mixer');
  if (r.after !== true) throw new Error('clicking Mute did not mute the clip');
  if (r.undone !== false) throw new Error('undo did not bring the sound back');
});

await step('a picture-only layer says so instead of showing a dead fader', async () => {
  await page.evaluate(async () => {
    window.gc.cmds.addTextClip?.();
    await new Promise(r => setTimeout(r, 120));
  });
  await page.click('#btnAddText').catch(() => {});
  await sleep(160);
  const r = await page.evaluate(() => {
    const root = document.getElementById('audioRoot');
    return { empty: !!root.querySelector('.empty'), faders: root.querySelectorAll('.sldr').length };
  });
  if (!r.empty || r.faders) throw new Error('a text layer was offered a volume control');
});

/* ── The crop studio ─────────────────────────────────────────────
   Driven with a real mouse on a real canvas. The thing that made the old crop
   tool useless was its size, so the checks that matter are that the room opens
   at full size, that a painted stroke actually becomes a mask, and that Escape
   leaves the document exactly as it found it. */
console.log('\n── cropping ─────────────────────────────');

/** A clip with a picture, and the studio open on a stand-in frame. */
async function openStudio() {
  return page.evaluate(async () => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { openCropStudio } = await import('app://gamecut/src/ui/preview/crop-studio.js');
    const { store, cmds, comp, assets } = window.gc;

    for (const t of store.doc.tracks) t.clips.length = 0;
    const asset = assets.add({ kind: 'video', name: 'frame.mp4', url: '', duration: 8 });
    const track = store.doc.tracks.find(t => t.kind === 'video');
    const clip = makeClip('video', {
      trackId: track.id, assetId: asset.id, name: 'frame.mp4',
      start: 0, duration: 4, sourceDuration: 8,
    });
    track.clips.push(clip);
    store.docChanged('crop test');
    store.select([clip.id]);

    // A stand-in for a decoded frame. The studio only ever asks a source to be
    // drawable and to report a size, which is exactly what a canvas is.
    const source = document.createElement('canvas');
    source.width = 1920; source.height = 1080;
    const c = source.getContext('2d');
    c.fillStyle = '#123'; c.fillRect(0, 0, 1920, 1080);
    c.fillStyle = '#fa0'; c.fillRect(1200, 120, 400, 300);

    window.__studio = openCropStudio({ clip, source, store, cmds, comp, onApply: () => {} });
    await new Promise(r => setTimeout(r, 200));
    return { clipId: clip.id, opened: !!window.__studio, before: track.clips.length };
  });
}

await step('the crop room opens over the whole window', async () => {
  const r = await openStudio();
  if (!r.opened) throw new Error('openCropStudio returned nothing');
  const box = await page.evaluate(() => {
    const el = document.querySelector('.cropst');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { w: b.width, h: b.height, vw: innerWidth, vh: innerHeight,
             tools: el.querySelectorAll('.cst').length,
             canvas: !!el.querySelector('.cropst__cv') };
  });
  if (!box) throw new Error('no crop studio in the DOM');
  if (!box.canvas) throw new Error('the studio has no canvas to draw on');
  if (box.w < box.vw - 2 || box.h < box.vh - 2)
    throw new Error(`the studio is ${Math.round(box.w)}×${Math.round(box.h)} inside a ${box.vw}×${box.vh} window — it is supposed to take the screen`);
  if (box.tools < 6) throw new Error('the toolbar is missing controls: only ' + box.tools);
});

await step('Escape leaves without touching the project', async () => {
  const r = await openStudio();
  await page.keyboard.press('Escape');
  await sleep(160);
  const after = await page.evaluate((id) => ({
    gone: !document.querySelector('.cropst'),
    clips: window.gc.store.doc.tracks.flatMap(t => t.clips).length,
    cropped: window.gc.store.doc.tracks.flatMap(t => t.clips).some(c => c.crop),
    still: !!window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id),
  }), r.clipId);
  if (!after.gone) throw new Error('Escape did not close the studio');
  if (after.cropped) throw new Error('Escape applied a crop anyway');
  if (after.clips !== r.before) throw new Error(`clip count went ${r.before} → ${after.clips}`);
  if (!after.still) throw new Error('the original clip disappeared');
});

await step('painting a shape and applying it makes a masked cut-out', async () => {
  const r = await openStudio();
  const stage = await page.locator('.cropst__cv').boundingBox();
  if (!stage) throw new Error('no canvas on screen');

  // A short scribble across the middle of the frame.
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
  await page.mouse.move(cx - 60, cy - 30);
  await page.mouse.down();
  for (const [dx, dy] of [[-20, 10], [20, 20], [60, -10], [70, 20]]) {
    await page.mouse.move(cx + dx, cy + dy);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(80);

  await page.click('#cstApply');
  await sleep(260);

  const out = await page.evaluate((id) => {
    const clips = window.gc.store.doc.tracks.flatMap(t => t.clips);
    const made = clips.find(c => c.id !== id && c.crop);
    return {
      open: !!document.querySelector('.cropst'),
      made: !!made,
      hasMask: !!made?.crop?.mask,
      maskIsPng: (made?.crop?.mask || '').startsWith('data:image/png'),
      w: made?.crop?.w, h: made?.crop?.h,
      originalUntouched: !clips.find(c => c.id === id)?.crop,
      silent: !!made?.silent,
    };
  }, r.clipId);

  if (out.open) throw new Error('the studio stayed open after Apply');
  if (!out.made) throw new Error('applying the paint made no cropped layer');
  if (!out.hasMask) throw new Error('the cut-out has no painted mask — it fell back to a plain box');
  if (!out.maskIsPng) throw new Error('the mask is not a PNG: ' + String(out.maskIsPng));
  if (!(out.w > 0.005 && out.w < 0.9)) throw new Error(`mask box width is ${out.w}, which cannot be right for a small scribble`);
  if (!out.originalUntouched) throw new Error('the original clip was cropped instead of copied');
  if (!out.silent) throw new Error('the cut-out is not silent — its audio would double up');
});

await step('the box tool still makes a plain rectangle', async () => {
  const r = await openStudio();
  await page.click('.cst[data-tool="box"]');
  await sleep(80);
  const stage = await page.locator('.cropst__cv').boundingBox();
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
  await page.mouse.move(cx - 120, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 6 });
  await page.mouse.up();
  await sleep(60);
  await page.click('#cstApply');
  await sleep(240);

  const out = await page.evaluate((id) => {
    const made = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id !== id && c.crop);
    return { made: !!made, mask: !!made?.crop?.mask, w: made?.crop?.w, h: made?.crop?.h };
  }, r.clipId);
  if (!out.made) throw new Error('the box tool produced no crop');
  if (out.mask) throw new Error('the box tool left a painted mask behind');
  if (!(out.w > 0.02 && out.h > 0.02)) throw new Error(`the box came out ${out.w}×${out.h}`);
});

await step('the studio cleans up after itself', async () => {
  await page.evaluate(() => { document.querySelector('.cropst') && window.__studio?.close(); });
  await sleep(120);
  const left = await page.evaluate(() => document.querySelectorAll('.cropst').length);
  if (left) throw new Error(left + ' crop studios still in the page');
});

/* ── Typing on the picture ───────────────────────────────────────
   The point of this feature is that the words and the shot are looked at
   together, so the checks are about the field appearing over the right layer,
   the canvas not drawing the same words underneath it, and Escape putting back
   what was there. */
console.log('\n── typing on the picture ────────────────');

/** One text clip, selected, playhead over it. */
async function aTitle(text = 'FIRST BLOOD') {
  return page.evaluate(async (txt) => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { store, playback } = window.gc;
    for (const t of store.doc.tracks) t.clips.length = 0;
    const track = store.doc.tracks.find(t => t.kind === 'text');
    // Earlier sections toggle track visibility; a hidden track would put the
    // layer out of the compositor's reach and the double-click would land on
    // nothing.
    track.hidden = false;
    const clip = makeClip('text', { trackId: track.id, name: 'Title', start: 0, duration: 4 });
    clip.text.text = txt;
    track.clips.push(clip);
    store.docChanged('title');
    store.select([clip.id]);
    playback.seek(1.2);
    await new Promise(r => setTimeout(r, 160));
    return clip.id;
  }, text);
}

await step('Enter on a selected title opens a field over it', async () => {
  await aTitle();
  await page.keyboard.press('Enter');
  await sleep(200);
  const r = await page.evaluate(() => {
    const ta = document.querySelector('.tedit');
    if (!ta) return { none: true };
    const b = ta.getBoundingClientRect();
    const f = document.getElementById('previewFrame').getBoundingClientRect();
    return {
      value: ta.value,
      focused: document.activeElement === ta,
      w: b.width, h: b.height,
      // Inside the picture, not parked in a corner of the window.
      inFrame: b.left >= f.left - 2 && b.right <= f.right + 2
            && b.top >= f.top - 2 && b.bottom <= f.bottom + 2,
      suppressed: window.gc.comp.hidden.size,
    };
  });
  if (r.none) throw new Error('no field appeared');
  if (r.value !== 'FIRST BLOOD') throw new Error('the field opened with "' + r.value + '"');
  if (!r.focused) throw new Error('the field opened without focus, so typing would go elsewhere');
  if (!(r.w > 10 && r.h > 10)) throw new Error(`the field is ${r.w}x${r.h}`);
  if (!r.inFrame) throw new Error('the field is not over the picture');
  if (r.suppressed !== 1) throw new Error('the canvas is still drawing the layer underneath — the words would double up');
});

await step('typing changes the title, and it is one undo step', async () => {
  const id = await aTitle('OLD');
  await page.keyboard.press('Enter');
  await sleep(180);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ACE', { delay: 30 });
  await sleep(120);
  const live = await page.evaluate((cid) =>
    window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid)?.text.text, id);
  if (live !== 'ACE') throw new Error('typing did not reach the clip: "' + live + '"');

  // Clicking away commits.
  await page.evaluate(() => document.querySelector('.tedit')?.blur());
  await sleep(200);
  const after = await page.evaluate((cid) => ({
    open: !!document.querySelector('.tedit'),
    text: window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid)?.text.text,
    suppressed: window.gc.comp.hidden.size,
  }), id);
  if (after.open) throw new Error('the field stayed open after blur');
  if (after.text !== 'ACE') throw new Error('the change was lost on blur: "' + after.text + '"');
  if (after.suppressed) throw new Error('the layer is still suppressed after closing');

  await page.evaluate(() => window.gc.history.undo());
  await sleep(160);
  const undone = await page.evaluate((cid) =>
    window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid)?.text.text, id);
  if (undone !== 'OLD')
    throw new Error(`one undo left the text at "${undone}" — typing is making a history step per key`);
});

await step('Escape puts the old words back', async () => {
  const id = await aTitle('KEEP ME');
  await page.keyboard.press('Enter');
  await sleep(180);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('rubbish', { delay: 20 });
  await sleep(100);
  await page.keyboard.press('Escape');
  await sleep(200);
  const r = await page.evaluate((cid) => ({
    open: !!document.querySelector('.tedit'),
    text: window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid)?.text.text,
    suppressed: window.gc.comp.hidden.size,
  }), id);
  if (r.open) throw new Error('Escape did not close the field');
  if (r.text !== 'KEEP ME') throw new Error('Escape left "' + r.text + '" behind');
  if (r.suppressed) throw new Error('Escape left the layer suppressed — it would be invisible');
});

await step('double-clicking the words on the preview opens the field', async () => {
  await aTitle('DOUBLE');
  const box = await page.evaluate(() => {
    const { comp, store } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips)[0];
    const b = comp.bounds(clip, store.rt.playhead);
    const f = document.getElementById('previewFrame').getBoundingClientRect();
    return { x: f.left + b.cx * f.width, y: f.top + b.cy * f.height };
  });
  await page.mouse.dblclick(box.x, box.y);
  await sleep(240);
  const r = await page.evaluate((pt) => {
    const el = document.elementFromPoint(pt.x, pt.y);
    const { comp, store } = window.gc;
    const ov = document.getElementById('previewOverlay').getBoundingClientRect();
    const hit = comp.hitTest((pt.x - ov.left) / ov.width, (pt.y - ov.top) / ov.height, store.rt.playhead);
    return {
      open: !!document.querySelector('.tedit'),
      landedOn: el ? (el.className || el.tagName) : 'nothing',
      hit: hit ? hit.type : 'nothing',
      t: store.rt.playhead,
      active: comp.activeClips(store.rt.playhead).map(x => x.clip.type),
      b: (() => { const c = store.doc.tracks.flatMap(t => t.clips)[0];
                  const bb = comp.bounds(c, store.rt.playhead);
                  return { cx: +bb.cx.toFixed(3), cy: +bb.cy.toFixed(3), w: +bb.w.toFixed(3), h: +bb.h.toFixed(3) }; })(),
      n: { x: +((pt.x - ov.left) / ov.width).toFixed(3), y: +((pt.y - ov.top) / ov.height).toFixed(3) },
    };
  }, box);
  if (!r.open)
    throw new Error(`double-clicking the title did not open a field; landed on ${r.landedOn}, hit-tested as ${r.hit}, at ${JSON.stringify(r.n)} vs bounds ${JSON.stringify(r.b)}, t=${r.t}, active=${r.active.join('/')}`);
  await page.keyboard.press('Escape');
  await sleep(120);
});

/* ── The speed badge ─────────────────────────────────────────────
   A "2×" that keeps up with the clip. The interesting failure is not that it
   fails to appear — it is that it appears once, says 2×, and then quietly lies
   after the speed is changed again. */
console.log('\n── speed badge ──────────────────────────');

async function aSpedClip(speed = 2) {
  return page.evaluate(async (sp) => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { store, cmds, assets } = window.gc;
    for (const t of store.doc.tracks) { t.clips.length = 0; t.hidden = false; }
    const asset = assets.add({ kind: 'video', name: 'fast.mp4', url: '', duration: 30 });
    const track = store.doc.tracks.find(t => t.kind === 'video');
    const clip = makeClip('video', {
      trackId: track.id, assetId: asset.id, name: 'fast.mp4',
      start: 0, duration: 8, sourceDuration: 30,
    });
    track.clips.push(clip);
    store.docChanged('speed test');
    store.select([clip.id]);
    cmds.setClipSpeed(clip.id, sp);
    await new Promise(r => setTimeout(r, 160));
    return clip.id;
  }, speed);
}

await step('a sped-up clip offers a badge, a normal one does not', async () => {
  await aSpedClip(2);
  await page.evaluate(() => document.querySelector('#rightTabs [data-tab="inspect"]')?.click());
  await sleep(220);
  const withSpeed = await page.evaluate(() => {
    const b = document.getElementById('btnSpeedBadge');
    return { there: !!b, label: b?.textContent || '' };
  });
  if (!withSpeed.there) throw new Error('no badge button on a 2× clip');
  if (!/2×/.test(withSpeed.label)) throw new Error('the button says "' + withSpeed.label + '"');

  await page.evaluate(async () => {
    const { store, cmds } = window.gc;
    cmds.setClipSpeed(store.doc.tracks.flatMap(t => t.clips)[0].id, 1);
    await new Promise(r => setTimeout(r, 200));
  });
  await sleep(220);
  const normal = await page.evaluate(() => !!document.getElementById('btnSpeedBadge'));
  if (normal) throw new Error('a clip at normal speed is still being offered a badge');
});

await step('adding the badge puts a draggable layer on the picture', async () => {
  const id = await aSpedClip(4);
  await page.evaluate(() => document.querySelector('#rightTabs [data-tab="inspect"]')?.click());
  await sleep(220);
  await page.click('#btnSpeedBadge');
  await sleep(260);
  const r = await page.evaluate((cid) => {
    const { store, comp } = window.gc;
    const badge = store.doc.tracks.flatMap(t => t.clips).find(c => c.badgeFor === cid);
    const src = store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    const track = store.doc.tracks.find(t => t.clips.some(c => c.id === badge?.id));
    return {
      made: !!badge,
      text: badge?.text?.text,
      type: badge?.type,
      onText: track?.kind,
      spans: badge && src && Math.abs(badge.start - src.start) < 1e-3
             && Math.abs(badge.duration - src.duration) < 1e-3,
      selected: store.rt.selection.includes(badge?.id),
      // It has to be something the compositor will actually paint.
      visible: !!comp.activeClips(badge ? badge.start + 0.1 : 0).find(x => x.clip.id === badge?.id),
    };
  }, id);
  if (!r.made) throw new Error('no badge was created');
  if (r.type !== 'text') throw new Error('the badge is a ' + r.type + ', not a text layer you can drag');
  if (r.text !== '4×') throw new Error('the badge says "' + r.text + '" on a 4× clip');
  if (r.onText !== 'text') throw new Error('the badge landed on a ' + r.onText + ' track');
  if (!r.spans) throw new Error('the badge does not cover the clip it is about');
  if (!r.selected) throw new Error('the badge was not selected, so it cannot be dragged straight away');
  if (!r.visible) throw new Error('the compositor will not paint the badge');
});

await step('changing the speed rewrites the badge, in one undo step', async () => {
  const id = await aSpedClip(2);
  await page.evaluate((cid) => window.gc.cmds.addSpeedBadge(cid), id);
  await sleep(200);
  const r = await page.evaluate(async (cid) => {
    const { store, cmds, history } = window.gc;
    const badgeText = () => store.doc.tracks.flatMap(t => t.clips)
      .find(c => c.badgeFor === cid)?.text?.text;
    const before = badgeText();
    cmds.setClipSpeed(cid, 8);
    await new Promise(r => setTimeout(r, 160));
    const after = badgeText();
    const src = store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    const badge = store.doc.tracks.flatMap(t => t.clips).find(c => c.badgeFor === cid);
    const follows = Math.abs(badge.duration - src.duration) < 1e-3;
    history.undo();
    await new Promise(r => setTimeout(r, 160));
    return { before, after, follows, undone: badgeText() };
  }, id);
  if (r.before !== '2×') throw new Error('the badge started at "' + r.before + '"');
  if (r.after !== '8×') throw new Error(`the badge still says "${r.after}" after the clip went to 8× — it is lying about the clip`);
  if (!r.follows) throw new Error('the badge did not shorten with the clip, so it hangs past the end');
  if (r.undone !== '2×') throw new Error(`one undo left the badge at "${r.undone}" — the badge and the speed are separate history steps`);
});

await step('removing the badge takes it off the timeline', async () => {
  const id = await aSpedClip(3);
  await page.evaluate((cid) => window.gc.cmds.addSpeedBadge(cid), id);
  await sleep(180);
  const gone = await page.evaluate(async (cid) => {
    const { store, cmds } = window.gc;
    cmds.removeSpeedBadge(cid);
    await new Promise(r => setTimeout(r, 150));
    return !store.doc.tracks.flatMap(t => t.clips).some(c => c.badgeFor === cid);
  }, id);
  if (!gone) throw new Error('the badge survived being removed');
});

/* ── Smoothness ──────────────────────────────────────────────────
   The timeline used to let the playhead walk off the right-hand edge during
   playback, so after a few seconds you were watching one thing and looking at
   another. */
console.log('\n── following the playhead ───────────────');

await step('the timeline follows the playhead during playback', async () => {
  const r = await page.evaluate(async () => {
    const { store, timeline, playback } = window.gc;
    // A long project, zoomed in, so the playhead is guaranteed to run off.
    for (const t of store.doc.tracks) { t.clips.length = 0; t.hidden = false; }
    const track = store.doc.tracks.find(t => t.kind === 'text');
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const c = makeClip('text', { trackId: track.id, start: 0, duration: 60 });
    track.clips.push(c);
    store.docChanged('follow test');
    store.ui.zoom = 8;
    store.ui.scrollX = 0;
    timeline.repaint();

    const startScroll = store.ui.scrollX;
    playback.play();
    await new Promise(res => setTimeout(res, 2600));
    const moved = store.ui.scrollX;
    const x = timeline.L.t2x(store.rt.playhead);
    playback.pause();
    return { startScroll, moved, x, W: timeline.L.W, head: store.rt.playhead };
  });

  if (!(r.head > 0.5)) throw new Error('playback did not actually run (playhead at ' + r.head + ')');
  if (r.moved <= r.startScroll + 1e-3)
    throw new Error(`the timeline never scrolled: still at ${r.moved} with the playhead at ${r.head}s`);
  if (!(r.x >= -2 && r.x <= r.W + 2))
    throw new Error(`the playhead is ${Math.round(r.x)}px into a ${r.W}px view — it has been left behind`);
});

await step('touching the timeline stops it moving by itself', async () => {
  const r = await page.evaluate(async () => {
    const { store, timeline, playback } = window.gc;
    store.ui.zoom = 8;
    playback.seek(0);
    store.ui.scrollX = 0;
    timeline.repaint();
    playback.play();
    await new Promise(res => setTimeout(res, 400));
    // A person taking hold of the view.
    timeline.deferFollow(4000);
    const at = store.ui.scrollX;
    store.ui.scrollX = 0;
    timeline.repaint();
    await new Promise(res => setTimeout(res, 900));
    const after = store.ui.scrollX;
    playback.pause();
    return { at, after };
  });
  if (r.after > 0.001)
    throw new Error(`the view yanked itself back to ${r.after} while the pointer was down`);
});

/* ── Graphics ────────────────────────────────────────────────────
   A graphic is an image layer with a look and a movement. The looks are only
   worth having if they reach the renderer, and the movements are only worth
   having if they are real keyframes you can then edit — so those are the two
   things these check, rather than that the buttons exist. */
console.log('\n── graphics ─────────────────────────────');

/** One image layer, selected, with the Inspector showing. */
async function aGraphic() {
  const id = await page.evaluate(async () => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { store, assets, playback } = window.gc;
    for (const t of store.doc.tracks) { t.clips.length = 0; t.hidden = false; }
    // A tiny PNG with transparency — the case the silhouette effects exist for.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==';
    const asset = assets.add({ kind: 'image', name: 'logo.png', url: png, thumb: png, duration: 5 });
    const track = store.doc.tracks.find(t => t.kind === 'video');
    const clip = makeClip('image', {
      trackId: track.id, assetId: asset.id, name: 'logo.png',
      start: 0, duration: 4, fit: 'contain',
    });
    track.clips.push(clip);
    store.docChanged('graphic');
    store.select([clip.id]);
    playback.seek(1);
    document.querySelector('#rightTabs [data-tab="inspect"]')?.click();
    return clip.id;
  });
  await sleep(260);
  return id;
}

await step('an image layer is offered looks and movements', async () => {
  await aGraphic();
  const r = await page.evaluate(() => ({
    looks: document.querySelectorAll('#inspectorRoot .gfxlook').length,
    motions: document.querySelectorAll('#inspectorRoot [data-motion]').length,
    strip: !!document.getElementById('keysStrip'),
  }));
  if (r.looks < 5) throw new Error('only ' + r.looks + ' looks offered');
  if (r.motions < 6) throw new Error('only ' + r.motions + ' movements offered');
  if (!r.strip) throw new Error('no keyframe strip');
});

await step('picking a look writes effects the renderer will use', async () => {
  const id = await aGraphic();
  await page.click('#inspectorRoot .gfxlook[data-look="sticker"]');
  await sleep(240);
  const r = await page.evaluate(async (cid) => {
    const { store, comp } = window.gc;
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    const { fxActive } = await import('app://gamecut/src/engine/layers/fx.js');
    return { fx: clip.fx, active: fxActive(clip.fx), lit: !!comp };
  }, id);
  if (!r.fx) throw new Error('the look wrote nothing onto the clip');
  if (!r.active) throw new Error('the effects block is there but reads as inert');
  if (!(r.fx.outline > 0)) throw new Error('the Sticker look has no outline: ' + JSON.stringify(r.fx));
});

await step('a look is one undo step and can be taken off', async () => {
  const id = await aGraphic();
  await page.click('#inspectorRoot .gfxlook[data-look="glow"]');
  await sleep(220);
  const r = await page.evaluate(async (cid) => {
    const find = () => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    const on = !!find().fx?.glow;
    window.gc.history.undo();
    await new Promise(r => setTimeout(r, 140));
    return { on, off: !find().fx };
  }, id);
  if (!r.on) throw new Error('the Glow look set no glow');
  if (!r.off) throw new Error('one undo did not take the look back off');
});

await step('a movement preset writes real, editable keyframes', async () => {
  const id = await aGraphic();
  await page.click('#inspectorRoot [data-motion="pop"]');
  await sleep(300);
  const r = await page.evaluate((cid) => {
    const clip = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    const keys = clip.keys || {};
    return {
      paths: Object.keys(keys),
      scale: keys['transform.scale'],
      diamonds: document.querySelectorAll('#keysStrip .keys__k').length,
      rows: document.querySelectorAll('#keysStrip .keys__row').length,
    };
  }, id);
  if (!r.paths.length) throw new Error('the preset wrote no keyframes at all');
  if (!r.scale || r.scale.length < 2) throw new Error('Pop in did not animate size');
  if (r.scale[0].v >= r.scale[1].v) throw new Error('Pop in starts bigger than it ends');
  if (!r.rows) throw new Error('the keyframe strip shows no rows for the new animation');
  if (r.diamonds < r.scale.length) throw new Error(`${r.diamonds} diamonds for ${r.scale.length}+ keys — the strip is not showing the real keys`);
});

await step('the animation actually changes what is drawn over time', async () => {
  const id = await aGraphic();
  await page.click('#inspectorRoot [data-motion="slide-l"]');
  await sleep(260);
  const r = await page.evaluate(async (cid) => {
    const { store } = window.gc;
    const { evalProp } = await import('app://gamecut/src/engine/keyframes.js');
    const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    return {
      atStart: evalProp(clip, 'transform.x', clip.start),
      atHalf: evalProp(clip, 'transform.x', clip.start + 0.6),
      opacity0: evalProp(clip, 'transform.opacity', clip.start),
    };
  }, id);
  if (Math.abs(r.atStart - r.atHalf) < 0.05)
    throw new Error(`the layer barely moves: ${r.atStart} → ${r.atHalf}`);
  if (!(r.atStart < r.atHalf)) throw new Error('"in from left" does not come from the left');
  if (r.opacity0 > 0.01) throw new Error('the entrance does not start invisible');
});

await step('a keyframe can be dragged and deleted by hand', async () => {
  const id = await aGraphic();
  await page.click('#inspectorRoot [data-motion="pop"]');
  await sleep(280);

  const before = await page.evaluate((cid) => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(x => x.id === cid);
    return (c.keys['transform.scale'] || []).map(k => k.t);
  }, id);
  if (before.length < 2) throw new Error('nothing to drag');

  // Drag the last diamond of the size row to the right.
  const box = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#keysStrip .keys__row')]
      .find(r => r.dataset.path === 'transform.scale');
    if (!row) return null;
    const ks = [...row.querySelectorAll('.keys__k')];
    const track = row.querySelector('.keys__track');
    const k = ks[ks.length - 1].getBoundingClientRect();
    const t = track.getBoundingClientRect();
    return { kx: k.x + k.width / 2, ky: k.y + k.height / 2, tx: t.x, tw: t.width, ty: t.y + t.height / 2 };
  });
  if (!box) throw new Error('no size row in the strip');

  await page.mouse.move(box.kx, box.ky);
  await page.mouse.down();
  // Deliberately slowly, with a pause between each move.
  //
  // The failure this guards against is a rebuild landing in the middle of the
  // gesture and throwing away the very button holding the pointer capture. A
  // fast drag can outrun the animation frame that rebuilds the panel, so a
  // quick synthetic drag passes whether or not the bug is there. Pausing longer
  // than a frame between moves makes the race deterministic.
  for (const p of [0.35, 0.55, 0.8]) {
    await page.mouse.move(box.tx + box.tw * p, box.ty, { steps: 3 });
    await sleep(150);
  }
  await page.mouse.up();
  await sleep(260);

  const after = await page.evaluate((cid) => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(x => x.id === cid);
    return (c.keys['transform.scale'] || []).map(k => k.t);
  }, id);
  // Not just "it moved a bit": it has to land where the pointer finished.
  // Committing on every pointermove moved it a few pixels and then stopped
  // dead, because the Inspector rebuilt and threw the button away mid-gesture —
  // and an assertion that only asked for movement passed anyway.
  const movedTo = Math.max(...after);
  const clipDur = await page.evaluate((cid) =>
    window.gc.store.doc.tracks.flatMap(t => t.clips).find(x => x.id === cid).duration, id);
  const want = clipDur * 0.8;
  if (!(movedTo > Math.max(...before) + 0.1))
    throw new Error(`dragging did not retime the key: ${before.join(',')} → ${after.join(',')}`);
  if (Math.abs(movedTo - want) > clipDur * 0.12)
    throw new Error(`the key stopped at ${movedTo.toFixed(2)}s but the pointer ended at ${want.toFixed(2)}s `
      + '— the drag was cut short, most likely by a rebuild mid-gesture');

  // And double-click takes one away.
  const n0 = after.length;
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#keysStrip .keys__row')]
      .find(r => r.dataset.path === 'transform.scale');
    const ks = [...row.querySelectorAll('.keys__k')];
    ks[ks.length - 1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(240);
  const n1 = await page.evaluate((cid) => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(x => x.id === cid);
    return (c.keys['transform.scale'] || []).length;
  }, id);
  if (n1 !== n0 - 1) throw new Error(`double-click left ${n1} keys, expected ${n0 - 1}`);
});

await step('removing the movement leaves the layer where it was', async () => {
  const id = await aGraphic();
  await page.click('#inspectorRoot [data-motion="spin"]');
  await sleep(260);
  await page.click('#btnClearKeys');
  await sleep(240);
  const r = await page.evaluate((cid) => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(x => x.id === cid);
    return { keys: Object.keys(c.keys || {}).length, there: !!c };
  }, id);
  if (!r.there) throw new Error('the layer disappeared');
  if (r.keys) throw new Error(r.keys + ' key tracks survived being cleared');
});

/* The effects themselves, at the pixel. A look that writes numbers onto a clip
   and then paints nothing would pass every check above. */
await step('a glow paints light outside the layer, and a tilt reshapes it', async () => {
  const r = await page.evaluate(async () => {
    const { drawFx } = await import('app://gamecut/src/engine/layers/fx.js');

    // A solid white square, 60×60, as the layer.
    const piece = document.createElement('canvas');
    piece.width = 60; piece.height = 60;
    const pc = piece.getContext('2d');
    pc.fillStyle = '#fff';
    pc.fillRect(0, 0, 60, 60);

    const run = (fx) => {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 200;
      const x = c.getContext('2d');
      x.save();
      x.translate(100, 100);
      drawFx(x, piece, { radius: 0, glow: 0, shadow: 0, outline: 0, tintAmount: 0,
                         tiltX: 0, tiltY: 0, depth: 0, ...fx }, 60, 60, 1);
      x.restore();
      const d = x.getImageData(0, 0, 200, 200).data;
      // Count lit pixels that fall OUTSIDE the 60×60 the layer itself occupies.
      let outside = 0, inside = 0, leftHalf = 0, rightHalf = 0;
      for (let py = 0; py < 200; py++) {
        for (let px = 0; px < 200; px++) {
          const a = d[(py * 200 + px) * 4 + 3];
          if (a < 24) continue;
          const within = px >= 70 && px < 130 && py >= 70 && py < 130;
          if (within) inside++; else outside++;
          if (px < 100) leftHalf++; else rightHalf++;
        }
      }
      return { outside, inside, leftHalf, rightHalf };
    };

    return {
      plain: run({}),
      glow: run({ glow: 0.25, glowColor: '#22d3ee', glowStrength: 1.4 }),
      outline: run({ outline: 0.06, outlineColor: '#ffffff' }),
      tilt: run({ tiltY: 35 }),
    };
  });

  if (r.plain.outside > 40)
    throw new Error(`a layer with no effects painted ${r.plain.outside} pixels outside itself`);
  if (!(r.plain.inside > 3000))
    throw new Error(`the plain layer barely painted at all (${r.plain.inside} pixels)`);

  if (!(r.glow.outside > 600))
    throw new Error(`the glow put only ${r.glow.outside} pixels outside the layer — it is not reaching the canvas`);
  if (!(r.outline.outside > 300))
    throw new Error(`the outline put only ${r.outline.outside} pixels outside the layer`);

  // A layer turned about its vertical axis is no longer symmetrical.
  const bias = Math.abs(r.tilt.leftHalf - r.tilt.rightHalf) / Math.max(1, r.tilt.leftHalf + r.tilt.rightHalf);
  const flat = Math.abs(r.plain.leftHalf - r.plain.rightHalf) / Math.max(1, r.plain.leftHalf + r.plain.rightHalf);
  if (!(bias > flat + 0.02))
    throw new Error(`a 35° turn left the layer as symmetrical as an untilted one (${bias.toFixed(3)} vs ${flat.toFixed(3)}) — the perspective is not being applied`);
  // ...but it must still be the same layer, roughly where it was. All the
  // pixels landing in one half means it was squeezed into a corner, which is
  // what happens when the tilt slices the wrong part of its source.
  if (bias > 0.45)
    throw new Error(`the tilted layer is entirely on one side (${(bias * 100).toFixed(0)}% bias) — it has been squashed, not turned`);
  if (r.tilt.inside < r.plain.inside * 0.45)
    throw new Error(`the tilted layer lost most of itself: ${r.tilt.inside} pixels vs ${r.plain.inside} untilted`);

  console.log(`     glow +${r.glow.outside}px outside \u00b7 outline +${r.outline.outside}px \u00b7 tilt asymmetry ${(bias * 100).toFixed(1)}%`);
});

/* ── Regressions ─────────────────────────────────────────────────
   One check per bug that was found by reading the code rather than by using
   the app. Each of these looked completely fine on screen. */
console.log('\n── regressions ──────────────────────────');

await step('a movement preset still plays on a very short clip', async () => {
  const r = await page.evaluate(async () => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { evalProp } = await import('app://gamecut/src/engine/keyframes.js');
    const { MOTIONS } = await import('app://gamecut/src/ui/graphics/motion.js');
    const { store } = window.gc;
    for (const t of store.doc.tracks) { t.clips.length = 0; t.hidden = false; }
    const track = store.doc.tracks.find(t => t.kind === 'text');
    // A third of a second — what you get from a hard trim, or from putting a
    // graphic on a clip at 16×.
    const clip = makeClip('text', { trackId: track.id, start: 0, duration: 0.3 });
    track.clips.push(clip);

    const out = {};
    for (const m of MOTIONS) {
      if (m.id === 'none') continue;
      clip.keys = m.build(clip) || {};
      const paths = Object.keys(clip.keys);
      // By the end of the clip, everything the preset animates must have
      // arrived somewhere sensible rather than still being mid-entrance.
      out[m.id] = {
        opacityAtEnd: paths.includes('transform.opacity')
          ? +evalProp(clip, 'transform.opacity', clip.start + clip.duration).toFixed(3) : null,
        xAtEnd: paths.includes('transform.x')
          ? +evalProp(clip, 'transform.x', clip.start + clip.duration).toFixed(3) : null,
        scaleMid: paths.includes('transform.scale')
          ? +evalProp(clip, 'transform.scale', clip.start + clip.duration * 0.5).toFixed(3) : null,
        ordered: paths.every(p => clip.keys[p].every((k, i, a) => i === 0 || k.t >= a[i - 1].t)),
        pastEnd: paths.some(p => clip.keys[p].some(k => k.t > clip.duration + 1e-6)),
      };
    }
    clip.keys = {};
    return out;
  });

  for (const [id, v] of Object.entries(r)) {
    if (!v.ordered) throw new Error(`"${id}" wrote keyframes out of order on a 0.3s clip`);
    if (v.pastEnd) throw new Error(`"${id}" put a keyframe past the end of a 0.3s clip`);
    if (v.opacityAtEnd != null && v.opacityAtEnd < 0.9 && id !== 'popout')
      throw new Error(`"${id}" leaves a 0.3s clip at ${v.opacityAtEnd} opacity — it never finishes appearing`);
    if (v.xAtEnd != null && Math.abs(v.xAtEnd - 0.5) > 0.05)
      throw new Error(`"${id}" leaves a 0.3s clip at x=${v.xAtEnd} — it never slides into place`);
    if (v.scaleMid != null && v.scaleMid < 0.5 && id !== 'popout')
      throw new Error(`"${id}" is still at ${v.scaleMid} scale halfway through a 0.3s clip`);
  }
});

await step('adding a graphic is a single undo', async () => {
  const r = await page.evaluate(async () => {
    const { store, history, assets, graphics, cmds } = window.gc;
    void graphics; void cmds;
    for (const t of store.doc.tracks) { t.clips.length = 0; t.hidden = false; }
    store.docChanged('reset');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==';
    const asset = assets.add({ kind: 'image', name: 'logo.png', url: png, thumb: png, duration: 5 });

    // Straight through the tab's own button, which is the path people take.
    document.querySelector('#leftTabs [data-tab="gfx"]')?.click();
    await new Promise(r => setTimeout(r, 200));
    const tile = document.querySelector(`#gfxRoot .gfxtile[data-asset="${asset.id}"]`);
    if (!tile) return { error: 'the graphic never appeared in the tab' };
    tile.click();
    await new Promise(r => setTimeout(r, 250));

    const count = () => store.doc.tracks.reduce((a, t) => a + t.clips.length, 0);
    const made = store.doc.tracks.flatMap(t => t.clips)[0];
    const placed = { n: count(), fx: !!made?.fx, fit: made?.fit, scale: made?.transform?.scale };
    history.undo();
    await new Promise(r => setTimeout(r, 200));
    return { placed, afterOneUndo: count() };
  });
  if (r.error) throw new Error(r.error);
  if (r.placed.n !== 1) throw new Error('expected one clip, got ' + r.placed.n);
  if (!r.placed.fx) throw new Error('the graphic arrived with no look on it');
  if (r.placed.fit !== 'contain') throw new Error('the graphic arrived as ' + r.placed.fit);
  if (!(r.placed.scale < 1)) throw new Error('the graphic arrived filling the frame');
  if (r.afterOneUndo !== 0)
    throw new Error(`one undo left ${r.afterOneUndo} clip(s) — placing a graphic is more than one history step`);
});

await step('an effect slider can be undone', async () => {
  const r = await page.evaluate(async () => {
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const { store, cmds, history, assets } = window.gc;
    for (const t of store.doc.tracks) { t.clips.length = 0; t.hidden = false; }
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==';
    const asset = assets.add({ kind: 'image', name: 'g.png', url: png, thumb: png, duration: 5 });
    const track = store.doc.tracks.find(t => t.kind === 'video');
    const clip = makeClip('image', { trackId: track.id, assetId: asset.id, start: 0, duration: 4, fit: 'contain' });
    clip.fx = { ...(await import('app://gamecut/src/engine/layers/fx.js')).defaultFx(), glow: 0.1 };
    track.clips.push(clip);
    store.docChanged('fx undo test');
    store.select([clip.id]);
    document.querySelector('#rightTabs [data-tab="inspect"]')?.click();
    await new Promise(r => setTimeout(r, 250));
    void cmds; void history;
    return clip.id;
  });

  // Drag the Glow fader with a real pointer, the way the bug was reachable.
  // The Look group sits well down a scrolling panel, so bring it into view
  // first — a rect measured off-screen is still a rect, and clicking it lands
  // on whatever is actually at those coordinates.
  const box = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('#inspectorRoot .row')]
      .find(x => x.querySelector('label')?.textContent === 'Glow');
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 120));
    const t = row.querySelector('.sldr__track')?.getBoundingClientRect();
    return t && { x: t.x, y: t.y + t.height / 2, w: t.width };
  });
  if (!box) throw new Error('no Glow fader in the inspector');

  await page.mouse.move(box.x + box.w * 0.7, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.75, box.y, { steps: 4 });
  await page.mouse.up();
  await sleep(200);

  const out = await page.evaluate(async (cid) => {
    const find = () => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cid);
    const after = find().fx.glow;
    window.gc.history.undo();
    await new Promise(r => setTimeout(r, 200));
    return { after, undone: find()?.fx?.glow };
  }, r);

  if (!(out.after > 0.15)) {
    const why = await page.evaluate((pt) => {
      const el = document.elementFromPoint(pt.x, pt.y);
      const row = [...document.querySelectorAll('#inspectorRoot .row')]
        .find(x => x.querySelector('label')?.textContent === 'Glow');
      const t = row?.querySelector('.sldr__track')?.getBoundingClientRect();
      return {
        landedOn: el ? (el.className || el.tagName) : 'nothing',
        attached: !!row?.isConnected,
        trackNow: t && { x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.width) },
        readout: row?.querySelector('.sldr__val')?.textContent,
      };
    }, { x: box.x + box.w * 0.7, y: box.y });
    throw new Error(`dragging the Glow fader did not change the glow (${out.after}); `
      + `pointer was over ${why.landedOn}, row attached=${why.attached}, `
      + `fader now at ${JSON.stringify(why.trackNow)} vs measured ${JSON.stringify(box)}, readout "${why.readout}"`);
  }
  if (Math.abs(out.undone - 0.1) > 1e-3)
    throw new Error(`undo left the glow at ${out.undone}, not the 0.1 it started at `
      + '— the fader wrote onto the document before the command took its snapshot');
});

console.log('\n── screenshots ──────────────────────────');
await page.click('#btnZoomFit');
await sleep(400);
await page.screenshot({ path: `${SHOT}/gamecut-full.png` });
await page.locator('#timelinePanel').screenshot({ path: `${SHOT}/gamecut-timeline.png` });
await page.locator('#leftPanel').screenshot({ path: `${SHOT}/gamecut-left.png` });
await page.locator('#rightPanel').screenshot({ path: `${SHOT}/gamecut-right.png` });

// The help sheet, because it is a piece of interface that only ever appears on
// purpose and would otherwise never be looked at again after it was written.
await page.keyboard.press('?');
await sleep(500);
await page.screenshot({ path: `${SHOT}/gamecut-help.png` });
await page.click('#helpClose');
await sleep(300);

await app.close();
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`FAILED — ${problems.length} problem(s):\n`);
  const seen = new Map();
  for (const p of problems) seen.set(p, (seen.get(p) || 0) + 1);
  for (const [p, n] of seen) console.log(` • ${p}${n > 1 ? `  (x${n})` : ''}`);
  process.exit(1);
} else {
  console.log('PASSED — zero console errors, page errors or failed requests.');
}
