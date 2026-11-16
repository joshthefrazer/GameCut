/**
 * Version history, brand kit, auto-vertical and stabilize, through the front door.
 *   xvfb-run -a node qa/features2.mjs
 */
import { execFileSync } from 'node:child_process';
import { launch, FIX, ROOT } from './harness.mjs';

const OUT = `${ROOT}/qa/out`;
const T = await launch({ name: 'features2' });
const { win, ev, frame, step, fresh, importFiles, byStart, sleep } = T;
const CLIP = FIX('test-clip.mp4');

// A white square crossing a dark 16:9 frame from left to right over 4 s.
const MOVER = `${OUT}/mover.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x101418:size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'color=c=white:size=120x120:rate=30',
  '-filter_complex', "[0][1]overlay=x='40+t*270':y=300:shortest=1", '-t', '4',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', MOVER]);
// A detailed picture shaken left and right: x offset 24 + 14·sin(9t).
const SHAKY = `${OUT}/shaky.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1400x800:rate=30',
  '-vf', "crop=1280:720:'24+14*sin(9*t)':40", '-t', '3',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', SHAKY]);
const LOGO = FIX('test-logo.png');

const clipNow = (id) => ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id), id);

console.log('\n── features 2 ─────');

await step('Version history: go back to an earlier version, and Ctrl+Z comes forward again', async () => {
  await fresh(); await importFiles([CLIP]);
  await ev(() => window.gc.library.takeVersion('test', true));
  await ev(() => { const g = window.gc; g.store.select(g.cmds.selectableIds()); g.cmds.removeSelected(); });
  if ((await byStart('video')).length) throw new Error('setting up: the clip is still there');
  await win.click('#btnVersions'); await frame();
  const rows = await ev(() => document.querySelectorAll('#versions .vers__row').length);
  if (!rows) throw new Error('no versions listed');
  await win.click('#versions .vers__row button'); await frame();
  if ((await byStart('video')).length !== 1) throw new Error('going back did not bring the clip back');
  await win.keyboard.press('Control+z'); await frame();
  if ((await byStart('video')).length) throw new Error('Ctrl+Z did not undo going back');
});

await step('versions are kept in the project file and come back when it is reopened', async () => {
  await fresh(); await importFiles([CLIP]);
  await ev(() => window.gc.library.takeVersion('kept', true));
  const id = await ev(async () => { await window.gc.library.save({ silent: true }); return window.gc.library.id; });
  await ev(async (id) => { await window.gc.library.open(id); }, id);
  const n = await ev(() => window.gc.library.versions().length);
  if (!n) throw new Error('no versions after reopening');
});

await step('Brand kit: new text uses your font and colour; your logo goes in the corner for the whole edit', async () => {
  await fresh(); await importFiles([CLIP]);
  await win.click('#leftTabs [data-tab="text"]'); await frame();
  await win.selectOption('#brandFont', 'Bebas Neue').catch(async () => {
    const f = await ev(() => [...document.querySelectorAll('#brandFont option')][2]?.value);
    await win.selectOption('#brandFont', f);
  });
  const chosen = await ev(() => document.getElementById('brandFont').value);
  await ev(() => { const c = document.querySelector('#brandKit .brand__cols input'); c.value = '#ff3366'; c.dispatchEvent(new Event('change')); });
  await win.setInputFiles('#brandLogoInput', [LOGO]); await sleep(500);
  await win.keyboard.press('t'); await frame();
  const t = (await byStart('text'))[0];
  const st = (await clipNow(t.id)).text;
  if (st.font !== chosen || st.color.toLowerCase() !== '#ff3366') throw new Error(`text came out ${st.font} / ${st.color}`);
  await win.click('#leftTabs [data-tab="text"]'); await frame();
  await win.click('#brandAddLogo'); await sleep(1200);
  const logo = (await byStart('image')).find(c => c.name === 'Logo');
  const dur = await ev(() => window.gc.store.rt.duration);
  if (!logo) throw new Error('no logo clip');
  if (Math.abs(logo.start) > 1e-6 || logo.duration < dur - 0.05) throw new Error(`logo spans ${logo.start}–${logo.start + logo.duration}, edit is ${dur}`);
  if (!(logo.transform.x > 0.8 && logo.transform.y < 0.2)) throw new Error('logo is not in the corner');
  await ev(() => localStorage.removeItem('gamecut.brand'));
});

await step('Auto-vertical: in 9:16 the frame follows a square moving left to right', async () => {
  await fresh();
  await win.click('#aspectSeg [data-ar="9:16"]'); await frame();
  await importFiles([MOVER]);
  const [v] = await byStart('video');
  await ev((id) => window.gc.store.select([id]), v.id); await sleep(200);
  await win.click('#inspectorRoot [data-itab="picture"]'); await frame();
  await win.click('#btnAutoVertical');
  for (let i = 0; i < 80; i++) { await sleep(250); if ((await clipNow(v.id)).keys?.['transform.x']?.length) break; }
  const keys = (await clipNow(v.id)).keys['transform.x'];
  if (!keys?.length) throw new Error('no keyframes written');
  const early = keys.find(k => k.t >= 0.3).v, late = [...keys].reverse().find(k => k.t <= 3.7).v;
  if (!(early > 0.5 + 0.2 && late < 0.5 - 0.2)) throw new Error(`frame went ${early.toFixed(2)} → ${late.toFixed(2)}`);
});

await step('Stabilize: the correction follows the shake, zoomed in so no edge shows', async () => {
  await fresh(); await importFiles([SHAKY]);
  const [v] = await byStart('video');
  await ev((id) => window.gc.store.select([id]), v.id); await sleep(200);
  await win.click('#inspectorRoot [data-itab="picture"]'); await frame();
  await win.click('#btnStabilize');
  for (let i = 0; i < 120; i++) { await sleep(250); if ((await clipNow(v.id)).keys?.['transform.x']?.length) break; }
  const c = await clipNow(v.id);
  const keys = c.keys['transform.x'];
  if (!keys?.length) throw new Error('no keyframes written');
  if (!(c.transform.scale > 1.05)) throw new Error('not zoomed in');
  // The shake moves the picture by −14·sin(9t) px (crop moves right); the fix moves it back.
  const xs = keys.map(k => k.v), ss = keys.map(k => Math.sin(9 * k.t));
  const mx = xs.reduce((a, b) => a + b) / xs.length, ms = ss.reduce((a, b) => a + b) / ss.length;
  let num = 0, dx = 0, ds = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ss[i] - ms); dx += (xs[i] - mx) ** 2; ds += (ss[i] - ms) ** 2; }
  const r = num / Math.sqrt(dx * ds || 1);
  if (!(Math.abs(r) > 0.6)) throw new Error(`correction does not track the shake (r = ${r.toFixed(2)})`);
  if (!(r > 0)) throw new Error(`correction goes the wrong way (r = ${r.toFixed(2)})`);
});

await step('Smooth 4K preview: a 1440p clip gets a light copy the preview plays, the export keeps the original', async () => {
  const BIG = `${OUT}/big1440.mp4`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=30', '-t', '3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', BIG]);
  await fresh();
  await importFiles([BIG]);
  await sleep(600);
  const offered = await ev(() => [...document.querySelectorAll('#toasts .toast')].find(t => /light copy/.test(t.textContent)));
  const btn = await win.$('#toasts .toast .toast__act');
  if (!btn) throw new Error('no offer to make a copy');
  void offered;
  await ev(() => { const b = [...document.querySelectorAll('#toasts .toast')].find(t => /light copy/.test(t.textContent))?.querySelector('.toast__act'); b?.click(); });
  let url = null;
  for (let i = 0; i < 120 && !url; i++) { await sleep(500); url = await ev(() => window.gc.assets.all().find(a => a.width === 2560)?.proxyUrl || null); }
  if (!url) throw new Error('the copy was never made');
  await ev(() => { window.gc.playback.seek(1); window.gc.comp.render(); });
  await sleep(800);
  const uses = await ev((u) => [...document.querySelectorAll('video')].some(v => v.src.replace(/\/$/, '') === u), url);
  if (!uses) throw new Error('the preview is not playing the copy');
  const exportUses = await ev(async () => {
    const { Compositor } = await import('app://gamecut/src/engine/compositor.js');
    const c = new Compositor(window.gc.store, document.createElement('canvas'), { fixedSize: { w: 64, h: 36 } });
    const r = !!c.pool.useProxies; c.dispose(); return r;
  });
  if (exportUses) throw new Error('export would use the copy');
});

void sleep;
await T.finish('FEATURES-2');
