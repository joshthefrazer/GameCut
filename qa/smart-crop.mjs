/**
 * Smart crop, through the front door: the HUD finder and click-to-cut-out.
 *
 * The test footage is a "game": a busy picture that keeps moving, with two
 * HUD pieces that never move — a minimap in the top-left corner and a long
 * strip in the top-right — and a solid orange badge to click on.
 *   xvfb-run -a node qa/smart-crop.mjs
 */
import { execFileSync } from 'node:child_process';
import { launch, ROOT } from './harness.mjs';
import { patchClick } from './reveal.mjs';

const OUT = `${ROOT}/qa/out`;
const GAME = `${OUT}/game-hud.mp4`;
// Moving world: a scrolling test pattern. HUD: a static rgb pattern (minimap,
// 200×200 at 30,30) and static bars (kill feed, 360×90 at 890,30). Badge: an
// orange box (240×120 at 520,520) that also never moves.
execFileSync('ffmpeg', ['-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=1800x1000:rate=30',
  '-f', 'lavfi', '-i', 'rgbtestsrc=size=200x200:rate=30',
  '-f', 'lavfi', '-i', 'smptebars=size=360x90:rate=30',
  '-f', 'lavfi', '-i', 'color=c=0xff8800:size=240x120:rate=30',
  '-filter_complex',
  "[0]crop=1280:720:'200+180*sin(t*1.7)':'120+100*cos(t*1.3)'[bg];[bg][1]overlay=30:30[a];[a][2]overlay=890:30[b];[b][3]overlay=520:520:shortest=1",
  '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', GAME]);

// A green box gliding across a still picture, for "Follow it as it moves".
const MOVER = `${OUT}/mover.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'smptehdbars=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'color=c=0x22c55e:size=120x120:rate=30',
  '-filter_complex', "[1]drawgrid=w=40:h=40:t=6:c=0x0b1220[g];[0][g]overlay=x='100+160*t':y='200+40*t':shortest=1",
  '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', MOVER]);

const T = await launch({ name: 'smartcrop' });
const { win, ev, step, fresh, importFiles, byStart, sleep } = T;
patchClick(win);

async function openRoom() {
  await fresh(); await importFiles([GAME]);
  await ev(async () => { const { store, playback } = window.gc; const c = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video'); store.select([c.id]); playback.seek(c.start + 1.2); await new Promise(r => setTimeout(r, 900)); });
  await win.click('#btnCrop'); await sleep(450);
  if (!(await ev(() => !!document.querySelector('.cropst')))) throw new Error('the crop room did not open');
  await win.click('.cst[data-tool="smart"]'); await sleep(150);
}
const found = () => ev(() => document.querySelector('.cropst__cv').__found || []);
const frameBox = () => ev(() => { const cv = document.querySelector('.cropst__cv'); const b = cv.getBoundingClientRect(); const f = cv.__frame; return { x: b.x + f.x, y: b.y + f.y, w: f.w, h: f.h }; });
const covers = (b, x, y, w, h, slack = 0.03) => b.x <= x / 1280 + slack && b.y <= y / 720 + slack
  && b.x + b.w >= (x + w) / 1280 - slack && b.y + b.h >= (y + h) / 720 - slack
  && b.w * b.h < (w / 1280) * (h / 720) * 3.5;

console.log('\n── smart crop ─────');

await step('Find the HUD finds the minimap and the kill-feed strip, and names them', async () => {
  await openRoom();
  await win.click('#cstFindHud');
  for (let i = 0; i < 60; i++) { await sleep(250); if ((await found()).length) break; }
  const f = await found();
  if (!f.length) throw new Error('found nothing: ' + await ev(() => document.getElementById('cstSmartNote').textContent));
  const mini = f.find(x => covers(x.box, 30, 30, 200, 200));
  const feed = f.find(x => covers(x.box, 890, 30, 360, 90));
  if (!mini) throw new Error(`no box around the minimap: ${JSON.stringify(f.map(x => x.box))}`);
  if (!feed) throw new Error(`no box around the strip: ${JSON.stringify(f.map(x => x.box))}`);
  if (mini.name !== 'Minimap') throw new Error(`the minimap was called "${mini.name}"`);
  if (!/Kill feed|Top-right/.test(feed.name)) throw new Error(`the strip was called "${feed.name}"`);
  // Nothing found in the middle of the moving picture.
  if (f.some(x => x.box.x + x.box.w / 2 > 0.3 && x.box.x + x.box.w / 2 < 0.7 && x.box.y + x.box.h / 2 > 0.3 && x.box.y + x.box.h / 2 < 0.65 && !covers(x.box, 520, 520, 240, 120))) {
    throw new Error('something moving was taken for HUD');
  }
});

await step('a joined piece (the strip) can be split, to keep just one part of it', async () => {
  const before = (await found()).length;
  const btn = await win.$('#cstFound .cropst__split');
  if (!btn) throw new Error('no Split button on any found piece');
  await btn.click(); await sleep(200);
  const after = await found();
  if (after.length <= before) throw new Error(`${before} pieces before Split, ${after.length} after`);
  if (!after.some(x => / · 1$/.test(x.name))) throw new Error('split parts are not named: ' + after.map(x => x.name).join(', '));
  // Put things back as the next step expects them.
  await win.click('#cstFindHud');
  for (let i = 0; i < 60; i++) { await sleep(250); if ((await found()).length === before) break; }
});

await step('cutting the found pieces makes one layer each, linked to the footage, sitting over their own pixels', async () => {
  const before = (await byStart('video')).length;
  const n = (await found()).filter(x => x.on).length;
  await win.click('#cstApply'); await sleep(400);
  const vs = await byStart('video');
  const crops = vs.filter(c => c.crop);
  if (vs.length - before !== n || crops.length !== n) throw new Error(`${crops.length} crop layers for ${n} pieces`);
  if (crops.some(c => !c.linkTo)) throw new Error('a crop layer is not linked to its footage');
  const mini = crops.find(c => c.name === 'Minimap');
  if (!mini) throw new Error('the minimap layer is not named');
  // In a 16:9 project the minimap layer's centre is where the minimap is.
  if (Math.abs(mini.transform.x - (130 / 1280)) > 0.04 || Math.abs(mini.transform.y - (130 / 720)) > 0.05) {
    throw new Error(`minimap layer sits at ${mini.transform.x.toFixed(3)}, ${mini.transform.y.toFixed(3)}`);
  }
});

await step('click to cut out: one click on the orange badge selects exactly the badge', async () => {
  await openRoom();
  const f = await frameBox();
  await win.mouse.click(f.x + f.w * (640 / 1280), f.y + f.h * (580 / 720)); await sleep(250);
  const sel = (await found()).find(x => /Selection/.test(x.name));
  if (!sel) throw new Error('nothing was selected');
  const b = sel.box;
  const want = { x: 520 / 1280, y: 520 / 720, w: 240 / 1280, h: 120 / 720 };
  for (const k of ['x', 'y', 'w', 'h']) if (Math.abs(b[k] - want[k]) > 0.025) throw new Error(`selection ${JSON.stringify(b)} vs badge ${JSON.stringify(want)}`);
});

await step('Exact shape makes a cut-out with a mask; clicking a piece unticks it', async () => {
  await win.check('input[name="cstOut"][value="shape"]');
  await win.click('#cstApply'); await sleep(400);
  const crops = (await byStart('video')).filter(c => c.crop);
  const last = crops.find(c => c.name === 'Selection');
  if (!last) throw new Error('no Selection layer');
  const hasMask = await ev((id) => !!window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).crop.mask, last.id);
  if (!hasMask) throw new Error('the exact shape has no mask');
  // Untick by clicking.
  await openRoom();
  const f = await frameBox();
  await win.mouse.click(f.x + f.w * 0.5, f.y + f.h * (580 / 720)); await sleep(200);
  await win.mouse.click(f.x + f.w * 0.5, f.y + f.h * (580 / 720)); await sleep(200);
  const s = (await found()).find(x => /Selection/.test(x.name));
  if (!s || s.on) throw new Error('clicking the selected piece did not untick it');
  await win.keyboard.press('Escape');
});

await step('Follow it as it moves: the crop box stays on a moving thing for the whole clip', async () => {
  await fresh(); await importFiles([MOVER]);
  const id = await ev(() => {
    const { store, cmds, playback } = window.gc;
    const v = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    playback.seek(v.start + 1);
    // The box at 1s: x = 260, y = 240, 120 square — drawn with a little room.
    const c = cmds.cropClip(v.id, { crop: { x: 250 / 1280, y: 230 / 720, w: 140 / 1280, h: 140 / 720 }, transform: { x: 0.8, y: 0.2, scale: 1 } });
    store.select([c.id]);
    return c.id;
  });
  await sleep(400);
  await win.click('#btnFollowCrop');
  let path = null;
  for (let i = 0; i < 120 && !path; i++) { await sleep(500); path = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id)?.crop?.path || null, id); }
  if (!path) throw new Error('no path was made');
  const at = (t) => ev(async ({ id, t }) => {
    const { cropAt } = await import('app://gamecut/src/engine/layers/video-layer.js');
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id);
    return cropAt(c, c.start + t);
  }, { id, t });
  for (const t of [0.2, 1, 2.5, 4.5]) {
    const p = await at(t);
    const wx = (100 + 160 * t - 10) / 1280, wy = (200 + 40 * t - 10) / 720;
    console.log(`     ${t}s: box at ${p.x.toFixed(3)}, ${p.y.toFixed(3)} — the thing is at ${wx.toFixed(3)}, ${wy.toFixed(3)}`);
    if (Math.abs(p.x - wx) > 0.02 || Math.abs(p.y - wy) > 0.03) throw new Error(`lost it at ${t}s`);
  }
  // Undo puts the box back where it was drawn.
  await ev(() => window.gc.history.undo()); await sleep(150);
  const still = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id)?.crop?.path, id);
  if (still?.length) throw new Error('undo did not stop the following');
});

await T.finish('SMART-CROP');
