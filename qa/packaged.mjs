/**
 * Boot the PACKAGED build (asar, production paths, app.isPackaged === true)
 * rather than the source tree. This is what catches files missing from the
 * build's `files` allowlist, paths that only resolve in dev, and anything that
 * behaves differently once isDev flips to false.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, readFile } from 'node:fs/promises';

/**
 * The version the package should report, read from package.json rather than
 * written down here. A literal in a test is a second copy of a number that
 * changes every release, and the only thing it ever catches is itself.
 */
const PKG_VERSION = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

const BIN = process.argv[2];
const OUT = process.argv[3] || '.';
const problems = [];
const log = (t, m) => { problems.push(`${t}: ${m}`); console.log(`  !! ${t}: ${m}`); };
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { log('THREW in ' + name, e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── packaged build ───────────────────────');

// Throwaway profile, removed first and last.
//
// The app takes a single-instance lock so double-clicking the icon focuses the
// running window instead of starting a rival copy. Chromium implements that on
// Linux with a SingletonLock file, which survives an unclean exit — and a run
// that inherits a stale one quits at startup and never opens a window. Tests
// must not depend on the previous run having shut down politely.
const PROFILE = `/tmp/gamecut-qa-packaged-${process.pid}`;

/**
 * Launch, capturing the main process's own output.
 *
 * A bare `electron.launch` timeout says only "no window in 60s", which is
 * useless for telling a real startup failure apart from this sandbox being
 * slow. Keeping stderr means the app gets to explain itself — the
 * single-instance-lock message, for one, prints there.
 */
async function launch(attempt) {
  await rm(PROFILE, { recursive: true, force: true });
  const a = await electron.launch({
    executablePath: BIN,
    args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${PROFILE}`],
    timeout: 120_000,
  });
  const mainOut = [];
  a.process().stderr.on('data', d => mainOut.push(String(d)));
  try {
    const w = await a.firstWindow({ timeout: 60_000 });
    return { a, w };
  } catch (err) {
    const said = mainOut.join('').trim().slice(-600);
    await a.close().catch(() => {});
    throw new Error(`no window on attempt ${attempt}: ${err.message}` +
                    (said ? `\n    main process said: ${said}` : '\n    main process said nothing'));
  }
}

let app, win;
try {
  ({ a: app, w: win } = await launch(1));
} catch (first) {
  // One retry: an Electron launch under a virtual display occasionally never
  // produces a window here. A failure that repeats is a real fault, and the
  // captured output above will say why.
  console.log(`  .. retrying launch — ${first.message}`);
  ({ a: app, w: win } = await launch(2));
}
// The probe below asks for files that must be refused; its 403s are the pass
// condition, not a fault.
let expectingBlockedRequests = false;
win.on('pageerror', (e) => log('renderer pageerror', e.message));
win.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (expectingBlockedRequests &&
      /Failed to load resource|ERR_BLOCKED|Content Security Policy|Refused to/i.test(m.text())) return;
  log('renderer console.error', m.text());
});

await win.waitForLoadState('domcontentloaded');
await sleep(2500);
/**
 * Start on the projects screen, the way the app now opens, and go in from it.
 *
 * Every suite below drives the editor, so each has to make the same first move
 * a person does. Clicking the real button rather than reaching past it means a
 * home screen that failed to hand over would fail the suites rather than being
 * quietly stepped around.
 */
async function enterEditor(page) {
  await page.waitForSelector('#homeNew', { timeout: 20000 });
  await page.click('#homeNew');
  await page.waitForFunction(() =>
    !document.getElementById('app').classList.contains('is-home'), null, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 500));
}
await enterEditor(win);


await step('running from asar, packaged mode', async () => {
  const r = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    path: app.getAppPath(),
    version: app.getVersion(),
  }));
  if (!r.packaged) throw new Error('app.isPackaged is false — not a real package');
  if (!/app\.asar/.test(r.path)) throw new Error('not running from asar: ' + r.path);
  if (r.version !== PKG_VERSION) {
    throw new Error(`packaged build reports ${r.version}, package.json says ${PKG_VERSION}`);
  }
});

await step('every asset resolved from the asar', async () => {
  const missing = await win.evaluate(async () => {
    // Pull the exact set the page references, then re-fetch each one.
    const urls = [
      ...[...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href),
      ...[...document.querySelectorAll('script[src]')].map(s => s.src),
    ];
    const bad = [];
    for (const u of urls) {
      try { const r = await fetch(u); if (!r.ok) bad.push(`${u} → ${r.status}`); }
      catch (e) { bad.push(`${u} → ${e.message}`); }
    }
    return bad;
  });
  if (missing.length) throw new Error(missing.join('; '));
});

await step('renderer booted from package', async () => {
  const ok = await win.evaluate(() => !!window.gc?.store && !!window.gamecut?.isDesktop);
  if (!ok) throw new Error('app did not initialise inside the package');
});

await step('cross-origin isolated in package', async () => {
  const iso = await win.evaluate(() => self.crossOriginIsolated);
  if (!iso) throw new Error('COOP/COEP lost in the packaged build');
});

/**
 * The stylesheet made it into the package and the canvas read it.
 *
 * This used to assert one exact hex, which meant it failed on a retheme — the
 * one change it should be indifferent to. What matters is that the tokens
 * resolve from tokens.css rather than from theme.js's hardcoded fallbacks: a
 * missing stylesheet inside the asar shows up as a working app in the wrong
 * colours, which is easy to miss by eye.
 */
await step('theme tokens live in package', async () => {
  const r = await win.evaluate(async () => {
    const m = await import('app://gamecut/src/ui/theme.js');
    const cs = getComputedStyle(document.documentElement);
    const read = (k) => cs.getPropertyValue(k).trim();
    return {
      lane: m.TH.lane,
      acc: read('--acc'),
      bg: read('--bg-0'),
      surface: read('--surface'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  for (const [k, v] of Object.entries(r)) {
    if (!v) throw new Error(`${k} is empty — tokens.css did not load from the asar`);
  }
  if (!/^#|^rgb/.test(r.acc)) throw new Error('--acc is not a colour: ' + r.acc);
  // theme.js falls back to the old light palette if the stylesheet is missing,
  // so a lane that still reads white means exactly that.
  if (r.lane.toLowerCase() === '#ffffff') {
    throw new Error('canvas palette fell back to the built-in defaults');
  }
});

await step('editor drives in package', async () => {
  await win.click('#btnAddText');
  await sleep(200);
  await win.click('#btnPlay');
  await sleep(500);
  await win.click('#btnPlay');
  await win.click('#aspectSeg [data-ar="9:16"]');
  await sleep(400);
  await win.click('#btnUndo');
  await sleep(200);
  const n = await win.evaluate(() =>
    window.gc.store.doc.tracks.reduce((a, t) => a + t.clips.length, 0));
  if (!(n > 0)) throw new Error('document empty after edits');
});

await step('source files not reachable from package', async () => {
  expectingBlockedRequests = true;
  const res = await win.evaluate(async () => {
    const out = {};
    for (const p of ['package.json', 'electron-main.cjs', 'preload.cjs']) {
      try { out[p] = (await fetch('app://gamecut/' + p)).status; } catch { out[p] = 'blocked'; }
    }
    return out;
  });
  expectingBlockedRequests = false;
  const served = Object.entries(res).filter(([, v]) => v === 200);
  if (served.length) throw new Error(JSON.stringify(served));
});

await win.screenshot({ path: `${OUT}/packaged-app.png` });
await step('quits cleanly', () => app.close());
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`PACKAGED FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
} else {
  console.log('PACKAGED PASSED — the built app runs from its asar.');
}
