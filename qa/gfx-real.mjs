/**
 * Graphics, the way a person uses them — not the way a test finds convenient.
 *
 * Every earlier graphics check built its image in memory from a data: URL and
 * pushed a hand-made clip onto a track. That skipped the file picker, the
 * importer, gcmedia://, the Graphics tab's own Place step and the mouse — which
 * is to say, every part of the path a real person takes. The shipped bug lived
 * in exactly that gap: placing a graphic wiped its position and opacity, so it
 * landed centred on the top-left corner, three-quarters off the picture, and
 * could not be dragged. Every in-memory test passed throughout.
 *
 * So this one goes through the front door, and checks what you would check by
 * eye: is it on the picture, can you drag it, does a look change it, and does
 * a project saved while the bug was live come back repaired.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import { patchClick, revealLocator } from './reveal.mjs';

const ROOT = (await import('node:path')).resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || '/tmp';
const PROFILE = `/tmp/gc-gfx-${process.pid}`;
const problems = [];
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── graphics, through the front door ─────');
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
patchClick(win);
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
win.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.waitForSelector('#homeNew'); await win.click('#homeNew'); await sleep(1200);

/** Share of preview pixels that are the fixture's red. */
const redShare = () => win.evaluate(async () => {
  await new Promise(r => setTimeout(r, 250));
  const cv = document.getElementById('previewCanvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let red = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { n++; if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) red++; }
  return red / n;
});
/** Where the red is, in page coordinates — so the mouse can be aimed at it. */
const redCentre = () => win.evaluate(() => {
  const cv = document.getElementById('previewCanvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < cv.height; y += 2) for (let x = 0; x < cv.width; x += 2) {
    const i = (y * cv.width + x) * 4;
    if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) { sx += x; sy += y; n++; }
  }
  if (!n) return null;
  const r = cv.getBoundingClientRect();
  return { x: r.left + (sx / n) * (r.width / cv.width), y: r.top + (sy / n) * (r.height / cv.height) };
});
const theClip = () => win.evaluate(() => {
  const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'image');
  return c ? { id: c.id, t: c.transform, fx: c.fx } : null;
});

await step('a PNG added through the Graphics tab lands on the picture', async () => {
  // Clear the demo so the only red on screen is ours.
  await win.evaluate(() => {
    const { store, cmds } = window.gc;
    store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
    cmds.removeSelected();
  });
  await win.click('#leftTabs [data-tab="gfx"]'); await sleep(250);
  await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/test-logo.png`]);
  await win.waitForSelector('#gfxRoot .gfxtile', { timeout: 15000 });
  await win.click('#gfxRoot .gfxtile');
  await sleep(600);
  await win.evaluate(() => window.gc.playback.seek(0.5));

  const c = await theClip();
  if (!c) throw new Error('clicking the tile put nothing on the timeline');
  for (const k of ['x', 'y', 'scale', 'rotation', 'opacity']) {
    if (typeof c.t[k] !== 'number' || !Number.isFinite(c.t[k])) {
      throw new Error(`the placed graphic has no ${k} (transform is ${JSON.stringify(c.t)})`);
    }
  }
  if (c.t.opacity !== 1) throw new Error('the graphic arrived at opacity ' + c.t.opacity);
  if (Math.abs(c.t.x - 0.5) > 0.01 || Math.abs(c.t.y - 0.5) > 0.01) {
    throw new Error(`the graphic arrived at ${c.t.x}, ${c.t.y} rather than the middle`);
  }
  const share = await redShare();
  // The fixture's ellipse at the arrival size covers roughly 5% of the frame.
  // A quarter of that is what the bug produced: centred on the corner.
  if (share < 0.035) throw new Error(`only ${(share * 100).toFixed(1)}% of the picture shows it — it is off-screen or faint`);
  console.log(`     on the picture: ${(share * 100).toFixed(1)}% of the frame`);
});

await step('it can be dragged across the picture with the mouse', async () => {
  const before = await theClip();
  const at = await redCentre();
  if (!at) throw new Error('nothing to aim at');
  await win.mouse.move(at.x, at.y);
  await win.mouse.down();
  for (let i = 1; i <= 10; i++) { await win.mouse.move(at.x + i * 15, at.y + i * 6); await sleep(16); }
  await win.mouse.up();
  await sleep(300);
  const after = await theClip();
  const dx = after.t.x - before.t.x, dy = after.t.y - before.t.y;
  if (!(dx > 0.05) || !(dy > 0.02)) {
    throw new Error(`dragging 150px right moved it by ${dx.toFixed(3)}, ${dy.toFixed(3)} of the frame`);
  }
  const moved = await redCentre();
  if (!moved || moved.x < at.x + 100) throw new Error('the numbers moved but the picture did not');
  console.log(`     moved to ${after.t.x.toFixed(3)}, ${after.t.y.toFixed(3)}`);
});

/**
 * Type a number into one of the Inspector's fields, the way a person does:
 * click it, replace what is there, press Enter.
 */
const setField = async (label, value) => {
  const row = win.locator('#inspectorRoot .row').filter({
    has: win.locator('label', { hasText: new RegExp(`^${label}$`) }),
  }).first();
  const input = row.locator('input').first();
  await revealLocator(input);
  await input.click();
  await input.fill(String(value));
  await input.press('Enter');
  await sleep(150);
};

/**
 * The default look survives being resized.
 *
 * Rounded corners are cut with a clip region on a pooled scratch canvas, and
 * the pool reset everything about that canvas except the clip. The first draw
 * left a clip the size of the picture at THAT size behind; every later draw
 * was confined to it, and `clearRect` obeys a clip too. So shrinking a graphic
 * and growing it again left it the small size — and since the very first frame
 * of Pop in is a tiny one, a graphic with the default Shadow look simply
 * vanished the moment it was given a motion.
 */
await step('a graphic with the default look survives a size change', async () => {
  const c = await theClip();
  if (!c.fx?.radius) throw new Error('expected the default look (Shadow, rounded) on the placed graphic');
  await setField('Scale', 0.8);
  const big = await redShare();
  await setField('Scale', 0.2);
  const small = await redShare();
  await setField('Scale', 0.8);
  const again = await redShare();
  console.log(`     0.8 → 0.2 → 0.8: ${(big * 100).toFixed(1)}% → ${(small * 100).toFixed(1)}% → ${(again * 100).toFixed(1)}%`);
  if (!(small > 0.002)) throw new Error('at scale 0.2 it is not on the picture at all');
  if (!(big > small * 4)) throw new Error('it did not get bigger at 0.8');
  if (Math.abs(again - big) > big * 0.1) {
    throw new Error(`back at 0.8 it covers ${(again * 100).toFixed(1)}% of the frame, not the ${(big * 100).toFixed(1)}% it did before`);
  }
  await setField('Scale', 0.42);
});

await step('a look applied from the Inspector changes how it is drawn', async () => {
  await sleep(200);
  const before = await redShare();
  await win.click('#inspectorRoot .gfxlook[data-look="sticker"]');
  await sleep(400);
  const c = await theClip();
  if (!c.fx) throw new Error('the look set no effects on the clip');
  // A sticker edge is a white border round the shape: less of the frame is red
  // at the edge, more is white. Look for the white.
  const white = await win.evaluate(() => {
    const cv = document.getElementById('previewCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let w = 0; for (let i = 0; i < d.length; i += 16) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) w++;
    return w;
  });
  if (white < 50) throw new Error(`the sticker look drew no white edge (${white} white samples)`);
  void before;
});

await step('a motion preset makes it actually move', async () => {
  const r = await win.evaluate(async () => {
    const { MOTIONS } = await import('app://gamecut/src/ui/graphics/motion.js');
    return MOTIONS.map(m => m.id);
  });
  const btn = await win.$('#inspectorRoot [data-motion]');
  if (!btn) throw new Error('no motion presets in the Inspector (have: ' + r.join(', ') + ')');
  await win.click('#inspectorRoot [data-motion="pop"]');
  await sleep(300);
  const keys = await win.evaluate(() => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'image');
    return Object.keys(c.keys || {}).filter(k => (c.keys[k] || []).length);
  });
  if (!keys.length) throw new Error('the motion preset wrote no keyframes');
  await win.evaluate(() => window.gc.playback.seek(0.02));
  const early = await redShare();
  await win.evaluate(() => window.gc.playback.seek(2));
  const later = await redShare();
  if (Math.abs(early - later) < 0.002) throw new Error(`the picture is the same at 0s and 2s (${early} vs ${later})`);
  console.log(`     keyframed: ${keys.join(', ')}`);
});

await step('a slide-in after a drag lands where it was dragged to', async () => {
  // The Inspector builds its buttons around a clip object. Dragging commits a
  // new document, and if the buttons still hold the old object, a slide-in
  // computes its destination from where the graphic USED to be.
  const at = await theClip();
  await win.click('#inspectorRoot [data-motion="slide-l"]');
  await sleep(300);
  const r = await win.evaluate(() => {
    const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'image');
    const xs = c.keys['transform.x'] || [];
    return { last: xs.at(-1)?.v, first: xs[0]?.v };
  });
  if (r.last === undefined) throw new Error('the slide wrote no x keyframes');
  if (Math.abs(r.last - at.t.x) > 0.005) {
    throw new Error(`it slides in to x=${r.last.toFixed(3)}, but it was dragged to x=${at.t.x.toFixed(3)}`);
  }
  if (!(r.first < r.last - 0.2)) throw new Error('it does not start off to the left');
});

await step('a project saved with the broken graphic comes back repaired', async () => {
  const r = await win.evaluate(async () => {
    const { store } = window.gc;
    const doc = structuredClone(store.doc);
    const c = doc.tracks.flatMap(t => t.clips).find(c => c.type === 'image');
    c.transform = { scale: 0.42 };          // exactly what 1.6.0 saved
    c.keys = {};
    store.replaceDoc(doc);
    const back = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'image');
    return back.transform;
  });
  if (r.x !== 0.5 || r.y !== 0.5 || r.opacity !== 1 || r.scale !== 0.42) {
    throw new Error('reopening did not repair it: ' + JSON.stringify(r));
  }
  await win.evaluate(() => window.gc.playback.seek(0.5));
  const share = await redShare();
  if (share < 0.035) throw new Error('repaired in the document, still not on the picture');
});

await win.screenshot({ path: `${OUT}/gfx-real.png` });
await app.close();
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`GRAPHICS FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
}
console.log('GRAPHICS PASSED — added, visible, draggable, styled, animated, repaired.');
