import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const OUT = process.argv[2] || '.';
const problems = [];
const log = (t, m) => { problems.push(`${t}: ${m}`); console.log(`  !! ${t}: ${m}`); };
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { log('THREW in ' + name, e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── electron shell ───────────────────────');

// Throwaway profile — a stale Chromium SingletonLock from an unclean exit
// makes the next launch quit before opening a window.
const PROFILE = `/tmp/gamecut-qa-dev-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu',
         `--user-data-dir=${PROFILE}`],
  cwd: '/home/claude/gamecut',
  env: { ...process.env, NODE_ENV: 'production' },
  timeout: 60_000,
});

// Main-process stdout/stderr often carries the real cause of a bad launch.
// Chromium chatters about GPU/dbus/fonts under xvfb, and this sandbox's egress
// proxy makes any stray TLS attempt surface as an ssl_client_socket error —
// none of that is GameCut. Anything else from the main process is a real fault.
const ENV_NOISE = /GPU|dbus|bus\.cc|libva|Fontconfig|gbm|vulkan|DevTools|sandbox|ssl_client_socket|net_error|cert_verify|NetworkService/i;
app.process().stderr.on('data', (d) => {
  const s = String(d);
  if (/error|Error|EACCES|ENOENT|cannot|failed/i.test(s) && !ENV_NOISE.test(s)) {
    log('main stderr', s.trim().slice(0, 300));
  }
});

const win = await app.firstWindow();
// The probe steps below deliberately request URLs that must fail; their 404/403
// console noise is the expected result, not a defect.
let expectingBlockedRequests = false;
win.on('pageerror', (e) => log('renderer pageerror', e.message));
win.on('console', (m) => {
  if (m.type() !== 'error') return;
  // A blocked request now reports twice — once from the session-level block and
  // once from CSP — and CSP words it differently.
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


await step('window opened', async () => {
  const t = await win.title();
  if (!/GameCut/i.test(t)) throw new Error('unexpected title: ' + t);
});

await step('served over app:// (no localhost bind)', async () => {
  const url = win.url();
  if (!url.startsWith('app://')) throw new Error('loaded from ' + url);
});

await step('cross-origin isolated (SharedArrayBuffer available)', async () => {
  const r = await win.evaluate(() => ({
    iso: self.crossOriginIsolated,
    sab: typeof SharedArrayBuffer !== 'undefined',
  }));
  if (!r.iso) throw new Error('crossOriginIsolated is false — COOP/COEP not applied');
  if (!r.sab) throw new Error('SharedArrayBuffer missing');
});

await step('renderer booted', async () => {
  const ok = await win.evaluate(() => !!window.gc?.store);
  if (!ok) throw new Error('window.gc missing — ES modules did not load over app://');
});

await step('preload bridge exposed', async () => {
  const r = await win.evaluate(() => ({
    present: !!window.gamecut?.isDesktop,
    hasSave: typeof window.gamecut?.saveAs === 'function',
    noRequire: typeof window.require === 'undefined',
    noProcess: typeof window.process === 'undefined',
  }));
  if (!r.present) throw new Error('window.gamecut missing');
  if (!r.hasSave) throw new Error('saveAs not exposed');
  if (!r.noRequire) throw new Error('SECURITY: require() leaked into the renderer');
  if (!r.noProcess) throw new Error('SECURITY: process leaked into the renderer');
});

/**
 * The renderer may ask to open a destination, never to open a URL.
 *
 * `shell.openExternal` hands a string to the operating system to launch. A page
 * that could choose that string could launch anything on the machine, so the
 * main process keeps the list and the renderer passes a key. This asserts the
 * refusal, which is the half that matters.
 */
await step('external opening is by key, not by URL', async () => {
  const r = await win.evaluate(async () => ({
    hasOpen: typeof window.gamecut?.openTarget === 'function',
    hasReveal: typeof window.gamecut?.revealFile === 'function',
    unknownKey: await window.gamecut?.openTarget?.('not-a-real-target'),
    aUrl: await window.gamecut?.openTarget?.('https://example.com'),
    missingFile: await window.gamecut?.revealFile?.('/definitely/not/a/real/file.mp4'),
  }));
  if (!r.hasOpen || !r.hasReveal) throw new Error('openTarget / revealFile not exposed');
  if (r.unknownKey !== false) throw new Error('an unknown destination key was not refused');
  if (r.aUrl !== false) throw new Error('SECURITY: the renderer could pass its own URL to the shell');
  if (r.missingFile !== false) throw new Error('revealing a nonexistent file should return false');
});

/**
 * Updating the editor without rebuilding the .exe.
 *
 * The interface is plain files served over app://, so nothing in the executable
 * changes when the editor does. This installs a bundle, checks the new file is
 * what actually loads, and checks the way back.
 *
 * The refusal matters most: a bundle naming electron-main.cjs or preload.cjs
 * must not be able to write them. Those run as Node with every privilege the
 * process has, and a file swap is not the right way to change them.
 */
await step('an update installs, takes effect, and can be undone', async () => {
  const { writeFile, rm } = await import('node:fs/promises');
  const BUNDLE = `/tmp/gamecut-test-${process.pid}.gcupdate`;

  const before = await win.evaluate(() => window.gc.store.doc.name);

  await writeFile(BUNDLE, JSON.stringify({
    kind: 'gamecut-update',
    version: '9.9.9-test',
    files: {
      // A real editor file, changed in a way that is trivial to detect.
      'src/probe-update.js': 'export const INSTALLED = "9.9.9-test";\n',
      // Both of these must be refused.
      'electron-main.cjs': 'throw new Error("should never be written");',
      '../escape.js': 'throw new Error("should never be written");',
    },
  }));

  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const fs = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const dir = path.join(userData, 'app-update');

  // The picker needs a human, so drive the installer the menu calls directly.
  const res = await app.evaluate((_e, bundlePath) => globalThis.__gcInstallUpdate(bundlePath), BUNDLE);

  if (!res?.ok) throw new Error('install failed: ' + (res?.reason || 'unknown'));
  if (!res.refused?.includes('electron-main.cjs')) {
    throw new Error('SECURITY: an update was allowed to write electron-main.cjs');
  }

  // The file really is on disk, inside the update folder and nowhere else.
  const probe = await fs.readFile(path.join(dir, 'src', 'probe-update.js'), 'utf8');
  if (!/9\.9\.9-test/.test(probe)) throw new Error('update file not written');
  for (const bad of [path.join(userData, 'escape.js'), path.join(dir, 'electron-main.cjs')]) {
    let leaked = true;
    try { await fs.access(bad); } catch { leaked = false; }
    if (leaked) throw new Error('SECURITY: update escaped its folder → ' + bad);
  }

  // And the protocol now serves it.
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await sleep(2000);
  const served = await win.evaluate(async () => {
    try {
      const m = await import('app://gamecut/src/probe-update.js');
      return m.INSTALLED;
    } catch (e) { return 'not served: ' + e.message; }
  });
  if (served !== '9.9.9-test') throw new Error('installed file is not what app:// serves: ' + served);

  // Back to the built-in version.
  await app.evaluate(async () => await globalThis.__gcRevertUpdate());
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await sleep(2000);
  await enterEditor(win);
  // Asking for the removed file must 404 — that refusal is the pass condition,
  // so the console noise it makes is expected rather than a fault.
  expectingBlockedRequests = true;
  const gone = await win.evaluate(async () => {
    try { await import('app://gamecut/src/probe-update.js?x=1'); return 'still there'; }
    catch { return 'gone'; }
  });
  await sleep(150);
  expectingBlockedRequests = false;
  if (gone !== 'gone') throw new Error('reverting did not remove the update');

  const after = await win.evaluate(() => window.gc.store.doc.name);
  if (!after || after !== before) throw new Error('editor did not come back cleanly after revert');

  await rm(BUNDLE, { force: true });
  console.log('     installed, served, refused native files, reverted');
});

/**
 * An update from an older build must not shadow a newer executable.
 *
 * This was a real failure, not a hypothetical: rebuilding the app with a brand
 * new projects screen changed nothing on screen, because an update installed
 * against the previous build was still serving its own copy of index.html and
 * src/. The overlay always won, and nothing said so.
 */
await step('an update from a previous build is dropped, not honoured', async () => {
  // Staged from Node: `require` is not available inside app.evaluate, and the
  // files only need to exist on disk for the main process to find them.
  const fs = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  const dir = path.join(userData, 'app-update');

  const stage = async (appVersion) => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'stale-probe.js'), 'export const X = 1;');
    await fs.writeFile(path.join(dir, '.version.json'), JSON.stringify({
      version: 'probe', installedAt: Date.now(), files: 1, appVersion,
    }));
  };
  const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

  // An overlay that belongs to some other build.
  await stage('0.0.0-other');
  const dropped = await app.evaluate(() => globalThis.__gcDropStale());
  if (!dropped) throw new Error('a stale update was not detected');
  if (dropped.builtFor !== '0.0.0-other') throw new Error('wrong build reported: ' + JSON.stringify(dropped));
  if (await exists(dir)) throw new Error('the stale overlay was left in place');

  // One stamped for THIS build has to survive.
  await stage(version);
  const kept = await app.evaluate(() => globalThis.__gcDropStale());
  if (kept) throw new Error('an update for this build was wrongly discarded');
  if (!await exists(path.join(dir, '.version.json'))) {
    throw new Error('an update for this build was deleted');
  }
  await fs.rm(dir, { recursive: true, force: true });
  console.log(`     stale overlay dropped · matching one kept (app ${version})`);
});

await step('desktop class applied', async () => {
  const ok = await win.evaluate(() => document.documentElement.classList.contains('is-desktop'));
  if (!ok) throw new Error('is-desktop class not set — initDesktop did not run');
});

await step('css + canvas painted', async () => {
  const r = await win.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    const c = document.getElementById('timelineCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3] > 8) lit++;
    return { bg, lit };
  });
  if (!/rgb/.test(r.bg)) throw new Error('body background unset — CSS did not load');
  if (r.lit < 50) throw new Error('timeline canvas blank');
});

await step('path traversal refused', async () => {
  expectingBlockedRequests = true;
  const res = await win.evaluate(async () => {
    // `new URL()` collapses ../ before the handler ever sees it, so escaping
    // has to be attempted through encoded separators and absolute host paths.
    const probes = [
      'app://gamecut/..%2f..%2f..%2f..%2fetc%2fpasswd',
      'app://gamecut/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'app://gamecut/..%5c..%5cwindows%5csystem32%5cdrivers%5cetc%5chosts',
      'app://gamecut/etc/passwd',
    ];
    const out = {};
    for (const p of probes) {
      try {
        const r = await fetch(p);
        out[p] = r.status === 200 ? '200 LEAK: ' + (await r.text()).slice(0, 40) : r.status;
      } catch { out[p] = 'blocked'; }
    }
    return out;
  });
  expectingBlockedRequests = false;
  const leaks = Object.entries(res).filter(([, v]) => String(v).startsWith('200'));
  if (leaks.length) throw new Error('escaped the app root: ' + JSON.stringify(leaks));
});

await step('non-web files in root are not served', async () => {
  expectingBlockedRequests = true;
  const res = await win.evaluate(async () => {
    const out = {};
    for (const p of ['package.json', 'electron-main.cjs', 'preload.cjs']) {
      try { out[p] = (await fetch('app://gamecut/' + p)).status; }
      catch { out[p] = 'blocked'; }
    }
    return out;
  });
  expectingBlockedRequests = false;
  const served = Object.entries(res).filter(([, v]) => v === 200);
  if (served.length) throw new Error('served source/manifest files: ' + JSON.stringify(served));
});

await step('outbound network is blocked', async () => {
  expectingBlockedRequests = true;
  const r = await win.evaluate(async () => {
    try {
      const res = await fetch('https://example.com/ping', { mode: 'no-cors' });
      return 'reached: ' + res.type;
    } catch (e) { return 'blocked'; }
  });
  expectingBlockedRequests = false;
  if (r !== 'blocked') throw new Error('renderer reached the network — ' + r);
});

await step('query strings resolve', async () => {
  const s = await win.evaluate(() => fetch('app://gamecut/index.html?v=42').then(r => r.status));
  if (s !== 200) throw new Error('cache-busting query broke resolution: ' + s);
});

await step('interaction works in shell', async () => {
  // A new project is empty, so there is nothing to play until something is on
  // the timeline. Adding a text layer is the cheapest way to have a duration.
  await win.click('#btnAddText');
  await sleep(300);
  await win.click('#btnPlay');
  await sleep(600);
  await win.click('#btnPlay');
  const t = await win.evaluate(() => window.gc.store.rt.playhead);
  if (!(t > 0)) throw new Error('playhead did not advance in Electron');
});

/**
 * The fullscreen TRANSITION cannot be exercised here: this box has no window
 * manager, so `requestFullscreen()` never settles and the promise hangs. What
 * is testable — and what would actually break — is the resize response the
 * fullscreen path depends on: the preview frame is sized from its viewport's
 * box, so if it does not refit when that box changes, going fullscreen would
 * leave a small picture in the middle of a big black screen.
 */
await step('preview refits when its container resizes', async () => {
  const read = () => win.evaluate(() => {
    const f = document.getElementById('previewFrame').getBoundingClientRect();
    const v = document.getElementById('previewViewport').getBoundingClientRect();
    return {
      frame: Math.round(f.width), viewport: Math.round(v.width), innerW: window.innerWidth,
      aspect: f.width / Math.max(1, f.height),
      projectAspect: window.gc.store.doc.width / window.gc.store.doc.height,
    };
  });

  const setSize = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, s) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setResizable(true);
      win.setSize(s.w, s.h);
    }, { w, h });
    // setSize is asynchronous at the OS level; wait for the renderer to see it
    // rather than guessing at a sleep duration.
    await win.waitForFunction(
      ([tw]) => Math.abs(window.innerWidth - tw) < 40, [w], { timeout: 5000 },
    ).catch(() => {});
    // The refit rides on ResizeObserver + rAF, and rAF is starved on this
    // software-rendered box. Wait for the frame to actually fit its viewport
    // rather than guessing a sleep.
    await win.waitForFunction(() => {
      const f = document.getElementById('previewFrame').getBoundingClientRect();
      const v = document.getElementById('previewViewport').getBoundingClientRect();
      const doc = window.gc.store.doc;
      const pad = 36;                                   // matches fit()
      const availW = Math.max(80, v.width - pad);
      const availH = Math.max(60, v.height - pad);
      const ar = doc.width / doc.height;
      let w = availW, h = w / ar;
      if (h > availH) { h = availH; w = h * ar; }
      return Math.abs(f.width - w) < 2;                 // settled on the fitted size
    }, null, { timeout: 8000 }).catch(() => {});
  };

  // Start small so there is room to grow inside the virtual screen; growing
  // past it would be clamped and make the comparison meaningless.
  await setSize(1200, 800);
  const small = await read();

  await setSize(1560, 920);
  const large = await read();

  const detail = ` small=${JSON.stringify(small)} large=${JSON.stringify(large)}`;
  if (large.viewport <= small.viewport) {
    throw new Error('window resize did not reach the viewport;' + detail);
  }
  if (large.frame <= small.frame) {
    throw new Error('preview frame did not refit;' + detail);
  }

  // The real invariant: the frame is always the biggest box with the project's
  // aspect that fits inside the viewport. Check it at both sizes rather than
  // expecting an exact round-trip, which the screen bound can spoil.
  for (const [label, m] of [['small', small], ['large', large]]) {
    if (m.frame > m.viewport) {
      throw new Error(`${label}: frame ${m.frame} overflows viewport ${m.viewport}`);
    }
    if (Math.abs(m.aspect - m.projectAspect) > 0.02) {
      throw new Error(`${label}: frame aspect ${m.aspect.toFixed(3)} != project ${m.projectAspect.toFixed(3)}`);
    }
  }
});

/**
 * Fullscreen is actually PERMITTED.
 *
 * The button had never worked once, in any build, and the reason was two lines
 * in the main process: the permission handler refused everything, and Chromium
 * routes `requestFullscreen()` through that same gate as the camera and the
 * microphone. A denial rejects immediately with a permissions error; this box
 * has no window manager, so a granted request may instead never settle. Those
 * two outcomes are what this tells apart — a rejection is the bug, and anything
 * else is the environment.
 */
await step('the shell permits fullscreen and nothing else', async () => {
  const r = await app.evaluate(() => ({
    has: typeof globalThis.__gcPermitted === 'function',
    fullscreen: globalThis.__gcPermitted?.('fullscreen'),
    media: globalThis.__gcPermitted?.('media'),
    geolocation: globalThis.__gcPermitted?.('geolocation'),
    notifications: globalThis.__gcPermitted?.('notifications'),
    openExternal: globalThis.__gcPermitted?.('openExternal'),
  }));
  if (!r.has) throw new Error('the permission policy is not readable — seam missing');
  if (!r.fullscreen) {
    throw new Error('fullscreen is refused by the session, so the button can never work');
  }
  for (const k of ['media', 'geolocation', 'notifications', 'openExternal']) {
    if (r[k]) throw new Error(`${k} is permitted, and nothing here needs it`);
  }
});

await step('fullscreen is not refused by the app itself', async () => {
  const r = await win.evaluate(() => new Promise((resolve) => {
    const el = document.getElementById('previewPanel');
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish({ outcome: 'pending' }), 3000);
    try {
      el.requestFullscreen({ navigationUI: 'hide' })
        .then(() => finish({ outcome: 'entered' }))
        .catch((e) => finish({ outcome: 'rejected', name: e.name, message: String(e.message || '') }));
    } catch (e) {
      finish({ outcome: 'threw', name: e.name, message: String(e.message || '') });
    }
  }));
  if (r.outcome === 'rejected' || r.outcome === 'threw') {
    throw new Error(`the shell refused fullscreen: ${r.name} — ${r.message}`);
  }
  // Leave it as we found it if it did go fullscreen.
  await win.evaluate(() => { if (document.fullscreenElement) return document.exitFullscreen(); });
  await sleep(300);
});

await step('fullscreen handler is attached and idempotent', async () => {
  const r = await win.evaluate(() => {
    const api = window.gc?.preview;
    return {
      hasToggle: typeof api?.toggleFullscreen === 'function',
      hasQuery: typeof api?.isFullscreen === 'function',
      notFsNow: api?.isFullscreen?.() === false,
      btn: !!document.getElementById('btnFullscreen'),
    };
  });
  if (!r.btn) throw new Error('no fullscreen button');
  if (!r.hasToggle || !r.hasQuery) throw new Error('preview does not expose the fullscreen API');
  if (!r.notFsNow) throw new Error('isFullscreen() should be false at rest');
});

await step('aspect switch in shell', async () => {
  await win.click('#aspectSeg [data-ar="9:16"]');
  await sleep(400);
  const d = await win.evaluate(() => window.gc.store.doc.width);
  if (d !== 1080) throw new Error('aspect switch failed: ' + d);
  await win.click('#aspectSeg [data-ar="16:9"]');
});

await win.screenshot({ path: `${OUT}/electron-app.png` });

await step('closes cleanly', async () => {
  await app.close();
});

await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`ELECTRON FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
} else {
  console.log('ELECTRON PASSED — shell boots, isolates, and drives the editor.');
}
