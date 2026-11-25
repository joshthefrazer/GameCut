/**
 * Stick to it: ring, arrow, name tag, spotlight and hide follow something tracked.
 *   node qa/stick.mjs
 * The footage is a green box gliding across still bars, so where the thing is
 * at any moment is known exactly.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { launch, ROOT } from './harness.mjs';

const OUT = `${ROOT}/qa/out`;
mkdirSync(OUT, { recursive: true });
const MOVER = `${OUT}/stick-mover.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'smptehdbars=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'color=c=0x22c55e:size=120x120:rate=30',
  '-filter_complex', "[1]drawgrid=w=40:h=40:t=6:c=0x0b1220[g];[0][g]overlay=x='100+160*t':y='200+40*t':shortest=1",
  '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', MOVER]);
// Centre of the box at time t, as fractions of the frame.
const thing = (t) => ({ x: (160 + 160 * t) / 1280, y: (260 + 40 * t) / 720 });

const T = await launch({ name: 'stick' });
const { win, ev, frame, step, fresh, importFiles, sleep, finish } = T;
const clips = () => ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips.map(c => ({ id: c.id, type: c.type, name: c.name, stick: c.stick || null, kind: c.shape?.kind || null, track: t.name, x: c.transform?.x, y: c.transform?.y }))));
const show = async (t) => {
  await ev((t) => { window.gc.playback.pause(); window.gc.playback.seek(t); }, t);
  for (let i = 0; i < 25; i++) { await sleep(120); if (await ev((t) => window.gc.comp.render(t, false), t)) break; }
  await sleep(80);
};
/** The real (stuck) transform of a clip at t, and the mean colour / brightness of patches of the canvas. */
const where = (id, t) => ev(({ id, t }) => {
  const c = window.gc.store.doc.tracks.flatMap(x => x.clips).find(c => c.id === id);
  const s = window.gc.comp.stuck(c, t);
  return { x: s.transform.x, y: s.transform.y, w: s.transform.w, h: s.transform.h };
}, { id, t });
const patch = (x, y, r = 0.012) => ev(({ x, y, r }) => {
  const c = window.gc.comp.canvas, s = document.createElement('canvas'); s.width = s.height = 16;
  const g = s.getContext('2d');
  g.drawImage(c, (x - r) * c.width, (y - r * c.width / c.height) * c.height, 2 * r * c.width, 2 * r * c.width, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data; let a = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { a[0] += d[i]; a[1] += d[i + 1]; a[2] += d[i + 2]; }
  return a.map(v => v / 256);
}, { x, y, r });
/** Raw pixels of a box of the canvas (64×64 sample). */
const region = (x, y, w, h) => ev(({ x, y, w, h }) => {
  const c = window.gc.comp.canvas, s = document.createElement('canvas'); s.width = s.height = 64;
  const g = s.getContext('2d');
  g.drawImage(c, (x - w / 2) * c.width, (y - h / 2) * c.height, w * c.width, h * c.height, 0, 0, 64, 64);
  return Array.from(g.getImageData(0, 0, 64, 64).data);
}, { x, y, w, h });
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4) / 3; };

let cropId = null, footId = null;
const setup = async () => {
  await fresh(); await importFiles([MOVER]);
  const r = await ev(() => {
    const { store, cmds, playback } = window.gc;
    const v = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video');
    playback.seek(v.start + 1);
    const c = cmds.cropClip(v.id, { crop: { x: 250 / 1280, y: 230 / 720, w: 140 / 1280, h: 140 / 720 }, transform: { x: 0.85, y: 0.85, scale: 0.3 } });
    store.select([c.id]);
    return { crop: c.id, foot: v.id };
  });
  cropId = r.crop; footId = r.foot;
  await sleep(300);
  await win.click('#btnFollowCrop');
  for (let i = 0; i < 80; i++) { await sleep(250); if (await ev((id) => !!window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id)?.crop?.path, cropId)) break; }
  await ev((id) => window.gc.store.select([id]), cropId); await sleep(250);
};
const stick = async (kind) => {
  await ev((id) => window.gc.store.select([id]), cropId); await sleep(250);
  const before = new Set((await clips()).map(c => c.id));
  await win.click(`#inspectorRoot [data-stick="${kind}"]`); await frame();
  return (await clips()).find(c => !before.has(c.id));
};
const near = (p, q, tol = 0.02) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;

console.log('\n── stick to it ─────');

await step('a ring stays on the moving thing from start to end (not on the crop layer)', async () => {
  await setup();
  const ring = await stick('ring');
  if (!ring || ring.kind !== 'ring' || ring.stick?.to !== cropId) throw new Error('no ring: ' + JSON.stringify(ring));
  for (const t of [0.3, 1, 2.5, 4.5]) {
    const p = await where(ring.id, t), q = thing(t);
    console.log(`     ${t}s: ring at ${p.x.toFixed(3)}, ${p.y.toFixed(3)} — the thing is at ${q.x.toFixed(3)}, ${q.y.toFixed(3)}`);
    if (!near(p, q)) throw new Error(`the ring is off at ${t}s`);
  }
});

await step('zooming and moving the footage takes the ring with it', async () => {
  const ring = (await clips()).find(c => c.kind === 'ring');
  await ev((id) => { const { cmds } = window.gc; cmds.setClipProp(id, 'transform.scale', 1.5, { merge: false }); cmds.setClipProp(id, 'transform.x', 0.6, { merge: false }); }, footId);
  await show(2);
  const p = await where(ring.id, 2), q = thing(2);
  const want = { x: 0.6 + (q.x - 0.5) * 1.5, y: 0.5 + (q.y - 0.5) * 1.5 };
  await ev((id) => { const { cmds } = window.gc; cmds.setClipProp(id, 'transform.scale', 1, { merge: false }); cmds.setClipProp(id, 'transform.x', 0.5, { merge: false }); }, footId);
  if (!near(p, want, 0.03)) throw new Error(`ring ${JSON.stringify(p)}, wanted ${JSON.stringify(want)}`);
});

await step('the ring is really painted on the picture, round the thing', async () => {
  const ring = (await clips()).find(c => c.kind === 'ring');
  const q = thing(2);
  await show(2);
  const withRing = await region(q.x, q.y, 0.22, 0.36);
  await ev((id) => { window.gc.cmds.setClipProp(id, 'transform.opacity', 0, { merge: false }); }, ring.id);
  await show(2);
  const without = await region(q.x, q.y, 0.22, 0.36);
  if (!(diff(withRing, without) > 1)) throw new Error('nothing was painted: ' + diff(withRing, without).toFixed(2));
  await ev(() => window.gc.history.undo());
});

await step('an arrow and a name tag sit above it and move with it', async () => {
  const arrow = await stick('arrow'), name = await stick('name');
  if (arrow?.kind !== 'arrow' || name?.type !== 'text') throw new Error(JSON.stringify([arrow, name]));
  for (const t of [0.5, 4]) {
    const q = thing(t), n = await where(name.id, t), a = await where(arrow.id, t);
    if (!(Math.abs(n.x - q.x) < 0.02 && n.y < q.y - 0.06)) throw new Error(`name tag at ${t}s: ${JSON.stringify(n)}`);
    if (!near(a, q)) throw new Error(`arrow at ${t}s: ${JSON.stringify(a)}`);
  }
});

await step('Spotlight darkens everything but the thing, under the pointers', async () => {
  await show(2);
  const q = thing(2);
  const out0 = await patch(0.9, 0.2), in0 = await patch(q.x, q.y);
  const spot = await stick('spot');
  await show(2);
  const out1 = await patch(0.9, 0.2), in1 = await patch(q.x, q.y);
  const lum = (c) => c[0] * .3 + c[1] * .59 + c[2] * .11;
  if (!(lum(out1) < lum(out0) * 0.45)) throw new Error(`the rest is not dark: ${lum(out0).toFixed(0)} → ${lum(out1).toFixed(0)}`);
  if (!(Math.abs(lum(in1) - lum(in0)) < 12)) throw new Error(`the thing went dark too: ${lum(in0).toFixed(0)} → ${lum(in1).toFixed(0)}`);
  const order = await ev(({ s, kinds }) => {
    const idx = (f) => window.gc.store.doc.tracks.findIndex(t => t.clips.some(f));
    return { spot: idx(c => c.id === s), pointers: kinds.map(k => idx(c => c.shape?.kind === k)) };
  }, { s: spot.id, kinds: ['ring', 'arrow'] });
  if (order.pointers.some(i => i >= order.spot)) throw new Error('the spotlight is on top of a pointer: ' + JSON.stringify(order));
  await ev(() => window.gc.history.undo());
});

await step('Hide it pixelates the thing, and only there', async () => {
  // Without the pointers in the way.
  await ev(() => { for (const t of window.gc.store.doc.tracks) for (const c of t.clips) if (c.stick) c.transform.opacity = 0; window.gc.store.docChanged('x'); });
  await show(2);
  const q = thing(2);
  const a0 = await region(q.x, q.y, 0.07, 0.12), b0 = await region(0.8, 0.2, 0.07, 0.12);
  const hide = await stick('hide');
  if (hide?.kind !== 'hide') throw new Error('no hide layer');
  await show(2);
  const a1 = await region(q.x, q.y, 0.07, 0.12), b1 = await region(0.8, 0.2, 0.07, 0.12);
  if (!(diff(a0, a1) > 3)) throw new Error('the thing is not hidden: ' + diff(a0, a1).toFixed(2));
  if (!(diff(b0, b1) < 1)) throw new Error('it changed the picture elsewhere: ' + diff(b0, b1).toFixed(2));
});

await step('the export paints the same stuck layers as the preview', async () => {
  const r = await ev(async () => {
    const { Compositor } = await import('app://gamecut/src/engine/compositor.js');
    const c = document.createElement('canvas');
    const comp = new Compositor(window.gc.store, c, { fixedSize: { w: 640, h: 360 } });
    const ring = window.gc.store.doc.tracks.flatMap(t => t.clips).find(x => x.shape?.kind === 'ring');
    const clip = window.gc.store.doc.tracks.flatMap(t => t.clips).find(x => x.type === 'video' && !x.crop);
    // A picture standing in for the decoder's, the way the export hands frames over.
    const pic = new OffscreenCanvas(1280, 720); pic.videoWidth = 1280; pic.videoHeight = 720;
    for (const v of window.gc.store.doc.tracks.flatMap(t => t.clips).filter(x => x.type === 'video')) comp.pool.overrides.set(v.id, pic);
    const out = [0.3, 2.5, 4.5].map(t => { const s = comp.stuck(ring, t); return { t, x: s.transform.x, y: s.transform.y }; });
    void clip; comp.dispose?.();
    return out;
  });
  for (const p of r) if (!near(p, thing(p.t))) throw new Error('export: ' + JSON.stringify(p));
});

await step('dragging it on the picture moves it but it keeps following; a corner resizes it; each is one undo', async () => {
  const ring = (await clips()).find(c => c.kind === 'ring');
  await show(1);
  await ev((id) => { window.gc.store.ui.snap = false; window.gc.store.select([id]); }, ring.id); await sleep(250);
  const a = await where(ring.id, 1), b = await where(ring.id, 3);
  const box = () => ev(() => { const r = document.querySelector('.gizmo').getBoundingClientRect(), f = document.querySelector('.gizmo').parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, fw: f.width, fh: f.height }; });
  let g = await box();
  await win.mouse.move(g.x + g.w / 2, g.y + g.h / 2); await win.mouse.down();
  for (let i = 1; i <= 6; i++) await win.mouse.move(g.x + g.w / 2 + 12 * i, g.y + g.h / 2 + 5 * i);
  await win.mouse.up(); await frame();
  const a2 = await where(ring.id, 1), b2 = await where(ring.id, 3), dx = 72 / g.fw, dy = 30 / g.fh;
  const off = (p, q) => Math.hypot(q.x - p.x - dx, q.y - p.y - dy);
  if (off(a, a2) > 0.01 || off(b, b2) > 0.01) throw new Error('moved wrongly: ' + JSON.stringify({ a, a2, b, b2, dx, dy }));
  await sleep(150); g = await box();
  await win.mouse.move(g.x + g.w, g.y + g.h); await win.mouse.down();
  for (let i = 1; i <= 6; i++) await win.mouse.move(g.x + g.w + 4 * i, g.y + g.h + 4 * i);
  await win.mouse.up(); await frame();
  const a3 = await where(ring.id, 1), b3 = await where(ring.id, 3);
  if (!(a3.w > a2.w * 1.1 && b3.w > b2.w * 1.1)) throw new Error('corner did not resize: ' + JSON.stringify({ a2, a3 }));
  await ev(() => window.gc.history.undo()); await ev(() => window.gc.history.undo()); await frame();
  const z = await where(ring.id, 1);
  if (Math.hypot(z.x - a.x, z.y - a.y) > 0.002 || Math.abs(z.w - a.w) > 0.002) throw new Error('two undos did not put it back');
});

await step('Let go leaves it where it is; undo puts it back; deleting the target does not break it', async () => {
  const ring = (await clips()).find(c => c.kind === 'ring');
  await show(2);
  const here = await where(ring.id, 2);
  await ev((id) => window.gc.store.select([id]), ring.id); await sleep(250);
  await win.click('#btnUnstick'); await frame();
  const free = (await clips()).find(c => c.id === ring.id);
  if (free.stick || !near(free, here, 0.005)) throw new Error('let go: ' + JSON.stringify(free));
  await ev(() => window.gc.history.undo()); await frame();
  if (!(await clips()).find(c => c.id === ring.id).stick) throw new Error('undo did not stick it back');
  await ev((id) => { window.gc.store.select([id]); window.gc.cmds.removeSelected(); }, cropId);
  await show(2);
  const gone = await where(ring.id, 2);
  if (!Number.isFinite(gone.x)) throw new Error('broke when the target was deleted');
});

await finish('STICK');
