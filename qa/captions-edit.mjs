/**
 * The caption editor (Shift+C), caption animations and per-word styles, through the front door.
 *   node qa/captions-edit.mjs
 */
import { launch, FIX } from './harness.mjs';

const T = await launch({ name: 'capedit' });
const { win, ev, frame, step, fresh, importFiles, sleep, finish } = T;

const grab = () => ev(() => {
  const c = window.gc.comp.canvas;
  const s = document.createElement('canvas'); s.width = 96; s.height = 54;
  s.getContext('2d').drawImage(c, 0, 0, 96, 54);
  return Array.from(s.getContext('2d').getImageData(0, 0, 96, 54).data);
});
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4) / 3; };
const redness = (a) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] > 170 && a[i + 1] < 90 && a[i + 2] < 90) n++; return n; };
const renderAt = async (t) => {
  await ev((t) => { window.gc.playback.pause(); window.gc.playback.seek(t); }, t);
  for (let i = 0; i < 20; i++) { await sleep(120); if (await ev((t) => window.gc.comp.render(t, false), t)) break; }
  await sleep(60);
  return grab();
};
const caps = () => ev(() => window.gc.store.doc.tracks.find(t => t.name === 'Captions')?.clips.map(c => ({
  id: c.id, s: +c.start.toFixed(3), d: +c.duration.toFixed(3), t: c.text.text, w: c.text.words?.length, ws: c.text.wordStyle || null, a: c.text.wordAnim || 'none',
})) || []);
const undos = () => ev(() => window.gc.history.undoStack.length);
const SRT = '1\n00:00:00,300 --> 00:00:02,000\nthat was insane bro\n\n2\n00:00:02,200 --> 00:00:04,400\nno way he hit that shot\n';
const openEditor = async () => {
  await win.mouse.move(4, 400); await ev(() => document.activeElement?.blur?.());
  if (await ev(() => document.getElementById('captionEditor')?.hidden !== false)) await win.keyboard.press('Shift+C');
  await frame();
};

console.log('\n── caption editor ─────');

await step('Shift+C opens the caption editor with every line; Space still plays while it is open', async () => {
  await fresh(); await importFiles([FIX('test-clip.mp4')]);
  await ev((s) => window.gc.captionFiles.importText(s, { name: 't.srt', look: 'pop' }), SRT);
  await openEditor();
  const rows = await ev(() => document.querySelectorAll('#captionEditor .cape__row').length);
  if (rows !== 2) throw new Error('rows: ' + rows);
  await win.mouse.move(400, 300); await ev(() => document.activeElement?.blur?.());
  await win.keyboard.press('Space'); await sleep(300);
  const playing = await ev(() => window.gc.store.rt.playing);
  await ev(() => window.gc.playback.pause());
  if (!playing) throw new Error('Space did not play with the editor open');
});

await step('Click a word → red: the word turns red on the picture, one undo step', async () => {
  const before = await renderAt(1.0);
  const u0 = await undos();
  await win.click('#captionEditor [data-word$=":2"]');          // "insane"
  await win.click('#captionEditor [data-wcolor="#ef4444"]');
  const c = (await caps())[0];
  if (c.ws?.[2]?.color !== '#ef4444') throw new Error('word style not saved: ' + JSON.stringify(c.ws));
  if ((await undos()) - u0 !== 1) throw new Error('not one undo step');
  const after = await renderAt(1.0);
  if (!(redness(after) > redness(before) + 3)) throw new Error(`no red on the picture: ${redness(before)} → ${redness(after)}`);
});

await step('Emoji, size and shake on a word change the picture; Clear puts it back', async () => {
  const plain = await renderAt(1.0);
  await win.click('#captionEditor [data-wemoji="🔥"]');
  await win.click('#captionEditor [data-wscale="1.7"]');
  await win.click('#captionEditor [data-wshake]');
  const c = (await caps())[0];
  const st = c.ws?.[2];
  if (!st || st.emoji !== '🔥' || st.scale !== 1.7 || !st.shake || st.color !== '#ef4444') throw new Error(JSON.stringify(st));
  const styled = await renderAt(1.0);
  if (!(diff(plain, styled) > 0.8)) throw new Error('the emoji and size did not show');
  await win.click('#captionEditor [data-wclear]');
  if ((await caps())[0].ws) throw new Error('Clear left a style behind');
});

await step('Split a line at a word, then join it back: words and timings survive', async () => {
  await win.click('#captionEditor [data-word$=":2"]');   // first row's 3rd word… use the second row instead:
  const second = (await caps())[1].id;
  await win.click(`#captionEditor [data-word="${second}:3"]`);   // "hit"
  await win.click('#captionEditor [data-split]');
  let c = await caps();
  if (c.length !== 3 || c[1].t !== 'no way he' || c[2].t !== 'hit that shot' || c[2].w !== 3) throw new Error(JSON.stringify(c));
  if (!(c[2].s > c[1].s && Math.abs(c[1].s + c[1].d - c[2].s) < 0.002)) throw new Error('split times do not meet: ' + JSON.stringify(c));
  await win.click(`#captionEditor [data-merge="${c[1].id}"]`);
  c = await caps();
  if (c.length !== 2 || c[1].t !== 'no way he hit that shot' || c[1].w !== 6) throw new Error(JSON.stringify(c));
});

await step('✎ fixes the typing; a same-length fix keeps the word timings', async () => {
  const id = (await caps())[0].id;
  const w0 = await ev((id) => JSON.stringify(window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).text.words), id);
  await win.click(`#captionEditor [data-editbtn="${id}"]`);
  await win.fill('#captionEditor .cape__edit', 'that was INSANE bro');
  await win.keyboard.press('Enter'); await frame();
  const c = (await caps())[0];
  const w1 = await ev((id) => JSON.stringify(window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).text.words), id);
  if (c.t !== 'that was INSANE bro' || w0 !== w1) throw new Error('fix: ' + c.t + ' / timings changed: ' + (w0 !== w1));
});

await step('Find and replace changes every caption in one go', async () => {
  await win.fill('#capeFind', 'bro');
  await win.fill('#capeRepl', 'man');
  await win.click('#capeReplace'); await frame();
  const c = await caps();
  if (c[0].t !== 'that was INSANE man') throw new Error(c[0].t);
});

await step('Caption animations: Bounce hides words not said yet; Karaoke fills as they are said', async () => {
  const early = 0.35;      // only the first word of line 1 has started
  const shown = await renderAt(early);
  await win.click('#captionEditor [data-anim="bounce"]');
  if ((await caps()).some(c => c.a !== 'bounce')) throw new Error('not every caption got the animation');
  const bounced = await renderAt(early + 0.5);
  const hidden = await renderAt(early);
  if (!(diff(shown, hidden) > 0.5)) throw new Error('Bounce did not hide the words not said yet');
  void bounced;
  await win.click('#captionEditor [data-anim="karaoke"]');
  const k1 = await renderAt(0.9), k2 = await renderAt(1.7);
  if (!(diff(k1, k2) > 0.3)) throw new Error('Karaoke looks the same mid-line and at the end');
  await win.click('#captionEditor [data-anim="none"]');
});

await step('A look tile restyles every caption but keeps the words, timings and word styles', async () => {
  await win.click('#captionEditor [data-word$=":2"]');
  await win.click('#captionEditor [data-wcolor="#22c55e"]');
  const before = await caps();
  await win.click('#captionEditor [data-look="neon"]');
  const after = await caps();
  const look = await ev(() => window.gc.store.doc.tracks.find(t => t.name === 'Captions').clips[0].text.glowColor);
  if (look !== '#38bdf8') throw new Error('the Neon look did not land');
  if (after.map(c => c.t + c.w).join() !== before.map(c => c.t + c.w).join()) throw new Error('words changed');
  if (after[0].ws?.[2]?.color !== '#22c55e') throw new Error('word style lost');
});

await step('Copy look from a caption does not carry its words or word styles to another', async () => {
  const [a, b] = await caps();
  await ev(({ a, b }) => { window.gc.cmds.copyLook(a); window.gc.cmds.pasteLook([b]); }, { a: a.id, b: b.id });
  const c = await caps();
  if (c[1].t !== b.t || c[1].w !== b.w || JSON.stringify(c[1].ws) !== JSON.stringify(b.ws)) throw new Error(JSON.stringify(c[1]));
});

await step('Esc closes the editor; the inspector of a caption offers to open it', async () => {
  await win.click('#captionEditor .cape__head b');
  const focus = await ev(() => { const a = document.activeElement; return a ? `${a.tagName}#${a.id}.${a.className}` : 'none'; });
  // The first Esc closes a word's style box if one is open; the next closes the panel.
  if (await ev(() => !!document.querySelector('#captionEditor .cape__pop'))) {
    await win.keyboard.press('Escape'); await frame();
    if (await ev(() => !!document.querySelector('#captionEditor .cape__pop'))) throw new Error('Esc did not close the word box');
  }
  await win.keyboard.press('Escape'); await frame();
  if (await ev(() => !document.getElementById('captionEditor').hidden)) throw new Error('Esc did not close it (focus was on ' + focus + ')');
  const id = (await caps())[0].id;
  await ev((id) => window.gc.store.select([id]), id); await sleep(250);
  await ev(() => document.querySelector('#inspectorRoot [data-itab="text"]')?.click()); await frame();
  const btn = await ev(() => !!document.getElementById('btnEditCaptions'));
  if (!btn) throw new Error('no "Edit all captions" button on a caption');
  await ev(() => document.getElementById('btnEditCaptions').click()); await frame();
  if (await ev(() => document.getElementById('captionEditor').hidden)) throw new Error('the button did not open the editor');
});

await finish('CAPTION-EDITOR');
