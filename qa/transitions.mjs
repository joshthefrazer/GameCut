/**
 * Every transition, in the app: it starts as the first shot, ends as the second,
 * really changes in between, is the same every time, is the same in the export,
 * and is cheap enough. Plus the picker. Contact sheets go to qa/out/trans-*.png.
 *   node qa/transitions.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { launch, ROOT } from './harness.mjs';

const OUT = `${ROOT}/qa/out`;
mkdirSync(OUT, { recursive: true });
const mk = (file, vf) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', vf, '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', `${OUT}/${file}`]);
mk('tr-a.mp4', 'testsrc2=size=1280x720:rate=30,hue=h=40:s=1.2');
mk('tr-b.mp4', 'mandelbrot=size=1280x720:rate=30:start_scale=1.2,eq=saturation=1.6:brightness=0.06');

const T = await launch({ name: 'trans', size: [1500, 900] });
const { win, ev, frame, step, fresh, importFiles, sleep, finish } = T;

const setup = async () => {
  await fresh(); await importFiles([`${OUT}/tr-a.mp4`, `${OUT}/tr-b.mp4`]);
  await ev(async () => {
    const { store, cmds, assets } = window.gc;
    const { makeClip } = await import('app://gamecut/src/core/schema.js');
    const lane = store.doc.tracks.filter(t => t.kind === 'video').at(-1);
    cmds.batch('set up', () => {
      store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id))); if (store.rt.selection.length) cmds.removeSelected();
      const by = (n) => assets.all().find(a => a.name.startsWith(n));
      for (const [n, s] of [['tr-a', 0], ['tr-b', 2.5]]) cmds.addClip(lane.id, makeClip('video', { name: n, assetId: by(n).id, start: s, duration: 2.5, inPoint: 0.5, sourceDuration: 4, silent: true }), { select: false });
    });
  });
  await sleep(700);
};
const bId = () => ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.name === 'tr-b').id);
const openPanel = async () => {
  await ev((id) => { window.gc.store.select([]); window.gc.store.setRT({ junction: id }); }, await bId());
  await win.click('#leftTabs [data-tab="trans"]'); await sleep(250);
  for (let i = 0; i < 40; i++) { if (await ev(() => window.gc.transitions.preview.captured.a && !document.querySelector('.trs__stage.is-loading'))) break; await sleep(150); }
  await sleep(500);
};

console.log('\n── transitions ─────');

await step('every one starts as the first shot, ends as the second, and is different in the middle', async () => {
  await setup();
  const bad = await ev(async () => {
    const { KINDS, paintTransition } = await import('app://gamecut/src/engine/transition-fx.js');
    const { demoFrames } = await import('app://gamecut/src/ui/transitions/trans-preview.js');
    const { a, b } = demoFrames();
    const W = 320, H = 180;
    const at = (tr, raw) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true }); paintTransition(g, a, b, { ...tr, raw }, W, H); return g.getImageData(0, 0, W, H).data; };
    const diff = (x, y) => { let d = 0; for (let i = 0; i < x.length; i += 4) d += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]); return d / (x.length / 4) / 3; };
    const hole = (x) => { let n = 0; for (let i = 3; i < x.length; i += 4) if (x[i] < 250) n++; return n / (x.length / 4); };
    const A = at({ kind: 'dissolve' }, 0), B = at({ kind: 'dissolve' }, 1);
    const out = [];
    for (const k of KINDS) for (const dir of k.dirs || [undefined]) {
      const tr = { kind: k.id, ...k.d, ...(dir ? { dir } : {}) };
      const s = at(tr, 0), e = at(tr, 1), s1 = at(tr, 0.012), e1 = at(tr, 0.988), m = at(tr, 0.45), m2 = at(tr, 0.45);
      const name = k.id + (dir ? ':' + dir : '');
      if (diff(s, A) > 0.5 || diff(e, B) > 0.5) out.push(name + ' does not begin/end on the two shots');
      // No pop: the first and last instants are close to the shots themselves.
      if (diff(s1, A) > 14) out.push(`${name} jumps at the start (${diff(s1, A).toFixed(1)})`);
      if (diff(e1, B) > 14) out.push(`${name} jumps at the end (${diff(e1, B).toFixed(1)})`);
      if (diff(m, A) < 4 && diff(m, B) < 4) out.push(name + ' does nothing in the middle');
      if (diff(m, m2) > 0) out.push(name + ' is not the same twice');
      for (const r of [0.1, 0.3, 0.5, 0.7, 0.9]) { const h = hole(at(tr, r)); if (h > 0.002) { out.push(`${name} leaves ${(h * 100).toFixed(1)}% of the picture empty at ${r}`); break; } }
    }
    return out;
  });
  if (bad.length) throw new Error('\n      ' + bad.join('\n      '));
});

await step('every setting changes the picture', async () => {
  const bad = await ev(async () => {
    const { KINDS, EASES, paintTransition } = await import('app://gamecut/src/engine/transition-fx.js');
    const { demoFrames } = await import('app://gamecut/src/ui/transitions/trans-preview.js');
    const { a, b } = demoFrames();
    const W = 240, H = 135;
    const at = (tr, raw) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true }); paintTransition(g, a, b, { ...tr, raw }, W, H); return g.getImageData(0, 0, W, H).data; };
    const diff = (x, y) => { let d = 0; for (let i = 0; i < x.length; i += 4) d += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]); return d / (x.length / 4) / 3; };
    const most = (t1, t2) => Math.max(...[0.25, 0.35, 0.42, 0.5, 0.58].map(r => diff(at(t1, r), at(t2, r))));
    const out = [];
    for (const k of KINDS) {
      const tr = { kind: k.id, ...k.d };
      if (k.amount && most({ ...tr, amount: 0.05 }, { ...tr, amount: 1 }) < 0.8) out.push(k.id + ': strength does nothing');
      if (k.dirs) for (const d of k.dirs.slice(1)) if (most({ ...tr, dir: k.dirs[0] }, { ...tr, dir: d }) < 0.8) out.push(`${k.id}: ${d} looks like ${k.dirs[0]}`);
      if (k.ease && most({ ...tr, ease: 'even' }, { ...tr, ease: 'snappy' }) < 0.8) out.push(k.id + ': feel does nothing');
      if (k.color && most({ ...tr, color: '#ff0000' }, { ...tr, color: '#00ff00' }) < 0.4) out.push(k.id + ': colour does nothing');
    }
    void EASES;
    return out;
  });
  if (bad.length) throw new Error('\n      ' + bad.join('\n      '));
});

await step('the picker shows all of them on your own shots; hovering plays, clicking applies, settings and undo work', async () => {
  await openPanel();
  const n = await ev(() => ({ tiles: document.querySelectorAll('#transRoot .trs').length, own: window.gc.transitions.preview.captured, demo: !!window.gc.transitions.preview.frames?.demo }));
  if (n.tiles !== 23 || !n.own.a || !n.own.b || n.demo) throw new Error(JSON.stringify(n));
  const blank = await ev(() => [...document.querySelectorAll('.trs__pic')].filter(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let mn = 255, mx = 0; for (let i = 0; i < d.length; i += 52) { mn = Math.min(mn, d[i]); mx = Math.max(mx, d[i]); } return mx - mn < 12; }).map(c => c.parentElement.dataset.pick));
  if (blank.filter(k => k !== 'dip' && k !== 'flash').length) throw new Error('blank tiles: ' + blank);
  await win.click('.trs[data-pick="whip"]'); await frame();
  const get = () => ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.name === 'tr-b').transIn);
  let tr = await get();
  if (tr?.kind !== 'whip' || tr.dir !== 'left' || !(tr.amount > 0)) throw new Error(JSON.stringify(tr));
  await win.click('#transRoot [data-dir="up"]'); await frame();
  await win.click('#transRoot [data-ease="bouncy"]'); await frame();
  tr = await get();
  if (tr.dir !== 'up' || tr.ease !== 'bouncy') throw new Error(JSON.stringify(tr));
  await ev(() => window.gc.history.undo()); await ev(() => window.gc.history.undo()); await frame();
  tr = await get();
  if (tr.dir !== 'left' || tr.ease !== 'snappy') throw new Error('undo: ' + JSON.stringify(tr));
  await win.fill('#transFind', 'glitch'); await sleep(200);
  const found = await ev(() => [...document.querySelectorAll('#transRoot .trs')].map(b => b.dataset.pick));
  if (!found.includes('glitch') || found.length > 6) throw new Error('search: ' + found);
  await win.fill('#transFind', ''); await sleep(150);
});

await step('the export paints the same picture as the preview', async () => {
  const worst = await ev(async () => {
    const { Compositor } = await import('app://gamecut/src/engine/compositor.js');
    const { store, playback, comp } = window.gc;
    const b = store.doc.tracks.flatMap(t => t.clips).find(c => c.name === 'tr-b');
    const px = (c) => { const s = document.createElement('canvas'); s.width = 64; s.height = 36; const g = s.getContext('2d'); g.drawImage(c, 0, 0, 64, 36); return g.getImageData(0, 0, 64, 36).data; };
    let worst = 0;
    for (const kind of ['whip', 'zoomin', 'glitch', 'slash']) {
      const { freshTransition } = await import('app://gamecut/src/engine/transitions.js');
      b.transIn = freshTransition(kind);
      const t = b.start + 0.03;
      playback.pause(); playback.seek(t);
      for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 60)); if (comp.render(t, false)) break; }
      const cv = document.createElement('canvas');
      const ex = new Compositor(store, cv, { fixedSize: { w: comp.canvas.width, h: comp.canvas.height } });
      for (const c of store.doc.tracks.flatMap(x => x.clips).filter(c => c.type === 'video')) { const s = comp.pool.peek(c); if (s) ex.pool.overrides.set(c.id, s); }
      ex.render(t, false);
      const p = px(comp.canvas), q = px(cv);
      let d = 0; for (let i = 0; i < p.length; i += 4) d += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
      worst = Math.max(worst, d / (p.length / 4) / 3);
      ex.dispose?.();
    }
    return worst;
  });
  if (worst > 2.5) throw new Error('differs by ' + worst.toFixed(1));
});

await step('how long each takes at 1080p (real canvas, graphics work included)', async () => {
  const r = await ev(async () => {
    const { KINDS, paintTransition } = await import('app://gamecut/src/engine/transition-fx.js');
    const { demoFrames } = await import('app://gamecut/src/ui/transitions/trans-preview.js');
    const W = 1920, H = 1080;
    const up = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(img, 0, 0, W, H); return c; };
    const a = up(demoFrames().a), b = up(demoFrames().b);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const out = [];
    const probe = document.createElement('canvas'); probe.width = probe.height = 1;
    const pg = probe.getContext('2d', { willReadFrequently: true });
    for (const k of KINDS) {
      const raws = [0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8];
      paintTransition(g, a, b, { kind: k.id, ...k.d, raw: 0.5 }, W, H); pg.drawImage(c, 0, 0, 1, 1); pg.getImageData(0, 0, 1, 1);
      let worst = 0, sum = 0;
      for (const raw of raws) { const t0 = performance.now(); paintTransition(g, a, b, { kind: k.id, ...k.d, raw }, W, H); pg.drawImage(c, 0, 0, 1, 1); pg.getImageData(0, 0, 1, 1); const ms = performance.now() - t0; worst = Math.max(worst, ms); sum += ms; }
      out.push([k.id, +(sum / raws.length).toFixed(1), +worst.toFixed(1)]);
    }
    return out.sort((x, y) => y[1] - x[1]);
  });
  console.log('     ' + r.map(([k, m, w]) => `${k} ${m}/${w}`).join('  ') + '   (average / worst ms)');
});

if (process.argv.includes('--pictures')) {
  await ev(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  const sheet = await ev(async () => {
    const { KINDS } = await import('app://gamecut/src/engine/transition-fx.js');
    const { drawMoment, demoFrames } = await import('app://gamecut/src/ui/transitions/trans-preview.js');
    const f = window.gc.transitions.preview.frames || demoFrames();
    const raws = [0.12, 0.3, 0.42, 0.5, 0.58, 0.7, 0.88], w = 176, h = 99, lab = 110;
    const make = (kinds) => {
      const c = document.createElement('canvas'); c.width = lab + raws.length * (w + 4); c.height = kinds.length * (h + 4);
      const g = c.getContext('2d'); g.fillStyle = '#0A0E19'; g.fillRect(0, 0, c.width, c.height);
      kinds.forEach((k, y) => {
        g.fillStyle = '#fff'; g.font = '700 14px Inter, sans-serif'; g.textBaseline = 'middle'; g.fillText(k.name, 10, y * (h + 4) + h / 2);
        raws.forEach((r, x) => { const p = document.createElement('canvas'); p.width = w * 2; p.height = h * 2; drawMoment(p, f, { kind: k.id, ...k.d }, r, false); g.imageSmoothingQuality = 'high'; g.drawImage(p, lab + x * (w + 4), y * (h + 4), w, h); });
      });
      return c.toDataURL('image/png').split(',')[1];
    };
    return [make(KINDS.slice(0, 12)), make(KINDS.slice(12))];
  });
  const { writeFileSync } = await import('node:fs');
  sheet.forEach((s, i) => writeFileSync(`${OUT}/trans-sheet-${i + 1}.png`, Buffer.from(s, 'base64')));
  await ev(async () => { const { freshTransition } = await import('app://gamecut/src/engine/transitions.js'); const b = window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.name === 'tr-b'); window.gc.cmds.setClipProp(b.id, 'transIn', freshTransition('whip'), { merge: false }); window.gc.store.setRT({ junction: b.id }); });
  await openPanel();
  await ev(() => window.gc.playback.seek(2.52)); await sleep(700);
  await ev(() => { document.querySelector('#transRoot').scrollTop = 0; }); await sleep(200); await win.screenshot({ path: `${OUT}/trans-panel.png` });
  await ev(() => { window.gc.store.ui.leftW = 420; document.querySelector('.app').style.setProperty('--left-w', '420px'); window.gc.bus?.emit?.('layout'); document.querySelector('.trs__bar').scrollIntoView(); }); await sleep(700); await win.screenshot({ path: `${OUT}/trans-tiles.png` });
}

await finish('TRANSITIONS');
