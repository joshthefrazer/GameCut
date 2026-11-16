/**
 * The crop room's Box tool, through the real window.
 *
 * What went wrong for real: the room's toolbar sits over the window's drag
 * strip, and on Windows that strip eats the clicks — so pressing Box did
 * nothing. A test that clicks the button cannot see that on Linux, so the
 * first check asks the question directly: for every button in the room, what
 * is the topmost thing at its centre, and is it a place you can click?
 *
 * Then the box itself: draw, resize by a handle, move, undo, lock to a shape,
 * and apply — checking that the piece lands exactly over the pixels it was
 * cut from, in a widescreen project and in a vertical one.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { patchClick } from './reveal.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || '/tmp');
const PROFILE = `/tmp/gc-cropbox-${process.pid}`;
const SRC = path.join(OUT, 'cropbox-src.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '6',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', SRC]);
const problems = [];
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};
console.log('\n── crop box ─────────────────────────────');
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
patchClick(win);
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.click('#homeNew'); await sleep(1000);
await win.setInputFiles('#filePicker', [SRC]);
for (let i = 0; i < 80; i++) { if (await win.evaluate(() => window.gc.store.doc.tracks.some(t => t.clips.some(c => c.type === 'video')))) break; await sleep(300); }
await sleep(1500);

const clips = () => win.evaluate(() => window.gc.store.doc.tracks.flatMap(t => t.clips.map(c => ({ id: c.id, type: c.type, crop: c.crop, tr: c.transform }))));
const openRoom = async () => {
  await win.evaluate(async () => { const { store, playback } = window.gc; const c = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video' && !c.crop); store.select([c.id]); playback.seek(c.start + 1); await new Promise(r => setTimeout(r, 900)); });
  await win.click('#btnCrop'); await sleep(450);
  if (!(await win.evaluate(() => !!document.querySelector('.cropst')))) throw new Error('the room did not open');
};
const frame = () => win.evaluate(() => { const cv = document.querySelector('.cropst__cv'); const b = cv.getBoundingClientRect(); const f = cv.__frame; return { x: b.x + f.x, y: b.y + f.y, w: f.w, h: f.h }; });
const box = () => win.evaluate(() => document.querySelector('.cropst__cv').__box);
const at = (f, u, v) => [f.x + f.w * u, f.y + f.h * v];
const drag = async (from, to, { shift = false } = {}) => {
  await win.mouse.move(...from); if (shift) await win.keyboard.down('Shift');
  await win.mouse.down(); await win.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 5 }); await win.mouse.move(...to, { steps: 5 }); await win.mouse.up();
  if (shift) await win.keyboard.up('Shift'); await sleep(120);
};
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

await openRoom();

await step('every button in the room is somewhere you can click (not a drag strip)', async () => {
  const bad = await win.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('.cropst button, .cropst select')) {
      const r = b.getBoundingClientRect();
      if (!r.width || getComputedStyle(b.closest('.cropst__paint,.cropst__shape,.cropst__slide') || b).pointerEvents === 'none') continue;
      const stack = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const region = stack.map(e => getComputedStyle(e).webkitAppRegion).find(v => v === 'drag' || v === 'no-drag');
      if (region === 'drag') out.push(b.id || b.dataset.tool || b.textContent.trim());
    }
    return out;
  });
  if (bad.length) throw new Error('buttons over the drag strip: ' + bad.join(', '));
});

await step('pressing Box switches to the box tool, and the room remembers it', async () => {
  await win.click('.cst[data-tool="box"]'); await sleep(150);
  const on = await win.evaluate(() => document.querySelector('.cst[data-tool="box"]').classList.contains('is-on'));
  if (!on) throw new Error('Box did not switch on');
  const remembered = await win.evaluate(() => localStorage.getItem('gamecut.cropTool'));
  if (remembered !== 'box') throw new Error('not remembered: ' + remembered);
});

const f0 = await frame();
await step('drawing a box makes a box', async () => {
  await drag(at(f0, .55, .10), at(f0, .85, .45));
  const b = await box();
  if (!b || !near(b.x, .55) || !near(b.y, .10) || !near(b.w, .30) || !near(b.h, .35)) throw new Error('box is ' + JSON.stringify(b));
});

await step('dragging a corner handle resizes it, the opposite corner stays put', async () => {
  await drag(at(f0, .85, .45), at(f0, .95, .60));
  const b = await box();
  if (!near(b.x, .55) || !near(b.y, .10) || !near(b.w, .40) || !near(b.h, .50)) throw new Error('box is ' + JSON.stringify(b));
});

await step('dragging inside moves the box without resizing it', async () => {
  await drag(at(f0, .75, .35), at(f0, .55, .40));
  const b = await box();
  if (!near(b.w, .40) || !near(b.h, .50) || !near(b.x, .35) || !near(b.y, .15)) throw new Error('box is ' + JSON.stringify(b));
});

await step('a plain click does not wipe the box', async () => {
  await drag(at(f0, .05, .90), at(f0, .05, .90));
  const b = await box();
  if (!b || !near(b.w, .40)) throw new Error('box is ' + JSON.stringify(b));
});

await step('Undo walks the box back, one change at a time', async () => {
  await win.click('#cstUndo'); await sleep(100);        // the move
  let b = await box();
  if (!near(b.x, .55) || !near(b.w, .40)) throw new Error('after one undo: ' + JSON.stringify(b));
  await win.click('#cstUndo'); await sleep(100);        // the resize
  b = await box();
  if (!near(b.w, .30) || !near(b.h, .35)) throw new Error('after two undos: ' + JSON.stringify(b));
});

await step('Square locks the box to a square', async () => {
  await win.selectOption('#cstAspect', '1'); await sleep(120);
  let b = await box();
  if (!near(b.w * 1280, b.h * 720, 3)) throw new Error(`refit is ${b.w * 1280} × ${b.h * 720}`);
  await win.click('#cstClear'); await sleep(80);
  await drag(at(f0, .20, .20), at(f0, .60, .70));
  b = await box();
  if (!near(b.w * 1280, b.h * 720, 3) || b.w < .05) throw new Error(`drawn ${b.w * 1280} × ${b.h * 720}`);
  await win.selectOption('#cstAspect', '0');
});

await step('Whole frame selects everything, and the arrow keys nudge a box', async () => {
  await win.click('#cstAll'); await sleep(100);
  let b = await box();
  if (!near(b.w, 1, .01) || !near(b.h, 1, .01)) throw new Error('not the whole frame: ' + JSON.stringify(b));
  await win.click('#cstClear'); await sleep(80);
  await drag(at(f0, .30, .30), at(f0, .50, .50));
  const b0 = await box();
  await win.keyboard.press('Shift+ArrowRight'); await sleep(80);
  b = await box();
  if (!near(b.x - b0.x, 10 / 1280, .0005)) throw new Error('nudged by ' + (b.x - b0.x) * 1280 + ' px');
});

await step('Apply crops exactly that part, and the piece sits right over the pixels it came from', async () => {
  const sample = () => win.evaluate(() => { const c = window.gc.comp; c.render(); const x = c.canvas.getContext('2d'); return Array.from(x.getImageData(0, 0, c.canvas.width, c.canvas.height).data); });
  await win.click('#cstCancel'); await sleep(300);
  await openRoom();
  const before = await sample();
  await win.click('.cst[data-tool="box"]');
  const f = await frame();
  await drag(at(f, .55, .10), at(f, .90, .50));
  const want = await box();
  await win.click('#cstApply'); await sleep(1800);
  const list = await clips();
  const made = list.find(c => c.crop);
  if (!made) throw new Error('no cropped layer');
  if (!near(made.crop.x, want.x, .005) || !near(made.crop.w, want.w, .005)) throw new Error('crop ' + JSON.stringify(made.crop) + ' vs box ' + JSON.stringify(want));
  const after = await sample();
  let sum = 0; for (let i = 0; i < before.length; i += 4) sum += Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]);
  const mean = sum / (before.length / 4) / 3;
  if (mean > 4) throw new Error(`the piece changed the picture (mean difference ${mean.toFixed(1)})`);
});

await step('in a vertical project a box on the cut-off side still lands where you can see it', async () => {
  await win.click('#aspectSeg button:nth-child(2)'); await sleep(900);
  await win.evaluate(() => { const { store } = window.gc; for (const t of store.doc.tracks) t.clips = t.clips.filter(c => !c.crop); store.docChanged('test'); });
  await openRoom();
  await win.click('.cst[data-tool="box"]');
  const vis = await win.evaluate(() => document.querySelector('.cropst__cv').__visible);
  if (!vis.partial) throw new Error('the room did not notice that part of the frame is cut off');
  const f = await frame();
  await drag(at(f, .82, .20), at(f, .98, .45));
  await win.click('#cstApply'); await sleep(900);
  const made = (await clips()).find(c => c.crop);
  if (!made) throw new Error('no piece was made');
  if (made.tr.x < 0 || made.tr.x > 1 || made.tr.y < 0 || made.tr.y > 1) throw new Error(`piece is off screen at ${made.tr.x.toFixed(2)}, ${made.tr.y.toFixed(2)}`);
});

await app.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall good');
process.exit(problems.length ? 1 : 0);
