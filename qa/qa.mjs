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
    stragglers: ['effectsRoot', 'graphicsRoot'].filter(id => document.getElementById(id)),
    transTiles: document.querySelectorAll('#transRoot .trs').length,
    transApplies: typeof window.gc?.transitions?.target === 'function',
  }));
  if (r.stragglers.length) throw new Error('removed panels still in the DOM: ' + r.stragglers.join(', '));
  if (r.tabs.join() !== r.panes.join()) {
    throw new Error(`tabs (${r.tabs.join(', ')}) do not match panes (${r.panes.join(', ')})`);
  }
  if (r.tabs.join() !== 'media,trans') throw new Error('unexpected tabs: ' + r.tabs.join(', '));
  if (r.transTiles < 4) throw new Error('transitions panel has ' + r.transTiles + ' tiles');
  if (!r.transApplies) throw new Error('transitions panel exposes no way to apply anything');
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
