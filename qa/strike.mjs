/**
 * Strike 2.0: the animation library, Library mode, Customize, and the
 * close-without-saving fix.
 *
 *   node qa/strike.mjs
 */
import { _electron as electron } from 'playwright';
import { rm } from 'node:fs/promises';
import { launch, sleep, waitFor, ROOT } from './harness.mjs';

console.log('\n── Strike: animations ───');
const h = await launch({ name: 'strike' });
const { ev, win, step, fresh, problems } = h;
await fresh();

const anims = () => ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'anim')
  .map(c => ({ id: c.id, anim: c.anim.id, p: c.anim.p, start: c.start, assetId: c.assetId, kind: window.gc.store.doc.tracks.find(t => t.clips.includes(c)).kind })));

await step('the Animate drawer lists all 61 and filters by search and category', async () => {
  await win.click('#tabAnim'); await sleep(300);
  const n = await ev(() => document.querySelectorAll('#animRoot .acard').length);
  if (n !== 61) throw new Error(`${n} cards`);
  await win.fill('#animSearch', 'kill'); await sleep(150);
  const k = await ev(() => [...document.querySelectorAll('#animRoot .acard')].map(c => c.dataset.anim));
  if (!k.includes('killCounter') || !k.includes('killFeed') || !k.includes('killStreak') || k.length > 8) throw new Error('search: ' + k);
  await win.fill('#animSearch', ''); await win.click('#animRoot [data-cat="counters"]'); await sleep(150);
  const c = await ev(() => [...document.querySelectorAll('#animRoot .acard')].map(c => c.dataset.anim));
  if (c.length !== 9 || !c.includes('countdown') || !c.includes('scoreboard')) throw new Error('category: ' + c);
  await win.click('#animRoot [data-cat="all"]');
});

await step('clicking a card puts it at the playhead on a text lane, selected, with its sound', async () => {
  await ev(() => { window.gc.store.rt.playhead = 1; });
  await win.click('#animRoot .acard[data-anim="killCounter"]'); await sleep(300);
  const a = await anims();
  if (a.length !== 1 || a[0].anim !== 'killCounter' || Math.abs(a[0].start - 1) > 0.02 || a[0].kind !== 'text') throw new Error(JSON.stringify(a));
  const sel = await ev(() => window.gc.store.rt.selection);
  if (sel[0] !== a[0].id) throw new Error('not selected');
  await waitFor(win, (id) => window.gc.assets.get(id)?.audioState === 'ready', a[0].assetId, { timeout: 8000 });
  const audible = await ev(async () => {
    const { audibleClips } = await import('app://gamecut/src/audio/graph.js');
    return audibleClips(window.gc.store).some(x => x.clip.type === 'anim');
  });
  if (!audible) throw new Error('its sound is not in the mix');
});

await step('the sounds animations bring are not listed as your media', async () => {
  const n = await ev(() => ({ all: window.gc.assets.all().length, pool: window.gc.assets.byBin('all').length, cards: document.querySelectorAll('#poolRoot .asset, #poolRoot [data-asset]').length }));
  if (n.all < 1 || n.pool !== 0 || n.cards !== 0) throw new Error(JSON.stringify(n));
});

await step('a second kill counter counts on from the first', async () => {
  await ev(() => window.gc.cmds.addAnimation('killCounter', 4));
  const a = (await anims()).filter(x => x.anim === 'killCounter').sort((x, y) => x.start - y.start);
  if (a.length !== 2 || a[1].p.count !== 2) throw new Error(JSON.stringify(a));
});

await step('it draws on the picture (and not before it starts)', async () => {
  const lit = await ev(() => {
    const { comp } = window.gc;
    const count = (t) => {
      comp.render(t, false);
      const c = comp.canvas, x = c.getContext('2d');
      const d = x.getImageData(0, 0, Math.round(c.width * 0.45), Math.round(c.height * 0.35)).data;
      let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 120) n++;
      return n;
    };
    return { before: count(0.5), during: count(1.8) };
  });
  if (lit.before > 5 || lit.during < 50) throw new Error(JSON.stringify(lit));
});

await step('Customize: the words change on the picture, as one undo step', async () => {
  const id = (await anims()).sort((x, y) => x.start - y.start)[0].id;
  await ev((id) => window.gc.store.select([id]), id); await sleep(250);
  const tab = await ev(() => document.querySelector('.itab.is-active')?.textContent);
  if (tab !== 'Customize') throw new Error('opened on ' + tab);
  const steps0 = await ev(() => window.gc.history.steps().length);
  await win.fill('.acust__txt[data-k="label"]', 'TRIPLE');
  await win.press('.acust__txt[data-k="label"]', 'Enter'); await sleep(200);
  const r = await ev((id) => ({ p: window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).anim.p, n: window.gc.history.steps().length }), id);
  if (r.p.label !== 'TRIPLE' || r.n !== steps0 + 1) throw new Error(JSON.stringify(r) + ' was ' + steps0);
  await ev(() => window.gc.cmds.undo()); await sleep(100);
  const back = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).anim.p.label, id);
  if (back !== undefined) throw new Error('undo left ' + back);
});

await step('a countdown from 5 beeps five times, then GO', async () => {
  const c = await ev(() => window.gc.cmds.addAnimation('countdown', 8));
  await ev((id) => window.gc.cmds.setAnimParam(id, 'from', 5), c.id ?? (await anims()).at(-1).id);
  const plan = await ev(async () => {
    const { soundPlan } = await import('app://gamecut/src/anim/sfx.js');
    const { animById, valuesFor } = await import('app://gamecut/src/anim/defs.js');
    const clip = window.gc.store.doc.tracks.flatMap(t => t.clips).find(x => x.anim?.id === 'countdown');
    const d = animById('countdown');
    return { asset: window.gc.assets.get(clip.assetId)?.bundled, plan: soundPlan(d, valuesFor(d, clip.anim.p), clip.duration) };
  });
  const beeps = plan.asset.filter(s => s.sound === 'beep').length, go = plan.asset.filter(s => s.sound === 'go').length;
  if (beeps !== 5 || go !== 1) throw new Error(JSON.stringify(plan.asset));
});

await step('swap keeps the place and timing; sound off removes it from the mix', async () => {
  const a = (await anims()).find(x => x.anim === 'killCounter');
  await ev((id) => window.gc.cmds.swapAnimation(id, 'headshot'), a.id);
  const b = (await anims()).find(x => x.id === a.id);
  if (b.anim !== 'headshot' || b.start !== a.start) throw new Error(JSON.stringify(b));
  await ev((id) => window.gc.cmds.setAnimSound(id, false), a.id);
  const off = await ev((id) => window.gc.store.doc.tracks.flatMap(t => t.clips).find(c => c.id === id).assetId, a.id);
  if (off) throw new Error('still has a sound');
});

await step('drag a card onto the timeline', async () => {
  const before = (await anims()).length;
  const dt = await win.evaluateHandle(() => new DataTransfer());
  const card = '#animRoot .acard[data-anim="follow"]';
  await win.dispatchEvent(card, 'dragstart', { dataTransfer: dt });
  const target = '#tlDrop';
  const box = await ev(() => { const r = document.getElementById('timelineView').getBoundingClientRect(); return { x: r.left + r.width * 0.7, y: r.top + 70 }; });
  await win.dispatchEvent(target, 'dragover', { dataTransfer: dt, clientX: box.x, clientY: box.y });
  await win.dispatchEvent(target, 'drop', { dataTransfer: dt, clientX: box.x, clientY: box.y });
  await sleep(200);
  const after = await anims();
  if (after.length !== before + 1 || !after.some(x => x.anim === 'follow')) throw new Error(`${before} → ${after.length}`);
});

await step('Library mode: opens over the editor, Add puts it in and goes back to Edit', async () => {
  await win.click('#modeLibrary'); await sleep(400);
  const open = await ev(() => !document.getElementById('libView').hidden && document.querySelectorAll('#libView .acard').length);
  if (open !== 61) throw new Error('cards: ' + open);
  await win.click('#libView .acard[data-anim="victory"]'); await sleep(250);
  await win.fill('#libView .libf input[data-k="title"]', 'GG').catch(async () => {
    const k = await ev(() => document.querySelector('#libView .libf input:not([type=color])')?.dataset.k);
    await win.fill(`#libView .libf input[data-k="${k}"]`, 'GG');
  });
  await win.click('#libAdd'); await sleep(300);
  const r = await ev(() => ({ mode: window.gc.animLib.mode, hidden: document.getElementById('libView').hidden }));
  const v = (await anims()).find(x => x.anim === 'victory');
  if (r.mode !== 'edit' || !r.hidden || !v || !Object.values(v.p).includes('GG')) throw new Error(JSON.stringify({ r, v }));
});

await step('Escape leaves Library mode; star a card and it shows under Starred', async () => {
  await win.click('#modeLibrary'); await sleep(200);
  await win.keyboard.press('Escape'); await sleep(150);
  if (!(await ev(() => document.getElementById('libView').hidden))) throw new Error('still open');
  await win.hover('#animRoot .acard[data-anim="aceSlam"]');
  await win.click('#animRoot .acard[data-anim="aceSlam"] .acard__star'); await sleep(100);
  await win.click('#animRoot [data-cat="starred"]'); await sleep(150);
  const s = await ev(() => [...document.querySelectorAll('#animRoot .acard')].map(c => c.dataset.anim));
  if (s.join() !== 'aceSlam') throw new Error(s.join());
  await win.click('#animRoot [data-cat="all"]');
});

await step('Ctrl+K finds animations', async () => {
  const hit = await ev(() => {
    window.gc.palette.open?.();
    const i = document.querySelector('#palInput, .pal input');
    if (!i) return 'no palette';
    i.value = 'boss health'; i.dispatchEvent(new Event('input', { bubbles: true }));
    const t = document.querySelector('.pal__item')?.textContent || '';
    window.gc.palette.close?.();
    return t;
  });
  if (!/health bar/i.test(hit)) throw new Error(hit);
});

/* ── Stage 3: cut flash, Quick look ─────────────────────────── */
// (Smart Zoom's steps used to sit here; the next steps need the recording it set up.)
await step('a recording with loud hits is on the timeline at 20 s (the next steps use it)', async () => {
  await h.importFiles([`${ROOT}/qa/fixtures/hits-clip.mp4`]);
  await ev(async () => {
    const { placeAsset } = await import('app://gamecut/src/ui/timeline/place-asset.js');
    const { store, cmds, assets } = window.gc;
    const a = assets.all().find(x => x.name?.startsWith('hits-clip'));
    placeAsset(store, cmds, a.id, { start: 20 });
  });
  await waitFor(win, () => window.gc.assets.all().find(x => x.name?.startsWith('hits-clip'))?.peaks?.rms, null, { timeout: 15000 });
});

await step('S flashes the cut on the timeline', async () => {
  await ev(() => { window.gc.store.select([]); window.gc.playback.seek(23.3); });
  const got = await ev(() => new Promise(res => { window.gc.store; const off = (e) => res(e); import('app://gamecut/src/core/events.js').then(({ bus }) => { bus.on('cut:flash', off); window.gc.cmds.splitAt(23.3, []); setTimeout(() => res(null), 500); }); }));
  if (!got || Math.abs(got.t - 23.3) > 0.05) throw new Error(JSON.stringify(got));
});

await step('Q shows the frame at full export size; Q again closes it', async () => {
  await ev(() => window.gc.playback.seek(22.1));
  await win.locator('#timelineCanvas').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await ev(() => document.activeElement?.blur());
  await win.keyboard.press('q');
  await waitFor(win, () => document.querySelector('#quickLook img')?.naturalWidth > 0, null, { timeout: 15000 });
  const r = await ev(() => { const i = document.querySelector('#quickLook img'); return { w: i.naturalWidth, h: i.naturalHeight, W: window.gc.store.doc.width, H: window.gc.store.doc.height }; });
  if (r.w !== r.W || r.h !== r.H) throw new Error(JSON.stringify(r));
  await win.keyboard.press('q'); await sleep(100);
  if (!(await ev(() => document.getElementById('quickLook').hidden))) throw new Error('did not close');
});

await step("the tour walks through five stops and Skip ends it; What's new is about 2.0", async () => {
  await ev(() => window.gc.tour.start()); await sleep(300);
  const first = await ev(() => document.querySelector('#tourx .tourx__card b')?.textContent);
  for (let i = 0; i < 4; i++) { await win.click('#tourx [data-next]'); await sleep(120); }
  const last = await ev(() => ({ t: document.querySelector('#tourx .tourx__card b')?.textContent, btn: document.querySelector('#tourx [data-next]')?.textContent }));
  await win.click('#tourx [data-next]'); await sleep(100);
  const gone = await ev(() => !document.getElementById('tourx') && localStorage.getItem('strike.tourDone') === '1');
  if (!first || last.btn !== 'Start editing' || !gone) throw new Error(JSON.stringify({ first, last, gone }));
  await ev(() => window.gc.tour.start()); await sleep(150);
  await win.click('#tourx [data-skip]'); await sleep(100);
  if (await ev(() => !!document.getElementById('tourx'))) throw new Error('skip did not end it');
  await ev(() => window.gc.qol.openTour()); await sleep(150);
  const head = await ev(() => document.querySelector('#tourPanel .vers__head b')?.textContent);
  await win.keyboard.press('Escape');
  if (!/2\.0\.0/.test(head)) throw new Error(head);
});

/* ── Stage 4: shorts kit ───────────────────────────────────── */
await step('sound pads: a click drops the sound at the playhead on the SFX lane', async () => {
  await win.click('#tabPads'); await sleep(200);
  await ev(() => { window.gc.store.select([]); window.gc.playback.seek(3); });
  const before = await ev(() => window.gc.store.doc.tracks.filter(t => /sfx/i.test(t.name)).reduce((n, t) => n + t.clips.length, 0));
  await win.click('#padsRoot [data-pad="7"]'); await sleep(300);
  const r = await ev(() => { const c = window.gc.store.doc.tracks.filter(t => t.kind === 'audio').flatMap(t => t.clips).find(c => c.name === 'Rewind'); return c && { start: c.start, dur: c.duration, asset: window.gc.assets.get(c.assetId)?.bundled?.[0]?.sound }; });
  if (!r || Math.abs(r.start - 3) > 0.02 || r.asset !== 'rewind' || Math.abs(r.dur - 1.1) > 0.05) throw new Error(JSON.stringify(r) + ' before ' + before);
});

await step('sound pads: a recorded take is one undo, and S does not split while recording', async () => {
  await ev(() => window.gc.playback.seek(5));
  const n0 = await ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).length);
  await win.click('#btnPadRec'); await sleep(250);
  for (const k of ['w', 's', 'd']) { await win.keyboard.press(k); await sleep(160); }
  await win.keyboard.press('Escape'); await sleep(400);
  const r = await ev(() => ({ n: window.gc.store.doc.tracks.flatMap(t => t.clips).length, last: window.gc.history.steps().filter(s => s.done).at(-1)?.label, rec: window.gc.pads.recording }));
  if (r.n !== n0 + 3 || r.last !== 'Sound pads: 3 sounds' || r.rec) throw new Error(JSON.stringify(r) + ' from ' + n0);
  await ev(() => window.gc.cmds.undo());
  const back = await ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).length);
  if (back !== n0) throw new Error('undo left ' + back);
});

await step('Make vertical: Game + cam turns the project 9:16 with a linked facecam layer, in one undo', async () => {
  const w0 = await ev(() => window.gc.store.doc.width);
  await win.click('#btnLayouts'); await sleep(200);
  await win.click('#layouts [data-layout="gameCam"]');
  await win.click('#layouts [data-cam="bl"]');
  await win.click('#layGo'); await sleep(400);
  const r = await ev(() => {
    const { store } = window.gc;
    const cams = store.doc.tracks.flatMap(t => t.clips).filter(c => c.layout);
    const main = [...store.doc.tracks].reverse().find(t => t.kind === 'video').clips.filter(c => c.type === 'video');
    return { w: store.doc.width, h: store.doc.height, cams: cams.length, linked: cams.every(c => main.some(m => m.id === c.linkTo)), camY: cams[0]?.transform.y, mainY: main[0]?.transform.y, crop: cams[0]?.crop };
  });
  if (r.w !== 1080 || r.h !== 1920 || !r.cams || !r.linked || !(r.camY < 0.3 && r.mainY > 0.5) || r.crop.x !== 0 || r.crop.y < 0.5) throw new Error(JSON.stringify(r));
  // Another layout replaces it rather than stacking.
  await ev(() => window.gc.layouts.apply('bubble', { cam: 'br' }));
  const again = await ev(() => window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.layout).length);
  if (again !== r.cams) throw new Error(`${again} facecam layers after a second layout`);
  await ev(() => { window.gc.cmds.undo(); window.gc.cmds.undo(); });
  const back = await ev(() => ({ w: window.gc.store.doc.width, cams: window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.layout).length }));
  if (back.w !== w0 || back.cams) throw new Error(JSON.stringify(back));
});

await step('a vertical project shows the phone safe zones with the guides', async () => {
  await ev(() => window.gc.layouts.apply('center', { cam: null })); await sleep(300);
  const t = await ev(() => document.getElementById('previewGuides')?.textContent || '');
  await ev(() => window.gc.cmds.undo()); await sleep(200);
  if (!/BUTTONS/.test(t) || !/SAFE FOR TIKTOK/.test(t)) throw new Error('guides: ' + t.slice(0, 120));
});

await step('captions: fillers dropped, keywords marked, single-word look makes one clip per word', async () => {
  const r = await ev(async () => {
    const { dropFillers, wordsToLines, keyIndices, CAPTION_LOOKS } = await import('app://gamecut/src/captions/captions.js');
    const words = [{ text: 'uh', s: 0, e: 0.2 }, { text: 'that', s: 0.3, e: 0.5 }, { text: 'was', s: 0.5, e: 0.7 }, { text: 'a', s: 0.7, e: 0.8 }, { text: 'clutch', s: 0.8, e: 1.2 }];
    const kept = dropFillers(words);
    const lines = wordsToLines(kept);
    const single = wordsToLines(kept, CAPTION_LOOKS.find(l => l.id === 'single').lines);
    return { kept: kept.map(w => w.text).join(' '), keys: keyIndices(lines[0].words), single: single.length, looks: CAPTION_LOOKS.map(l => l.id).join() };
  });
  if (r.kept !== 'that was a clutch' || r.keys.join() !== '3' || r.single !== 4 || !/box/.test(r.looks)) throw new Error(JSON.stringify(r));
});

/* ── Stage 5: Clip Inbox, thumbnails, Discord export, blur fit ── */
await step('blur fit: a landscape clip in a tall frame has a soft fill, not black bars', async () => {
  const r = await ev(async () => {
    const { store, cmds, comp } = window.gc;
    const main = [...store.doc.tracks].reverse().find(t => t.kind === 'video').clips.find(c => c.type === 'video');
    cmds.setResolution({ width: 1080, height: 1920, aspect: '9:16' });
    await new Promise(r => setTimeout(r, 400));
    window.gc.playback.seek(main.start + 0.5);
    await new Promise(r => setTimeout(r, 700));
    const litRow = () => {
      comp.render(main.start + 0.5, false);
      const c = comp.canvas, x = c.getContext('2d');
      const top = x.getImageData(0, Math.round(c.height * 0.05), c.width, 1).data;
      let lit = 0; for (let i = 0; i < top.length; i += 4) if (top[i] + top[i + 1] + top[i + 2] > 30) lit++;
      return lit;
    };
    cmds.setClipProp(main.id, 'fit', 'contain', { merge: false });
    const bars = litRow();
    cmds.setClipProp(main.id, 'fit', 'blur', { merge: false });
    const lit = litRow();
    cmds.undo(); cmds.undo(); cmds.undo();
    return { lit, bars, w: comp.canvas.width };
  });
  if (r.lit < r.bars + r.w * 0.2) throw new Error(JSON.stringify(r));
});

await step('Export offers "Small for Discord", sized under 10 MB', async () => {
  await win.click('#btnExport'); await sleep(500);
  const r = await ev(() => ({ tile: !!document.querySelector('[data-preset="discord"]'), meta: document.querySelector('[data-preset="discord"] .xp__meta')?.textContent || '' }));
  await win.keyboard.press('Escape'); await sleep(200);
  const mb = +((r.meta.match(/~(\d+) MB/) || [])[1] || 999);
  if (!r.tile || mb > 10) throw new Error(JSON.stringify(r));
});

await step('Thumbnail maker: picks frames, draws words on a 1280×720 picture', async () => {
  await ev(() => window.gc.thumbs.open());
  await waitFor(win, () => document.getElementById('thumbBig')?.width === 1280, null, { timeout: 20000 }); await sleep(300);
  const r = await ev(() => {
    const big = document.getElementById('thumbBig');
    const x = big.getContext('2d');
    const d = x.getImageData(0, 0, big.width, big.height).data;
    let volt = 0; for (let i = 0; i < d.length; i += 4 * 13) if (d[i] > 170 && d[i + 1] > 220 && d[i + 2] < 120) volt++;
    return { w: big.width, h: big.height, frames: document.querySelectorAll('.thm__frame').length, volt };
  });
  await win.keyboard.press('Escape');
  if (r.w !== 1280 || r.h !== 720 || r.frames < 2 || r.volt < 200) throw new Error(JSON.stringify(r));
});

await step('the project name box does not keep focus it was not asked for (keys reach the editor)', async () => {
  const r = await ev(async () => {
    const b = document.getElementById('projName');
    b.focus();                                   // as Chromium does on its own
    await new Promise(r => setTimeout(r, 50));
    return document.activeElement === b;
  });
  if (r) throw new Error('the name box kept a focus nobody asked for');
  await win.click('#projName');
  const clicked = await ev(() => document.activeElement?.id);
  await win.keyboard.press('Escape');
  await ev(() => document.activeElement?.blur());
  if (clicked !== 'projName') throw new Error('clicking the name box no longer lets you type in it');
});

await step('saved and reopened: animations and their sounds come back', async () => {
  const r = await ev(async () => {
    const { library, assets, store } = window.gc;
    await library.save({ silent: true });
    const id = library.id;
    const n = store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'anim').length;
    await library.open(id);
    await new Promise(r => setTimeout(r, 1200));
    const clips = store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'anim');
    const sounds = clips.filter(c => c.assetId).map(c => assets.get(c.assetId));
    return { n, back: clips.length, missing: sounds.filter(a => !a || a.missing).length, ready: sounds.filter(a => a?.audioState === 'ready').length, total: sounds.length };
  });
  if (r.back !== r.n || r.missing || r.ready !== r.total || !r.total) throw new Error(JSON.stringify(r));
});
await h.app.close();
const stepFails = problems.length;

/* ── Closing without doing anything writes no project ─────────── */
console.log('\n── Strike: closing saves only what is worth keeping ───');
const PROFILE = `/tmp/gc-strike-close-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });
const open = async () => {
  const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 60000 });
  const w = await app.firstWindow(); await w.waitForLoadState('domcontentloaded'); await sleep(1800);
  return { app, w };
};
const close = async (app) => {
  const gone = new Promise(r => app.on('close', r));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await Promise.race([gone, sleep(8000)]);
  try { await app.close(); } catch { /* already gone */ }
};
let failed = 0;
const check = async (title, fn) => {
  try { await fn(); console.log('  ok   ' + title); } catch (e) { failed++; console.log('  FAIL ' + title + '\n  !! ' + e.message); }
};
await check('close from the home screen: no project', async () => {
  const { app } = await open(); await close(app);
  const { app: a2, w } = await open();
  const n = await w.evaluate(async () => (await window.gc.library.list()).length);
  await close(a2);
  if (n !== 0) throw new Error(`${n} projects`);
});
await check('open a new project, touch nothing, close: no project', async () => {
  const { app, w } = await open();
  await w.click('#homeNew'); await sleep(800);
  await close(app);
  const { app: a2, w: w2 } = await open();
  const n = await w2.evaluate(async () => (await window.gc.library.list()).length);
  await close(a2);
  if (n !== 0) throw new Error(`${n} projects`);
});
await check('add an animation, close: it is kept', async () => {
  const { app, w } = await open();
  await w.click('#homeNew'); await sleep(800);
  await w.evaluate(() => window.gc.cmds.addAnimation('headshot', 0));
  await close(app);
  const { app: a2, w: w2 } = await open();
  const n = await w2.evaluate(async () => (await window.gc.library.list()).length);
  await close(a2);
  if (n !== 1) throw new Error(`${n} projects`);
});

await check('Clip Inbox lists a new recording; Open in editor and Quick short use it where it is', async () => {
  const { mkdir, copyFile } = await import('node:fs/promises');
  const dir = `/tmp/gc-inbox-${process.pid}`;
  await mkdir(`${dir}/Game`, { recursive: true });
  await copyFile(`${ROOT}/qa/fixtures/test-clip.mp4`, `${dir}/Game/clutch 2026-10-20.mp4`);
  const { app, w } = await open();
  const listed = await w.evaluate(async (d) => { await window.gamecut.inbox.addPath(d); await window.gc.inbox.refresh(); return window.gc.inbox.data.items.map(i => ({ name: i.name, isNew: i.isNew })); }, dir);
  if (!listed.some(i => i.name === 'clutch 2026-10-20.mp4' && i.isNew)) { await close(app); throw new Error(JSON.stringify(listed)); }
  const cards = await w.evaluate(() => document.querySelectorAll('#homeInbox .inbox__item').length);
  const i = await w.evaluate(() => window.gc.inbox.data.items.findIndex(x => x.name.startsWith('clutch')));
  await w.evaluate((i) => window.gc.inbox.use(window.gc.inbox.data.items[i], false), i);
  await sleep(2500);
  const ed = await w.evaluate(() => ({ home: document.getElementById('app').classList.contains('is-home'), clips: window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'video').length, path: window.gc.assets.all()[0]?.path || '' }));
  await w.evaluate(() => document.getElementById('btnHome').click()); await sleep(1500);
  await w.evaluate((i) => window.gc.inbox.use(window.gc.inbox.data.items[i], true), i);
  await sleep(2500);
  const sh = await w.evaluate(() => ({ w: window.gc.store.doc.width, h: window.gc.store.doc.height, layers: window.gc.store.doc.tracks.flatMap(t => t.clips).filter(c => c.layout).length }));
  await close(app);
  if (!cards || ed.home || ed.clips !== 1 || !ed.path.endsWith('clutch 2026-10-20.mp4')) throw new Error(JSON.stringify({ cards, ed }));
  if (sh.w !== 1080 || sh.h !== 1920 || sh.layers !== 1) throw new Error(JSON.stringify(sh));
});

const total = stepFails + failed;
console.log(total ? `\n${total} problem(s)` : '\nall good');
for (const p of problems) console.log('  - ' + p);
process.exit(total ? 1 : 0);
