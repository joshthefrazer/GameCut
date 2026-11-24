/**
 * The built Windows app (dist/win-unpacked), off-screen, with a throwaway profile:
 * it starts, can check for updates, and the new tools are in it.
 *   node qa/packaged-quiet.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const want = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const dir = mkdtempSync(path.join(tmpdir(), 'strike-pk-'));
const log = path.join(dir, 'main-errors.txt');
let failed = 0;
const check = (ok, name, extra = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`); };
const app = await electron.launch({
  executablePath: path.join(ROOT, 'dist', 'win-unpacked', 'Strike.exe'),
  args: ['--no-sandbox', `--user-data-dir=${path.join(dir, 'p')}`],
  env: { ...process.env, STRIKE_QA_QUIET: '1', STRIKE_QA_ERRLOG: log }, timeout: 60000,
});
try {
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', e => errs.push(e.message));
  await win.waitForFunction(() => !!window.gc?.stickTo && !!window.gc?.captionEditor && !!window.gc?.editTools, null, { timeout: 30000 });
  check(true, 'the packaged app starts with the new tools in it');
  const v = await app.evaluate(({ app }) => ({ v: app.getVersion(), packed: app.isPackaged, p: app.getPath('userData') }));
  check(v.v === want && v.packed, `it is version ${want}`, JSON.stringify(v));
  check(v.p.startsWith(dir), 'it used the throwaway profile, not the real one', v.p);
  const m = await win.evaluate(() => window.gamecut.models.status('outline-small'));
  check(m && !m.error && m.ready === false, 'it knows the outline model', JSON.stringify(m));
  // The live site is still signed with the old, lost key: a real check must reach it and refuse it.
  const up = await win.evaluate(() => window.gamecut.checkForUpdate());
  console.log('     update check:', JSON.stringify({ phase: up?.phase, configured: up?.configured, lastError: up?.lastError }));
  check(up?.configured === true, 'it is set up to check for updates', JSON.stringify(up).slice(0, 300));
  await win.waitForTimeout(1500);
  check(!errs.length, 'no errors on the page', errs.join(' | '));
} finally {
  await app.close().catch(() => {});
}
check(!existsSync(log), 'no errors in the main process', existsSync(log) ? readFileSync(log, 'utf8') : '');
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold it a moment */ }
console.log(failed ? '\nPACKAGED FAILED' : '\nPACKAGED PASSED');
process.exit(failed ? 1 : 0);
