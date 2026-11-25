/**
 * The update as published (docs/), taken by a real older Strike: its own code, its
 * own signature check, off-screen, a throwaway profile, a server on this computer.
 *   node qa/update-from-release.mjs <folder with the older Strike checked out>
 */
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const ROOT = path.resolve(import.meta.dirname, '..'), OLD = path.resolve(process.argv[2]);
if (path.relative(ROOT, OLD) === '') throw new Error('give the older copy, not this one');
const want = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const server = createServer((q, r) => { const f = path.join(ROOT, 'docs', path.basename(q.url.split('?')[0])); if (!existsSync(f)) { r.writeHead(404); r.end(); return; } r.writeHead(200); r.end(readFileSync(f)); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const cfgFile = path.join(OLD, 'update-config.json'), cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
cfg.manifestUrl = `http://127.0.0.1:${server.address().port}/update.json`; cfg.autoCheck = false;
writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
const profile = mkdtempSync(path.join(tmpdir(), 'strike-upd-'));
let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
const start = async () => { const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${profile}`], cwd: OLD, timeout: 60000, env: { ...process.env, STRIKE_QA_QUIET: '1' } }); const win = await app.firstWindow(); const errs = []; win.on('pageerror', e => errs.push(e.message)); await win.waitForLoadState('domcontentloaded'); await sleep(2500); return { app, win, errs }; };
try {
  let { app, win } = await start();
  ok(await win.evaluate(() => window.gamecut.version()) === '2.1.0', 'it really is the older Strike: ' + await win.evaluate(() => window.gamecut.version()));
  ok(await win.evaluate(() => !window.gc.keymap), 'without the new features');
  const api = await win.evaluate(() => ['checkForUpdate', 'updateStatus', 'applyStagedUpdate']);
  const call = (n) => win.evaluate((k) => window.gamecut[k](), n);
  console.log('     bridge:', api.join(' '));
  await call(api.find(k => /^check/i.test(k)));
  let st = null;
  for (let i = 0; i < 60; i++) { st = await call(api.find(k => /Status$/.test(k))); if (/ready|needs|error/.test(st?.net?.phase || '')) break; await sleep(500); }
  const s = st?.net;
  ok(s?.phase === 'ready' && s?.available?.version === want && !s.available.needsInstaller, `it checks the signature, downloads ${want} and needs no installer (${s?.phase} ${s?.available?.version} ${s?.lastError || ''})`);
  ok((s?.available?.notes || []).length > 5, 'the notes come with it: ' + (s?.available?.notes || []).length);
  await call(api.find(k => /apply/i.test(k))); await sleep(6000);
  await app.close().catch(() => {});
  let errs; ({ app, win, errs } = await start());
  const now = await win.evaluate(async () => ({ keymap: !!window.gc?.keymap, shell: await window.gamecut.version(), icon: !!window.gamecut.setAppIcon, chip: document.getElementById('verChip')?.textContent, log: (await (await fetch('./assets/changelog.json')).json()).slice(0, 3).map(x => x.version + ':' + x.notes.length) }));
  ok(now.keymap && now.shell === '2.1.0' && !now.icon && now.chip === 'v' + want, 'after a restart it runs the new editor on the old shell: ' + JSON.stringify(now));
  ok(now.log.join().startsWith('2.3.0:') && now.log[1].startsWith('2.2.0:'), 'both dev logs are in it');
  await win.click('#homeNew'); await sleep(900);
  const use = await win.evaluate(async () => {
    const g = window.gc; g.cmds.addTextClip(0.5); g.cmds.addTextClip(0.5);
    g.qol.themes.open(); document.querySelector('#themeStudio [data-theme="sakura"]').click(); const tick = document.querySelector('.thst__tick').textContent;
    await new Promise(r => setTimeout(r, 900)); g.qol.themes.close();
    g.store.select(g.store.doc.tracks.flatMap(t => t.clips.map(c => c.id))); await new Promise(r => setTimeout(r, 300));
    const multi = !!document.querySelector('[data-multi="Opacity"]'); const ws = g.workspaces.apply('cutting');
    const { KINDS } = await import('./src/engine/transition-fx.js').catch(() => import('app://gamecut/src/engine/transition-fx.js'));
    return { logo: /ff7eb6/.test(getComputedStyle(document.querySelector('.topbar .brand__mark')).backgroundImage), tick, multi, ws, kinds: KINDS.length };
  });
  ok(use.logo && use.multi && use.ws && use.kinds === 23 && !/app icon/.test(use.tick), 'themes, many clips, workspaces and transitions work there: ' + JSON.stringify(use));
  ok(!errs.length, 'no errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await app.close().catch(() => {});
} finally { server.close(); try { rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* still closing */ } }
console.log(bad ? 'UPDATE FROM RELEASE FAILED' : 'UPDATE FROM RELEASE PASSED'); process.exit(bad ? 1 : 0);
