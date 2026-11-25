/**
 * Themes: every built-in one paints and reads well, the maker changes the editor live,
 * undoes, warns, saves, survives a reload and deletes. Pictures: qa/out/theme-*.png
 *   node qa/themes.mjs [--pictures]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { launch, ROOT } from './harness.mjs';
const OUT = `${ROOT}/qa/out`;
mkdirSync(OUT, { recursive: true });
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=size=1280x720:rate=30:speed=0.03:seed=4', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', `${OUT}/th-a.mp4`]);
const T = await launch({ name: 'themes', size: [1500, 900] });
const { win, ev, step, fresh, importFiles, sleep, finish } = T;

console.log('\n── themes ─────');
await fresh(); await importFiles([`${OUT}/th-a.mp4`]);
await ev(async () => {
  const { store, cmds, assets } = window.gc;
  const { makeClip } = await import('app://gamecut/src/core/schema.js');
  const a = assets.all()[0];
  const v = store.doc.tracks.filter(t => t.kind === 'video').at(-1), au = store.doc.tracks.filter(t => t.kind === 'audio'), tx = store.doc.tracks.find(t => t.kind === 'text');
  cmds.batch('set up', () => {
    store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id))); if (store.rt.selection.length) cmds.removeSelected();
    cmds.addClip(v.id, makeClip('video', { name: 'Ranked clutch', assetId: a.id, start: 0, duration: 3.2, sourceDuration: 8 }), { select: false });
    cmds.addClip(v.id, makeClip('video', { name: 'Ace on Haven', assetId: a.id, start: 3.2, duration: 4, inPoint: 3, sourceDuration: 8 }), { select: true });
    cmds.addClip(tx.id, makeClip('text', { name: 'NO WAY', start: 1, duration: 2.4, text: { text: 'NO WAY' } }), { select: false });
    void au;
  });
  window.gc.timeline?.fit?.();
});
await sleep(900);

await step('every built-in theme is complete and easy to read', async () => {
  const bad = await ev(async () => {
    const { GALLERY, checkTheme, themeVars, contrast } = await import('app://gamecut/src/ui/themes/theme-core.js');
    const out = [];
    for (const t of GALLERY) {
      for (const p of checkTheme(t)) out.push(`${t.name}: ${p.msg} (${p.ratio.toFixed(1)})`);
      const v = themeVars(t);
      for (const [k, x] of Object.entries(v)) if (!x || /undefined|NaN/.test(x)) out.push(`${t.name}: ${k} = ${x}`);
      if (contrast(v['--on-acc'], v['--acc']) < 4) out.push(`${t.name}: lettering on buttons`);
    }
    return out;
  });
  if (bad.length) throw new Error('\n      ' + bad.join('\n      '));
});

await step('wearing one repaints the page and the timeline, and text really reads on what is behind it', async () => {
  const bad = await ev(async () => {
    const { GALLERY } = await import('app://gamecut/src/ui/themes/theme-core.js');
    const { TH } = await import('app://gamecut/src/ui/theme.js');
    const out = []; const seen = new Set();
    window.gc.qol.themes.open();
    const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); if (/color\(srgb/.test(c)) { m[0] *= 255; m[1] *= 255; m[2] *= 255; } return { c: m.slice(0, 3), a: m[3] ?? 1 }; };
    const L = (c) => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const behind = (n) => { const st = []; for (let e = n; e; e = e.parentElement) { const s = getComputedStyle(e); if (/url|gradient/.test(s.backgroundImage)) { const g = s.backgroundImage.match(/(rgba?|color)\([^)]*\)/); if (g) { const p = parse(g[0]); st.push(p); if (p.a > 0.98) break; } else return null; } const p = parse(s.backgroundColor); if (p.a > 0) st.push(p); if (p.a > 0.98) break; } let c = parse(getComputedStyle(document.body).backgroundColor).c; for (const p of st.reverse()) c = c.map((v, i) => v + (p.c[i] - v) * p.a); return c; };
    for (const t of GALLERY) {
      document.querySelector(`#themeStudio [data-theme="${t.id}"]`).click();
      await new Promise(r => setTimeout(r, 260));
      const k = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim() + getComputedStyle(document.documentElement).getPropertyValue('--acc').trim();
      if (seen.has(k)) out.push(t.name + ' looks like another'); seen.add(k);
      if (!t.css && TH.lane !== getComputedStyle(document.documentElement).getPropertyValue('--tl-lane').trim()) out.push(t.name + ': timeline not repainted');
      const low = new Set();
      for (const n of document.querySelectorAll('.topbar *, .rail *, #leftPanel *, #rightPanel *, .timeline *, #themeStudio *, .transport *, .pv-float *')) {
        if (![...n.childNodes].some(x => x.nodeType === 3 && x.data.trim().length > 1)) continue;
        const b = n.getBoundingClientRect(); if (b.width < 4 || b.height < 4) continue;
        const s = getComputedStyle(n); if (s.visibility === 'hidden' || +s.opacity < 0.6 || n.closest('[disabled],.start--hero,svg,.savechip,.lib-item,.media-card,[class*="thumb"]')) continue;
        let dim = false; for (let e = n; e; e = e.parentElement) if (+getComputedStyle(e).opacity < 0.6) dim = true; if (dim) continue;
        const bg = behind(n); if (!bg) continue;
        const fg = parse(s.color); const col = bg.map((v, i) => v + (fg.c[i] - v) * fg.a);
        const r = (Math.max(L(col), L(bg)) + 0.05) / (Math.min(L(col), L(bg)) + 0.05);
        if (r < 2.9) low.add(`${n.className || n.tagName} "${n.textContent.trim().slice(0, 16)}" ${r.toFixed(1)}`);
      }
      if (low.size) out.push(`${t.name}: ${[...low].slice(0, 6).join(' | ')}`);
    }
    return out;
  });
  if (bad.length) throw new Error('\n      ' + bad.join('\n      '));
});

if (process.argv.includes('--pictures')) {
  await ev(() => document.querySelectorAll('.toast,.upd,[id*=whatsNew]').forEach(t => t.classList.contains('toast') && t.remove()));
  for (const id of ['strike', 'volt', 'graphite', 'midnight', 'sakura', 'retro', 'dusk', 'paper', 'contrast', 'day']) {
    await ev((x) => { const s = JSON.parse(localStorage.getItem('gamecut.settings') || '{}'); window.gc.qol.themes.close(); s.theme = x; localStorage.setItem('gamecut.settings', JSON.stringify({ ...s, theme: x })); window.gc.qol.applySettings(); document.querySelectorAll('.toast').forEach(t => t.remove()); }, id);
    await sleep(350); await win.screenshot({ path: `${OUT}/theme-${id}.png` });
  }
  await ev(() => { localStorage.setItem('gamecut.settings', '{"theme":"strike"}'); window.gc.qol.applySettings(); window.gc.qol.themes.open(); }); await sleep(300); await win.screenshot({ path: `${OUT}/theme-gallery.png` });
  await ev(() => document.querySelector('#themeStudio [data-theme="sakura"]').click()); await win.click('#themeNew'); await sleep(400); await win.screenshot({ path: `${OUT}/theme-maker.png` }); await win.click('#themeCancel');
}

await step('the maker: live colours, warning and Fix, shape, undo, cancel puts it back', async () => {
  await ev(() => document.querySelector('#themeStudio [data-theme="midnight"]').click());
  await win.click('#themeNew'); await sleep(200);
  const v = (k) => ev((x) => getComputedStyle(document.documentElement).getPropertyValue(x).trim(), k);
  const set = (k, c) => ev(([key, col]) => { const i = document.querySelector(`#themeStudio input[type=color][data-key="${key}"]`); i.value = col; i.dispatchEvent(new Event('input', { bubbles: true })); }, [k, c]);
  await set('accent', '#ff00aa');
  if (await v('--acc') !== '#ff00aa') throw new Error('not live: ' + await v('--acc'));
  await sleep(420);
  await set('text', '#22304f'); await sleep(420);
  const w = await ev(() => document.querySelector('.thst__warn').textContent);
  if (!/hard to read/.test(w)) throw new Error('no warning: ' + w);
  await win.click('.thst__warn button'); await sleep(100);
  if (/Text is hard/.test(await ev(() => document.querySelector('.thst__warn').textContent))) throw new Error('Fix did not fix');
  await sleep(420);
  await win.click('#themeUndo'); await win.click('#themeUndo');
  if (await v('--acc') !== '#ff00aa') throw new Error('undo went too far');
  await win.click('#themeUndo');
  if (await v('--acc') !== '#38bdf8') throw new Error('undo: ' + await v('--acc'));
  await win.click('[data-v="radius:1.6"]'); if (await v('--rk') !== '1.6') throw new Error('corners');
  await win.click('#themeCancel');
  if (await v('--rk') !== '1' || await ev(() => JSON.parse(localStorage.getItem('gamecut.settings')).theme) !== 'midnight') throw new Error('cancel');
});

await step('saved, worn again after a restart of the page, deleted and brought back', async () => {
  await win.click('#themeNew'); await sleep(150);
  await win.fill('#themeName', '<b>Mine</b>');
  await ev(() => { const i = document.querySelector('#themeStudio input[type=color][data-key="bg"]'); i.value = '#102030'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await ev(async () => { const c = document.createElement('canvas'); c.width = 900; c.height = 500; const g = c.getContext('2d'); const l = g.createLinearGradient(0, 0, 900, 500); l.addColorStop(0, '#243b55'); l.addColorStop(1, '#c06c84'); g.fillStyle = l; g.fillRect(0, 0, 900, 500); const b = await new Promise(r => c.toBlob(r, 'image/png')); await window.gc.qol.themes.picture(new File([b], 'x.png')); });
  if (!/url\("blob:/.test(await ev(() => getComputedStyle(document.querySelector('.aurora')).backgroundImage))) throw new Error('picture not behind the editor');
  await win.click('#themeSave'); await sleep(150);
  const s = await ev(() => ({ on: document.documentElement.style.getPropertyValue('--bg-0'), b: !!document.querySelector('#themeStudio .thst__name b b'), n: document.querySelector('#themeStudio .thst__card.is-on b').textContent }));
  if (s.on !== '#102030' || s.b || s.n !== '<b>Mine</b>') throw new Error(JSON.stringify(s));
  await ev(() => [...document.querySelectorAll('.thst__cardacts button')].find(b => b.textContent === 'Delete').click()); await sleep(150);
  if (await ev(() => document.documentElement.dataset.theme)) throw new Error('did not fall back to Strike');
  await ev(() => [...document.querySelectorAll('.toast button')].find(b => /undo/i.test(b.textContent)).click()); await sleep(150);
  if (await ev(() => document.documentElement.style.getPropertyValue('--bg-0')) !== '#102030') throw new Error('not brought back');
  await win.reload(); await sleep(2500);
  if (await ev(() => document.documentElement.style.getPropertyValue('--bg-0')) !== '#102030') throw new Error('forgotten after a reload');
});

await finish('THEMES');
