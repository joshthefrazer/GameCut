/**
 * 2.3: filmstrips, your own keys, workspaces, paste parts, many clips, replace
 * footage, trim preview, markers list, stars, reopen where you were.
 *   node qa/qol23.mjs [--pictures]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { launch, ROOT } from './harness.mjs';
const OUT = `${ROOT}/qa/out`;
mkdirSync(OUT, { recursive: true });
// Scenes that change colour every second, with a beep on each: what a strip should show is known.
const COLS = ['0xd94f4f', '0xe0a03c', '0x7fb84a', '0x3ca7a0', '0x3c6fd9', '0x7a4fd0', '0xc94f9e', '0x8a8f99'];
execFileSync('ffmpeg', ['-v', 'error', '-y', ...COLS.flatMap(c => ['-f', 'lavfi', '-i', `color=c=${c}:size=640x360:rate=30:duration=1`]), '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(440*2*PI*t)*lt(mod(t,1),0.25)':d=8",
  '-filter_complex', COLS.map((_, i) => `[${i}]`).join('') + `concat=n=${COLS.length}:v=1:a=0[v]`, '-map', '[v]', '-map', `${COLS.length}:a`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', `${OUT}/q23-a.mp4`]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', `${OUT}/q23-b.mp4`]);
const T = await launch({ name: 'qol23', size: [1500, 900] });
const { win, ev, frame, step, fresh, importFiles, sleep, finish } = T;
console.log('\n── 2.3 ─────');
const clips = () => ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips));
const undo = () => ev(() => window.gc.history.undo());
async function setup() {
  await fresh(); await importFiles([`${OUT}/q23-a.mp4`, `${OUT}/q23-b.mp4`]);
  await ev(async () => {
    const { store, cmds, assets } = window.gc;
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const A = assets.all().find(a => a.name === 'q23-a.mp4');
    const lane = store.doc.tracks.filter(t => t.kind === 'video').at(-1), tx = store.doc.tracks.find(t => t.kind === 'text');
    store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id))); if (store.rt.selection.length) cmds.removeSelected();
    cmds.batch('set up', () => {
      for (const [n, s, i] of [['One', 0, 0], ['Two', 4, 2], ['Three', 8, 1]]) cmds.addClip(lane.id, makeClip('video', { name: n, assetId: A.id, start: s, duration: 4, inPoint: i, sourceDuration: 8 }), { select: false });
      for (const s of [1, 5]) cmds.addClip(tx.id, makeClip('text', { name: 'NICE', start: s, duration: 2, text: { text: 'NICE' } }), { select: false });
    });
    window.gc.timeline.fitAll();
  });
  await sleep(500);
}
const id = (n) => ev((x) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.name === x).id, n);

await step('the strip along a clip shows the moments it covers, and stops while playing', async () => {
  await setup();
  for (let i = 0; i < 60; i++) { const s = await ev(() => window.gc.filmstripStats()); if (s.tiles >= 6 && !s.waiting) break; await sleep(250); }
  const r = await ev(async (cols) => {
    const { tileAt } = await import('app://gamecut/src/media/filmstrip.js');
    const A = window.gc.assets.all().find(a => a.name === 'q23-a.mp4');
    const want = cols.map(c => [1, 3, 5].map(i => parseInt(c.slice(i + 1, i + 3), 16)));
    const ask = () => cols.map((_, i) => tileAt(A, i + 0.5, 0.5));
    ask(); for (let i = 0; i < 80 && window.gc.filmstripStats().waiting; i++) { ask(); await new Promise(r => setTimeout(r, 150)); }
    return ask().map((c, i) => { if (!c) return 'none'; const d = c.getContext('2d').getImageData(50, 30, 1, 1).data; return Math.max(...want[i].map((v, k) => Math.abs(v - d[k]))); });
  }, COLS);
  if (r.some(x => x === 'none' || x > 24)) throw new Error('wrong pictures: ' + JSON.stringify(r));
  // and on the timeline itself: clip One (0–4 s) runs through the first colours
  const seen = await ev(() => { window.gc.timeline.repaint(); return new Promise(res => setTimeout(() => {
    const { L } = window.gc.timeline, cv = document.querySelector('#timelineView canvas, .timeline__view canvas'), k = cv.width / L.W, row = L.rows.find(r => r.track.clips.some(c => c.name === 'One')), g = cv.getContext('2d');
    res([0.5, 1.5, 2.5, 3.5].map(t => [...g.getImageData(Math.round(L.t2x(t) * k), Math.round((row.y + 18) * k), 1, 1).data].slice(0, 3)));
  }, 250)); });
  const apart = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  if (apart(seen[0], seen[2]) < 40 || apart(seen[1], seen[3]) < 40) throw new Error('the same picture all along: ' + JSON.stringify(seen));
});

await step('a key can be changed, taken from another action, left empty, reset, and survives a reload', async () => {
  await ev(() => window.gc.keymap.open()); await sleep(150);
  await win.fill('#keysFind', 'Split at the playhead'); await sleep(80);
  await win.click('.keys__row[data-id="split"] .keys__key'); await win.keyboard.press('x'); await sleep(80);
  if (await ev(() => document.querySelector('.keys__row[data-id="split"] .keys__key').textContent) !== 'X') throw new Error('not recorded');
  await win.click('#keysDone');
  const n0 = (await clips()).length;
  await ev(() => { window.gc.playback.seek(2); window.gc.store.select([]); document.activeElement?.blur(); });
  await win.keyboard.press('s'); await frame();
  if ((await clips()).length !== n0) throw new Error('the old key still splits');
  await win.keyboard.press('x'); await frame();
  if ((await clips()).length <= n0) throw new Error('the new key does not split');
  await undo();
  const took = await ev(() => { const r = window.gc.keymap.set('marker', 'V'); return { took: r.took?.id, v: window.gc.keymap.actions.find(a => a.id === 'tool-select').key, refuse: window.gc.keymap.set('marker', 'Esc').ok, undoSafe: window.gc.keymap.set('marker', 'Ctrl+Z').ok }; });
  if (took.took !== 'tool-select' || took.v !== '' || took.refuse || took.undoSafe) throw new Error(JSON.stringify(took));
  await win.reload(); await sleep(2500);
  const kept = await ev(() => window.gc.keymap.mine);
  if (kept.split !== 'X' || kept.marker !== 'V') throw new Error('forgotten: ' + JSON.stringify(kept));
  const back = await ev(() => { window.gc.keymap.reset(); return { mine: Object.keys(window.gc.keymap.mine).length, s: window.gc.keymap.actions.find(a => a.id === 'split').key }; });
  if (back.mine || back.s !== 'S') throw new Error('reset: ' + JSON.stringify(back));
  await setup();
  await ev(() => { window.gc.playback.seek(2); window.gc.store.select([]); document.activeElement?.blur(); });
  await win.keyboard.press('s'); await frame();
  if ((await clips()).length !== 7) throw new Error('S does not split again after the reset');
  await undo();
  await ev(() => { document.activeElement?.blur(); });
  await win.click('#projName'); await win.keyboard.press('Alt+2'); await sleep(150);
  if (await ev(() => window.gc.workspaces.current) === 'picture') throw new Error('keys fire while typing');
  await ev(() => document.activeElement.blur());
});

await step('workspaces: Alt+number, keep your own, update, delete, and the shapes fit the window', async () => {
  const size = () => ev(() => ({ t: window.gc.store.ui.timelineH, r: window.gc.store.ui.rightW, closed: document.getElementById('app').classList.contains('drawer-closed'), lanes: window.gc.store.ui.trackSize, prev: document.getElementById('previewViewport').getBoundingClientRect().height }));
  await win.keyboard.press('Alt+1'); await sleep(400);
  const a = await size();
  await win.keyboard.press('Alt+2'); await sleep(400);
  const b = await size();
  await win.keyboard.press('Alt+4'); await sleep(400);
  const c = await size();
  if (!(a.t > b.t + 100) || !a.closed || !b.closed || c.closed || c.lanes !== 'L' || !(b.prev > a.prev + 60) || a.prev < 80) throw new Error(JSON.stringify({ a, b, c }));
  await ev(() => window.gc.workspaces.saveAs('<i>Mine</i>'));
  await win.keyboard.press('Alt+2'); await sleep(350);
  await win.keyboard.press('Alt+5'); await sleep(350);
  const d = await size();
  if (Math.abs(d.t - c.t) > 2 || d.closed) throw new Error('own one: ' + JSON.stringify({ c, d }));
  await win.click('#btnWorkspace'); await sleep(250);
  const m = await ev(() => ({ n: document.querySelectorAll('.wsp__card').length, html: !!document.querySelector('.wsp__t b i') }));
  if (m.n !== 5 || m.html) throw new Error(JSON.stringify(m));
  if (process.argv.includes('--pictures')) await win.screenshot({ path: `${OUT}/q23-workspaces.png` });
  await win.click('.wsp__acts button:nth-child(2)'); await sleep(120);
  if (await ev(() => document.querySelectorAll('.wsp__card').length) !== 4) throw new Error('not deleted');
  await win.keyboard.press('Escape');
  await ev(() => window.gc.workspaces.apply('words')); await sleep(400);
});

await step('paste only the ticked parts; the rest of each clip is untouched; one undo', async () => {
  const [one, two, three] = [await id('One'), await id('Two'), await id('Three')];
  await ev(async ([x]) => { const { cmds } = window.gc; const { freshTransition } = await import('app://gamecut/src/engine/transitions.js'); cmds.setClipProp(x, 'transform.scale', 0.5, { merge: false }); cmds.setClipProp(x, 'volume', 0.4, { merge: false }); cmds.setClipProp(x, 'blend', 'screen', { merge: false }); cmds.setClipProp(x, 'transIn', freshTransition('whip'), { merge: false }); cmds.copyLook(x); }, [one]);
  await ev((ids) => window.gc.store.select(ids), [two, three]);
  await ev(() => window.gc.lookPaste.open()); await sleep(150);
  for (const p of await ev(() => [...document.querySelectorAll('.pp__part')].map(b => [b.dataset.part, b.classList.contains('is-on')]))) if (p[1] !== ['blend', 'sound'].includes(p[0])) await win.click(`.pp__part[data-part="${p[0]}"]`);
  if (process.argv.includes('--pictures')) await win.screenshot({ path: `${OUT}/q23-paste.png` });
  await win.click('#ppGo'); await frame();
  const c = (await clips()).filter(x => [two, three].includes(x.id));
  if (c.some(x => x.blend !== 'screen' || x.volume !== 0.4 || x.transform.scale !== 1 || x.transIn)) throw new Error(JSON.stringify(c.map(x => [x.blend, x.volume, x.transform.scale, x.transIn])));
  await undo();
  if ((await clips()).filter(x => [two, three].includes(x.id)).some(x => x.blend === 'screen' || x.volume === 0.4)) throw new Error('undo');
  // the plain paste is what it always was: no sound, no transition
  await ev(() => window.gc.cmds.pasteLook(window.gc.store.rt.selection)); await frame();
  const d = (await clips()).find(x => x.id === two);
  if (d.transform.scale !== 0.5 || d.volume === 0.4 || d.transIn) throw new Error('plain paste changed: ' + JSON.stringify([d.transform.scale, d.volume, d.transIn]));
  await undo();
});

await step('several clips at once: mixed values, set on all, one undo', async () => {
  const ids = [await id('Two'), await id('Three')];
  await ev((x) => { window.gc.cmds.setClipProp(x[0], 'transform.opacity', 0.3, { merge: false }); window.gc.store.select(x); }, ids); await sleep(250);
  const mixed = await ev(() => [...document.querySelectorAll('#inspectorRoot .is-mixed')].map(n => n.dataset.multi));
  if (!mixed.includes('Opacity') || mixed.includes('Scale')) throw new Error('mixed: ' + mixed);
  const set = async (what, v) => { await win.fill(`[data-multi="${what}"] input`, v); await win.keyboard.press('Enter'); await sleep(250); };
  await set('Opacity', '60');
  let c = (await clips()).filter(x => ids.includes(x.id));
  if (c.some(x => Math.abs(x.transform.opacity - 0.6) > 0.001)) throw new Error(JSON.stringify(c.map(x => x.transform.opacity)));
  await undo();
  c = (await clips()).filter(x => ids.includes(x.id));
  if (c[0].transform.opacity !== 0.3 || c[1].transform.opacity !== 1) throw new Error('undo: ' + c.map(x => x.transform.opacity));
  await set('Volume', '50'); await set('Speed', '2');
  c = (await clips()).filter(x => ids.includes(x.id));
  if (c.some(x => x.volume !== 0.5 || x.speed !== 2)) throw new Error(JSON.stringify(c.map(x => [x.volume, x.speed])));
  await undo(); await undo();
  c = (await clips()).filter(x => ids.includes(x.id));
  if (c.some(x => (x.speed || 1) !== 1 || (x.volume ?? 1) !== 1)) throw new Error('two undos did not put them back: ' + JSON.stringify(c.map(x => [x.volume, x.speed])));
  if (process.argv.includes('--pictures')) { await ev(() => document.querySelectorAll('.toast').forEach(t => t.remove())); await win.screenshot({ path: `${OUT}/q23-many.png` }); }
});

await step('replace footage keeps the place and the edit; shorter footage shortens it; undo', async () => {
  const two = await id('Two');
  const r = await ev((x) => { const b = window.gc.assets.all().find(a => a.name === 'q23-b.mp4'); window.gc.cmds.setClipProp(x, 'blend', 'multiply', { merge: false }); return { b: b.id, r: window.gc.cmds.replaceMedia(x, b.id) }; }, two);
  const c = (await clips()).find(x => x.id === two);
  if (!r.r.ok || !r.r.shorter || c.assetId !== r.b || c.start !== 4 || Math.abs(c.duration - 3) > 0.05 || c.inPoint !== 0 || c.blend !== 'multiply') throw new Error(JSON.stringify(c));
  await undo();
  const d = (await clips()).find(x => x.id === two);
  if (d.duration !== 4 || d.assetId === r.b) throw new Error('undo');
  await undo();
});

await step('dragging a cut shows the last and first frames, and they go away after', async () => {
  const three = await id('Three');
  await ev(() => { window.gc.timeline.fitAll(); }); await sleep(300);
  const p = await ev((x) => { const { L } = window.gc.timeline; const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(k => k.id === x); const row = L.rows.find(r => r.track.clips.includes(c)); const v = document.getElementById('timelineView').getBoundingClientRect(); return { x: v.left + L.t2x(c.start) + 3, y: v.top + row.y + 7 }; }, three);
  await win.mouse.move(p.x, p.y); await win.mouse.down();
  for (let i = 1; i <= 8; i++) { await win.mouse.move(p.x + i * 6, p.y); await sleep(40); }
  let s = null;
  for (let i = 0; i < 25; i++) { s = await ev(() => { const el = document.getElementById('trimPreview'); return { on: !el.hidden, wait: [...el.querySelectorAll('figure:not([hidden])')].filter(f => f.classList.contains('is-wait')).length, b: el.querySelector('[data-side=b] canvas').getContext('2d').getImageData(120, 60, 1, 1).data[3] }; }); if (s.on && !s.wait) break; await sleep(150); }
  if (process.argv.includes('--pictures')) await win.screenshot({ path: `${OUT}/q23-trim.png` });
  await win.mouse.up(); await sleep(150);
  if (!s.on || s.wait || !s.b) throw new Error(JSON.stringify(s));
  if (!await ev(() => document.getElementById('trimPreview').hidden)) throw new Error('still showing');
  await undo();
});

await step('markers list: note, colour, jump, remove; kept in the document', async () => {
  await ev(() => { const { cmds, store } = window.gc; store.select([]); document.activeElement?.blur(); for (const t of [1, 3, 6]) cmds.addMarker(t); });
  await win.keyboard.press('Shift+M'); await sleep(200);
  await win.fill('.mkp__row:nth-child(2) .mkp__name', 'the ace'); await win.keyboard.press('Enter'); await sleep(150);
  await win.click('.mkp__row:nth-child(2) .mkp__flag'); await sleep(100);
  await win.click('.mkp__row:nth-child(3) .mkp__t'); await sleep(150);
  const r = await ev(() => ({ m: window.gc.store.doc.markers.map(m => [m.label, m.color]), p: window.gc.store.rt.playhead }));
  if (r.m[1][0] !== 'the ace' || r.m[1][1] === '#ffb454' || Math.abs(r.p - 6) > 0.05) throw new Error(JSON.stringify(r));
  if (process.argv.includes('--pictures')) { await ev(() => document.querySelectorAll('.toast').forEach(t => t.remove())); await win.screenshot({ path: `${OUT}/q23-markers.png` }); }
  await win.hover('.mkp__row:nth-child(1)'); await win.click('.mkp__row:nth-child(1) .mkp__x'); await sleep(120);
  if (await ev(() => window.gc.store.doc.markers.length) !== 2) throw new Error('not removed');
  await ev(() => document.activeElement?.blur()); await win.keyboard.press('Shift+M');
});

await step('stars: starring does not apply it, the filter shows only those, and the right-click list leads with them', async () => {
  await ev((x) => { window.gc.store.select([]); window.gc.store.setRT({ junction: x }); }, await id('Two'));
  await win.click('#leftTabs [data-tab="trans"]'); await sleep(500);
  await win.hover('.trs[data-pick="leak"]'); await win.click('.trs[data-pick="leak"] .star'); await sleep(100);
  if ((await clips()).find(c => c.name === 'Two').transIn) throw new Error('the star applied it');
  await win.click('.trs__chips [data-group="star"]'); await sleep(200);
  const n = await ev(() => [...document.querySelectorAll('#transRoot .trs')].map(b => b.dataset.pick));
  if (n.join() !== 'leak') throw new Error('filter: ' + n);
  await win.click('.trs__chips [data-group="all"]');
  await win.click('#leftTabs [data-tab="fx"]'); await sleep(200);
  const before = (await clips()).length;
  await ev(() => document.querySelector('.fxtile .star').click()); await win.click('[data-fxshow="star"]'); await sleep(100);
  const f = await ev(() => [...document.querySelectorAll('.fxtile')].filter(b => !b.hidden).length);
  if (f !== 1 || (await clips()).length !== before) throw new Error('effects: ' + f);
  await win.click('[data-fxshow="all"]');
});

await step('a project opens where you left it', async () => {
  await ev(async () => { const { store, playback, library } = window.gc; store.ui.zoom = 2.2; playback.seek(5.5); await library.save({ silent: true }); window.gc.resume.note(); });
  const pid = await ev(() => window.gc.library.id);
  await ev(() => document.getElementById('btnHome').click()); await sleep(900);
  await ev(() => { window.gc.playback.seek(0); });
  const r = await ev(async (x) => { await window.gc.library.open(x); window.gc.resume.restore(); return { p: window.gc.store.rt.playhead, z: window.gc.store.ui.zoom }; }, pid);
  if (Math.abs(r.p - 5.5) > 0.05 || Math.abs(r.z - 2.2) > 0.01) throw new Error(JSON.stringify(r));
});

if (process.argv.includes('--pictures')) {
  await setup(); await ev(() => { window.gc.workspaces.apply('cutting'); window.gc.timeline.fitAll(); window.gc.playback.seek(2.5); }); await sleep(3500);
  await ev(() => document.querySelectorAll('.toast').forEach(t => t.remove())); await win.screenshot({ path: `${OUT}/q23-strips.png` });
  await ev(() => { window.gc.keymap.set('split', 'X'); window.gc.keymap.open(); }); await sleep(300); await win.screenshot({ path: `${OUT}/q23-keys.png` });
}
await finish('2.3');
