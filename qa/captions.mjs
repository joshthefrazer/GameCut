/**
 * Auto-captions, through the front door.
 *
 * A clip with a real voice in it (made with a speech synthesiser, saying a
 * known sentence one second in), the speech model "downloaded" from a local
 * stand-in for the model host, and the words checked against what was said.
 *
 *   xvfb-run -a node qa/captions.mjs
 * Needs the model files under MODEL_SRC (see below) — the test serves them.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch, FIX } from './harness.mjs';

const MODEL_SRC = process.env.GC_MODEL_SRC || '/tmp/claude-0/scratch/models-src';
let served = 0;
const server = http.createServer((req, res) => {
  const p = path.join(MODEL_SRC, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(MODEL_SRC) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  // Answer the way the real host does: a redirect to where the file lives.
  if (!req.url.includes('?real')) { res.writeHead(302, { Location: req.url + '?real' }); res.end(); return; }
  served++;
  res.writeHead(200, { 'Content-Length': fs.statSync(p).size });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${server.address().port}`;

const T = await launch({ name: 'captions', env: { GAMECUT_MODEL_HOST: HOST } });
const { win, ev, step, fresh, importFiles, sleep } = T;

const capClips = () => ev(() => {
  const t = window.gc.store.doc.tracks.find(t => t.name === 'Captions');
  return t ? t.clips.map(c => ({ id: c.id, start: c.start, duration: c.duration, text: c.text.text, words: c.text.words, y: c.transform.y })).sort((a, b) => a.start - b.start) : null;
});
const waitDone = async (ms) => {
  for (let i = 0; i < ms / 500; i++) {
    await sleep(500);
    const r = await ev(() => ({ open: !document.getElementById('captions').hidden, status: document.getElementById('capStatus')?.textContent || '' }));
    if (!r.open) return r;
    if (/failed|No speech|Stopped/.test(r.status)) return r;
  }
  return { open: true, status: 'timed out: ' + await ev(() => document.getElementById('capStatus')?.textContent) };
};
const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

console.log('\n── auto-captions ─────');

await step('Auto-captions opens from the Text drawer and says the model is downloaded once', async () => {
  await fresh(); await importFiles([FIX('talk-clip.mp4')]);
  await ev(() => { const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video'); window.gc.store.select([]); return c; });
  await win.click('#tabText'); await sleep(250);
  await win.click('#btnCaptions'); await sleep(400);
  const r = await ev(() => ({ open: !document.getElementById('captions').hidden, btn: document.getElementById('btnCapGo')?.textContent, note: document.querySelector('.capd__note')?.textContent }));
  if (!r.open) throw new Error('the captions box did not open');
  if (!/Download/.test(r.btn)) throw new Error(`the button says "${r.btn}" before anything was downloaded`);
  if (!/80 MB/.test(r.note)) throw new Error('it does not say how big the download is: ' + r.note);
});

await step('Download & make captions: fetches the model, listens, and writes what was said, on time', async () => {
  await win.click('#btnCapGo');
  const r = await waitDone(240000);
  if (r.open) throw new Error('it did not finish: ' + r.status);
  const cs = await capClips();
  if (!cs?.length) throw new Error('no Captions lane');
  const all = norm(cs.map(c => c.text).join(' '));
  console.log(`     heard: "${all}"`);
  for (const want of ['welcome back to the channel', 'win this match', 'enemy behind the wall', 'triple kill']) {
    if (!all.includes(want)) throw new Error(`"${want}" is not in the captions`);
  }
  if (Math.abs(cs[0].start - 1.0) > 0.45) throw new Error(`the first caption starts at ${cs[0].start.toFixed(2)}s; the voice starts at 1.0s`);
  if (cs.length < 6) throw new Error(`only ${cs.length} lines — they should be short`);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c.text.split(' ').length > 5) throw new Error(`a caption is too long to read: "${c.text}"`);
    if (!Array.isArray(c.words) || c.words.length !== c.text.split(' ').length) throw new Error(`"${c.text}" does not have a time for each word`);
    if (cs[i + 1] && c.start + c.duration > cs[i + 1].start + 1e-6) throw new Error(`"${c.text}" overlaps the next line`);
    if (c.words.some(w => w.s < -0.01 || w.e > c.duration + 0.5)) throw new Error(`"${c.text}" has word times outside its clip`);
  }
  if (served < 7) throw new Error(`only ${served} model files were fetched`);
});

await step('the word being said lights up, the others stay white', async () => {
  const cs = await capClips();
  const c = cs.find(x => x.words.length >= 3);
  const yellow = (t) => ev(async (t) => {
    const { playback, comp } = window.gc;
    playback.seek(t); await new Promise(r => setTimeout(r, 150)); comp.render();
    const cv = comp.canvas, d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 160 && d[i + 2] < 90) n++;
    return n;
  }, t);
  // Mute the footage so its test pattern's yellow does not count.
  await ev(() => { for (const t of window.gc.store.doc.tracks) for (const x of t.clips) if (x.type === 'video') x.transform.opacity = 0; window.gc.store.docChanged('test'); });
  const w1 = c.words[1];
  const during = await yellow(c.start + (w1.s + w1.e) / 2);
  const before = await yellow(Math.max(0, c.start - 0.3));
  console.log(`     yellow pixels while word 2 is said: ${during}, before the line: ${before}`);
  if (during < 150) throw new Error('nothing lit up while the word was said');
  if (before > 20) throw new Error('something was yellow before the line');
});

await step('the model is kept: the next run does not download again, and replaces only the chosen stretch', async () => {
  const n0 = served;
  const before = await capClips();
  await ev(() => { const c = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video'); window.gc.store.select([c.id]); });
  await win.click('#btnCaptions'); await sleep(400);
  const btn = await ev(() => document.getElementById('btnCapGo').textContent);
  if (/Download/.test(btn)) throw new Error('it offers to download again');
  await win.click('.capd__look[data-look="clean"]');
  await win.click('#btnCapGo');
  const r = await waitDone(240000);
  if (r.open) throw new Error('second run did not finish: ' + r.status);
  if (served !== n0) throw new Error('the model was fetched again');
  const after = await capClips();
  const lanes = await ev(() => window.gc.store.doc.tracks.filter(t => t.name.startsWith('Captions')).length);
  if (lanes !== 1) throw new Error(`${lanes} caption lanes — the second run should reuse the first`);
  if (Math.abs(after.length - before.length) > 2) throw new Error(`${before.length} captions became ${after.length}`);
  const plate = await ev(() => window.gc.store.doc.tracks.find(t => t.name === 'Captions').clips[0].text.bg);
  if (plate !== 'box') throw new Error('the Clean look was not used');
});

await step('one Ctrl+Z takes the whole run back', async () => {
  const before = await capClips();
  await ev(() => window.gc.history.undo()); await sleep(200);
  const after = await capClips();
  const bg = await ev(() => window.gc.store.doc.tracks.find(t => t.name === 'Captions')?.clips[0]?.text.bg);
  if (!after || after.length === 0) throw new Error('undo removed the first run too');
  if (bg === 'box') throw new Error('undo did not bring back the first look');
  void before;
});

await step('music and SFX lanes are left out of what it listens to', async () => {
  const r = await ev(async () => {
    const { speechStore } = await import('app://gamecut/src/captions/captions.js');
    const s = speechStore(window.gc.store);
    return s.doc.tracks.map(t => `${t.name}:${t.muted ? 'm' : '-'}`).join(',');
  });
  if (!/Music:m/.test(r) || !/SFX:m/.test(r)) throw new Error('not muted: ' + r);
  if (/Video 1:m/.test(r)) throw new Error('the footage was muted: ' + r);
});

server.close();
await T.finish('CAPTIONS');
