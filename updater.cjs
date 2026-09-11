/**
 * Checking for, fetching and verifying updates.
 *
 * This is the one part of GameCut that talks to the network, and the shape of
 * it is the whole point:
 *
 *  - It runs in the MAIN process, over Node's own `https`. It does not go
 *    through Chromium's session, which is still locked to `app:` and
 *    `gcmedia:` — so the editor, where the footage and the projects live, is
 *    exactly as sealed as it was before this file existed. Nothing about a
 *    video, a project, a filename or a keystroke can reach this code.
 *
 *  - It only ever talks to ONE origin: the one compiled into
 *    `update-config.json`. Every address it fetches is built from the manifest
 *    URL rather than read out of the manifest, so even a manifest written by
 *    somebody else cannot point this app at a different server.
 *
 *  - It sends nothing. A plain GET of a static file, no query string, no
 *    identifier, no headers beyond a user agent naming the version — which the
 *    server needs anyway to serve the right thing, and which is the one fact a
 *    static host would log regardless.
 *
 *  - It refuses to install anything that is not signed by the key baked into
 *    the build. Friends will be running this, and a machine that downloads code
 *    and runs it is the most dangerous thing in the application. A compromised
 *    host, a hijacked DNS record or a proxy in the middle all fail here rather
 *    than at the point where the code is already running.
 *
 * With no public key configured it does nothing at all, which is the shipped
 * default. Failing closed is the only sensible direction for this feature.
 */
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/** Hard ceilings. A hostile or broken server must not be able to fill a disk. */
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/* ── Version comparison ──────────────────────────────────────────
   Plain numeric dotted versions, which is all this project uses. Anything
   unparseable sorts as 0 rather than throwing — a malformed version in a
   manifest should mean "not newer", never a crash on launch. */
function parseVersion(v) {
  return String(v || '').split('.').map(n => parseInt(n, 10) || 0);
}

/** -1, 0 or 1. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  const n = Math.max(x.length, y.length, 3);
  for (let i = 0; i < n; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* ── The one origin this build may talk to ───────────────────── */

/**
 * Is this a URL we are allowed to fetch?
 *
 * Same origin as the configured manifest, and HTTPS — with one exception, for
 * loopback. A manifest served from 127.0.0.1 cannot meaningfully be intercepted,
 * and being able to point a build at a local file server is what makes this
 * whole path testable end to end instead of by inspection.
 */
function sameOrigin(url, manifestUrl) {
  let a, b;
  try { a = new URL(url); b = new URL(manifestUrl); } catch { return false; }
  const loopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';
  if (a.protocol !== 'https:' && !loopback(a.hostname)) return false;
  return a.protocol === b.protocol && a.host === b.host;
}

/**
 * Fetch a URL into memory, with a hard byte cap and a timeout.
 *
 * Redirects are followed only within the same origin, so a redirect cannot be
 * used to walk this out of its allowlist.
 */
function fetchBuffer(url, { manifestUrl, limit, depth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!sameOrigin(url, manifestUrl)) {
      reject(new Error('refused: ' + url + ' is not the update address this build trusts'));
      return;
    }
    if (depth > MAX_REDIRECTS) { reject(new Error('too many redirects')); return; }

    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'user-agent': 'GameCut', 'accept': '*/*' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        fetchBuffer(next, { manifestUrl, limit, depth: depth + 1 }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`server said ${status}`));
        return;
      }
      const declared = parseInt(res.headers['content-length'] || '0', 10);
      if (declared && declared > limit) {
        res.destroy();
        reject(new Error('that file is larger than this app will accept'));
        return;
      }
      const chunks = [];
      let got = 0;
      res.on('data', (c) => {
        got += c.length;
        if (got > limit) { res.destroy(); reject(new Error('that file is larger than this app will accept')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('the update server did not answer')); });
    req.on('error', reject);
  });
}

/* ── Signature ───────────────────────────────────────────────── */

/**
 * A manifest is `{ kind, payload, sig }` where `payload` is base64 of the JSON
 * bytes and `sig` is an Ed25519 signature over those exact bytes.
 *
 * Signing the encoded bytes rather than the parsed object sidesteps the classic
 * trap in signed JSON: two encoders disagreeing about key order or whitespace,
 * which makes a valid signature fail — or worse, invites a "canonicalisation"
 * step subtle enough to have its own bugs. There is one byte string, it is
 * quoted verbatim in the file, and it is the thing that is signed.
 */
function verifyManifest(raw, publicKeyB64) {
  if (!publicKeyB64) {
    return { ok: false, reason: 'This build has no update key, so it will not install updates from the network.' };
  }
  let outer;
  try { outer = JSON.parse(raw.toString('utf8')); } catch {
    return { ok: false, reason: 'The update information could not be read.' };
  }
  if (!outer || outer.kind !== 'gamecut-manifest' || !outer.payload || !outer.sig) {
    return { ok: false, reason: 'That is not a GameCut update manifest.' };
  }

  let payload, sig, key;
  try {
    payload = Buffer.from(outer.payload, 'base64');
    sig = Buffer.from(outer.sig, 'base64');
    key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return { ok: false, reason: 'The update signature is malformed.' };
  }

  let good = false;
  try { good = crypto.verify(null, payload, key, sig); } catch { good = false; }
  if (!good) {
    return { ok: false, reason: 'That update is not signed by this build’s key, so it was refused.' };
  }

  let manifest;
  try { manifest = JSON.parse(payload.toString('utf8')); } catch {
    return { ok: false, reason: 'The signed update information could not be read.' };
  }
  if (!manifest || manifest.product !== 'gamecut') {
    return { ok: false, reason: 'That update is for a different program.' };
  }
  return { ok: true, manifest };
}

/* ── Staged rollout ──────────────────────────────────────────── */

/**
 * A stable yes/no per install, so a staged rollout does not flicker.
 *
 * The id is random, kept locally and never sent anywhere — it exists only so
 * that this machine gives the same answer every time it is asked about the
 * same version. Hashing it with the version means a machine that is early for
 * one release is not systematically early for every release.
 */
function inRollout(installId, version, rollout) {
  const pct = typeof rollout === 'number' ? rollout : 1;
  if (!(pct >= 0)) return true;
  if (pct >= 1) return true;
  if (pct <= 0) return false;
  const h = crypto.createHash('sha256').update(`${installId}:${version}`).digest();
  return (h.readUInt32BE(0) % 10000) < Math.round(pct * 10000);
}

/* ── The updater ─────────────────────────────────────────────── */

/**
 * @param {object} deps
 *   appVersion   – the shell's own version (package.json)
 *   runningVersion – the editor version actually loaded (an installed update, or the shell's)
 *   config       – { manifestUrl, publicKey, checkEveryHours, autoCheck }
 *   userDataDir  – where the install id and the staged download live
 *   onState      – called whenever there is something new to say
 */
function createUpdater({ appVersion, runningVersion, config, userDataDir, onState }) {
  const stateFile = path.join(userDataDir, 'update-state.json');
  const stagedFile = path.join(userDataDir, 'staged.gcupdate');

  let state = {
    /** idle | checking | downloading | ready | uptodate | needs-installer | error | off */
    phase: config.publicKey ? 'idle' : 'off',
    available: null,     // { version, notes, bytes, publishedAt }
    lastCheck: 0,
    lastError: null,
    history: [],
    staged: null,        // { version, path, sha256 }
  };

  /* Persisted so the app does not lose a downloaded update, or forget it has
     already told you about a version, just because it was closed. */
  let persisted = {};
  try { persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { persisted = {}; }
  if (!persisted.installId) {
    persisted.installId = crypto.randomBytes(8).toString('hex');
  }
  if (persisted.staged && fs.existsSync(stagedFile)) {
    state.staged = persisted.staged;
    state.available = persisted.available || null;
    if (state.available) state.phase = 'ready';
  }
  state.history = Array.isArray(persisted.history) ? persisted.history : [];
  state.lastCheck = persisted.lastCheck || 0;
  savePersisted();

  function savePersisted() {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        installId: persisted.installId,
        lastCheck: state.lastCheck,
        staged: state.staged,
        available: state.available,
        history: state.history,
        seen: persisted.seen || null,
      }));
    } catch { /* a state file we cannot write is not worth failing over */ }
  }

  function set(patch) {
    state = { ...state, ...patch };
    savePersisted();
    try { onState?.(publicState()); } catch { /* the window may be gone */ }
  }

  function publicState() {
    return {
      phase: state.phase,
      appVersion,
      runningVersion,
      available: state.available,
      staged: state.staged ? { version: state.staged.version } : null,
      lastCheck: state.lastCheck,
      lastError: state.lastError,
      history: state.history,
      autoCheck: config.autoCheck !== false,
      configured: !!config.publicKey && !/CHANGE-ME/.test(config.manifestUrl || ''),
    };
  }

  /**
   * Ask the server what the latest version is, and fetch it if it is newer.
   *
   * `manual` only changes the reporting: a scheduled check that fails is not
   * worth a message, because a laptop is offline half the time and there is
   * nothing for anyone to do about it. A check you asked for always answers.
   */
  async function check({ manual = false } = {}) {
    if (!config.publicKey) {
      set({ phase: 'off', lastError: null });
      return publicState();
    }
    if (/CHANGE-ME/.test(config.manifestUrl || '')) {
      set({ phase: 'off', lastError: 'No update address is set in this build.' });
      return publicState();
    }
    if (state.phase === 'checking' || state.phase === 'downloading') return publicState();

    set({ phase: 'checking', lastError: null });
    try {
      const raw = await fetchBuffer(config.manifestUrl, {
        manifestUrl: config.manifestUrl, limit: MAX_MANIFEST_BYTES,
      });
      const v = verifyManifest(raw, config.publicKey);
      if (!v.ok) throw new Error(v.reason);

      const m = v.manifest;
      const now = Date.now();
      const history = Array.isArray(m.history) ? m.history.slice(0, 40) : [];

      // Newer than what is actually RUNNING, which is the installed update if
      // there is one — not the shell's own version. Comparing against the shell
      // would offer the same update forever.
      if (compareVersions(m.version, runningVersion) <= 0) {
        set({ phase: 'uptodate', available: null, lastCheck: now, history, lastError: null });
        return publicState();
      }

      if (!inRollout(persisted.installId, m.version, m.rollout)) {
        set({ phase: 'uptodate', available: null, lastCheck: now, history, lastError: null });
        return publicState();
      }

      /**
       * Some releases change the shell itself, and a file swap cannot deliver
       * those — by design, because those files run as Node with the full
       * privileges of the process. The manifest says so, and the app asks for
       * the installer instead of pretending a partial update worked.
       */
      const needsInstaller = !!m.needsInstaller
        || (m.minShell && compareVersions(appVersion, m.minShell) < 0);

      const available = {
        version: m.version,
        notes: Array.isArray(m.notes) ? m.notes : [],
        publishedAt: m.published || null,
        bytes: m.bundle?.bytes || 0,
        needsInstaller,
        installerUrl: needsInstaller && m.installer?.path
          ? new URL(m.installer.path, config.manifestUrl).toString() : null,
      };

      if (needsInstaller) {
        set({ phase: 'needs-installer', available, lastCheck: now, history, lastError: null });
        return publicState();
      }

      if (state.staged?.version === m.version && fs.existsSync(stagedFile)) {
        set({ phase: 'ready', available, lastCheck: now, history, lastError: null });
        return publicState();
      }

      set({ phase: 'downloading', available, lastCheck: now, history });
      const staged = await download(m);
      set({ phase: 'ready', staged, available, lastError: null });
      return publicState();
    } catch (err) {
      const msg = String(err?.message || err);
      set({ phase: state.staged ? 'ready' : 'error', lastError: manual ? msg : null,
            lastCheck: Date.now() });
      if (!manual) set({ lastError: null });
      return publicState();
    }
  }

  /**
   * Fetch the bundle and check it byte for byte before it is allowed near the
   * install path. The address is built from the manifest URL, so it cannot
   * point anywhere else; the hash is inside the signed payload, so a swapped
   * file fails even if the download itself was tampered with.
   */
  async function download(m) {
    const rel = m.bundle?.path;
    if (!rel) throw new Error('That release has no update file attached.');
    const url = new URL(rel, config.manifestUrl).toString();
    const buf = await fetchBuffer(url, { manifestUrl: config.manifestUrl, limit: MAX_BUNDLE_BYTES });

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (!m.bundle.sha256 || sha !== String(m.bundle.sha256).toLowerCase()) {
      throw new Error('The downloaded update did not match its signed checksum, so it was thrown away.');
    }

    // Parse it here as well: a file that is not a GameCut update should be
    // rejected while it is still a download, not halfway through installing.
    let bundle;
    try { bundle = JSON.parse(buf.toString('utf8')); } catch {
      throw new Error('The downloaded update is not readable.');
    }
    if (bundle?.kind !== 'gamecut-update') throw new Error('The downloaded file is not a GameCut update.');
    if (compareVersions(bundle.version, m.version) !== 0) {
      throw new Error('The downloaded update says it is a different version to the one announced.');
    }

    await fsp.mkdir(userDataDir, { recursive: true });
    await fsp.writeFile(stagedFile, buf);
    return { version: m.version, path: stagedFile, sha256: sha };
  }

  /** Forget a staged download — used after it has been installed. */
  async function clearStaged(installedVersion) {
    try { await fsp.rm(stagedFile, { force: true }); } catch { /* already gone */ }
    if (installedVersion) {
      persisted.seen = installedVersion;
    }
    set({ staged: null, available: null, phase: 'uptodate' });
  }

  /** What the "what's new" card should show once, after an update lands. */
  function unseenNotes(version) {
    if (!version) return null;
    if (persisted.seen === version) return null;
    const entry = state.history.find(h => h.version === version);
    return entry ? { version, notes: entry.notes || [] } : null;
  }

  function markSeen(version) {
    persisted.seen = version;
    savePersisted();
  }

  let timer = null;
  function start() {
    if (config.autoCheck === false || !config.publicKey) return;
    const hours = Math.max(1, Number(config.checkEveryHours) || 6);
    // A short delay on launch: opening the app should never wait on a network
    // round trip, and the first thing anyone does is look at their projects.
    setTimeout(() => check().catch(() => {}), 8000);
    timer = setInterval(() => check().catch(() => {}), hours * 3600_000);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return {
    check, start, stop, clearStaged, unseenNotes, markSeen,
    get state() { return publicState(); },
    get stagedPath() { return state.staged ? stagedFile : null; },
  };
}

module.exports = {
  createUpdater,
  compareVersions,
  verifyManifest,
  sameOrigin,
  inRollout,
  fetchBuffer,
};
