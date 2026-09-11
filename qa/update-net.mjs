/**
 * The update system, end to end, against a real server.
 *
 * This is the one feature that downloads code and runs it, so it is tested by
 * standing up an actual HTTP server, pointing a real GameCut at it, and
 * watching it accept a good release and refuse every bad one. Asserting on the
 * pure functions alone would prove the arithmetic and miss the point: what
 * matters is what the running application does when a server lies to it.
 *
 * The server is on 127.0.0.1. The updater allows plain HTTP only for loopback,
 * where there is no meaningful middle to be in — which is exactly what makes
 * this testable instead of a matter of reading the code and hoping.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { generateKeyPairSync, createHash, sign as cryptoSign, randomBytes } from 'node:crypto';

const ROOT = '/home/claude/gamecut';
const problems = [];
const log = (t, m) => { problems.push(`${t}: ${m}`); console.log(`  !! ${t}: ${m}`); };
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { log('THREW in ' + name, e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── updates over the network ─────────────');

/* ── A signing key, and a second one nobody should trust ─────── */
const good = generateKeyPairSync('ed25519');
const evil = generateKeyPairSync('ed25519');
const publicKeyB64 = good.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/* ── A server that serves whatever the current test tells it to ── */
let routes = new Map();
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const body = routes.get(path);
  if (body === undefined) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/`;
const MANIFEST_URL = BASE + 'update.json';

/** A .gcupdate carrying one real editor file, so the installer will accept it. */
function makeBundle(version, marker) {
  return JSON.stringify({
    kind: 'gamecut-update',
    version,
    note: 'test bundle',
    files: {
      'index.html': `<!doctype html><title>GameCut</title><!-- ${marker} -->`,
      'src/marker.js': `export const MARKER = ${JSON.stringify(marker)};`,
    },
  });
}

function sign(manifest, key = good.privateKey) {
  const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
  return JSON.stringify({
    kind: 'gamecut-manifest',
    payload: payload.toString('base64'),
    sig: cryptoSign(null, payload, key).toString('base64'),
  });
}

/** Put a complete, valid release on the server and return its manifest. */
function publish(version, { key = good.privateKey, patch = {}, bundle = null } = {}) {
  const text = bundle ?? makeBundle(version, 'v' + version);
  const name = `GameCut-${version}.gcupdate`;
  const manifest = {
    product: 'gamecut',
    channel: 'stable',
    version,
    published: new Date().toISOString(),
    rollout: 1,
    needsInstaller: false,
    minShell: null,
    bundle: {
      path: name,
      sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
      bytes: Buffer.byteLength(text),
    },
    notes: [`Everything in ${version}`, 'A second line'],
    history: [{ version, published: new Date().toISOString(), notes: [`Everything in ${version}`] }],
    ...patch,
  };
  routes.set('/' + name, text);
  routes.set('/update.json', sign(manifest, key));
  return manifest;
}

/* ── Launch ──────────────────────────────────────────────────── */
const PROFILE = `/tmp/gamecut-qa-update-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });
const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${PROFILE}`],
  cwd: ROOT, timeout: 60_000,
});
const win = await app.firstWindow();
win.on('pageerror', (e) => log('pageerror', e.message));
await win.waitForLoadState('domcontentloaded');
await sleep(2200);

/** Point the running app at our server, with our key. */
const aim = (cfg = {}) => app.evaluate(({ /* electron */ }, c) =>
  globalThis.__gcRestartUpdater(c), {
    manifestUrl: MANIFEST_URL, publicKey: publicKeyB64,
    autoCheck: false, checkEveryHours: 999, ...cfg,
  });
const check = () => app.evaluate(() => globalThis.__gcCheckUpdate());
const shellVersion = await app.evaluate(({ app: a }) => a.getVersion());

/* Fresh state between tests: the updater remembers a staged download on
   purpose, and one test's leftovers must not answer another test's question. */
async function reset() {
  await app.evaluate(() => globalThis.__gcUpdateTestReset());
  await aim();
}

/* ── The happy path ──────────────────────────────────────────── */
await step('a signed newer release is found, fetched and checked', async () => {
  await reset();
  const next = bump(shellVersion);
  publish(next);
  const st = await check();
  if (st.phase !== 'ready') {
    throw new Error(`expected it to be ready, got ${st.phase}: ${st.lastError || ''}`);
  }
  if (st.available?.version !== next) throw new Error('offered ' + st.available?.version);
  if (!st.available.notes?.length) throw new Error('the release notes did not come through');
  if (st.staged?.version !== next) throw new Error('nothing was actually downloaded');
});

await step('installing it swaps the editor for the downloaded one', async () => {
  const next = bump(shellVersion);
  // Through the same IPC the button in the panel uses.
  const res = await win.evaluate(() => window.gamecut.applyStagedUpdate());
  if (!res?.ok) throw new Error('install refused: ' + (res?.reason || '?'));
  if (res.version !== next) throw new Error('installed ' + res.version);

  await sleep(1400);
  const stamp = await app.evaluate(() => globalThis.__gcReadInstalled('.version.json'));
  if (!stamp) throw new Error('nothing was installed');
  if (JSON.parse(stamp).version !== next) throw new Error('the stamp says ' + JSON.parse(stamp).version);

  const marker = await app.evaluate(() => globalThis.__gcReadInstalled('src/marker.js'));
  if (!marker?.includes('v' + next)) throw new Error('the installed file is not the one downloaded');
});

await step('the same version is not offered again', async () => {
  // The editor is now running the update, so the server has nothing newer.
  await aim();
  const st = await check();
  if (st.phase === 'ready') throw new Error('it offered an update it has already installed');
  if (st.phase !== 'uptodate') throw new Error('phase is ' + st.phase);
});

/* ── Everything it has to refuse ─────────────────────────────── */
await step('a manifest signed by the wrong key is refused', async () => {
  await reset();
  publish(bump(shellVersion, 2), { key: evil.privateKey });
  const st = await check();
  if (st.phase === 'ready') throw new Error('it installed something signed by a stranger');
  if (!/signed/i.test(st.lastError || '')) throw new Error('wrong reason: ' + st.lastError);
});

await step('a tampered manifest body is refused', async () => {
  await reset();
  const v = bump(shellVersion, 2);
  publish(v);
  // Re-encode the payload with a different version, keeping the old signature.
  const raw = JSON.parse(routes.get('/update.json'));
  const payload = JSON.parse(Buffer.from(raw.payload, 'base64').toString('utf8'));
  payload.version = bump(shellVersion, 9);
  raw.payload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  routes.set('/update.json', JSON.stringify(raw));

  const st = await check();
  if (st.phase === 'ready') throw new Error('an edited manifest was accepted');
  if (!/signed/i.test(st.lastError || '')) throw new Error('wrong reason: ' + st.lastError);
});

await step('a bundle that does not match its checksum is thrown away', async () => {
  await reset();
  const v = bump(shellVersion, 2);
  const m = publish(v);
  // Swap the file the manifest points at, leaving the signed hash alone.
  routes.set('/' + m.bundle.path, makeBundle(v, 'SWAPPED'));
  const st = await check();
  if (st.phase === 'ready') throw new Error('a swapped download was accepted');
  if (!/checksum/i.test(st.lastError || '')) throw new Error('wrong reason: ' + st.lastError);
});

await step('an older version is never offered', async () => {
  await reset();
  publish('0.0.1');
  const st = await check();
  if (st.phase !== 'uptodate') throw new Error('phase is ' + st.phase + ' for an older release');
  if (st.available) throw new Error('it offered a downgrade');
});

await step('a release that needs the installer says so instead of half-updating', async () => {
  await reset();
  const v = bump(shellVersion, 2);
  publish(v, { patch: { needsInstaller: true, installer: { path: `GameCut-${v}-x64.exe` } } });
  const st = await check();
  if (st.phase !== 'needs-installer') throw new Error('phase is ' + st.phase);
  if (st.staged) throw new Error('it downloaded a bundle it cannot use');
  if (!st.available?.installerUrl?.startsWith(BASE)) {
    throw new Error('installer link is ' + st.available?.installerUrl);
  }
});

await step('a build that is too old for the release is told to reinstall', async () => {
  await reset();
  const v = bump(shellVersion, 2);
  publish(v, { patch: { minShell: bump(shellVersion, 5) } });
  const st = await check();
  if (st.phase !== 'needs-installer') throw new Error('phase is ' + st.phase);
});

await step('a manifest pointing at another server is refused', async () => {
  await reset();
  const v = bump(shellVersion, 2);
  publish(v, { patch: { bundle: { path: 'https://example.invalid/evil.gcupdate', sha256: 'x', bytes: 1 } } });
  const st = await check();
  if (st.phase === 'ready') throw new Error('it fetched from somewhere else entirely');
  if (!/trusts|refused/i.test(st.lastError || '')) throw new Error('wrong reason: ' + st.lastError);
});

await step('with no key compiled in, nothing is installed from the network', async () => {
  await reset();
  publish(bump(shellVersion, 2));
  await aim({ publicKey: '' });
  const st = await check();
  if (st.phase !== 'off') throw new Error('phase is ' + st.phase + ' with no key');
  if (st.staged) throw new Error('it downloaded something with no way to verify it');
});

await step('a server that answers with rubbish is survived', async () => {
  await reset();
  routes.set('/update.json', 'this is not json at all');
  const st = await check();
  if (st.phase === 'ready') throw new Error('rubbish was accepted');
  if (!st.lastError) throw new Error('it failed silently');
});

await step('a dead server is survived', async () => {
  await reset();
  await aim({ manifestUrl: `http://127.0.0.1:${PORT + 1}/update.json` });
  const st = await check();
  if (st.phase === 'ready') throw new Error('phase is ready with no server');
  if (!st.lastError) throw new Error('it failed silently');
});

/* ── The staged rollout ──────────────────────────────────────── */
await step('a rollout of zero reaches nobody, and one reaches everybody', async () => {
  const { inRollout } = await import(`file://${ROOT}/updater.cjs`).then(m => m.default || m);
  let none = 0, all = 0;
  for (let i = 0; i < 200; i++) {
    const id = randomBytes(8).toString('hex');
    if (inRollout(id, '2.0.0', 0)) none++;
    if (inRollout(id, '2.0.0', 1)) all++;
  }
  if (none !== 0) throw new Error(`${none} installs were let into a 0% rollout`);
  if (all !== 200) throw new Error(`${200 - all} installs were kept out of a 100% rollout`);

  // A quarter rollout should land somewhere near a quarter, and must be stable.
  let hit = 0;
  const ids = Array.from({ length: 600 }, () => randomBytes(8).toString('hex'));
  for (const id of ids) if (inRollout(id, '2.0.0', 0.25)) hit++;
  const pct = hit / ids.length;
  if (pct < 0.18 || pct > 0.32) throw new Error(`a 25% rollout reached ${(pct * 100).toFixed(0)}%`);
  for (const id of ids.slice(0, 50)) {
    if (inRollout(id, '2.0.0', 0.25) !== inRollout(id, '2.0.0', 0.25)) {
      throw new Error('the same install got two different answers');
    }
  }
});

await step('the editor never gets a way to name an address', async () => {
  const keys = await win.evaluate(() => Object.keys(window.gamecut || {}));
  const bad = keys.filter(k => /url|fetch|host|origin|download/i.test(k));
  // openInstallerPage takes a URL, but the main process checks it against the
  // one origin this build trusts before doing anything with it.
  const allowed = new Set(['openInstallerPage']);
  const leaks = bad.filter(k => !allowed.has(k));
  if (leaks.length) throw new Error('the bridge exposes: ' + leaks.join(', '));

  const r = await win.evaluate(() =>
    window.gamecut.openInstallerPage('https://example.invalid/evil.exe'));
  if (r?.ok) throw new Error('the renderer opened a page on an untrusted host');
});

/** 1.4.0 → 1.4.1, or +n on the patch number. */
function bump(v, n = 1) {
  const p = String(v).split('.').map(x => parseInt(x, 10) || 0);
  while (p.length < 3) p.push(0);
  p[2] += n;
  return p.join('.');
}

await app.close().catch(() => {});
server.close();
await rm(PROFILE, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`UPDATE FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.log(' • ' + p);
  process.exit(1);
} else {
  console.log('UPDATE PASSED — signed releases install, everything else is refused.');
}
