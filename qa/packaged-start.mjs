/**
 * Does the built app start, every time? No Playwright: the exe is started the
 * way Windows does it (off-screen, throwaway profile) and asked over its
 * debugging port whether the editor has loaded.
 *   node qa/packaged-start.mjs [times] [path to Strike.exe]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const times = Number(process.argv[2] || 8);
const exe = process.argv[3] || path.join(ROOT, 'dist', 'win-unpacked', 'Strike.exe');
let bad = 0;
for (let i = 1; i <= times; i++) {
  const dir = mkdtempSync(path.join(tmpdir(), 'strike-st-'));
  const log = path.join(dir, 'err.txt');
  const child = spawn(exe, [`--user-data-dir=${path.join(dir, 'p')}`, '--remote-debugging-port=0', '--remote-allow-origins=*'],
    { env: { ...process.env, STRIKE_QA_QUIET: '1', STRIKE_QA_ERRLOG: log }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stderr.on('data', d => { out += d; }); child.stdout.on('data', d => { out += d; });
  let exited = null; child.on('exit', c => { exited = c; });
  const t0 = Date.now();
  let ok = false, seen = '';
  while (Date.now() - t0 < 25000 && !ok && exited === null) {
    await sleep(200);
    const port = out.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) continue;
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find(p => p.type === 'page');
      seen = page?.url || 'no page yet';
      if (!page) continue;
      ok = await new Promise((res) => {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const stop = setTimeout(() => { ws.close(); res(false); }, 1500);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '!!(window.gc&&window.gc.stickTo&&window.gc.captionEditor)', returnByValue: true } }));
        ws.onmessage = (e) => { clearTimeout(stop); ws.close(); res(JSON.parse(e.data).result?.result?.value === true); };
        ws.onerror = () => { clearTimeout(stop); res(false); };
      });
    } catch { /* not listening yet */ }
  }
  const err = existsSync(log) ? readFileSync(log, 'utf8').slice(0, 300) : '';
  if (!ok || err) bad++;
  console.log(`  ${ok && !err ? 'ok  ' : 'FAIL'} start ${i}: ${((Date.now() - t0) / 1000).toFixed(1)} s ${ok ? '' : `(page: ${seen || 'none'}, exit ${exited}) ${out.slice(-200)}`} ${err}`);
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch { /* already gone */ }
  await sleep(700);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold it a moment */ }
}
console.log(bad ? `STARTS FAILED: ${bad} of ${times}` : `STARTS PASSED: ${times} of ${times}`);
process.exit(bad ? 1 : 0);
