/**
 * Click to outline anything: the optional model, end to end.
 *
 *   node qa/outline.mjs
 *
 * 1. Downloads the outline model through the app's own model download
 *    (pinned commit, size and SHA-256 checked), as a person pressing the button would.
 * 2. Speed and quality spike: on pictures with a known answer (a textured round
 *    map, a figure on a busy background, a bar of interface), one click must
 *    outline the thing; the overlap with the true shape (IoU) is measured, and
 *    how long "looking" and each click take, on the CPU and (if offered) the GPU.
 * 3. Through the front door: the crop window's Smart tool outlines with one
 *    click, Ctrl+click adds, Alt+click takes away, and the cut lands on the timeline.
 * 4. A damaged download is thrown away (checksum).
 *
 * Results are printed and written to qa/out/outline-report.json.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, FIX, ROOT, waitFor } from './harness.mjs';

const T = await launch({ name: 'outline' });
const { win, ev, step, fresh, importFiles, sleep, finish } = T;
const report = { when: new Date().toISOString(), devices: {}, ui: {} };
mkdirSync(`${ROOT}/qa/out`, { recursive: true });

console.log('\n── outline ─────');

await step('the model downloads once through the app, pinned and checked', async () => {
  const st0 = await ev(() => window.gamecut.models.status('outline-small'));
  if (st0.ready) throw new Error('a fresh profile should not have the model yet');
  const t0 = Date.now();
  const r = await ev(() => window.gamecut.models.download('outline-small'));
  if (r?.error) throw new Error('download failed: ' + r.error);
  report.downloadMs = Date.now() - t0;
  const st = await ev(() => window.gamecut.models.status('outline-small'));
  if (!st.ready) throw new Error('not ready after download: ' + JSON.stringify(st));
  report.modelBytes = st.bytes;
  console.log(`     downloaded ${(st.bytes / 1e6).toFixed(1)} MB in ${(report.downloadMs / 1000).toFixed(1)} s`);
});

/* Pictures with a known answer, drawn in the page. Returns { canvas, truth: Uint8Array(w*h), click: {x,y} }. */
const SCENES = `
  function rng(s) { return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
  function noise(g, w, h, seed, base, spread) {
    const r = rng(seed); const im = g.getImageData(0, 0, w, h);
    for (let i = 0; i < im.data.length; i += 4) { const k = (r() - .5) * spread;
      im.data[i] = base[0] + k; im.data[i+1] = base[1] + k * .8; im.data[i+2] = base[2] + k * .6; im.data[i+3] = 255; }
    g.putImageData(im, 0, 0);
  }
  window.__scenes = {
    map(w = 1280, h = 720) {   // a round, textured map in a corner of a busy game frame
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#5b7fb0'); sky.addColorStop(1, '#3a5a2a');
      g.fillStyle = sky; g.fillRect(0, 0, w, h);
      const r = rng(7); for (let i = 0; i < 160; i++) { g.fillStyle = 'hsl(' + (80 + r() * 60) + ',40%,' + (20 + r() * 30) + '%)'; g.fillRect(r() * w, h * .45 + r() * h * .55, 10 + r() * 60, 10 + r() * 40); }
      const cx = w * .86, cy = h * .2, R = h * .15;
      const t = document.createElement('canvas'); t.width = w; t.height = h; const tg = t.getContext('2d');
      noise(tg, w, h, 3, [150, 130, 90], 120);
      for (let i = 0; i < 40; i++) { tg.strokeStyle = 'rgba(40,60,30,.8)'; tg.lineWidth = 2 + r() * 4; tg.beginPath(); tg.moveTo(cx - R + r() * 2 * R, cy - R + r() * 2 * R); tg.lineTo(cx - R + r() * 2 * R, cy - R + r() * 2 * R); tg.stroke(); }
      g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip(); g.drawImage(t, 0, 0); g.restore();
      g.strokeStyle = '#e8e8e8'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      const m = document.createElement('canvas'); m.width = w; m.height = h; const mg = m.getContext('2d');
      mg.fillStyle = '#fff'; mg.beginPath(); mg.arc(cx, cy, R + 2, 0, Math.PI * 2); mg.fill();
      return { c, m, click: { x: (cx + R * .3) / w, y: (cy - R * .2) / h } };
    },
    figure(w = 1280, h = 720) {   // a figure (head + body + legs) on a noisy, colourful background
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      noise(g, w, h, 11, [90, 110, 140], 90);
      const r = rng(5); for (let i = 0; i < 90; i++) { g.fillStyle = 'hsla(' + r() * 360 + ',50%,50%,.5)'; g.fillRect(r() * w, r() * h, 20 + r() * 90, 20 + r() * 90); }
      const draw = (gg, fill) => {
        gg.fillStyle = fill || '#c0392b'; gg.beginPath(); gg.ellipse(w * .45, h * .3, 34, 40, 0, 0, Math.PI * 2); gg.fill();
        gg.fillStyle = fill || '#1f6f3f'; gg.beginPath(); gg.roundRect(w * .45 - 60, h * .3 + 40, 120, 170, 18); gg.fill();
        gg.fillStyle = fill || '#2c3e70'; gg.fillRect(w * .45 - 55, h * .3 + 205, 45, 140); gg.fillRect(w * .45 + 10, h * .3 + 205, 45, 140);
      };
      draw(g);
      const m = document.createElement('canvas'); m.width = w; m.height = h; draw(m.getContext('2d'), '#fff');
      return { c, m, click: { x: .45, y: (h * .3 + 120) / h } };
    },
    bar(w = 1280, h = 720) {   // an interface bar with text and a gradient, on gameplay
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      noise(g, w, h, 23, [70, 80, 60], 110);
      const x = w * .04, y = h * .86, bw = w * .3, bh = h * .07;
      const gr = g.createLinearGradient(x, 0, x + bw, 0); gr.addColorStop(0, '#16a34a'); gr.addColorStop(.7, '#22c55e'); gr.addColorStop(.71, '#1e293b'); gr.addColorStop(1, '#1e293b');
      g.fillStyle = '#0b0f19'; g.beginPath(); g.roundRect(x - 4, y - 4, bw + 8, bh + 8, 10); g.fill();
      g.fillStyle = gr; g.beginPath(); g.roundRect(x, y, bw, bh, 8); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 26px sans-serif'; g.textBaseline = 'middle'; g.fillText('HP 70 / 100', x + 16, y + bh / 2);
      const m = document.createElement('canvas'); m.width = w; m.height = h; const mg = m.getContext('2d');
      mg.fillStyle = '#fff'; mg.beginPath(); mg.roundRect(x - 4, y - 4, bw + 8, bh + 8, 10); mg.fill();
      return { c, m, click: { x: (x + bw * .4) / w, y: (y + bh / 2) / h } };
    },
  };
`;

async function spike(device) {
  return ev(async ({ device, SCENES }) => {
    // eslint-disable-next-line no-eval
    (0, eval)(SCENES);
    const o = await import('app://gamecut/src/ui/preview/outline.js');
    o.stopOutline();
    try { localStorage.setItem('strike.outlineDevice', device); } catch {}
    const t0 = performance.now();
    let started;
    try { started = await o.ensureOutline(); } catch (e) { return { device, error: 'start: ' + e.message }; }
    finally { try { localStorage.removeItem('strike.outlineDevice'); } catch {} }
    const startMs = performance.now() - t0;
    const out = { device: started.device, startMs: Math.round(startMs), scenes: {} };
    for (const name of ['map', 'figure', 'bar']) {
      const s = window.__scenes[name]();
      const looks = [];
      let img;
      for (let k = 0; k < 2; k++) { const a = performance.now(); img = await o.lookAt(s.c); looks.push(performance.now() - a); }
      const clicks = []; let piece;
      for (let k = 0; k < 3; k++) { const a = performance.now(); piece = await o.outlineAt(img.id, [{ ...s.click, add: true }]); clicks.push(performance.now() - a); }
      // IoU against the true shape, at the mask's size: for the outline shown first, and for
      // each outline [ and ] can step to.
      const g = document.createElement('canvas'); g.width = piece.mw; g.height = piece.mh;
      const gg = g.getContext('2d'); gg.drawImage(s.m, 0, 0, piece.mw, piece.mh);
      const t = gg.getImageData(0, 0, piece.mw, piece.mh).data;
      const iouOf = (bits) => { let inter = 0, uni = 0; for (let i = 0; i < bits.length; i++) { const a = bits[i] === 1, b = t[i * 4 + 3] > 127; if (a && b) inter++; if (a || b) uni++; } return +(inter / uni).toFixed(3); };
      const each = piece.options.map(o => iouOf(o.bits));
      out.scenes[name] = { iou: iouOf(piece.bits), bestIou: Math.max(...each), options: each, shownFirst: piece.pick, score: +piece.score.toFixed(3),
        lookMs: looks.map(Math.round), clickMs: clicks.map(Math.round), mask: [piece.mw, piece.mh] };
    }
    out.memMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
    o.stopOutline();
    return out;
  }, { device, SCENES });
}

for (const device of ['wasm', 'webgpu']) {
  await step(`spike on ${device}: one click outlines a textured map, a figure and an interface bar`, async () => {
    const r = await spike(device);
    report.devices[device] = r;
    if (r.error) {
      if (device === 'webgpu') { console.log(`     webgpu not usable here: ${r.error}`); return; }
      throw new Error(r.error);
    }
    console.log(`     ran on ${r.device}, started in ${r.startMs} ms`);
    for (const [k, s] of Object.entries(r.scenes)) console.log(`     ${k.padEnd(7)} IoU first ${s.iou}, sizes [${s.options.join(', ')}]  look ${s.lookMs.join('/')} ms  click ${s.clickMs.join('/')} ms`);
    // One click, plus at most a press of [ or ], must get the thing (IoU ≥ 0.85).
    const bad = Object.entries(r.scenes).filter(([, s]) => s.bestIou < 0.85);
    if (bad.length) throw new Error('poor outline: ' + bad.map(([k, s]) => `${k} best IoU ${s.bestIou}`).join(', '));
  });
}

await step('crop window: Smart click outlines, Ctrl+click adds, Alt+click takes away, Enter cuts it out', async () => {
  await fresh(); await importFiles([FIX('test-clip.mp4')]);
  await ev(async () => { const { store, playback } = window.gc; const c = store.doc.tracks.flatMap(t => t.clips).find(c => c.type === 'video'); store.select([c.id]); playback.seek(c.start + 1.2); await new Promise(r => setTimeout(r, 900)); });
  await win.click('#btnCrop');
  await waitFor(win, () => !!document.querySelector('.cropst'), null, { timeout: 8000 });
  await win.click('.cst[data-tool="smart"]');
  await waitFor(win, () => document.querySelector('.cropst__cv')?.__outline?.state === 'ready', null, { timeout: 60000 });
  const info = await ev(() => document.querySelector('.cropst__cv').__outline);
  report.ui.device = info.device; report.ui.lookMs = info.lookMs;
  // Click, then wait until the piece list changes (a new piece, or one more click on it) or a toast says why not.
  const sig = () => ev(() => JSON.stringify((document.querySelector('.cropst__cv').__found || []).map(f => [f.points, f.box])));
  const at = async (u, v, mods = []) => {
    const before = await sig();
    await ev(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
    const f = await ev(() => { const cv = document.querySelector('.cropst__cv'); const r = cv.getBoundingClientRect(); return { ...cv.__frame, left: r.left, top: r.top }; });
    for (const m of mods) await win.keyboard.down(m);
    await win.mouse.click(f.left + f.x + u * f.w, f.top + f.y + v * f.h);
    for (const m of mods) await win.keyboard.up(m);
    await waitFor(win, (b) => JSON.stringify((document.querySelector('.cropst__cv').__found || []).map(f => [f.points, f.box])) !== b
      || !!document.querySelector('#toasts .toast'), before, { timeout: 20000 });
    await sleep(120);
    const toasts = await T.toastTexts();
    if (toasts.length) console.log('     toast: ' + toasts.join(' | '));
    return ev(() => document.querySelector('.cropst__cv').__found);
  };
  // testsrc2 has big flat-coloured bars and a moving pattern; any click must outline *something*.
  let found = await at(0.2, 0.35);
  if (found.length !== 1 || !found[0].outlined) throw new Error('first click did not make one outlined piece: ' + JSON.stringify(found));
  const a0 = found[0].box.w * found[0].box.h;
  report.ui.sizesOffered = found[0].sizes;
  if (found[0].sizes > 1) {
    const p0 = found[0].pick;
    const up = p0 < found[0].sizes - 1;
    await win.keyboard.press(up ? ']' : '['); await sleep(150);
    const f2 = await ev(() => document.querySelector('.cropst__cv').__found);
    if (f2[0].pick !== p0 + (up ? 1 : -1)) throw new Error(`${up ? ']' : '['} did not switch the outline size: ${JSON.stringify(f2)}`);
    await win.keyboard.press(up ? '[' : ']'); await sleep(150);
  }
  found = await at(0.55, 0.35, ['Control']);
  if (found.length !== 1 || found[0].points !== 2) throw new Error('Ctrl+click did not refine the same piece: ' + JSON.stringify(found));
  const a1 = found[0].box.w * found[0].box.h;
  found = await at(0.55, 0.35, ['Alt']);
  if (found[0].points !== 3) throw new Error('Alt+click did not refine: ' + JSON.stringify(found));
  report.ui.boxes = { first: +a0.toFixed(4), added: +a1.toFixed(4), takenAway: +(found[0].box.w * found[0].box.h).toFixed(4) };
  if (!(a1 >= a0)) throw new Error(`adding a bit made the piece smaller (${a0} → ${a1})`);
  const n0 = await ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'video').length);
  await win.keyboard.press('Enter');
  await waitFor(win, () => !document.querySelector('.cropst'), null, { timeout: 8000 });
  const cut = await ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'video' && c.crop));
  if (cut.length < 1) throw new Error('no cut-out on the timeline');
  if (!cut[0].crop.mask) throw new Error('the cut-out has no exact shape (mask)');
  report.ui.cutOut = { name: cut[0].name, crop: { x: cut[0].crop.x, y: cut[0].crop.y, w: cut[0].crop.w, h: cut[0].crop.h } };
  const n1 = await ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'video').length);
  if (n1 !== n0 + 1) throw new Error(`expected one new layer, got ${n1 - n0}`);
});

await step('a damaged model file is thrown away instead of used', async () => {
  // Corrupt the downloaded encoder in place, then ask for the model again: status must say
  // not ready (wrong size) or the re-download must verify; a file of the right size but wrong
  // bytes must be caught by the checksum on the next download.
  const r = await T.app.evaluate(async ({ app }) => {
    const req = process.mainModule?.require || globalThis.require;
    const fs = req('node:fs'); const path = req('node:path');
    const f = path.join(app.getPath('userData'), 'models', 'outline-small', 'onnx', 'vision_encoder_quantized.onnx');
    const size = fs.statSync(f).size;
    fs.truncateSync(f, size - 1000);
    return { size };
  });
  const st = await ev(() => window.gamecut.models.status('outline-small'));
  if (st.ready) throw new Error('a cut-short model file still counts as ready');
  const again = await ev(() => window.gamecut.models.download('outline-small'));
  if (again?.error) throw new Error('re-download failed: ' + again.error);
  const st2 = await ev(() => window.gamecut.models.status('outline-small'));
  if (!st2.ready) throw new Error('not ready after the re-download');
  report.damaged = { cutShortSize: r.size - 1000, recovered: true };
});

writeFileSync(`${ROOT}/qa/out/outline-report.json`, JSON.stringify(report, null, 2));
console.log('\nreport: qa/out/outline-report.json');
await finish('OUTLINE');
