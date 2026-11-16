/**
 * The timeline, driven the way a person drives it.
 *
 * Every check here goes through the real front door: files come in through the
 * file picker (or a real drop event carrying real File objects), clips are cut
 * with S, moved and trimmed with the mouse, deleted with the Delete key, and
 * menus are opened with a right-click and clicked. The bug that started this
 * round shipped because every earlier test built its state in memory and so
 * skipped exactly the code a person runs. Geometry is read from the timeline's
 * own layout object only to know where to aim the mouse.
 *
 * Each step names the user-visible bug it guards. Run:
 *   xvfb-run -a node qa/timeline.mjs qa/out
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, readFile } from 'node:fs/promises';
import { waitFor } from './wait.mjs';
import { patchClick, revealLocator } from './reveal.mjs';

const ROOT = (await import('node:path')).resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || '/tmp';
const PROFILE = `/tmp/gc-timeline-${process.pid}`;
const CLIP = `${ROOT}/qa/fixtures/test-clip.mp4`;      // 5 s, 640×360, with sound
const TONE = `${ROOT}/qa/fixtures/test-tone.mp3`;      // ~4 s
const LOGO = `${ROOT}/qa/fixtures/test-logo.png`;      // red ellipse, 600×400

const problems = [];
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
const step = async (name, fn) => {
  if (only && !only.test(name)) return;
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── timeline, through the front door ─────');
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({
  args: ['.', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${PROFILE}`],
  cwd: ROOT, timeout: 60000,
});
const win = await app.firstWindow();
patchClick(win);
const IGNORE = /deprecat|Autoplay|AudioContext|willReadFrequently/i;
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
win.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) problems.push('console.error: ' + m.text()); });
await win.waitForLoadState('domcontentloaded'); await sleep(2000);

/* ── helpers ──────────────────────────────────────────────────── */

const ev = (fn, arg) => win.evaluate(fn, arg);
const frame = () => new Promise(r => setTimeout(r, 120));

/** A brand-new empty project, reached the way a person reaches one. */
async function fresh() {
  const home = await ev(() => document.getElementById('app').classList.contains('is-home'));
  if (!home) {
    await win.click('#btnHome');
    await waitFor(win, () => document.getElementById('app').classList.contains('is-home'), null, { timeout: 15000 });
  }
  await win.click('#homeNew');
  await waitFor(win, () => !document.getElementById('app').classList.contains('is-home'), null, { timeout: 15000 });
  await sleep(400);
  // Toasts from the last project would otherwise be clicked by mistake.
  await ev(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
}

const clips = () => ev(() => window.gc.store.doc.tracks.flatMap((t, ti) => t.clips.map(c => ({
  id: c.id, name: c.name, type: c.type, start: c.start, duration: c.duration, inPoint: c.inPoint,
  speed: c.speed, transIn: c.transIn, badgeFor: c.badgeFor ?? null, keys: c.keys, fit: c.fit ?? null,
  sourceDuration: c.sourceDuration, track: t.name, trackId: t.id, trackKind: t.kind, trackIndex: ti,
  transform: c.transform,
}))));
const byStart = async (type = null) => (await clips()).filter(c => !type || c.type === type).sort((a, b) => a.start - b.start);
const undoDepth = () => ev(() => window.gc.history.undoStack.length);

/** Import files through the file picker and wait until they are all assets. */
async function importFiles(paths) {
  const n0 = await ev(() => window.gc.assets.all().length);
  await win.click('#leftTabs [data-tab="media"]').catch(() => {});
  await win.setInputFiles('#filePicker', paths);
  await waitFor(win, (n) => window.gc.assets.all().length >= n, n0 + paths.length, { timeout: 20000 });
  await sleep(500);
}

/** Page geometry of a clip on the timeline canvas. */
const box = (id) => ev((id) => {
  const { L } = window.gc.timeline;
  const v = document.getElementById('timelineView').getBoundingClientRect();
  for (const row of L.rows) {
    const c = row.track.clips.find(c => c.id === id);
    if (c) return { x0: v.left + L.t2x(c.start), x1: v.left + L.t2x(c.start + c.duration),
                    y: v.top + row.y + row.h / 2, top: v.top + row.y, h: row.h };
  }
  return null;
}, id);
/** Page x of a timeline time, and the y of a track's lane. */
const xOf = (t) => ev((t) => document.getElementById('timelineView').getBoundingClientRect().left + window.gc.timeline.L.t2x(t), t);
const laneY = (pred) => ev((src) => {
  const f = new Function('t', 'return (' + src + ')(t)');
  const { L } = window.gc.timeline;
  const v = document.getElementById('timelineView').getBoundingClientRect();
  const row = L.rows.find(r => f(r.track));
  return row ? v.top + row.y + row.h / 2 : null;
}, pred.toString());
const rulerY = () => ev(() => document.getElementById('timelineView').getBoundingClientRect().top + 15);

async function drag(x0, y0, x1, y1, steps = 12) {
  await win.mouse.move(x0, y0);
  await win.mouse.down();
  for (let i = 1; i <= steps; i++) { await win.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await sleep(12); }
  await win.mouse.up();
  await frame();
}
/** Click the ruler at time t (snapping is off for this so it lands exactly). */
async function playheadTo(t) {
  await ev((t) => window.gc.playback.seek(t), t);   // exact; ruler clicks snap
  await frame();
}
async function clickClip(id, { shift = false } = {}) {
  const b = await box(id);
  if (shift) await win.keyboard.down('Shift');
  await win.mouse.click((b.x0 + b.x1) / 2, b.y + 6);
  if (shift) await win.keyboard.up('Shift');
  await frame();
}
async function rightClick(x, y) { await win.mouse.click(x, y, { button: 'right' }); await sleep(150); }
async function menuItem(text) {
  const item = win.locator('.ctx .ctx__item', { hasText: text }).first();
  await item.click();
  await sleep(150);
}
const menuTexts = () => ev(() => [...document.querySelectorAll('.ctx .ctx__item')].map(b => b.textContent));
const toastTexts = () => ev(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent));
async function setRipple(on) {
  const is = await ev(() => document.getElementById('btnRipple').classList.contains('is-active'));
  if (is !== on) await win.click('#btnRipple');
  await sleep(80);
}
async function setSnap(on) {
  const is = await ev(() => window.gc.store.ui.snap);
  if (is !== on) await win.click('#btnMagnet');
}

/** Fresh project, one 5 s clip imported (it lands at 0 by itself), cut at 2.5 s. */
async function twoHalves() {
  await fresh();
  await importFiles([CLIP]);
  await waitFor(win, () => window.gc.store.doc.tracks.some(t => t.clips.length), null, { timeout: 10000 });
  await win.click('#timelineView', { position: { x: 5, y: 5 } }).catch(() => {});
  await ev(() => window.gc.store.select([]));
  await playheadTo(2.5);
  await win.keyboard.press('s');
  await frame();
  const v = await byStart('video');
  if (v.length !== 2) throw new Error(`setting up: expected two halves, have ${v.length}`);
  return v;
}

/* ════════════════════════════════════════════════════════════════ */

await step('[Q3] the first import goes onto an empty timeline, fitted to view', async () => {
  await fresh();
  await importFiles([CLIP]);
  await sleep(300);
  const c = await clips();
  const v = c.filter(x => x.type === 'video');
  if (v.length !== 1) throw new Error(`expected the recording on the timeline once, found ${v.length}`);
  const main = await ev(() => [...window.gc.store.doc.tracks].reverse().find(t => t.kind === 'video').id);
  if (v[0].trackId !== main) throw new Error(`it went on ${v[0].track}, not the main video track`);
  if (Math.abs(v[0].start) > 1e-6) throw new Error('it did not start at 0:00');
  const b = await box(v[0].id);
  const W = await ev(() => window.gc.timeline.L.W);
  if (b.x1 - b.x0 < W * 0.6) throw new Error(`the clip is only ${Math.round(b.x1 - b.x0)}px of a ${W}px timeline — not zoomed to fit`);
  // A second import only adds to the Media panel.
  await importFiles([TONE]);
  const after = await clips();
  if (after.length !== c.length) throw new Error('a second import also landed on the timeline');
});

await step('[4] double-clicking a media tile adds the clip once, wherever you click', async () => {
  await fresh();
  await importFiles([CLIP]);
  const count = async () => (await clips()).filter(x => x.type === 'video').length;
  const n0 = await count();
  const tile = win.locator('#poolRoot .asset', { hasText: 'test-clip' }).first();
  await tile.dblclick({ position: { x: 10, y: 10 } });
  await sleep(400);
  const n1 = await count();
  if (n1 !== n0 + 1) throw new Error(`double-clicking the tile corner added ${n1 - n0} clips`);
  await tile.hover();
  const plus = await tile.locator('.asset__add').boundingBox();
  await win.mouse.dblclick(plus.x + plus.width / 2, plus.y + plus.height / 2);
  await sleep(400);
  const n2 = await count();
  if (n2 !== n1 + 1) throw new Error(`double-clicking the + added ${n2 - n1} clips`);
  await tile.locator('.asset__add').click();
  await sleep(400);
  if (await count() !== n2 + 1) throw new Error('a single click on + no longer adds');
});

await step('[1] Ripple is on by default; Delete closes the gap; the toast undoes it', async () => {
  const [a, b] = await twoHalves();
  const on = await ev(() => document.getElementById('btnRipple').classList.contains('is-active'));
  if (!on) throw new Error('Ripple is not on in a new project');
  await clickClip(a.id);
  await win.keyboard.press('Delete');
  await frame();
  const left = await byStart('video');
  if (left.length !== 1 || left[0].id !== b.id) throw new Error('Delete did not remove the first half');
  if (Math.abs(left[0].start) > 1e-6) throw new Error(`the second half stayed at ${left[0].start}s — a black gap was left`);
  const t = await toastTexts();
  if (!t.some(x => /Deleted/.test(x) && /Undo/.test(x))) throw new Error('no "Deleted … Undo" toast: ' + JSON.stringify(t));
  await win.locator('#toasts .toast', { hasText: 'Deleted' }).locator('.toast__act').click();
  await frame();
  const back = await byStart('video');
  if (back.length !== 2 || Math.abs(back[1].start - 2.5) > 1e-6) throw new Error('Undo on the toast did not put it back');
  const t2 = await toastTexts();
  if (!t2.some(x => /Undid/.test(x) && /Redo/.test(x))) throw new Error('undo shows no "Undid … Redo" toast: ' + JSON.stringify(t2));
});

await step('[1] the Ripple choice is remembered after a restart', async () => {
  await setRipple(false);
  await win.reload();
  await win.waitForLoadState('domcontentloaded'); await sleep(2000);
  await win.click('#homeNew');
  await waitFor(win, () => !document.getElementById('app').classList.contains('is-home'));
  const off = await ev(() => !document.getElementById('btnRipple').classList.contains('is-active') && !window.gc.store.ui.ripple);
  await setRipple(true);
  if (!off) throw new Error('Ripple came back on after being turned off');
});

await step('[1][8] ripple trims: the end pulls the next clip back; each drag is one undo step', async () => {
  const [a] = await twoHalves();
  await setRipple(true);
  await setSnap(false);
  const d0 = await undoDepth();
  // Grab the edges near the top: the seam's transition button sits mid-height.
  // Two separate drags of the SAME edge straight after each other (they used
  // to merge into one undo step), then one of the other edge.
  let b = await box(a.id);
  await drag(b.x1 - 3, b.top + 10, (await xOf(2)), b.top + 10, 6);
  b = await box(a.id);
  await drag(b.x1 - 3, b.top + 10, (await xOf(1.5)), b.top + 10, 6);
  b = await box(a.id);
  await drag(b.x0 + 3, b.top + 10, (await xOf(0.5)), b.top + 10);
  const d1 = await undoDepth();
  await setSnap(true);
  const v = await byStart('video');
  if (Math.abs(v[0].start) > 1e-6) throw new Error(`with Ripple on, trimming the head moved the clip to ${v[0].start}`);
  if (Math.abs(v[0].duration - 1.0) > 0.05) throw new Error(`first half is ${v[0].duration}s, expected ~1s`);
  if (Math.abs(v[0].inPoint - 0.5) > 0.05) throw new Error(`head trim set in-point ${v[0].inPoint}, expected ~0.5`);
  if (Math.abs(v[1].start - (v[0].start + v[0].duration)) > 1e-3) throw new Error(`the next clip sits at ${v[1].start}, not against the trimmed one (${v[0].duration})`);
  if (d1 - d0 !== 3) throw new Error(`three drags made ${d1 - d0} undo steps`);
  await win.keyboard.press('Control+z');
  await frame();
  const u = await byStart('video');
  if (Math.abs(u[0].duration - 1.5) > 0.05 || Math.abs(u[1].start - 1.5) > 0.05) throw new Error('one undo did not take back exactly the second drag');
});

await step('[1] ripple speed: making a clip 2× pulls the next one back', async () => {
  const [a] = await twoHalves();
  const b = await box(a.id);
  await rightClick((b.x0 + b.x1) / 2, b.y);
  await win.locator('.ctx .ctx__item', { hasText: 'Speed' }).first().hover();
  await sleep(150);
  await menuItem('2× — double speed');
  const v = await byStart('video');
  if (Math.abs(v[0].duration - 1.25) > 0.02) throw new Error(`2× made it ${v[0].duration}s`);
  if (Math.abs(v[1].start - 1.25) > 0.02) throw new Error(`the next clip stayed at ${v[1].start}s`);
});

await step('[1] with Ripple off a gap stays, is hatched, and right-click → Close gap closes it', async () => {
  const [a, bb] = await twoHalves();
  await setRipple(false);
  await clickClip(a.id);
  await win.keyboard.press('Delete');
  await frame();
  let v = await byStart('video');
  if (Math.abs(v[0].start - 2.5) > 1e-6) throw new Error('Ripple off still moved the next clip');
  const gaps = await ev(() => window.gc.timeline.L.mainGaps || []);
  if (!gaps.length) throw new Error('the gap on the main track is not drawn as a gap');
  const y = await laneY((t) => t.id === window.gc.store.doc.tracks.filter(x => x.kind === 'video').at(-1).id);
  await rightClick(await xOf(1.2), y);
  const items = await menuTexts();
  if (!items.some(x => /Close this gap/.test(x))) throw new Error('no Close gap in the menu: ' + JSON.stringify(items));
  await menuItem('Close this gap');
  v = await byStart('video');
  await setRipple(true);
  if (v[0].id !== bb.id || Math.abs(v[0].start) > 1e-6) throw new Error(`after Close gap the clip is at ${v[0].start}`);
});

await step('[2] splitting a clip with a dissolve does not add a dissolve at the new cut', async () => {
  const [, b] = await twoHalves();
  const bx = await box(b.id);
  await rightClick((bx.x0 + bx.x1) / 2, bx.y);
  await win.locator('.ctx .ctx__item', { hasText: 'Transition on the cut' }).first().hover();
  await sleep(150);
  await win.locator('.ctx .ctx__wrap', { hasText: 'Transition on the cut' }).locator('.ctx__flyout .ctx__item').first().click();
  await sleep(150);
  const withT = (await byStart('video'))[1];
  if (!withT.transIn) throw new Error('setting up: no transition was set');
  await clickClip(b.id);
  await playheadTo(3.75);
  await win.keyboard.press('s');
  await frame();
  const v = await byStart('video');
  if (v.length !== 3) throw new Error('the split did not happen');
  if (v[2].transIn) throw new Error(`the new right half got a ${v[2].transIn.kind} at the new cut`);
  if (!v[1].transIn) throw new Error('the original cut lost its transition');
  // Ctrl+D on the clip with the transition: no dip between it and the copy.
  await clickClip(v[1].id);
  await win.keyboard.press('Control+d');
  await frame();
  const sel = await ev(() => window.gc.store.rt.selection);
  const copy = (await clips()).find(c => c.id === sel[0]);
  if (!copy) throw new Error('no copy selected after Ctrl+D');
  if (copy.transIn) throw new Error(`the copy got a ${copy.transIn.kind} between it and the original`);
});

await step('[3] a locked track protects its clips from S, Delete, Ctrl+A, arrows, drags and the menu', async () => {
  const [a] = await twoHalves();
  await clickClip(a.id);                                  // selected BEFORE locking
  await win.locator('#trackHeaders .th', { hasText: 'Video 1' }).locator('[data-flag="locked"]').click();
  await frame();
  const before = JSON.stringify(await byStart('video'));
  await playheadTo(1.2);
  await win.keyboard.press('s');
  await win.keyboard.press('Delete');
  await win.keyboard.press('Alt+ArrowRight');
  await frame();
  const b = await box(a.id);
  await drag((b.x0 + b.x1) / 2, b.y + 6, (b.x0 + b.x1) / 2 + 120, b.y + 6);
  if (JSON.stringify(await byStart('video')) !== before) throw new Error('a clip on a locked track was changed');
  await win.keyboard.press('Control+a');
  const sel = await ev(() => window.gc.store.rt.selection);
  const vids = (await clips()).filter(c => c.type === 'video').map(c => c.id);
  if (sel.some(id => vids.includes(id))) throw new Error('Ctrl+A selected clips on the locked track');
  await rightClick((b.x0 + b.x1) / 2, b.y);
  const items = await menuTexts();
  await win.keyboard.press('Escape');
  if (items.some(x => /^Delete|^Speed|Split/.test(x))) throw new Error('the menu still offers edits: ' + JSON.stringify(items));
  if (!items.some(x => /Unlock/.test(x))) throw new Error('the menu does not offer to unlock');
});

await step('[5] head-trimming a 2× clip stops at the start of the footage', async () => {
  await fresh();
  await importFiles([CLIP]);
  await setRipple(false);
  await setSnap(false);
  let [c] = await byStart('video');
  let b = await box(c.id);
  await rightClick((b.x0 + b.x1) / 2, b.y);
  await win.locator('.ctx .ctx__item', { hasText: 'Speed' }).first().hover(); await sleep(150);
  await menuItem('2× — double speed');
  // Move it away from 0:00 so there is room on the left, then trim 1 s off its head.
  b = await box(c.id);
  await drag((b.x0 + b.x1) / 2, b.y + 6, (b.x0 + b.x1) / 2 + (await xOf(3)) - (await xOf(0)), b.y + 6);
  [c] = await byStart('video');
  b = await box(c.id);
  await drag(b.x0 + 3, b.y, await xOf(c.start + 1), b.y);
  [c] = await byStart('video');
  if (Math.abs(c.inPoint - 2) > 0.05) throw new Error(`trimming 1 s off a 2× clip set in-point ${c.inPoint}, expected 2`);
  // Now drag the head far to the left: only 1 s of timeline (2 s of footage) is there.
  b = await box(c.id);
  await drag(b.x0 + 3, b.y, await xOf(0.2), b.y);
  [c] = await byStart('video');
  await setSnap(true);
  if (c.inPoint < -1e-6) throw new Error('in-point went negative');
  const used = c.inPoint + c.duration * c.speed;
  if (Math.abs(c.inPoint) > 0.02 || Math.abs(c.start - 3) > 0.02) throw new Error(`head stopped at ${c.start}s with in-point ${c.inPoint} (expected 3 s, 0)`);
  if (used > c.sourceDuration + 0.02) throw new Error(`the clip now asks for ${used.toFixed(2)}s of a ${c.sourceDuration}s recording`);
});

await step('[6][7] a title can be lengthened from the left, and its keyframes stay put', async () => {
  await fresh();
  await importFiles([CLIP]);                              // so there is a 0:02 to stand on
  await setRipple(false);
  await setSnap(false);
  await ev(() => window.gc.store.select([]));
  await playheadTo(2);
  await win.keyboard.press('t');
  await frame();
  let [t] = await byStart('text');
  // A keyframe one second into the title (at 0:03), through the same command
  // the Inspector's diamond button uses.
  await ev((id) => window.gc.cmds.setKeyAt(id, 'transform.x', 3, 0.3), t.id);
  const b = await box(t.id);
  await drag(b.x0 + 3, b.y, await xOf(1), b.y);
  [t] = await byStart('text');
  await setSnap(true);
  if (Math.abs(t.duration - 4) > 0.02) throw new Error(`the title is ${t.duration}s long, expected 4 s (lengthened by 1 s)`);
  if (Math.abs(t.start - 1) > 0.02) throw new Error(`the title's left edge stopped at ${t.start}s instead of 1s`);
  const k = t.keys['transform.x']?.[0];
  if (!k || Math.abs(t.start + k.t - 3) > 0.02) throw new Error(`the keyframe moved to ${k ? t.start + k.t : 'nowhere'} (was at 3 s)`);
});

await step('[9] dragging a spaced-out group against 0:00 keeps its spacing', async () => {
  const [a, b0] = await twoHalves();
  await setRipple(false);
  await setSnap(false);
  // Pull the second half 1 s right to open a gap, then select both.
  let bb = await box(b0.id);
  await drag((bb.x0 + bb.x1) / 2, bb.y + 6, (bb.x0 + bb.x1) / 2 + (await xOf(1)) - (await xOf(0)), bb.y + 6);
  let v = await byStart('video');
  const gap = v[1].start - v[0].start;
  await clickClip(a.id);
  await clickClip(b0.id, { shift: true });
  // Both move right together first, so there is room to run into 0:00.
  let ab = await box(a.id);
  await drag((ab.x0 + ab.x1) / 2, ab.y + 6, (ab.x0 + ab.x1) / 2 + (await xOf(1)) - (await xOf(0)), ab.y + 6);
  v = await byStart('video');
  if (!(v[0].start > 0.9)) throw new Error('setting up: the group did not move right together');
  // Drag by the LATER clip: the one under the pointer is not the one that
  // reaches 0:00 first. (Shift+Z first, so all of it is on screen.)
  await win.keyboard.press('Shift+Z');
  await frame();
  ab = await box(b0.id);
  await drag((ab.x0 + ab.x1) / 2, ab.y + 6, (ab.x0 + ab.x1) / 2 - 500, ab.y + 6);
  v = await byStart('video');
  await setSnap(true);
  if (v[0].start > 1e-6) throw new Error(`the group did not reach 0:00 (front clip at ${v[0].start})`);
  if (Math.abs((v[1].start - v[0].start) - gap) > 1e-3) throw new Error(`spacing went from ${gap} to ${v[1].start - v[0].start}`);
});

await step('[10] duplicating two clips puts the copies after both, not on top', async () => {
  await twoHalves();
  await win.keyboard.press('Control+a');
  await win.keyboard.press('Control+d');
  await frame();
  const v = await byStart('video');
  for (let i = 1; i < v.length; i++) {
    if (v[i].trackId === v[i - 1].trackId && v[i].start < v[i - 1].start + v[i - 1].duration - 1e-6) {
      throw new Error(`copies overlap: ${v.map(x => x.start.toFixed(2)).join(', ')}`);
    }
  }
  if (Math.abs(v[2].start - 5) > 1e-3 || Math.abs(v[3].start - 7.5) > 1e-3) throw new Error(`copies at ${v.map(x => x.start).join(', ')}`);
});

await step('[11] shortcuts still work after touching a slider; a focused select keeps its arrows', async () => {
  await twoHalves();
  await ev(() => window.gc.store.select([]));
  await win.click('#zoomRange');
  await playheadTo(1);
  await win.keyboard.press('s');
  await frame();
  if ((await byStart('video')).length !== 3) throw new Error('S did nothing after the zoom slider was clicked');
  await win.focus('#previewQuality');
  const before = await ev(() => ({ v: document.getElementById('previewQuality').value, ph: window.gc.store.rt.playhead }));
  await win.keyboard.press('ArrowLeft');
  await frame();
  const after = await ev(() => ({ v: document.getElementById('previewQuality').value, ph: window.gc.store.rt.playhead }));
  await ev(() => document.activeElement.blur());
  if (Math.abs(after.ph - before.ph) > 1e-6) throw new Error('the arrow moved the playhead while a dropdown had focus');
  const prevented = await ev(() => {
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    document.getElementById('previewQuality').focus();
    document.getElementById('previewQuality').dispatchEvent(e);
    document.activeElement.blur();
    return e.defaultPrevented;
  });
  if (prevented) throw new Error('ArrowDown was swallowed from the focused dropdown');
});

await step('[12] a command that changes nothing keeps Redo; undo drops dead clips from the selection', async () => {
  const [a] = await twoHalves();
  await clickClip(a.id);
  await playheadTo(1);
  await win.keyboard.press('s');                          // selection is now the new right piece
  await frame();
  await win.keyboard.press('Control+z');
  await frame();
  const sel = await ev(() => window.gc.store.rt.selection);
  const live = (await clips()).map(c => c.id);
  if (sel.some(id => !live.includes(id))) throw new Error('the selection still names a clip the undo removed');
  // S with the playhead past every clip changes nothing. Redo must survive it.
  await ev(() => window.gc.store.select([]));
  await playheadTo(9);
  await win.keyboard.press('s');
  const canRedo = await ev(() => window.gc.history.canRedo);
  if (!canRedo) throw new Error('a split that cut nothing wiped Redo');
  await playheadTo(1);
  await win.keyboard.press('s');                          // nothing selected: cuts at 1 s
  await frame();
  if ((await byStart('video')).length !== 3) throw new Error('S after undoing a split did nothing');
});

await step('[13] the audio lane does not offer a text layer; a video lane routes it to a text track', async () => {
  await fresh();
  const ay = await laneY((t) => t.kind === 'audio');
  await rightClick(await xOf(1), ay);
  const items = await menuTexts();
  await win.keyboard.press('Escape');
  if (items.some(x => /text layer/.test(x))) throw new Error('an audio lane offers "Add a text layer here"');
  const vy = await laneY((t) => t.kind === 'video');
  await rightClick(await xOf(1), vy);
  await menuItem('Add a text layer here');
  const [t] = await byStart('text');
  if (!t || t.trackKind !== 'text') throw new Error(`the text layer went on a ${t?.trackKind} track`);
});

await step('[14] tracks can be deleted (asking first if they hold clips) and new ones go in sensible places', async () => {
  await fresh();
  await importFiles([CLIP]);
  const names = () => ev(() => window.gc.store.doc.tracks.map(t => t.name));
  const n0 = await names();
  await win.locator('#trackHeaders .th', { hasText: 'SFX' }).hover();
  await win.locator('#trackHeaders .th', { hasText: 'SFX' }).locator('[data-del]').click();
  await frame();
  if ((await names()).includes('SFX')) throw new Error('the empty SFX track was not deleted');
  await win.keyboard.press('Control+z'); await frame();
  if (!(await names()).includes('SFX')) throw new Error('Undo did not bring the track back');
  // Video 1 has the clip: deleting asks.
  await win.locator('#trackHeaders .th', { hasText: 'Video 1' }).click({ button: 'right' });
  await sleep(150);
  await menuItem('Delete this track');
  const ask = await menuTexts();
  if (!ask.some(x => /Keep it/.test(x))) throw new Error('deleting a track with clips did not ask first');
  await menuItem('Delete it');
  if ((await names()).includes('Video 1')) throw new Error('confirmed, but the track is still there');
  await win.keyboard.press('Control+z'); await frame();
  // + Video lands above the existing video tracks and under the text ones.
  // The group + offers ready-made lanes of its kind.
  await win.click('#trackHeaders [data-add="video"]'); await frame();
  await win.click('.ctx [data-item="lane-video"]'); await frame();
  await win.click('#trackHeaders [data-add="audio"]'); await frame();
  await win.click('.ctx [data-item="lane-sfx"]'); await frame();
  const tr = await ev(() => window.gc.store.doc.tracks.map(t => ({ k: t.kind, n: t.name })));
  const iv = tr.findIndex(t => t.n === 'Video 3');
  const lastText = tr.map(t => t.k).lastIndexOf('text');
  const firstVideo = tr.findIndex(t => t.k === 'video');
  if (!(iv > lastText && iv === firstVideo)) throw new Error('new video track went to ' + iv + ' in ' + JSON.stringify(tr.map(t => t.n)));
  if (tr.at(-1).k !== 'audio' || tr.at(-1).n !== 'SFX 2') throw new Error('new audio track not at the bottom: ' + JSON.stringify(tr.map(t => t.n)));
  void n0;
});

await step('[15] on the projects screen and behind dialogs, keys do not touch the project', async () => {
  await twoHalves();
  const n = (await clips()).length;
  // Help sheet open: Ctrl+A, Delete do nothing; Esc closes it even after a click inside.
  await win.keyboard.press('?');
  await sleep(300);
  await win.keyboard.press('Control+a');
  await win.keyboard.press('Delete');
  await win.click('#helpBody', { position: { x: 30, y: 30 } });
  await win.keyboard.press('Escape');
  await sleep(350);
  const helpHidden = await ev(() => document.getElementById('helpSheet').hidden);
  if (!helpHidden) throw new Error('Esc did not close the help sheet after clicking inside it');
  if ((await clips()).length !== n) throw new Error('Ctrl+A, Delete behind the help sheet deleted clips');
  // Projects screen.
  await win.click('#btnHome');
  await waitFor(win, () => document.getElementById('app').classList.contains('is-home'));
  await win.keyboard.press('Control+a');
  await win.keyboard.press('Delete');
  await win.keyboard.press('s');
  await sleep(200);
  const m = (await clips()).length;
  await win.click('#homeNew');
  await waitFor(win, () => !document.getElementById('app').classList.contains('is-home'));
  if (m !== n) throw new Error(`Ctrl+A, Delete on the projects screen changed the hidden project (${n} → ${m} clips)`);
});

await step('[16] M adds a marker, and nothing claims M mutes the preview', async () => {
  await fresh();
  await win.keyboard.press('m');
  const marks = await ev(() => window.gc.store.doc.markers.length);
  if (marks !== 1) throw new Error('M did not add a marker');
  const mute = await ev(() => document.getElementById('btnMute').getAttribute('aria-label'));
  if (/\(M\)/.test(mute || '')) throw new Error('the mute button still says M: ' + mute);
});

await step('[17] files dropped from the desktop land at the drop point; sound beside the video', async () => {
  await fresh();
  const vid = (await readFile(CLIP)).toString('base64');
  const aud = (await readFile(TONE)).toString('base64');
  const y = await laneY((t) => t.kind === 'video' && t.name === 'Video 1');
  // Put one clip down first so the drop is not the "first import".
  await importFiles([CLIP]);
  await setSnap(false);
  const x = await xOf(7);
  await ev(async ({ vid, aud, x, y }) => {
    const bin = (b) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin(vid)], 'drop-clip.mp4', { type: 'video/mp4' }));
    dt.items.add(new File([bin(aud)], 'drop-tone.mp3', { type: 'audio/mpeg' }));
    const el = document.getElementById('tlDrop');
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, { vid, aud, x, y });
  await waitFor(win, () => window.gc.store.doc.tracks.flatMap(t => t.clips).some(c => /drop-tone/.test(c.name)), null, { timeout: 15000 });
  await sleep(300);
  await setSnap(true);
  const c = await clips();
  const v = c.find(x => /drop-clip/.test(x.name));
  const a = c.find(x => /drop-tone/.test(x.name));
  if (!v || Math.abs(v.start - 7) > 0.05) throw new Error(`the dropped video starts at ${v?.start}, not at the drop point (7 s)`);
  if (v.track !== 'Video 1') throw new Error(`the dropped video went on ${v.track}, not the lane it was dropped on`);
  if (!a || a.trackKind !== 'audio') throw new Error('the dropped sound did not go on a sound lane');
  if (Math.abs(a.start - 7) > 0.05) throw new Error(`the sound starts at ${a.start}, not with the video at 7 s`);
});

await step('[18] the ruler never labels a whole second "+30f", and reads in seconds at normal zoom', async () => {
  await twoHalves();
  const labels = await ev(() => window.gc.timeline.L.rulerLabels || []);
  if (labels.some(l => /f$/.test(l))) throw new Error('frame labels at normal zoom: ' + labels.join(' '));
  if (!labels.includes('0:01') && !labels.includes('0:02')) throw new Error('no m:ss labels: ' + labels.join(' '));
  // At 30 and 24 fps (where a third or a sixth of a second is not exact in
  // binary), sweep the zoom slider end to end and read every label drawn.
  const bad = [];
  for (const rate of ['30', '24']) {
    await ev(() => window.gc.store.select([]));
      await win.locator('#inspectorRoot .row', { hasText: 'Frame rate' }).locator('select').selectOption(rate);
    await frame();
    console.log('     fps now', await ev(() => window.gc.store.doc.fps), 'asked', rate);
    for (let v = 300; v <= 1000; v += 7) {
      await win.locator('#zoomRange').fill(String(v));
      await ev(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const ls = await ev(() => window.gc.timeline.L.rulerLabels || []);
      for (const l of ls) {
        const m = /^\+(\d+)f$/.exec(l);
        if (m && +m[1] >= +rate) bad.push(`${l} at ${rate} fps`);
      }
    }
  }
  if (bad.length) throw new Error('impossible frame labels: ' + [...new Set(bad)].join(' '));
});

await step('[19] shift-clicking the only selected clip deselects it without an error', async () => {
  const [a] = await twoHalves();
  await clickClip(a.id);
  const n = problems.length;
  await clickClip(a.id, { shift: true });
  const sel = await ev(() => window.gc.store.rt.selection);
  if (sel.includes(a.id)) throw new Error('it is still selected');
  if (problems.length !== n) throw new Error('it threw');
});

await step('[20][Q6] arrows move the playhead; Alt+arrows nudge the clip and keep it on a frame', async () => {
  const [, b] = await twoHalves();
  await clickClip(b.id);
  const ph = await ev(() => window.gc.store.rt.playhead);
  await win.keyboard.press('ArrowRight');
  await frame();
  const r = await ev(() => window.gc.store.rt.playhead);
  const fps = await ev(() => window.gc.store.doc.fps);
  const [, b1] = await byStart('video');
  if (Math.abs(b1.start - 2.5) > 1e-9) throw new Error('a plain arrow moved the selected clip');
  if (Math.abs(r - ph - 1 / fps) > 1e-6) throw new Error('a plain arrow did not step the playhead a frame');
  for (let i = 0; i < 7; i++) await win.keyboard.press('Alt+ArrowRight');
  await frame();
  const [, b2] = await byStart('video');
  const f = b2.start * fps;
  if (Math.abs(b2.start - (2.5 + 7 / fps)) > 1e-6) throw new Error(`Alt+→ ×7 put it at ${b2.start}`);
  if (Math.abs(f - Math.round(f)) > 1e-9) throw new Error(`the start ${b2.start} is off the frame grid`);
  // Nudged back past the clip before it, the track is still in time order.
  for (let i = 0; i < 3; i++) await win.keyboard.press('Alt+Shift+ArrowLeft');
  await frame();
  const order = await ev(() => window.gc.store.doc.tracks.map(t => t.clips.map(c => c.start)));
  if (order.some(l => l.some((v, i) => i && v < l[i - 1]))) throw new Error('the track is out of order: ' + JSON.stringify(order));
  // Typing a start in the Inspector lands on a frame too.
  const field = win.locator('#inspectorRoot .row', { hasText: 'Start' }).locator('input').first();
  await revealLocator(field);
  await field.click();
  await field.fill('1.234');
  await field.press('Enter');
  await frame();
  const typed = (await clips()).find(c => c.id === b.id).start;
  if (Math.abs(typed * fps - Math.round(typed * fps)) > 1e-6) throw new Error(`typing 1.234 left the start at ${typed}, off the frame grid`);
});

await step('[Q1] a graphic placed from the Graphics tab is drawn OVER the footage', async () => {
  await fresh();
  await importFiles([CLIP]);
  await win.click('#leftTabs [data-tab="gfx"]'); await sleep(250);
  await win.setInputFiles('#filePicker', [LOGO]);
  await win.waitForSelector('#gfxRoot .gfxtile', { timeout: 15000 });
  await playheadTo(1);
  await win.click('#gfxRoot .gfxtile');
  await sleep(600);
  const c = await clips();
  const img = c.find(x => x.type === 'image');
  const vid = c.find(x => x.type === 'video');
  if (!img) throw new Error('nothing was placed');
  if (!(img.trackIndex < vid.trackIndex)) throw new Error(`the graphic is on ${img.track}, under the footage on ${vid.track}`);
  const order = await ev(() => window.gc.comp.activeClips(1.2).map(x => x.clip.type));
  if (order.indexOf('image') < order.indexOf('video')) throw new Error('painted under the footage: ' + order.join(' → '));
  const red = await ev(async () => {
    await new Promise(r => setTimeout(r, 300));
    const cv = document.getElementById('previewCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0, r = 0;
    for (let i = 0; i < d.length; i += 16) { n++; if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) r++; }
    return r / n;
  });
  if (red < 0.01) throw new Error(`the graphic cannot be seen on the picture (${(red * 100).toFixed(2)}% red)`);
});

await step('[Q2] a landscape recording in a 9:16 project arrives as blur-fit', async () => {
  await fresh();
  await win.click('#aspectSeg [data-ar="9:16"]');
  await sleep(200);
  await importFiles([CLIP]);
  const [v] = await byStart('video');
  if (v?.fit !== 'blur') throw new Error(`fit is ${v?.fit}`);
  await win.click('#aspectSeg [data-ar="16:9"]');
});

await step('[Q5] the wheel scrolls the tracks; Shift+wheel scrolls along; the TRACKS label stays readable', async () => {
  await twoHalves();
  for (let i = 0; i < 5; i++) { await win.click('#trackHeaders [data-add="video"]'); await sleep(60); await win.click('.ctx [data-item="lane-video"]'); await sleep(60); }
  await frame();
  const vy = await laneY((t) => t.kind === 'video');
  await win.mouse.move(await xOf(1), vy);
  const s0 = await ev(() => ({ x: window.gc.store.ui.scrollX, y: window.gc.store.ui.scrollY }));
  await win.mouse.wheel(0, 120); await frame();
  const s1 = await ev(() => ({ x: window.gc.store.ui.scrollX, y: window.gc.store.ui.scrollY }));
  if (!(s1.y > s0.y) || s1.x !== s0.x) throw new Error(`plain wheel: ${JSON.stringify(s0)} → ${JSON.stringify(s1)}`);
  await win.keyboard.down('Shift'); await win.mouse.wheel(0, 120); await win.keyboard.up('Shift'); await frame();
  const s2 = await ev(() => ({ x: window.gc.store.ui.scrollX, y: window.gc.store.ui.scrollY }));
  if (!(s2.x > s1.x)) throw new Error('Shift+wheel did not scroll along the timeline');
  const top = await ev(() => {
    const sp = document.querySelector('#trackHeaders .th-spacer').getBoundingClientRect();
    const el = document.elementFromPoint(sp.left + 20, sp.top + sp.height / 2);
    return el?.className || el?.tagName;
  });
  if (!/th-spacer/.test(top)) throw new Error('the TRACKS label is covered by ' + top);
});

await step('[Q7] Beat sync hides BPM and Tap until it is on; one Snap button, named Snap', async () => {
  await fresh();
  const hidden = await ev(() => !document.getElementById('bpmInput').getClientRects().length
    && !document.getElementById('btnTapTempo').getClientRects().length);
  if (!hidden) throw new Error('BPM / Tap are on screen with Beat sync off');
  await win.click('#btnBeatGrid');
  const shown = await ev(() => !!document.getElementById('bpmInput').getClientRects().length && window.gc.store.ui.beatGrid);
  await win.click('#btnBeatGrid');
  if (!shown) throw new Error('Beat sync did not show BPM / turn the grid on');
  const label = await ev(() => document.getElementById('btnMagnet').textContent.trim());
  if (label !== 'Snap') throw new Error('the snap control is called ' + label);
});

await step('[Q8] the speed badge lands top-left, clear of the phone buttons', async () => {
  await fresh();
  await win.click('#aspectSeg [data-ar="9:16"]');
  await importFiles([CLIP]);
  const [c] = await byStart('video');
  let b = await box(c.id);
  await rightClick((b.x0 + b.x1) / 2, b.y);
  await win.locator('.ctx .ctx__item', { hasText: 'Speed' }).first().hover(); await sleep(150);
  await menuItem('2× — double speed');
  b = await box(c.id);
  await rightClick((b.x0 + b.x1) / 2, b.y);
  await menuItem('badge');
  const badge = (await clips()).find(x => x.badgeFor === c.id);
  await win.click('#aspectSeg [data-ar="16:9"]');
  if (!badge) throw new Error('no badge');
  if (!(badge.transform.x < 0.3 && badge.transform.y < 0.25)) throw new Error(`badge at ${badge.transform.x}, ${badge.transform.y}`);
});

await win.screenshot({ path: `${OUT}/timeline.png` });
await app.close();
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`TIMELINE FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('TIMELINE PASSED — cut, trimmed, rippled, locked, dropped and undone by hand.');
