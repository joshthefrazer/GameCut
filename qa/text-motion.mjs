/**
 * Text: motion, saved looks and saved texts — through the real window.
 *
 * Motion is checked by looking at what is actually drawn. For every way of
 * arriving, the first frame must differ from the settled one, and the settled
 * one must be the same picture as text with no motion at all — otherwise an
 * animation that "works" would leave the words slightly wrong forever. Leaving
 * has to end up gone or moved; typing has to reveal more as time passes.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { patchClick } from './reveal.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const PROFILE = `/tmp/gc-textmotion-${process.pid}`;
const problems = [];
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('  !! ' + e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};
console.log('\n── text motion & saved text ─────────────');
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
patchClick(win);
win.on('pageerror', e => problems.push('pageerror: ' + e.message));
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.click('#homeNew'); await sleep(1000);

const textClips = () => win.evaluate(() => window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'text').map(c => ({ id: c.id, start: c.start, dur: c.duration, name: c.name, text: c.text })));

/** The picture at time t, as numbers: how much is lit, and a coarse fingerprint. */
const shot = (t) => win.evaluate(async (t) => {
  const { playback, comp } = window.gc;
  playback.seek(t); await new Promise(r => setTimeout(r, 120)); comp.render();
  const c = comp.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0; const px = new Uint8Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; px[j] = v; if (v > 60) lit++; }
  return { lit, px: Array.from(px) };
}, t);
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.px.length; i++) s += Math.abs(a.px[i] - b.px[i]); return s / a.px.length; };

// One plain text to be the reference, written the way a person would: through the panel's own model.
const setup = (patch) => win.evaluate((patch) => {
  const { store, cmds } = window.gc;
  for (const t of store.doc.tracks) t.clips = t.clips.filter(c => c.type !== 'text');
  const clip = cmds.addTextClip(0, null);
  Object.assign(clip.text, { text: 'HELLO WORLD', color: '#ffffff', weight: 900, size: 0.14, shadow: 0, glow: 0, strokeWidth: 0, bg: 'none' }, patch);
  clip.start = 0; clip.duration = 4;
  store.docChanged('test'); store.select([clip.id]);
  return clip.id;
}, patch);

let ref;
await step('plain text draws, and is the same at every moment', async () => {
  await setup({ anim: 'none' });
  const a = await shot(0.1), b = await shot(2);
  ref = b;
  if (a.lit < 500) throw new Error('nothing was drawn (' + a.lit + ' lit pixels)');
  if (diff(a, b) > 0.01) throw new Error('plain text changed over time');
});

const IN = ['fade', 'pop', 'rise', 'fall', 'drop', 'slam', 'grow', 'slideL', 'slideR', 'spin', 'flip', 'wipe', 'glitch'];
for (const unit of ['all', 'word', 'letter']) {
  for (const kind of IN) {
    await step(`${kind} (${unit}): starts different, settles exactly as still text`, async () => {
      await setup({ anim: kind, animDur: 0.5, animUnit: unit, animSpread: 0.4 });
      const first = await shot(0.02), end = await shot(0.5 + (unit === 'all' ? 0 : 0.4 * 0.5 * 2) + 0.25);
      if (diff(first, ref) < 0.05 && first.lit > ref.lit * 0.97) throw new Error('the first frame already looks finished');
      const d = diff(end, ref);
      if (d > 1.6) throw new Error(`settled picture differs from plain text by ${d.toFixed(2)}`);
    });
  }
}

for (const kind of ['fade', 'pop', 'slideL', 'drop', 'wipe', 'spin']) {
  await step(`leaving with ${kind}: the last moment is gone or moved`, async () => {
    await setup({ animOut: kind, animOutDur: 0.5 });
    const mid = await shot(1.5), last = await shot(3.99);
    if (diff(mid, ref) > 0.05) throw new Error('moved before it should');
    if (diff(last, ref) < 0.2 && last.lit > ref.lit * 0.95) throw new Error('still fully there at the very end');
  });
}

await step('typewriter reveals more as time passes, then shows the cursor', async () => {
  await setup({ anim: 'type', animDur: 1.6 });
  const a = await shot(0.3), b = await shot(0.9), c = await shot(1.5), d = await shot(2.6);
  if (!(a.lit < b.lit && b.lit < c.lit)) throw new Error(`lit pixels ${a.lit} → ${b.lit} → ${c.lit} do not grow`);
  if (diff(d, ref) > 0.5) throw new Error('the typed text does not end up as plain text');
});

await step('loops keep moving; Still does not', async () => {
  await setup({ animLoop: 'wave', animUnit: 'letter' });
  const a = await shot(1.0), b = await shot(1.4);
  if (diff(a, b) < 0.3) throw new Error('wave did not move');
  await setup({ animLoop: 'none' });
  const c = await shot(1.0), d = await shot(1.4);
  if (diff(c, d) > 0.01) throw new Error('a still text moved');
});

await step('the old text style (no new fields) still opens and draws as before', async () => {
  await setup({});
  await win.evaluate(() => { const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'text'); for (const k of ['animOut', 'animOutDur', 'animLoop', 'animUnit', 'animSpread', 'typeCursor']) delete c.text[k]; });
  const a = await shot(2);
  if (diff(a, ref) > 0.01) throw new Error('an older project draws differently');
});

await step('the panel shows the motion controls and the play button', async () => {
  await setup({ anim: 'pop' });
  await win.evaluate(() => window.gc.store.select([window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'text').id]));
  await sleep(500);
  await win.click('[data-itab="motion"]'); await sleep(300);
  const phases = await win.evaluate(() => [...document.querySelectorAll('.mtiles')].map(e => e.dataset.phase + ':' + e.querySelectorAll('.mtile').length));
  for (const want of ['in', 'out', 'loop']) if (!phases.some(p => p.startsWith(want + ':') && +p.split(':')[1] > 2)) throw new Error('missing motion tiles: ' + want + ' in ' + phases.join('|'));
  if (!(await win.$('.mtiles[data-phase="in"] .mtile.is-on[data-k="pop"]'))) throw new Error('the chosen arrival (pop) is not shown as picked');
  if (!(await win.$('#motionPlay'))) throw new Error('no play button');
  await win.click('[data-itab="text"]'); await sleep(200);
});

await step('the browser prompt really is unavailable here (why Save look never worked)', async () => {
  const r = await win.evaluate(() => { try { const v = prompt('x'); return 'returned:' + v; } catch (e) { return 'threw:' + e.message; } });
  if (!r.startsWith('threw') && r !== 'returned:null') throw new Error('prompt gave ' + r);
});

await step('Save this look: the in-app box opens, and the look is saved and listed', async () => {
  await setup({ color: '#fbbf24', anim: 'rise', animLoop: 'float' });
  await sleep(400);
  await win.evaluate(() => window.gc.store.select([window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'text').id]));
  await sleep(400);
  const before = await win.evaluate(() => document.querySelectorAll('.look').length);
  await win.click('button.fontdrop:has-text("Save this look")');
  await win.waitForSelector('.askd__in', { timeout: 3000 });
  await win.fill('.askd__in', 'Gold rise');
  await win.keyboard.press('Enter'); await sleep(500);
  const after = await win.evaluate(() => document.querySelectorAll('.look').length);
  const saved = await win.evaluate(() => JSON.parse(localStorage.getItem('gamecut.textLooks') || '[]'));
  if (!saved.some(l => l.name === 'Gold rise' && l.style.animLoop === 'float')) throw new Error('not saved: ' + JSON.stringify(saved).slice(0, 200));
  if (after !== before + 1) throw new Error(`the gallery went from ${before} to ${after}`);
  if (await win.$('.askd')) throw new Error('the box stayed open');
});

await step('typing in the box does not trigger editor shortcuts, and Escape cancels', async () => {
  await win.click('button.fontdrop:has-text("Save this look")');
  await win.waitForSelector('.askd__in');
  const n0 = await win.evaluate(() => window.gc.store.doc.tracks.reduce((a, t) => a + t.clips.length, 0));
  await win.keyboard.type('s c m b delete', { delay: 20 });
  await win.keyboard.press('Escape'); await sleep(200);
  const n1 = await win.evaluate(() => window.gc.store.doc.tracks.reduce((a, t) => a + t.clips.length, 0));
  if (await win.$('.askd')) throw new Error('Escape did not close it');
  if (n0 !== n1) throw new Error('typing in the box changed the timeline');
  const saved = await win.evaluate(() => JSON.parse(localStorage.getItem('gamecut.textLooks') || '[]'));
  if (saved.length !== 1) throw new Error('Escape saved something: ' + saved.length);
});

await step('Save these words & look, then add them from the Text drawer in one undoable step', async () => {
  await win.evaluate(() => { const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'text'); c.text.text = 'FOLLOW FOR MORE'; });
  await win.evaluate(() => window.gc.store.select([window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'text').id]));
  await sleep(300);
  await win.click('button.fontdrop:has-text("Save these words")');
  await win.waitForSelector('.askd__in');
  await win.fill('.askd__in', 'Follow CTA');
  await win.keyboard.press('Enter'); await sleep(400);
  await win.click('#tabText'); await sleep(400);
  const tile = await win.$('.gfx__text .look[title*="FOLLOW FOR MORE"]');
  if (!tile) throw new Error('the saved text is not in the Text drawer');
  const before = (await textClips()).length;
  await win.evaluate(() => { window.gc.store.rt.playhead = 0; });
  await tile.click(); await sleep(400);
  const after = await textClips();
  if (after.length !== before + 1) throw new Error('no clip was added');
  const made = after.find(c => c.text.text === 'FOLLOW FOR MORE' && c.name === 'Follow CTA');
  if (!made || made.text.animLoop !== 'float' || made.text.color !== '#fbbf24') throw new Error('look was not carried: ' + JSON.stringify(made?.text).slice(0, 160));
  await win.evaluate(() => window.gc.history.undo()); await sleep(200);
  if ((await textClips()).length !== before) throw new Error('one undo did not remove it');
});

await step('a built-in look added from the Text drawer arrives with its motion and a long enough clip', async () => {
  await win.click('#tabText'); await sleep(200);
  await win.click('.gfx__text .look[data-text-id="terminal"]'); await sleep(400);
  const t = (await textClips()).find(c => c.name === 'Terminal');
  if (!t || t.text.anim !== 'type') throw new Error('terminal look missing: ' + JSON.stringify(t));
  if (t.dur < 3) throw new Error('clip too short for its own animation: ' + t.dur);
});

await app.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall good');
process.exit(problems.length ? 1 : 0);
