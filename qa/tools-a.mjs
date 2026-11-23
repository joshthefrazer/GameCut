/**
 * Strike 3.0 Update A: the editing tools, through the front door.
 * Colour, blend modes, In / Out (mark, loop, Lift, Extract, export just the range),
 * J K L shuttle, frame step, trim to playhead, slip, go to a time, subtitle files,
 * the What's-new card, and the moved keys (Ctrl+I import, Shift+L loop).
 *   node qa/tools-a.mjs
 */
import { launch, FIX } from './harness.mjs';

const T = await launch({ name: 'toolsa' });
const { win, ev, frame, step, fresh, importFiles, byStart, sleep, playheadTo, clickClip, finish } = T;
const CLIP = FIX('test-clip.mp4');
const LOGO = FIX('test-logo.png');

const grab = () => ev(() => {
  const c = window.gc.comp.canvas;
  const s = document.createElement('canvas'); s.width = 64; s.height = 36;
  s.getContext('2d').drawImage(c, 0, 0, 64, 36);
  return Array.from(s.getContext('2d').getImageData(0, 0, 64, 36).data);
});
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4) / 3; };
const sat = (a) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.max(a[i], a[i + 1], a[i + 2]) - Math.min(a[i], a[i + 1], a[i + 2]); return s / (a.length / 4); };
const renderAt = async (t) => {
  await ev((t) => { window.gc.playback.pause(); window.gc.playback.seek(t); }, t);
  for (let i = 0; i < 20; i++) { await sleep(150); if (await ev((t) => window.gc.comp.render(t, false), t)) break; }
  await sleep(80);
  return grab();
};
const video = async () => (await byStart('video'))[0];
const keyAt = async (k, t = null) => { if (t != null) await playheadTo(t); await win.mouse.move(4, 400); await ev(() => document.activeElement?.blur?.()); await win.keyboard.press(k); await frame(); };

console.log('\n── tools (3.0 Update A) ─────');

await step('Colour: the Colour group is on the Picture tab, and Mono drains the colour (undo puts it back)', async () => {
  await fresh(); await importFiles([CLIP]);
  const v = await video();
  const before = await renderAt(1.2);
  await clickClip(v.id);
  await win.click('#inspectorRoot [data-itab="picture"]'); await frame();
  const has = await ev(() => !!document.querySelector('#inspectorRoot [data-group="colour"] .ctile[data-colour="mono"]'));
  if (!has) throw new Error('no Colour group with preset tiles');
  await win.click('#inspectorRoot .ctile[data-colour="mono"]'); await frame();
  const mono = await renderAt(1.2);
  if (!(sat(before) > 20)) throw new Error('the test clip is not colourful to begin with: ' + sat(before));
  if (!(sat(mono) < 4)) throw new Error('Mono did not make it black and white: saturation ' + sat(mono).toFixed(1));
  const c = (await video()).color || (await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id)?.color, v.id));
  if (!c || c.saturation !== -1) throw new Error('clip.color not saved: ' + JSON.stringify(c));
  await ev(() => window.gc.history.undo()); await frame();
  const back = await renderAt(1.2);
  if (diff(back, before) > 2) throw new Error('undo did not bring the colour back');
});

await step('Colour sliders: warmth makes it warmer, Compare shows the original on the left', async () => {
  const v = await video();
  const plain = await renderAt(1.2);
  await ev((id) => window.gc.cmds.setClipProp(id, 'color', { brightness: 0, contrast: 0, saturation: 0, warmth: 1, tint: 0, fade: 0 }, { merge: false }), v.id);
  const warm = await renderAt(1.2);
  const avg = (a, ch) => { let s = 0; for (let i = ch; i < a.length; i += 4) s += a[i]; return s / (a.length / 4); };
  // Warmer = red pulled up against blue (bright test colours clip, so compare the gap, not red alone).
  if (!((avg(warm, 0) - avg(warm, 2)) - (avg(plain, 0) - avg(plain, 2)) > 20 && avg(warm, 0) > avg(plain, 0))) {
    throw new Error(`warmth: red ${avg(plain, 0).toFixed(1)}→${avg(warm, 0).toFixed(1)}, blue ${avg(plain, 2).toFixed(1)}→${avg(warm, 2).toFixed(1)}`);
  }
  await ev(() => { window.gc.comp.compare = { on: true, x: 0.5 }; });
  const cmp = await renderAt(1.2);
  await ev(() => { window.gc.comp.compare.on = false; });
  const half = (a, b, x0, x1) => { let d = 0, n = 0; for (let y = 0; y < 36; y++) for (let x = x0; x < x1; x++) { const i = (y * 64 + x) * 4; d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 2] - b[i + 2]); n++; } return d / n / 2; };
  if (half(cmp, plain, 2, 28) > 3) throw new Error('Compare left side is not the original');
  if (half(cmp, warm, 36, 62) > 3) throw new Error('Compare right side is not the graded picture');
  await ev((id) => window.gc.cmds.setClipProp(id, 'color', null, { merge: false }), v.id);
});

await step('Blend: a picture set to Multiply darkens instead of covering, and the choice is saved', async () => {
  await fresh(); await importFiles([CLIP, LOGO]);
  await ev(async () => {
    const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
    const g = window.gc; const a = g.assets.all().find(x => x.kind === 'image'); placeAsset(g.store, g.cmds, a.id, { start: 0, allowShift: true });
  });
  await frame();
  const img = (await byStart('image'))[0];
  if (!img) throw new Error('logo not placed');
  await ev((id) => window.gc.cmds.setClipProp(id, 'transform.scale', 4, { merge: false }), img.id);
  const normal = await renderAt(1.2);
  await clickClip(img.id);
  await win.click('#inspectorRoot [data-itab="picture"]'); await frame();
  const sel = await win.$('#blendMode');
  if (!sel) throw new Error('no Blend menu next to Opacity');
  await win.selectOption('#blendMode', 'multiply'); await frame();
  const mult = await renderAt(1.2);
  const b = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id)?.blend, img.id);
  if (b !== 'multiply') throw new Error('blend not saved: ' + b);
  if (!(diff(normal, mult) > 3)) throw new Error('Multiply looks the same as Normal');
  await win.selectOption('#blendMode', 'normal'); await frame();
});

await step('I and O mark In and Out; the length shows beside the time; Alt+X clears them', async () => {
  await fresh(); await importFiles([CLIP]);
  await keyAt('i', 1); await keyAt('o', 3);
  const r = await ev(() => window.gc.store.doc.range);
  if (!r || Math.abs(r.in - 1) > 0.02 || Math.abs(r.out - 3) > 0.02) throw new Error('range: ' + JSON.stringify(r));
  const chip = await ev(() => { const c = document.getElementById('rangeChip'); return c && !c.hidden ? c.textContent : null; });
  if (!/IN.OUT 2\.00 s/.test(chip || '')) throw new Error('range chip: ' + chip);
  const assets = await ev(() => window.gc.assets.all().length);
  if (assets !== 1) throw new Error('pressing I imported something (it must mark In now)');
  await keyAt('Alt+x');
  if (await ev(() => window.gc.store.doc.range)) throw new Error('Alt+X did not clear');
  await ev(() => window.gc.history.undo());
  if (!(await ev(() => window.gc.store.doc.range))) throw new Error('undo did not bring the range back');
});

await step('Extract takes In to Out out and closes the gap; Lift leaves the gap; one undo each', async () => {
  const d0 = await ev(() => window.gc.store.rt.duration);
  await ev(() => window.gc.editTools.removeRange(true)); await frame();
  const d1 = await ev(() => window.gc.store.rt.duration);
  if (Math.abs((d0 - d1) - 2) > 0.05) throw new Error(`Extract: ${d0} → ${d1}`);
  await ev(() => window.gc.history.undo()); await frame();
  const d2 = await ev(() => window.gc.store.rt.duration);
  if (Math.abs(d2 - d0) > 0.02) throw new Error('one undo did not restore the Extract: ' + d2);
  await ev(() => window.gc.editTools.removeRange(false)); await frame();
  const clips = await byStart('video');
  const d3 = await ev(() => window.gc.store.rt.duration);
  if (Math.abs(d3 - d0) > 0.02) throw new Error('Lift changed the length');
  const gap = clips.length === 2 && Math.abs(clips[0].start + clips[0].duration - 1) < 0.02 && Math.abs(clips[1].start - 3) < 0.02;
  if (!gap) throw new Error('Lift did not leave a 1 s → 3 s gap: ' + JSON.stringify(clips.map(c => [c.start, c.duration])));
  await ev(() => window.gc.history.undo());
});

await step('Loop with In and Out set plays just that part', async () => {
  await ev(() => { window.gc.store.setRT({ loop: true }); window.gc.playback.seek(0.2); window.gc.playback.play(); });
  await sleep(300);
  const p0 = await ev(() => window.gc.store.rt.playhead);
  await sleep(2600);
  const seen = await ev(() => window.gc.store.rt.playhead);
  await ev(() => { window.gc.playback.pause(); window.gc.store.setRT({ loop: false }); });
  if (!(p0 >= 0.95 && p0 < 3.05)) throw new Error('play did not start at In: ' + p0);
  if (!(seen >= 0.95 && seen < 3.05)) throw new Error('played outside In to Out: ' + seen);
});

await step('Export "Only In to Out" renders just that part', async () => {
  const r = await ev(async () => {
    const { rangedStore } = await import('app://gamecut/src/export/range-doc.js');
    const { renderToMp4 } = await import('app://gamecut/src/export/render-export.js');
    const s = rangedStore(window.gc.store);
    let total = 0;
    const bytes = await renderToMp4({ store: s, width: 320, height: 180, fps: 30, vBitrate: 800_000, aBitrate: 96_000,
      onProgress: (e) => { if (e.phase === 'video' && e.total) total = e.total; }, shouldCancel: () => false });
    return { dur: s.rt.duration, total, size: bytes?.byteLength || 0, clips: s.doc.tracks.flatMap(t => t.clips).map(c => [+c.start.toFixed(3), +c.duration.toFixed(3), +(c.inPoint || 0).toFixed(3)]) };
  });
  if (Math.abs(r.dur - 2) > 0.02) throw new Error('range length ' + r.dur);
  if (Math.abs(r.total - 60) > 2) throw new Error('frames ' + r.total);
  if (!(r.size > 1000)) throw new Error('no file made');
  const v = r.clips.find(c => c[1] > 1.9);
  if (!v || Math.abs(v[2] - 1) > 0.02) throw new Error('the export did not start 1 s into the footage: ' + JSON.stringify(r.clips));
  const dialog = await ev(() => { document.getElementById('btnExport').click(); return new Promise(res => setTimeout(() => res(!!document.getElementById('xpRange')), 600)); });
  await ev(() => document.querySelector('#exportModal [data-close]')?.click());
  if (!dialog) throw new Error('the Export dialog does not offer "Only In to Out"');
});

await step('J K L: L plays, L again goes 2× (picture only), K stops, J goes backwards; , and . step a frame', async () => {
  await ev(() => window.gc.editTools.clearMarks());
  await keyAt('l', 1);
  await sleep(400);
  if (!(await ev(() => window.gc.store.rt.playing))) throw new Error('L did not play');
  await keyAt('l');
  await sleep(200);
  const a = await ev(() => window.gc.store.rt.playhead);
  await sleep(500);
  const b = await ev(() => window.gc.store.rt.playhead);
  const rate = await ev(() => window.gc.editTools.rate);
  if (rate !== 2) throw new Error('second L: rate ' + rate);
  if (!(b - a > 0.6)) throw new Error(`2× did not move fast enough: ${a} → ${b}`);
  await keyAt('k');
  const c = await ev(() => window.gc.store.rt.playhead);
  await sleep(300);
  const d = await ev(() => window.gc.store.rt.playhead);
  if (Math.abs(d - c) > 0.001 || (await ev(() => window.gc.store.rt.playing))) throw new Error('K did not stop');
  await keyAt('j');
  await sleep(400);
  await keyAt('k');
  const e = await ev(() => window.gc.store.rt.playhead);
  if (!(e < d - 0.15)) throw new Error(`J did not go backwards: ${d} → ${e}`);
  await playheadTo(2);
  await keyAt('.');
  const f1 = await ev(() => window.gc.store.rt.playhead);
  await keyAt(','); await keyAt(',');
  const f2 = await ev(() => window.gc.store.rt.playhead);
  const fr = 1 / (await ev(() => window.gc.store.doc.fps));
  if (Math.abs(f1 - (2 + fr)) > 1e-3 || Math.abs(f2 - (2 - fr)) > 1e-3) throw new Error(`frame step: ${f1}, ${f2}`);
});

await step('Alt+] trims the end of the clip to the playhead, Alt+[ the start', async () => {
  await fresh(); await importFiles([CLIP]);
  await keyAt('Alt+BracketRight', 4);
  let v = await video();
  if (Math.abs(v.start + v.duration - 4) > 0.02) throw new Error('end not at 4: ' + JSON.stringify([v.start, v.duration]));
  await keyAt('Alt+BracketLeft', 1);
  v = await video();
  if (Math.abs(v.inPoint - 1) > 0.02) throw new Error('start not trimmed: ' + JSON.stringify(v));
});

await step('Alt+. slips: a later part of the recording plays inside the clip, which stays where it is', async () => {
  await fresh(); await importFiles([CLIP]);
  const v0 = await video();
  await ev((id) => window.gc.cmds.trimClip(id, 'out', 3, false), v0.id);
  await clickClip(v0.id);
  await keyAt('Alt+Shift+Period');
  const v = await video();
  const fr = 1 / (await ev(() => window.gc.store.doc.fps));
  if (Math.abs(v.inPoint - 10 * fr) > 1e-3 || Math.abs(v.start - v0.start) > 1e-6) throw new Error('slip: ' + JSON.stringify([v.start, v.inPoint]));
});

await step('Ctrl+G (or a click on the time) goes to a time you type', async () => {
  await keyAt('Control+g');
  if (!(await ev(() => !document.getElementById('goToTime')?.hidden))) throw new Error('Ctrl+G did not open');
  await win.fill('#goToInput', '0:02.15');
  await win.keyboard.press('Enter'); await frame();
  const fps = await ev(() => window.gc.store.doc.fps);
  const p = await ev(() => window.gc.store.rt.playhead);
  if (Math.abs(p - (2 + 15 / fps)) > 1e-3) throw new Error('playhead ' + p);
  const parse = await ev(() => ['83', '1:23', '2m5s', '+1', '-0.5', 'nonsense'].map(s => window.gc.editTools.parseTime(s)));
  const want = [83, 83, 125, p + 1, p - 0.5, null];
  for (let i = 0; i < want.length; i++) if (want[i] === null ? parse[i] !== null : Math.abs(parse[i] - want[i]) > 1e-6) throw new Error('parseTime: ' + JSON.stringify(parse));
  await win.click('#tcCurrent');
  if (!(await ev(() => !document.getElementById('goToTime')?.hidden))) throw new Error('clicking the time did not open Go to');
  await win.keyboard.press('Escape');
});

await step('Subtitle files: an .srt comes in on the Captions lane, and saves back out the same', async () => {
  await fresh(); await importFiles([CLIP]);
  const SRT = '1\n00:00:00,500 --> 00:00:01,800\nHello <i>there</i>\n\n2\n00:00:02,000 --> 00:00:03,250\nsecond line\nwith a break\n';
  const n = await ev((s) => window.gc.captionFiles.importText(s, { name: 'test.srt' }), SRT);
  if (n !== 2) throw new Error('lines made: ' + n);
  const caps = await ev(() => window.gc.store.doc.tracks.find(t => t.name === 'Captions')?.clips.map(c => ({ s: c.start, d: c.duration, t: c.text.text, w: c.text.words?.length })));
  if (!caps || caps[0].t !== 'Hello there' || caps[1].t !== 'second line with a break' || caps[1].w !== 5) throw new Error(JSON.stringify(caps));
  const out = await ev(async () => { const m = await import('app://gamecut/src/captions/caption-files.js'); return m.toSRT(m.captionLines(window.gc.store.doc)); });
  if (!/^1\n00:00:00,500 --> 00:00:01,800\nHello there\n/.test(out) || !/00:00:02,000 --> 00:00:03,2[3-6]\d/.test(out)) throw new Error(out);
  const vtt = await ev(async () => { const m = await import('app://gamecut/src/captions/caption-files.js'); return m.parseCaptions('WEBVTT\n\n00:01.000 --> 00:02.500 align:center\n<v Bob>Hi</v> there\n'); });
  if (vtt.length !== 1 || vtt[0].text !== 'Hi there' || vtt[0].start !== 1 || vtt[0].end !== 2.5) throw new Error('vtt: ' + JSON.stringify(vtt));
});

await step('Moved keys: Shift+L loops, the help sheet lists the new keys, no What\'s-new card on a fresh install', async () => {
  const l0 = await ev(() => !!window.gc.store.rt.loop);
  await keyAt('Shift+l');
  const l1 = await ev(() => !!window.gc.store.rt.loop);
  await keyAt('Shift+l');
  if (l1 === l0) throw new Error('Shift+L did not toggle loop');
  const help = await ev(() => { window.gc.help.toggle(); const t = document.getElementById('helpSheet')?.textContent || ''; window.gc.help.toggle(); return t; });
  for (const k of ['Mark In / Out', 'Ctrl + I', 'J / K / L', 'Go to a time']) if (!help.includes(k)) throw new Error('help sheet is missing ' + k);
  if (await ev(() => { const w = document.getElementById('whatsNew'); return !!w && !w.hidden; })) throw new Error("What's-new card shown on a fresh install");
});

await finish('TOOLS-A');
