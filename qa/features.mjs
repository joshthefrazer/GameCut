/**
 * The new editing features, through the front door: effects, compare,
 * copy/paste look, speed ramps, highlights, beat sync, the highlight reel,
 * auto-duck and voice clean-up.
 *   xvfb-run -a node qa/features.mjs
 */
import { execFileSync } from 'node:child_process';
import { launch, FIX, ROOT } from './harness.mjs';

const OUT = `${ROOT}/qa/out`;
const T = await launch({ name: 'features' });
const { win, ev, frame, step, fresh, importFiles, byStart, sleep, playheadTo } = T;
const CLIP = FIX('test-clip.mp4');

// A recording that is quiet except for two loud bursts, at 1.5 s and 4 s.
const BURSTS = `${OUT}/bursts.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-f', 'lavfi', '-i', "aevalsrc='0.02*sin(2*PI*220*t)+if(between(t,1.5,1.8)+between(t,4,4.3),0.9*sin(2*PI*330*t),0)':s=48000",
  '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', BURSTS]);
// A click track at 120 BPM.
const CLICKS = `${OUT}/clicks120.mp3`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
  "aevalsrc='if(lt(mod(t-0.25,0.5),0.04),0.9*sin(2*PI*1000*t),0)':s=44100", '-t', '16', '-c:a', 'libmp3lame', CLICKS]);

const grab = () => ev(() => {
  const c = window.gc.comp.canvas;
  const s = document.createElement('canvas'); s.width = 64; s.height = 36;
  s.getContext('2d').drawImage(c, 0, 0, 64, 36);
  return Array.from(s.getContext('2d').getImageData(0, 0, 64, 36).data);
});
const diff = (a, b, x0 = 0, x1 = 64) => {
  let d = 0, n = 0;
  for (let y = 0; y < 36; y++) for (let x = x0; x < x1; x++) {
    const i = (y * 64 + x) * 4; d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n++;
  }
  return d / n / 3;
};
const renderAt = async (t) => {
  await win.mouse.move(4, 400);
  await ev((t) => { window.gc.playback.pause(); window.gc.playback.seek(t); }, t);
  for (let i = 0; i < 20; i++) { await sleep(150); if (await ev((t) => window.gc.comp.render(t, false), t)) break; }
  await sleep(80);
  return grab();
};
const clipsOf = async (type) => (await byStart(type));

console.log('\n── features ─────');

await step('Effects drawer: a punch-in zoom lands above the footage and really zooms the picture', async () => {
  await fresh(); await importFiles([CLIP]);
  const plain = await renderAt(1.4);
  await playheadTo(1);
  await win.click('#leftTabs [data-tab="fx"]'); await frame();
  await win.click('#fxRoot [data-fx="zoom"]'); await frame();
  const fx = (await clipsOf('effect'))[0];
  if (!fx) throw new Error('no effect clip');
  const main = (await clipsOf('video'))[0];
  if (fx.trackIndex >= main.trackIndex) throw new Error('the effect is not above the footage');
  const zoomed = await renderAt(1.4);
  if (diff(plain, zoomed) < 6) throw new Error(`the picture did not change (${diff(plain, zoomed).toFixed(1)})`);
  const after = await renderAt(3.5);
  const plainAfter = await (async () => { return after; })();
  void plainAfter;
});

await step('Z drops a punch-in zoom at the playhead; dragging the + moves where it zooms', async () => {
  await fresh(); await importFiles([CLIP]);
  await playheadTo(2);
  await win.keyboard.press('z'); await frame();
  const fx = (await clipsOf('effect'))[0];
  if (!fx || Math.abs(fx.start - 2) > 0.05) throw new Error('Z did not add a zoom at the playhead');
  await playheadTo(2.4);
  const p = await ev(() => { const r = document.getElementById('fxPoint').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: !document.getElementById('fxPoint').hidden }; });
  if (!p.shown) throw new Error('no zoom point on the picture');
  await win.mouse.move(p.x, p.y); await win.mouse.down();
  await win.mouse.move(p.x + 80, p.y + 40, { steps: 6 }); await win.mouse.up(); await frame();
  const e = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).effect, fx.id);
  if (!(e.x > 0.52 && e.y > 0.52)) throw new Error(`zoom point is ${e.x}, ${e.y}`);
});

await step('shake, flash and glitch each change the picture while they run', async () => {
  for (const kind of ['shake', 'flash', 'glitch', 'rgb', 'bw', 'vignette']) {
    await fresh(); await importFiles([CLIP]);
    const plain = await renderAt(1.1);
    await ev((k) => window.gc.cmds.addEffect(k, 1), kind);
    const fxd = await renderAt(1.1);
    if (diff(plain, fxd) < 2) throw new Error(`${kind} did nothing (${diff(plain, fxd).toFixed(2)})`);
  }
});

await step('an effect on the picture lanes leaves a title above it alone', async () => {
  await fresh(); await importFiles([CLIP]);
  await playheadTo(1); await win.keyboard.press('t'); await frame();
  await ev(() => window.gc.cmds.addEffect('shake', 1));
  const tracks = await ev(() => window.gc.store.doc.tracks.map(t => ({ kind: t.kind, has: t.clips.map(c => c.type) })));
  const ti = tracks.findIndex(t => t.has.includes('text')), ei = tracks.findIndex(t => t.has.includes('effect'));
  if (!(ti < ei)) throw new Error('the effect sits above the title');
});

await step('the export renders effects too (same painter at full size)', async () => {
  await fresh(); await importFiles([CLIP]);
  await ev(() => window.gc.cmds.addEffect('flash', 1));
  const r = await ev(async () => {
    const { Compositor } = await import('app://gamecut/src/engine/compositor.js');
    const c = document.createElement('canvas');
    const comp = new Compositor(window.gc.store, c, { fixedSize: { w: 320, h: 180 } });
    comp.resize();
    const at = async (t) => { for (let i = 0; i < 40; i++) { if (comp.render(t, false)) break; await new Promise(r => setTimeout(r, 100)); } const d = c.getContext('2d').getImageData(0, 0, 320, 180).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; };
    await at(1.02); await at(2.5);
    const flash = await at(1.02), plain = await at(2.5);
    comp.dispose();
    return { flash, plain };
  });
  if (!(r.flash > r.plain + 40)) throw new Error(`export frame during the flash is not brighter (${r.flash.toFixed(0)} vs ${r.plain.toFixed(0)})`);
});

await step('Compare: left of the line is without the effect, right of it is with', async () => {
  await fresh(); await importFiles([CLIP]);
  await ev(() => window.gc.cmds.addEffect('bw', 0.5));
  const withFx = await renderAt(1.5);
  await ev(() => { const g = window.gc; for (const t of g.store.doc.tracks) t.hidden = t.clips.some(c => c.type === 'effect'); g.store.docChanged('x'); });
  const without = await renderAt(1.5);
  await ev(() => { const g = window.gc; for (const t of g.store.doc.tracks) t.hidden = false; g.store.docChanged('x'); });
  await win.click('#btnCompare'); await frame();
  const cmp = await renderAt(1.5);
  await win.click('#btnCompare');
  if (diff(cmp, without, 2, 28) > 3) throw new Error('the left half is not the picture without effects');
  if (diff(cmp, withFx, 36, 62) > 3) throw new Error('the right half is not the finished picture');
});

await step('Copy look / paste look: a crop copied from one clip lands on others in one undo', async () => {
  await fresh(); await importFiles([CLIP, CLIP]);
  await ev(async () => {
    const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
    const g = window.gc; const a = g.assets.all()[1]; placeAsset(g.store, g.cmds, a.id, { allowShift: true });
  });
  await frame();
  const [a, b] = await clipsOf('video');
  await ev((id) => window.gc.cmds.setClipProp(id, 'crop', { x: 0.1, y: 0.1, w: 0.25, h: 0.25 }, { merge: false }), a.id);
  await ev((id) => window.gc.store.select([id]), a.id);
  await win.keyboard.press('Control+Alt+c');
  await ev((id) => window.gc.store.select([id]), b.id);
  const d0 = await ev(() => window.gc.history.undoStack.length);
  await win.keyboard.press('Control+Alt+v'); await frame();
  const nb = (await clipsOf('video')).find(x => x.id === b.id);
  const d1 = await ev(() => window.gc.history.undoStack.length);
  if (!nb.crop || Math.abs(nb.crop.w - 0.25) > 1e-6) throw new Error('the crop did not paste');
  if (d1 - d0 !== 1) throw new Error(`${d1 - d0} undo steps`);
});

await step('Speed ramp "Hit & release": slow pieces around the playhead, nothing overlaps, one undo', async () => {
  await fresh(); await importFiles([CLIP]);
  const [v] = await clipsOf('video');
  await ev((id) => window.gc.store.select([id]), v.id); await sleep(200);
  await playheadTo(2.5);
  await win.click('#inspectorRoot [data-itab="timing"]'); await frame();
  const d0 = await ev(() => window.gc.history.undoStack.length);
  await win.click('#inspectorRoot [data-ramp="hit"]'); await frame();
  const vs = await clipsOf('video');
  const d1 = await ev(() => window.gc.history.undoStack.length);
  if (vs.length < 3) throw new Error(`only ${vs.length} pieces`);
  if (!vs.some(x => Math.abs(x.speed - 0.25) < 1e-6)) throw new Error('no slow-motion piece');
  for (let i = 1; i < vs.length; i++) if (Math.abs(vs[i].start - (vs[i - 1].start + vs[i - 1].duration)) > 2 / 60) throw new Error('pieces do not butt up');
  const total = vs.reduce((s, x) => s + x.duration, 0);
  if (!(total > v.duration + 0.5)) throw new Error(`ramp did not lengthen the clip (${total})`);
  // Footage stays continuous: each piece starts where the last one ended in the source.
  for (let i = 1; i < vs.length; i++) {
    const end = vs[i - 1].inPoint + vs[i - 1].duration * vs[i - 1].speed;
    if (Math.abs(vs[i].inPoint - end) > 0.05) throw new Error('a piece skips or repeats footage');
  }
  if (d1 - d0 !== 1) throw new Error(`${d1 - d0} undo steps`);
});

await step('Find highlights marks the loud moments', async () => {
  await fresh(); await importFiles([BURSTS]);
  await sleep(1500);
  await win.click('#leftTabs [data-tab="media"]');
  await win.click('#btnHighlights'); await frame();
  const ms = await ev(() => window.gc.store.doc.markers.map(m => m.t));
  const near = (t) => ms.some(m => Math.abs(m - t) < 0.5);
  if (!near(1.6) || !near(4.1)) throw new Error(`markers at ${ms.map(m => m.toFixed(2)).join(', ')}`);
  await ev(() => window.gc.playback.seek(0));
  await win.keyboard.press(']'); await frame();
  const ph = await ev(() => window.gc.store.rt.playhead);
  if (Math.abs(ph - ms[0]) > 0.02) throw new Error('] did not jump to the first marker');
});

await step('Find the beat reads 120 BPM off a click track and turns the beat grid on', async () => {
  await fresh(); await importFiles([CLIP, CLICKS]);
  await sleep(1500);
  await win.click('#btnBeatSong'); await frame();
  const r = await ev(() => ({ bpm: window.gc.store.doc.bpm, off: window.gc.store.doc.beatOffset, grid: window.gc.store.ui.beatGrid }));
  if (Math.abs(r.bpm - 120) > 1) throw new Error(`found ${r.bpm} BPM`);
  if (!r.grid) throw new Error('the beat grid is off');
  const ph = ((r.off - 0.25) % 0.5 + 0.5) % 0.5;
  if (Math.min(ph, 0.5 - ph) > 0.06) throw new Error(`beats are off the clicks by ${ph.toFixed(3)}s`);
});

await step('Cut to the beat makes every main-lane shot a whole number of beats', async () => {
  await fresh(); await importFiles([CLIP]);
  await ev(() => { window.gc.cmds.setBPM(120); window.gc.store.doc.beatOffset = 0; });
  await playheadTo(1.3); await win.keyboard.press('s'); await frame();
  await ev(() => window.gc.store.select([]));
  await playheadTo(3.1); await win.keyboard.press('s'); await frame();
  await win.click('#btnCutBeat'); await frame();
  for (const c of await clipsOf('video')) {
    const k = c.duration / 0.5;
    if (Math.abs(k - Math.round(k)) > 0.04 && c !== (await clipsOf('video')).at(-1)) throw new Error(`a shot is ${c.duration}s, not whole beats`);
    const s = c.start / 0.5;
    if (Math.abs(s - Math.round(s)) > 0.04) throw new Error(`a shot starts off the beat at ${c.start}`);
  }
});

const soundReady = () => T.ev(() => window.gc.assets.all().every(a => a.kind !== 'video' || a.peaks?.rms));
const waitSound = async () => { for (let i = 0; i < 60 && !(await soundReady()); i++) await sleep(250); };
await step('Highlight reel: the loud moments of a recording become a first cut', async () => {
  await fresh(); await importFiles([BURSTS]);
  await sleep(1500);
  await ev(() => window.gc.cmds.removeSelected());
  await ev(() => { const g = window.gc; g.store.select(g.cmds.selectableIds()); g.cmds.removeSelected(); });
  await win.click('#btnReel'); await frame();
  const vs = await clipsOf('video');
  if (vs.length < 1) throw new Error(`${vs.length} shots`);
  const covers = (t) => vs.some(c => t >= c.inPoint && t <= c.inPoint + c.duration);
  if (!covers(1.6) || !covers(4.1)) throw new Error('the reel misses a loud moment');
});

await step('Auto-duck: the music dips while the game is loud and comes back after', async () => {
  await fresh(); await importFiles([BURSTS, CLICKS]);
  await sleep(1500);
  const env = await ev(async () => {
    const g = window.gc;
    const music = g.store.doc.tracks.find(t => t.kind === 'audio' && t.clips.length);
    g.cmds.setTrackFlag(music.id, 'duck', { on: true, depth: 0.7 });
    const { duckEnvelope, gainAt } = await import('app://gamecut/src/audio/graph.js');
    const m = g.store.doc.tracks.find(t => t.id === music.id);
    const pts = duckEnvelope(g.store, m.clips[0], m);
    return pts && { loud: gainAt(pts, 1.75), quiet: gainAt(pts, 3.2) };
  });
  if (!env) throw new Error('no ducking envelope');
  if (!(env.loud < 0.5 && env.quiet > 0.9)) throw new Error(JSON.stringify(env));
});

await step('Voice clean-up switches on from the Sound tab and the mix still renders', async () => {
  await fresh(); await importFiles([BURSTS]);
  await waitSound();
  const [v] = await clipsOf('video');
  await ev((id) => window.gc.store.select([id]), v.id); await sleep(200);
  await win.click('#inspectorRoot [data-itab="sound"]'); await frame();
  await win.click('#btnVoiceClean'); await frame();
  const on = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).clean, v.id);
  if (!on) throw new Error('clean-up is not on');
  const peak = await ev(async () => {
    const { renderTimelineAudio } = await import('app://gamecut/src/audio/graph.js');
    const b = await renderTimelineAudio(window.gc.store, 5);
    const d = b.getChannelData(0); let m = 0; for (const x of d) m = Math.max(m, Math.abs(x)); return m;
  });
  if (!(peak > 0.05)) throw new Error(`the cleaned mix is silent (${peak})`);
});

await T.finish('FEATURES');
