/**
 * 1.9 quality of life, through the front door: lanes, fades, history,
 * jumping, labels, renaming, hover info, snapshots, settings.
 *   xvfb-run -a node qa/qol.mjs
 */
import { launch, FIX } from './harness.mjs';
import { patchClick } from './reveal.mjs';

const T = await launch({ name: 'qol' });
const { win, ev, step, fresh, importFiles, sleep, box, clips } = T;
patchClick(win);

const tracks = () => ev(() => window.gc.store.doc.tracks.map(t => ({ id: t.id, name: t.name, kind: t.kind, color: t.color || null, voice: !!t.voice, duck: !!t.duck?.on, n: t.clips.length })));
const menuItem = (id) => win.click(`.ctx [data-item="${id}"]`);
const hoverSub = async (id) => { await win.hover(`.ctx [data-item="${id}"]`); await sleep(150); };
const firstVideo = () => ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video'));

console.log('\n── quality of life ─────');

await step('the Lane button offers ready-made lanes, and a Music lane dips under talking', async () => {
  await fresh(); await importFiles([FIX('test-clip.mp4')]);
  await win.click('#btnAddLane'); await sleep(200);
  const items = await ev(() => [...document.querySelectorAll('.ctx [data-item^="lane-"]')].map(b => b.dataset.item));
  for (const k of ['video', 'facecam', 'text', 'voice', 'music', 'sfx']) if (!items.includes('lane-' + k)) throw new Error('no ' + k + ' lane offered: ' + items);
  const before = (await tracks()).length;
  await menuItem('lane-music'); await sleep(250);
  await win.click('#btnAddLane'); await sleep(150);
  await menuItem('lane-voice'); await sleep(250);
  const ts = await tracks();
  if (ts.length !== before + 2) throw new Error(`${before} lanes became ${ts.length}`);
  const music = ts.find(t => t.name.startsWith('Music') && t.duck);
  const voice = ts.find(t => t.name.startsWith('Voice') && t.voice);
  if (!music) throw new Error('the new Music lane does not dip: ' + JSON.stringify(ts));
  if (!voice) throw new Error('the new Voice lane does not clean up speech');
  // One undo per lane.
  await ev(() => window.gc.history.undo()); await sleep(100);
  if ((await tracks()).length !== before + 1) throw new Error('one undo did not remove exactly the last lane');
});

await step('the group + offers only that kind of lane', async () => {
  await win.click('[data-add="audio"]'); await sleep(200);
  const items = await ev(() => [...document.querySelectorAll('.ctx [data-item^="lane-"]')].map(b => b.dataset.item));
  if (items.some(i => /video|facecam|text/.test(i)) || !items.includes('lane-sfx')) throw new Error('sound + offered: ' + items);
  await win.keyboard.press('Escape');
});

await step('a lane can be dragged by its dot to reorder it, and moved from the right-click menu', async () => {
  await ev(() => { window.gc.cmds.addLane('facecam'); });
  await sleep(250);
  let ts = (await tracks()).filter(t => t.kind === 'video');
  const fc = ts.find(t => t.name.startsWith('Facecam'));
  const other = ts.find(t => t !== fc);
  const iFc = ts.indexOf(fc), iOther = ts.indexOf(other);
  const g = await ev((id) => { const r = document.querySelector(`.th[data-track="${id}"] [data-grip]`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, fc.id);
  const o = await ev((id) => { const r = document.querySelector(`.th[data-track="${id}"]`).getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; }, other.id);
  await win.mouse.move(g.x, g.y); await win.mouse.down();
  for (let i = 1; i <= 8; i++) { await win.mouse.move(g.x, g.y + (o.y - g.y) * i / 8); await sleep(20); }
  await win.mouse.up(); await sleep(250);
  ts = (await tracks()).filter(t => t.kind === 'video');
  if (ts.findIndex(t => t.id === fc.id) !== iOther) throw new Error(`dragged from ${iFc} to ${iOther}, now at ${ts.findIndex(t => t.id === fc.id)}`);
  // Right-click → Move down puts it back.
  await win.click(`.th[data-track="${fc.id}"] .th__name`, { button: 'right' }); await sleep(150);
  await menuItem(iOther < iFc ? 'laneDown' : 'laneUp'); await sleep(200);
  ts = (await tracks()).filter(t => t.kind === 'video');
  if (ts.findIndex(t => t.id === fc.id) !== iFc) throw new Error('Move did not put it back');
  // Never into the sound lanes.
  const moved = await ev((id) => { const tr = window.gc.store.doc.tracks; const i = tr.findIndex(t => t.id === id); const a = tr.findIndex(t => t.kind === 'audio'); return window.gc.cmds.moveTrackTo(id, a); }, fc.id);
  if (moved) throw new Error('a picture lane was moved among the sound lanes');
});

await step('lane colour, rename and duplicate from the lane menu', async () => {
  const v = (await tracks()).find(t => t.n > 0 && t.kind === 'video');
  await win.click(`.th[data-track="${v.id}"] .th__name`, { button: 'right' }); await sleep(150);
  await hoverSub('laneColour');
  await menuItem('lanecol-green'); await sleep(200);
  let t = (await tracks()).find(x => x.id === v.id);
  if (t.color !== '#22c55e') throw new Error('colour not set: ' + t.color);
  const headColor = await ev((id) => getComputedStyle(document.querySelector(`.th[data-track="${id}"]`)).getPropertyValue('--th-color').trim(), v.id);
  if (headColor !== '#22c55e') throw new Error('the lane header does not show it: ' + headColor);
  await win.click(`.th[data-track="${v.id}"] .th__name`, { button: 'right' }); await sleep(150);
  await menuItem('laneDup'); await sleep(250);
  const ts = await tracks();
  const dup = ts.find(x => x.name === `${v.name} copy`);
  if (!dup || dup.n !== v.n) throw new Error('no copy with the same clips: ' + JSON.stringify(ts));
  const ids = await ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
  if (new Set(ids).size !== ids.length) throw new Error('the copy reuses clip ids');
  await ev(() => window.gc.history.undo()); await sleep(100);
});

await step('fade by dragging the dot on a clip\'s top corner — and it really fades the picture', async () => {
  await fresh(); await importFiles([FIX('test-clip.mp4')]);
  const c = await firstVideo();
  await ev(() => { window.gc.timeline.fitAll?.(); }); await sleep(250);
  await ev((id) => window.gc.store.select([id]), c.id); await sleep(150);
  const h = await ev((id) => window.gc.timeline.view?.fadeHandles?.(window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id)) || document.getElementById('timelineView').fadeHandles(window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id)), c.id);
  if (!h) throw new Error('no fade handles');
  const v = await ev(() => { const r = document.getElementById('timelineView').getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const [, hx, hy] = h[0];
  const pps = await ev(() => window.gc.store.pxPerSec);
  await win.mouse.move(v.x + hx, v.y + hy); await win.mouse.down();
  for (let i = 1; i <= 10; i++) { await win.mouse.move(v.x + hx + (pps * 1.2) * i / 10, v.y + hy); await sleep(16); }
  await win.mouse.up(); await sleep(200);
  const after = await firstVideo();
  if (!(after.fadeIn > 0.9 && after.fadeIn < 1.6)) throw new Error('fadeIn is ' + after.fadeIn);
  if (after.start !== c.start || after.duration !== c.duration) throw new Error('the drag moved or trimmed the clip');
  const lum = (t) => ev(async (t) => {
    const { playback, comp } = window.gc; playback.seek(t); await new Promise(r => setTimeout(r, 300)); comp.render();
    const cv = comp.canvas, d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 16) / 3;
  }, t);
  const a = await lum(c.start + 0.05), b = await lum(c.start + 2.5);
  console.log(`     fade ${after.fadeIn.toFixed(1)}s · brightness ${a.toFixed(0)} at the start vs ${b.toFixed(0)} later`);
  if (!(a < b * 0.4)) throw new Error('the start is not darker — the fade does not show');
  await ev(() => window.gc.history.undo()); await sleep(100);
  if ((await firstVideo()).fadeIn) throw new Error('one undo did not remove the fade');
});

await step('hovering a clip shows its name, length and speed', async () => {
  const c = await firstVideo();
  const b = await box(c.id);
  await win.mouse.move((b.x0 + b.x1) / 2, b.y + 6); await sleep(80);
  await win.mouse.move((b.x0 + b.x1) / 2 + 3, b.y + 6); await sleep(800);
  const tip = await ev(() => { const t = document.getElementById('tlTip'); return t && !t.hidden ? t.textContent : null; });
  if (!tip || !tip.includes(c.name) || !/5\.0s/.test(tip)) throw new Error('tip: ' + tip);
  await win.mouse.move(5, 5);
});

await step('colour label, rename and "select this and everything after" from the clip menu', async () => {
  await ev(() => { const { store, cmds } = window.gc; const v = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video'); cmds.splitAt(2, [v.id]); });
  await sleep(200);
  const vs = (await clips()).filter(c => c.type === 'video').sort((a, b) => a.start - b.start);
  const b = await box(vs[0].id);
  await win.mouse.click((b.x0 + b.x1) / 2, b.y + 6, { button: 'right' }); await sleep(150);
  await hoverSub('label');
  await menuItem('label-orange'); await sleep(150);
  const lab = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).label, vs[0].id);
  if (lab !== '#f97316') throw new Error('label is ' + lab);
  await win.mouse.click((b.x0 + b.x1) / 2, b.y + 6, { button: 'right' }); await sleep(150);
  await menuItem('selectFrom'); await sleep(100);
  const sel = await ev(() => window.gc.store.rt.selection.length);
  if (sel < 2) throw new Error('selected ' + sel);
  // Rename through the Inspector header.
  await ev((id) => window.gc.store.select([id]), vs[0].id); await sleep(250);
  await win.dblclick('.ihead__name'); await sleep(100);
  await win.fill('#clipRename', 'Ace clutch');
  await win.keyboard.press('Enter'); await sleep(200);
  const name = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).name, vs[0].id);
  if (name !== 'Ace clutch') throw new Error('name is ' + name);
});

await step('↑ / ↓ jump between cuts, and Shift+Delete closes the gap', async () => {
  await ev(() => { window.gc.store.select([]); window.gc.playback.seek(0.5); });
  await ev(() => document.activeElement?.blur?.()); await sleep(50);
  await ev(() => window.gc.store.select([]));
  await win.keyboard.press('ArrowDown'); await sleep(100);
  const t1 = await ev(() => window.gc.store.rt.playhead);
  if (Math.abs(t1 - 2) > 0.05) throw new Error('↓ went to ' + t1);
  await win.keyboard.press('ArrowDown'); await sleep(100);
  const t2 = await ev(() => window.gc.store.rt.playhead);
  if (Math.abs(t2 - 5) > 0.05) throw new Error('second ↓ went to ' + t2);
  await win.keyboard.press('ArrowUp'); await sleep(100);
  if (Math.abs(await ev(() => window.gc.store.rt.playhead) - 2) > 0.05) throw new Error('↑ did not go back');
  // Ripple off, then Shift+Delete the first piece: the second slides to 0.
  await ev(() => { window.gc.store.ui.ripple = false; });
  const vs = (await clips()).filter(c => c.type === 'video').sort((a, b) => a.start - b.start);
  await ev((id) => window.gc.store.select([id]), vs[0].id);
  await win.keyboard.press('Shift+Delete'); await sleep(200);
  const left = (await clips()).filter(c => c.type === 'video');
  if (left.length !== 1 || Math.abs(left[0].start) > 0.01) throw new Error('after Shift+Delete: ' + JSON.stringify(left.map(c => c.start)));
  await ev(() => { window.gc.store.ui.ripple = true; });
});

await step('History lists the steps, and clicking one goes back to it', async () => {
  await win.click('#btnHistory'); await sleep(200);
  const rows = await ev(() => [...document.querySelectorAll('.hist__row')].map(r => ({ n: +r.dataset.n, t: r.textContent })));
  if (rows.length < 4) throw new Error('only ' + rows.length + ' rows');
  if (!rows.some(r => /Rename clip/.test(r.t)) || !rows.some(r => /Colour label/.test(r.t))) throw new Error('missing steps: ' + rows.map(r => r.t).join(' | '));
  const target = rows.find(r => /Colour label/.test(r.t));
  await win.click(`.hist__row[data-n="${target.n}"]`); await sleep(250);
  const state = await ev(() => { const vs = window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'video'); return { n: vs.length, names: vs.map(c => c.name), labels: vs.map(c => c.label || null) }; });
  if (state.n !== 2 || state.names.includes('Ace clutch') || !state.labels.includes('#f97316')) throw new Error('not back at the label step: ' + JSON.stringify(state));
  // The later steps are still there to redo.
  const undone = await ev(() => document.querySelectorAll('.hist__row.is-undone').length);
  if (undone < 2) throw new Error('later steps vanished');
  const redoRow = await ev(() => document.querySelector('.hist__row.is-undone:last-of-type')?.dataset.n);
  await win.click(`.hist__row[data-n="${redoRow}"]`); await sleep(250);
  if ((await clips()).filter(c => c.type === 'video').length !== 1) throw new Error('redo to the end did not restore the delete');
  await win.keyboard.press('Escape');
});

await step('click the timecode and type a time to jump; Ctrl+K understands times too', async () => {
  await win.click('#tcCurrent'); await sleep(100);
  await win.fill('#tcJump', '0:01.5');
  await win.keyboard.press('Enter'); await sleep(150);
  const t = await ev(() => window.gc.store.rt.playhead);
  if (Math.abs(t - 1.5) > 0.05) throw new Error('jumped to ' + t);
  if (!/00:00:01/.test(await ev(() => document.getElementById('tcCurrent').textContent))) throw new Error('timecode not repainted');
  await win.keyboard.press('Control+k'); await sleep(150);
  await win.keyboard.type('1s');
  await sleep(150);
  const first = await ev(() => document.querySelector('.pal__item .pal__name')?.textContent);
  if (!/Go to 0:01/.test(first)) throw new Error('first result: ' + first);
  await win.keyboard.press('Enter'); await sleep(150);
  if (Math.abs(await ev(() => window.gc.store.rt.playhead) - 1) > 0.05) throw new Error('Ctrl+K did not jump');
});

await step('Save this frame writes a full-size PNG of the playhead frame', async () => {
  // The save dialog is the system's; a stand-in sink receives the bytes instead.
  const res = await ev(async () => {
    window.gc.playback.seek(1.5);
    const saved = {};
    const sink = { open: async () => ({ token: 't', path: '/x.png' }), write: async (_t, b) => { saved.len = b.length; saved.head = Array.from(b.slice(0, 4)); }, close: async () => ({ ok: true }), abort: async () => {} };
    const out = await window.gc.qol.saveFrame({ sink });
    return { out, saved, W: window.gc.store.doc.width };
  });
  if (!res.out || res.out.width !== res.W) throw new Error('no frame: ' + JSON.stringify(res));
  if (res.saved.head?.[1] !== 0x50 || res.saved.head?.[2] !== 0x4e) throw new Error('not a PNG: ' + res.saved.head);
  if (res.saved.len < 20000) throw new Error('suspiciously small PNG: ' + res.saved.len);
});

await step('Settings: a new accent colour reaches the buttons and the timeline, and is remembered', async () => {
  await win.click('#btnSettings'); await sleep(200);
  await win.click('[data-accent="emerald"]'); await sleep(200);
  const acc = await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());
  if (acc !== '#10b981') throw new Error('accent is ' + acc);
  // Strike: the selection ring is always Volt (the edit); the accent reaches
  // the timeline through the drop ghost and the active lane.
  const th = await ev(async () => { const T = (await import('app://gamecut/src/ui/theme.js')).TH; return { sel: T.selRing, ghost: T.ghostLine }; });
  if (!/C6FF3D/i.test(th.sel)) throw new Error('the selection ring is not Volt: ' + th.sel);
  if (!/16,\s*185,\s*129|10b981/i.test(th.ghost)) throw new Error('the timeline did not take the accent: ' + th.ghost);
  await win.click('[data-density="compact"]'); await sleep(150);
  if (!(await ev(() => document.documentElement.classList.contains('is-compact')))) throw new Error('compact did not apply');
  const saved = await ev(() => JSON.parse(localStorage.getItem('gamecut.settings')));
  if (saved.accent !== 'emerald' || saved.density !== 'compact') throw new Error('not saved: ' + JSON.stringify(saved));
  await win.click('[data-density="comfy"]'); await sleep(100);
  await win.click('[data-accent="auto"]'); await sleep(100);
  await win.keyboard.press('Escape');
});

await step("What's new opens from Settings and its Show me buttons work", async () => {
  await ev(() => window.gc.qol.openTour()); await sleep(200);
  const n = await ev(() => document.querySelectorAll('.tour__item').length);
  if (n < 6) throw new Error(n + ' items');
  await win.click('#tourPanel [data-show="2"]'); await sleep(200);
  if (await ev(() => document.getElementById('historyPanel').hidden)) throw new Error('Show me did not open History');
  await win.keyboard.press('Escape');
});

await T.finish('QOL');
