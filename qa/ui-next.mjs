/**
 * The overhauled interface and the Motion tab, through the front door.
 *   xvfb-run -a node qa/ui-next.mjs
 */
import { launch, FIX } from './harness.mjs';

const T = await launch({ name: 'uinext' });
const { win, ev, frame, step, fresh, importFiles, byStart, box, sleep, playheadTo } = T;
const CLIP = FIX('test-clip.mp4');

/** Mean absolute difference between two preview frames (0..255). */
const grab = () => ev(() => {
  const c = window.gc.comp.canvas;
  const s = document.createElement('canvas'); s.width = 64; s.height = 36;
  s.getContext('2d').drawImage(c, 0, 0, 64, 36);
  return Array.from(s.getContext('2d').getImageData(0, 0, 64, 36).data);
});
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4) / 3; };
const renderAt = async (t) => {
  await win.mouse.move(4, 400);                 // nothing hovered: no live preview running
  await ev((t) => { window.gc.playback.pause(); window.gc.playback.seek(t); }, t);
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if (await ev((t) => window.gc.comp.render(t, false), t)) break;
  }
  await sleep(100);
  return grab();
};

async function oneClip() {
  await fresh();
  await importFiles([CLIP]);
  const [v] = await byStart('video');
  await ev((id) => window.gc.store.select([id]), v.id);
  await frame();
  return v;
}

console.log('\n── UI overhaul + Motion ─────');

await step('the rail opens each drawer, and the drawer can be hidden for a bigger preview', async () => {
  await fresh();
  for (const [tab, pane] of [['text', 'textRoot'], ['gfx', 'gfxRoot'], ['trans', 'transRoot'], ['media', 'poolRoot']]) {
    await win.click(`#leftTabs [data-tab="${tab}"]`); await frame();
    const on = await ev((id) => document.getElementById(id).classList.contains('is-active') && !!document.getElementById(id).offsetParent, pane);
    if (!on) throw new Error(`${tab} did not open its drawer`);
  }
  const w0 = await ev(() => document.getElementById('previewViewport').getBoundingClientRect().width);
  await win.click('#btnDrawerClose'); await sleep(350);
  const w1 = await ev(() => document.getElementById('previewViewport').getBoundingClientRect().width);
  const hidden = await ev(() => !document.getElementById('leftPanel').offsetParent);
  await win.click('#leftTabs [data-tab="media"]'); await sleep(250);
  const back = await ev(() => !!document.getElementById('leftPanel').offsetParent);
  if (!hidden || !back) throw new Error(`drawer hidden ${hidden}, back ${back}`);
  if (!(w1 > w0 + 20)) throw new Error(`the preview did not grow (${w0} → ${w1})`);
});

await step('tools float on the preview: crop, guides, aspect and quality sit on the picture area', async () => {
  const inside = await ev(() => {
    const vp = document.getElementById('previewViewport').getBoundingClientRect();
    return ['btnCrop', 'tglGuides', 'aspectSeg', 'previewQuality', 'btnFullscreen'].every(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.left >= vp.left - 1 && r.right <= vp.right + 1 && r.top >= vp.top - 1 && r.bottom <= vp.bottom + 1;
    });
  });
  if (!inside) throw new Error('a tool is not on the preview');
});

await step('Ctrl+K finds an action by a few letters and runs it', async () => {
  await oneClip();
  await ev(() => window.gc.store.select([]));
  await playheadTo(2);
  await win.keyboard.press('Control+k');
  if (!(await ev(() => !document.getElementById('palette').hidden))) throw new Error('the palette did not open');
  await win.keyboard.type('split every');
  await win.keyboard.press('Enter'); await frame();
  const v = await byStart('video');
  if (v.length !== 2) throw new Error(`have ${v.length} clips, expected the split`);
  if (!(await ev(() => document.getElementById('palette').hidden))) throw new Error('the palette stayed open');
});

await step('Ctrl+K finds a clip by its words and jumps to it', async () => {
  await oneClip();
  await playheadTo(3);
  await win.keyboard.press('t'); await frame();
  await ev(() => { const g = window.gc; const t = g.store.doc.tracks.flatMap(x => x.clips).find(c => c.type === 'text'); g.cmds.setClipProp(t.id, 'text.text', 'CLUTCH 1v4', { merge: false }); g.store.select([]); g.playback.seek(0); });
  await win.click('#btnSearch');
  await win.keyboard.type('clutch');
  await win.keyboard.press('Enter'); await frame();
  const r = await ev(() => ({ ph: window.gc.store.rt.playhead, sel: window.gc.store.selectedClips.map(x => x.clip.type) }));
  if (Math.abs(r.ph - 3) > 0.05 || r.sel[0] !== 'text') throw new Error(JSON.stringify(r));
});

await step('the inspector shows a clip in tabs, and remembers the tab per kind of clip', async () => {
  const v = await oneClip();
  const tabs = await ev(() => [...document.querySelectorAll('#inspectorRoot .itab')].map(b => b.textContent));
  if (tabs.join() !== 'Picture,Motion,Timing,Sound') throw new Error(`video tabs: ${tabs}`);
  await win.click('#inspectorRoot [data-itab="timing"]'); await frame();
  await ev(() => window.gc.store.select([])); await frame();
  await ev((id) => window.gc.store.select([id]), v.id); await sleep(250);
  const act = await ev(() => document.querySelector('#inspectorRoot .itab.is-active')?.dataset.itab);
  if (act !== 'timing') throw new Error(`came back on ${act}`);
  await playheadTo(1); await win.keyboard.press('t'); await sleep(250);
  const ttabs = await ev(() => [...document.querySelectorAll('#inspectorRoot .itab')].map(b => b.textContent));
  if (ttabs.join() !== 'Text,Motion,Timing,Position') throw new Error(`text tabs: ${ttabs}`);
});

await step('Motion on footage: picking "Pop" makes the clip actually pop in, as one undo', async () => {
  const v = await oneClip();
  const rest = await renderAt(1.5);
  const early0 = await renderAt(0.04);
  await ev((id) => window.gc.store.select([id]), v.id); await sleep(200);
  await win.click('#inspectorRoot [data-itab="motion"]'); await frame();
  const d0 = await ev(() => window.gc.history.undoStack.length);
  await win.click('#inspectorRoot .mtiles[data-phase="in"] .mtile[data-k="pop"]'); await sleep(250);
  const d1 = await ev(() => window.gc.history.undoStack.length);
  const m = (await byStart('video'))[0].motion;
  if (m?.anim !== 'pop') throw new Error(`motion is ${JSON.stringify(m)}`);
  if (d1 - d0 !== 1) throw new Error(`${d1 - d0} undo steps`);
  const early1 = await renderAt(0.04);
  const restNow = await renderAt(1.5);
  if (diff(early0, early1) < 8) throw new Error(`the first frames look the same with and without the pop (${diff(early0, early1).toFixed(1)})`);
  if (diff(rest, restNow) > 3) throw new Error('the picture is different once the pop has finished');
});

await step('hovering a tile plays that move on the picture, and leaving puts it back untouched', async () => {
  const v = await oneClip();
  await ev((id) => window.gc.store.select([id]), v.id); await sleep(200);
  await win.click('#inspectorRoot [data-itab="motion"]'); await frame();
  await playheadTo(2); await sleep(300);
  await ev(() => window.gc.comp.render(window.gc.store.rt.playhead, false));
  const still = await grab();
  await win.hover('#inspectorRoot .mtiles[data-phase="loop"] .mtile[data-k="wobble"]');
  let moved = 0;
  for (let i = 0; i < 6; i++) { await sleep(120); moved = Math.max(moved, diff(still, await grab())); }
  await win.mouse.move(5, 300); await sleep(250);
  const after = await grab();
  const m = (await byStart('video'))[0].motion;
  if (moved < 3) throw new Error(`nothing moved while hovering (${moved.toFixed(1)})`);
  if (diff(still, after) > 2) throw new Error('the picture did not settle back after hovering');
  if (m && m.animLoop && m.animLoop !== 'none') throw new Error('hovering changed the project');
});

await step('a combo sets arrive and leave together; the bar shows them and its edge can be dragged', async () => {
  const v = await oneClip();
  await ev((id) => window.gc.store.select([id]), v.id); await sleep(200);
  await win.click('#inspectorRoot [data-itab="motion"]'); await frame();
  await win.click('#inspectorRoot [data-combo="through"]'); await sleep(250);
  let m = (await byStart('video'))[0].motion;
  if (m.anim !== 'slideL' || m.animOut !== 'slideR') throw new Error(JSON.stringify(m));
  const txt = await ev(() => document.getElementById('motionBar').textContent);
  if (!/Slide from left/.test(txt) || !/Slide right/.test(txt)) throw new Error(`bar says "${txt}"`);
  const g = await ev(() => { const r = document.querySelector('#motionBar .mbar__grip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await win.mouse.move(g.x, g.y); await win.mouse.down();
  await win.mouse.move(g.x + 40, g.y, { steps: 6 }); await win.mouse.up(); await sleep(250);
  m = (await byStart('video'))[0].motion;
  if (!(m.animDur > 0.55)) throw new Error(`arrival is still ${m.animDur}s`);
});

await step('text motion lives in the same Motion tab, letter by letter included', async () => {
  await oneClip();
  await playheadTo(1); await win.keyboard.press('t'); await sleep(250);
  await win.click('#inspectorRoot [data-itab="motion"]'); await frame();
  await win.click('#inspectorRoot .mtiles[data-phase="in"] .mtile[data-k="type"]'); await sleep(200);
  await win.click('#inspectorRoot [data-unit="letter"]'); await sleep(200);
  const t = (await byStart('text'))[0];
  const s = await ev((id) => { for (const tr of window.gc.store.doc.tracks) for (const c of tr.clips) if (c.id === id) return c.text; }, t.id);
  if (s.anim !== 'type' || s.animUnit !== 'letter') throw new Error(JSON.stringify({ anim: s.anim, unit: s.animUnit }));
});

await step('the Text drawer adds text in one click', async () => {
  await oneClip();
  await win.click('#leftTabs [data-tab="text"]'); await frame();
  await win.click('#btnTextAdd'); await frame();
  if ((await byStart('text')).length !== 1) throw new Error('no text was added');
});

void box;
await T.finish('UI-NEXT');
