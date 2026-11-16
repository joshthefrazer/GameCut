/**
 * The redesigned timeline, through the front door.
 *
 * Guards the "timeline messes up the video" fixes — linked layers that stay
 * in step with their footage, and clips that can never silently cover each
 * other — and the new tools: Razor, Hand, the overview strip, lane groups,
 * Close gaps, renaming, and messages kept off the timeline.
 *   xvfb-run -a node qa/timeline-next.mjs
 */
import { launch, FIX } from './harness.mjs';

const T = await launch({ name: 'tlnext' });
const { win, ev, frame, step, fresh, importFiles, byStart, box, xOf, drag, playheadTo,
  clickClip, setRipple, setSnap, toastTexts, sleep } = T;
const CLIP = FIX('test-clip.mp4');     // 5 s

/** Fresh project: the 5 s clip on the main lane, cut into three. */
async function three() {
  await fresh();
  await importFiles([CLIP]);
  await ev(() => window.gc.store.select([]));
  await playheadTo(1.5); await win.keyboard.press('s'); await frame();
  await ev(() => window.gc.store.select([]));
  await playheadTo(3); await win.keyboard.press('s'); await frame();
  await ev(() => window.gc.store.select([]));
  const v = await byStart('video');
  if (v.length !== 3) throw new Error(`setting up: expected three pieces, have ${v.length}`);
  return v;
}

/** A cropped layer made from a clip, through the same command the crop room uses. */
const cropOf = (id) => ev((id) => window.gc.cmds.cropClip(id, {
  crop: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, transform: { x: 0.2, y: 0.2, scale: 0.4 },
}).id, id);

const noOverlaps = async () => {
  const all = await byStart();
  for (const a of all) for (const b of all) {
    if (a === b || a.trackId !== b.trackId) continue;
    if (a.start < b.start + b.duration - 1e-6 && b.start < a.start + a.duration - 1e-6) {
      throw new Error(`"${a.name}" (${a.start}) and "${b.name}" (${b.start}) overlap on ${a.track}`);
    }
  }
};

console.log('\n── timeline: links, no-overlap, tools ─────');

await step('a cropped layer stays on its footage when a shot before it is deleted (Ripple)', async () => {
  const [a, b, c] = await three();
  const crop = await cropOf(c.id);
  await setRipple(true);
  await clickClip(a.id);
  await win.keyboard.press('Delete'); await frame();
  const v = await byStart('video');
  const main = v.find(x => x.id === c.id);
  const layer = v.find(x => x.id === crop);
  if (!layer) throw new Error('the crop layer was lost');
  if (Math.abs(layer.start - main.start) > 1e-6 || Math.abs(layer.inPoint - main.inPoint) > 1e-6) {
    throw new Error(`crop at ${layer.start} (in ${layer.inPoint}) but its footage is at ${main.start} (in ${main.inPoint}) — out of sync`);
  }
  void b;
});

await step('splitting the footage splits its crop layer too, each half following its own half', async () => {
  const [, , c] = await three();
  const crop = await cropOf(c.id);
  await ev((id) => window.gc.store.select([id]), c.id);
  await playheadTo(4); await win.keyboard.press('s'); await frame();
  const v = await byStart('video');
  const crops = v.filter(x => x.linkTo);
  if (crops.length !== 2) throw new Error(`expected two crop pieces, have ${crops.length}`);
  for (const cp of crops) {
    const host = v.find(x => x.id === cp.linkTo);
    if (!host || Math.abs(host.start - cp.start) > 1e-6 || Math.abs(host.duration - cp.duration) > 1e-6) {
      throw new Error('a crop piece does not match the shot it belongs to');
    }
  }
  void crop;
});

await step('deleting a shot takes its crop layer with it', async () => {
  const [, , c] = await three();
  const crop = await cropOf(c.id);
  await setRipple(false);
  await clickClip(c.id);
  await win.keyboard.press('Delete'); await frame();
  if ((await byStart()).some(x => x.id === crop)) throw new Error('an orphaned crop was left behind, showing nothing');
});

await step('dragging a crop layer on its own frees it from the footage', async () => {
  const [, , c] = await three();
  const crop = await cropOf(c.id);
  await setSnap(false);
  const b = await box(crop);
  await drag((b.x0 + b.x1) / 2, b.top + 8, (b.x0 + b.x1) / 2 + ((await xOf(1)) - (await xOf(0))), b.top + 8);
  const now = (await byStart()).find(x => x.id === crop);
  await setSnap(true);
  if (now.linkTo) throw new Error('still linked after being moved by hand');
});

await step('Ripple on: dropping a shot onto another slots it in beside it — reorder by dragging', async () => {
  const [a, b, c] = await three();
  await setRipple(true);
  // Grab the first shot and drop it over the second half of the last one.
  const ba = await box(a.id), bc = await box(c.id);
  await drag((ba.x0 + ba.x1) / 2, ba.top + 8, bc.x1 - 6, bc.top + 8, 16);
  await noOverlaps();
  const v = await byStart('video');
  const order = v.map(x => x.id).join();
  if (order !== [b.id, c.id, a.id].join()) throw new Error(`order is ${v.map(x => x.start.toFixed(2) + ':' + x.id.slice(-4)).join(' ')}`);
  if (Math.abs(v[0].start) > 1e-6) throw new Error(`the lane did not close up (first shot at ${v[0].start})`);
  for (let i = 1; i < v.length; i++) if (Math.abs(v[i].start - (v[i - 1].start + v[i - 1].duration)) > 1e-3) throw new Error('a gap or overlap was left between shots');
});

await step('Ripple off: dropping a shot onto another puts it on a new layer, covering nothing', async () => {
  const [a, b] = await three();
  await setRipple(false);
  await setSnap(false);
  const ba = await box(a.id), bb = await box(b.id);
  await drag((ba.x0 + ba.x1) / 2, ba.top + 8, (bb.x0 + bb.x1) / 2, bb.top + 8, 12);
  await setSnap(true);
  await noOverlaps();
  const moved = (await byStart()).find(x => x.id === a.id);
  if (moved.trackId === b.trackId) throw new Error('it was dropped on top of the other shot');
});

await step('Ripple off: dragging an end into the next clip stops at it', async () => {
  const [a, b] = await three();
  await setRipple(false);
  await setSnap(false);
  // Make room first: delete the middle piece's neighbour gap by trimming a in.
  await ev((id) => window.gc.cmds.trimClip(id, 'out', 1.0, false), a.id);
  const ba = await box(a.id);
  await drag(ba.x1 - 2, ba.top + 8, (await xOf(2.6)), ba.top + 8);
  await setSnap(true);
  const v = await byStart('video');
  const na = v.find(x => x.id === a.id);
  if (na.start + na.duration > (v.find(x => x.id === b.id).start) + 1e-6) throw new Error(`the end slid under the next clip (ends ${na.start + na.duration})`);
  await noOverlaps();
});

await step('Razor: B, then clicking a clip cuts it there; V goes back to Select', async () => {
  await fresh();
  await importFiles([CLIP]);
  await setSnap(false);
  await win.keyboard.press('b');
  const tool = await ev(() => window.gc.store.ui.tool);
  if (tool !== 'razor') throw new Error(`B gave the ${tool} tool`);
  const [v0] = await byStart('video');
  const b = await box(v0.id);
  await win.mouse.click(await xOf(2), b.top + 8); await frame();
  const v = await byStart('video');
  await setSnap(true);
  if (v.length !== 2 || Math.abs(v[1].start - 2) > 0.05) throw new Error(`razor click gave ${v.length} pieces, cut at ${v[1]?.start}`);
  await win.keyboard.press('v');
  if ((await ev(() => window.gc.store.ui.tool)) !== 'select') throw new Error('V did not go back to Select');
  const lit = await ev(() => document.getElementById('btnToolSelect').classList.contains('is-active'));
  if (!lit) throw new Error('the Select button is not lit');
});

await step('Hand tool: dragging the lanes moves the view, not the clips', async () => {
  await fresh();
  await importFiles([CLIP]);
  await ev(() => { window.gc.store.ui.zoom = 6; window.gc.timeline.repaint(); });
  await win.click('#btnToolHand');
  const [v0] = await byStart('video');
  const b = await box(v0.id);
  const s0 = await ev(() => window.gc.store.ui.scrollX);
  await drag(b.x0 + 300, b.top + 8, b.x0 + 100, b.top + 8);
  const s1 = await ev(() => window.gc.store.ui.scrollX);
  const [v1] = await byStart('video');
  await win.click('#btnToolSelect');
  if (!(s1 > s0)) throw new Error('the view did not move');
  if (Math.abs(v1.start - v0.start) > 1e-9) throw new Error('the clip moved');
});

await step('the overview strip shows the whole project and dragging it moves the view', async () => {
  await fresh();
  await importFiles([CLIP]);
  await ev(() => { window.gc.store.ui.zoom = 8; window.gc.store.ui.scrollX = 0; window.gc.timeline.repaint(); });
  await sleep(200);
  const r = await ev(() => { const b = document.getElementById('tlOverview').getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width }; });
  await drag(r.x + 10, r.y, r.x + r.w * 0.6, r.y, 8);
  const sx = await ev(() => window.gc.store.ui.scrollX);
  if (!(sx > 1)) throw new Error(`the view is still at ${sx}s`);
});

await step('a lane group folds away and comes back', async () => {
  await fresh();
  const n0 = await ev(() => window.gc.timeline.L.rows.length);
  await win.click('#trackHeaders [data-fold="audio"]'); await frame();
  const n1 = await ev(() => window.gc.timeline.L.rows.length);
  const audio = await ev(() => window.gc.timeline.L.rows.filter(r => r.track.kind === 'audio').length);
  await win.click('#trackHeaders [data-fold="audio"]'); await frame();
  const n2 = await ev(() => window.gc.timeline.L.rows.length);
  if (audio !== 0 || n1 >= n0 || n2 !== n0) throw new Error(`lanes ${n0} → ${n1} (audio ${audio}) → ${n2}`);
});

await step('Close gaps closes every hole on the main lane in one undo, and a title rides along', async () => {
  const [a, b, c] = await three();
  await setRipple(false);
  await clickClip(b.id);
  await win.keyboard.press('Delete'); await frame();
  // A title over the last shot.
  await ev(() => window.gc.store.select([]));
  await playheadTo(3.5); await win.keyboard.press('t'); await frame();
  const [title] = await byStart('text');
  const off = title.start - c.start;
  const d0 = await ev(() => window.gc.history.undoStack.length);
  await win.click('#btnCloseGaps'); await frame();
  const v = await byStart('video');
  const t2 = (await byStart('text'))[0];
  const nc = v.find(x => x.id === c.id);
  if (Math.abs(nc.start - (v[0].start + v[0].duration)) > 1e-3) throw new Error(`the gap is still there (last shot at ${nc.start})`);
  if (Math.abs((t2.start - nc.start) - off) > 1e-3) throw new Error('the title stayed behind instead of riding with its shot');
  const d1 = await ev(() => window.gc.history.undoStack.length);
  if (d1 - d0 !== 1) throw new Error(`${d1 - d0} undo steps`);
  void a;
});

await step('Alt + arrows stop at the next clip instead of sliding under it', async () => {
  const [a, b] = await three();
  await setRipple(false);
  await clickClip(a.id);
  for (let i = 0; i < 5; i++) await win.keyboard.press('Alt+ArrowRight');
  await frame();
  await noOverlaps();
  void b;
});

await step('double-clicking a lane name renames it', async () => {
  await fresh();
  // Any audio lane will do (the default music lane has been called "Beat" since 2.0, so a fixed name went stale).
  const name = win.locator('#trackHeaders .th .th__name', { hasText: /^(Music|Beat)$/ }).first();
  await name.dblclick();
  await win.keyboard.press('Control+a');
  await win.keyboard.type('Beat drop');
  await win.keyboard.press('Enter'); await frame();
  const names = await ev(() => window.gc.store.doc.tracks.map(t => t.name));
  if (!names.includes('Beat drop')) throw new Error(`names: ${names.join(', ')}`);
});

await step('messages appear over the preview, never on top of the timeline', async () => {
  const [a] = await three();
  await clickClip(a.id);
  await win.keyboard.press('Delete'); await frame();
  const r = await ev(() => {
    const t = document.querySelector('#toasts .toast')?.getBoundingClientRect();
    const tl = document.getElementById('timelinePanel').getBoundingClientRect();
    const pv = document.getElementById('previewViewport').getBoundingClientRect();
    return t && { overTimeline: t.bottom > tl.top + 2, inPreview: t.top >= pv.top - 2 && t.bottom <= pv.bottom };
  });
  if (!r) throw new Error('no message was shown');
  if (r.overTimeline || !r.inPreview) throw new Error(JSON.stringify(r));
  void toastTexts;
});

await step('snapping says what it snapped to', async () => {
  const [a, b] = await three();
  await setRipple(false);
  await setSnap(true);
  const bb = await box(b.id);
  await win.mouse.move((bb.x0 + bb.x1) / 2, bb.top + 8);
  await win.mouse.down();
  await win.mouse.move((bb.x0 + bb.x1) / 2 + 5, bb.top + 8, { steps: 4 });
  const ph = await xOf(await ev(() => window.gc.store.rt.playhead));
  void ph;
  const kind = await ev(() => window.gc.store.rt.snapKind);
  await win.keyboard.press('Escape');
  await win.mouse.up();
  if (kind !== 'clip') throw new Error(`snapped to ${kind}, expected the clip edge`);
  void a;
});

await T.finish('TIMELINE-NEXT');
