/**
 * Publish a release.
 *
 *   npm run release
 *   npm run release -- --rollout 0.25
 *   npm run release -- --hold
 *
 * Produces `docs/` — the website and the update files together, in the folder
 * GitHub Pages serves. Commit it and push, and every GameCut install pointed at
 * that address sees the new version within a few hours, or immediately if
 * someone presses Check now. (The folder is `publishDir` in
 * site/site-config.json; anywhere static works, not only Pages.)
 *
 * What it does, in order:
 *   1. Packs index.html + src / styles / vendor / assets into one .gcupdate.
 *   2. Notices whether the shell changed. If electron-main.cjs, preload.cjs or
 *      package.json moved since the last release, a file swap is not enough and
 *      the manifest says so, so installs ask for the new .exe instead of quietly
 *      half-updating.
 *   3. Reads the release notes out of CHANGELOG.md — the section under the
 *      heading for this version — so the notes your friends read and the notes
 *      you wrote are the same text.
 *   4. Signs the manifest with the private key from `npm run keygen`.
 *
 * The manifest is signed as a base64 blob rather than as readable JSON. That is
 * not obfuscation: signing the exact bytes is what makes verification simple and
 * exact, with no question of key order or whitespace. `update.txt` is
 * written alongside it in plain text so you can read what you just published.
 *
 * You control the rollout by what you upload and when. `--hold` publishes the
 * files but leaves the announced version where it was, so you can put a build
 * in place and switch it on later by re-running without the flag.
 */
import { readFile, writeFile, readdir, mkdir, rm, copyFile, access, stat } from 'node:fs/promises';
import { buildSite } from './build-site.mjs';
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
/**
 * Where the finished site is written.
 *
 * `docs/` by default, because that is a folder GitHub Pages will serve as-is —
 * so publishing is `git push` rather than dragging files into a web host. It
 * also sidesteps a trap: the repository root already has an `index.html`, which
 * is the EDITOR's, and a Pages site served from the root would hand people that
 * instead of the website.
 */
const siteCfg = JSON.parse(
  await readFile(path.join(ROOT, 'site', 'site-config.json'), 'utf8'));
const SITE = path.isAbsolute(siteCfg.publishDir || '')
  ? siteCfg.publishDir
  : path.join(ROOT, siteCfg.publishDir || path.join('dist', 'site'));
const DIRS = ['src', 'styles', 'vendor', 'assets'];
const FILES = ['index.html'];
/**
 * Two different questions, which used to share one answer.
 *
 * REBUILD — "does the .exe need building again?" A version bump alone is enough:
 * the number is baked into the installer's name, its Add/Remove entry and its
 * version resource. So is the publisher name, and so is anything under "build".
 *
 * SHELL — "can an existing install take this release as a file swap?" Only the
 * main process can answer that, and it is a much shorter list. An update
 * replaces the editor's files; it cannot replace the code that loads them.
 *
 * Conflating the two is what made every release since 1.5.0 report a shell
 * change on its first pass — because bumping the version edits package.json —
 * and it would have made the flag useless in the other direction too: an
 * `needsInstaller: true` on every single release trains people to ignore it.
 */
const SHELL = ['electron-main.cjs', 'preload.cjs', 'update-config.json', 'updater.cjs'];
/**
 * SHELL, plus everything that changes what the INSTALLER looks like or calls
 * itself. None of this reaches an existing install — an icon is not code — but
 * all of it is baked into the .exe, so a release that changes any of it and
 * does not rebuild ships a download that still wears the old logo and credits
 * the old publisher, which is exactly what 1.6.0 was for.
 */
const REBUILD = [...SHELL,
  path.join('build', 'installer.nsh'),
  path.join('build', 'icon.ico'),
  path.join('build', 'installer-side.bmp')];
/**
 * The parts of package.json a file update cannot deliver.
 *
 * `main` names the file Electron runs, `dependencies` are what ends up in
 * node_modules inside the asar, and `build` decides how the app is packaged.
 * Change any of those and the shell someone already has is the wrong shell.
 * `version`, `author`, `scripts` and the rest are not in here on purpose: they
 * matter to the installer, not to whether the editor can be swapped in.
 */
const SHELL_PKG_FIELDS = ['main', 'dependencies', 'build'];
/** What the installer takes from package.json: its name, its publisher, its packaging. */
const REBUILD_PKG_FIELDS = [...SHELL_PKG_FIELDS, 'author', 'productName', 'description', 'copyright'];
const NATIVE_STAMP = path.join(ROOT, 'dist', '.native-hash');
const KEY_FILE = process.env.GAMECUT_KEY
  || path.join(process.env.GAMECUT_KEY_DIR || path.join(homedir(), '.gamecut'), 'signing-key.pem');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const has = (name) => argv.includes('--' + name);

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const config = JSON.parse(await readFile(path.join(ROOT, 'update-config.json'), 'utf8'));
const version = String(flag('version') || pkg.version);
const rollout = Number(flag('rollout', 1));
const hold = has('hold');

/* ── Checks worth failing on rather than publishing something broken ── */
if (!config.publicKey) {
  die('No signing key yet. Run `npm run keygen` once, then rebuild the .exe so every copy carries the public half.');
}
if (/CHANGE-ME/.test(config.manifestUrl || '')) {
  die('update-config.json still has the placeholder address.\n'
    + '  Set "manifestUrl" to where update.json will live, e.g.\n'
    + '  https://yourname.github.io/gamecut/update.json');
}
if (!(await access(KEY_FILE).then(() => true, () => false))) {
  die(`No private key at ${KEY_FILE}.\n  That file is what signs a release. Run \`npm run keygen\`, or set GAMECUT_KEY.`);
}

function die(msg) {
  console.error('\n  ✖ ' + msg + '\n');
  process.exit(1);
}

/* ── Pack the editor ─────────────────────────────────────────── */
async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

const files = {};
for (const f of FILES) files[f] = await readFile(path.join(ROOT, f), 'utf8');
for (const d of DIRS) {
  for (const abs of await walk(path.join(ROOT, d))) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    files[rel] = await readFile(abs, 'utf8');
  }
}

/* ── Did anything that needs a rebuild change? ───────────────── */
/**
 * A fingerprint of some files plus some package.json fields.
 *
 * `version` is in neither list, deliberately. Bumping it is what a release IS,
 * so counting it as a change would make every release report that everything
 * changed — which is how "the app shell changed" came to be printed on every
 * single publish, and why nobody would have believed it when it mattered.
 */
async function fingerprint(list, pkgFields) {
  const h = createHash('sha256');
  for (const n of list) {
    try { h.update(await readFile(path.join(ROOT, n))); } catch { h.update('absent'); }
  }
  h.update(JSON.stringify(pkgFields.map(f => pkg[f] ?? null)));
  return h.digest('hex').slice(0, 16);
}
const nativeHash = await fingerprint(REBUILD, REBUILD_PKG_FIELDS);
const shellHash = await fingerprint(SHELL, SHELL_PKG_FIELDS);

/**
 * Did the shell change since the last RELEASE — not since the last run?
 *
 * PUBLISH.bat runs this script twice for a release that needs a new .exe: once
 * to discover that it does, then again once the installer has been built so it
 * can be copied in beside the manifest. The stamp is rewritten on every run, so
 * comparing "since last run" made the second pass compare against the first —
 * against itself — conclude nothing had changed, and publish a manifest saying
 * `needsInstaller: false`.
 *
 * That is the worst possible answer. It tells every existing install it can
 * take this release as a file update, when the whole reason the release needed
 * an installer is that a file update cannot carry a new main process. The
 * result would be the new editor running on the old shell: no error anyone
 * could act on, just an app that half works.
 *
 * The second pass is not "a new release with an unchanged shell" — it is the
 * SAME release, run again with the installer now built. The two are told apart
 * by version and fingerprint together, and the verdict is remembered rather
 * than recomputed. Editing the main process without bumping the version still
 * reports a change, and a later version with renderer-only edits still installs
 * by itself rather than demanding an installer forever after one that needed one.
 */
let stamp = null;
try {
  const raw = (await readFile(NATIVE_STAMP, 'utf8')).trim();
  // Stamps written before this fix are a bare fingerprint of the old combined
  // list. There is nothing useful to carry forward from one, so it is treated
  // as "no previous release" rather than compared against a different formula.
  stamp = raw.startsWith('{') ? JSON.parse(raw) : null;
} catch { /* first release on this machine */ }

const samePublish = !!stamp
  && stamp.version === version
  && stamp.hash === nativeHash
  && stamp.shellHash === shellHash;

const shellChanged = samePublish
  ? !!stamp.shellChanged
  : (stamp ? stamp.shellHash !== shellHash : false);

/**
 * Whether the .exe itself is out of date — a different question. See REBUILD.
 *
 * Not true on a first run with no stamp: someone who has simply never built a
 * Windows binary is in an ordinary state, and the missing-installer clause
 * further down covers the case that actually matters.
 */
const rebuildNeeded = samePublish
  ? !!stamp.rebuildNeeded
  : (stamp ? stamp.hash !== nativeHash : false);

/* ── Release notes ───────────────────────────────────────────── */

/**
 * Pull the bullet points for this version out of CHANGELOG.md.
 *
 * One source of truth: the file you write for yourself is the text your friends
 * read in the app. A release with no section for its own version stops here
 * rather than shipping an empty "what's new", because an update that cannot say
 * what changed is the kind nobody trusts enough to install.
 */
async function notesFor(v) {
  let md = '';
  try { md = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8'); } catch { return null; }
  const lines = md.split('\n');
  const start = lines.findIndex(l => new RegExp(`^#{1,3}\\s.*\\b${v.replace(/\./g, '\\.')}\\b`).test(l));
  if (start < 0) return null;
  /**
   * A bullet is everything up to the next bullet, not just its first line.
   *
   * Markdown wraps; a note written over three lines is still one note. Reading
   * only the first line silently truncated every sentence in the changelog at
   * about eighty characters — in the app AND on the website — which read like
   * the text had been cut off mid-thought, because it had.
   */
  const out = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      if (current) out.push(current);
      current = m[1];
    } else if (current !== null && line.trim()) {
      current += ' ' + line.trim();
    } else if (current !== null && !line.trim()) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out.length
    ? out.map(t => t.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim())
    : null;
}

const notes = await notesFor(version);
if (!notes && !has('no-notes')) {
  die(`CHANGELOG.md has no section for ${version}.\n`
    + `  Add one:\n\n    ## ${version}\n\n    - What you changed\n\n`
    + '  Or pass --no-notes if this release genuinely has nothing to say.');
}

/* ── Previous history, so the in-app log keeps its past ──────── */
let history = [];
try {
  const prev = JSON.parse(await readFile(path.join(SITE, 'update.json'), 'utf8'));
  const payload = JSON.parse(Buffer.from(prev.payload, 'base64').toString('utf8'));
  history = Array.isArray(payload.history) ? payload.history : [];
} catch { /* first release, or the site folder was cleaned */ }

history = [
  { version, published: new Date().toISOString(), notes: notes || [] },
  ...history.filter(h => h.version !== version),
].slice(0, 40);

/* ── Write it all out ────────────────────────────────────────── */
/* The folder is NOT wiped between releases. It mirrors what is uploaded, and
   an editor-only release does not rebuild the .exe — deleting it would leave
   the Download button pointing at nothing. Old update bundles are pruned
   below instead, which is the only thing that actually accumulates. */
await mkdir(SITE, { recursive: true });

const bundle = {
  kind: 'gamecut-update',
  version,
  note: (notes || [])[0] || '',
  builtAt: new Date().toISOString(),
  files,
};
const bundleText = JSON.stringify(bundle);
const bundleName = `GameCut-${version}.gcupdate`;
await writeFile(path.join(SITE, bundleName), bundleText);
const sha256 = createHash('sha256').update(Buffer.from(bundleText, 'utf8')).digest('hex');

/**
 * The installer, if electron-builder has made one for THIS version.
 *
 * Only an exact version match is copied. An .exe left over from an earlier
 * build is not this release, and publishing it under this release's name would
 * hand somebody the wrong program — the site falls back to the last installer
 * it genuinely published instead, which it remembers in site-config.json.
 */
let installer = null;
for (const guess of [
  `GameCut-${version}-x64.exe`,
  `GameCut Setup ${version}.exe`,
  `GameCut-${version}.exe`,
]) {
  const from = path.join(ROOT, 'dist', guess);
  if (await access(from).then(() => true, () => false)) {
    await copyFile(from, path.join(SITE, guess));
    installer = { name: guess, bytes: (await stat(from)).size };
    /**
     * GitHub refuses any single file over 100 MB, and the push fails outright
     * rather than warning. Better to hear it here than after a five-minute
     * upload dies.
     */
    if (installer.bytes > 90 * 1024 * 1024) {
      console.log(`\n  \u26a0  ${guess} is ${(installer.bytes / 1048576).toFixed(0)} MB.`);
      console.log('     GitHub rejects any file over 100 MB. If this grows, put the');
      console.log('     installer in a GitHub Release instead and set "installer" in');
      console.log('     site/site-config.json to that download link.');
    }
    break;
  }
}
const installerName = installer?.name || null;

/**
 * Prune what would otherwise pile up.
 *
 * Update bundles are small; three is plenty. Installers are ninety megabytes
 * each, and a folder with five of them is a folder nobody wants to clone — so
 * only the one the page actually links to survives. Git still remembers the
 * old ones in its history, which is why the size warning below exists.
 */
const keepBundles = new Set([bundleName]);
for (const h of history.slice(1, 3)) keepBundles.add(`GameCut-${h.version}.gcupdate`);
const keepExe = installer?.name || siteCfg.lastInstaller?.name || null;
for (const f of await readdir(SITE).catch(() => [])) {
  if (f.endsWith('.gcupdate') && !keepBundles.has(f)) await rm(path.join(SITE, f), { force: true });
  if (f.endsWith('.exe') && f !== keepExe) await rm(path.join(SITE, f), { force: true });
}

const announced = hold
  ? (history[1]?.version || version)
  : version;

const manifest = {
  product: 'gamecut',
  channel: String(flag('channel', 'stable')),
  version: announced,
  published: new Date().toISOString(),
  rollout: Math.max(0, Math.min(1, isFinite(rollout) ? rollout : 1)),
  needsInstaller: shellChanged,
  minShell: shellChanged ? version : (flag('min-shell') || null),
  bundle: { path: bundleName, sha256, bytes: Buffer.byteLength(bundleText) },
  installer: installerName ? { path: installerName } : null,
  notes: notes || [],
  history,
};

const payload = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
const key = createPrivateKey(await readFile(KEY_FILE, 'utf8'));
const sig = cryptoSign(null, payload, key);

await writeFile(path.join(SITE, 'update.json'), JSON.stringify({
  kind: 'gamecut-manifest',
  payload: payload.toString('base64'),
  sig: sig.toString('base64'),
}, null, 2) + '\n');

// The same thing in plain text, for you rather than for the app.
await writeFile(path.join(SITE, 'update.txt'),
  JSON.stringify(manifest, null, 2) + '\n');
// The stamp lives in dist/ next to whatever electron-builder made, which may
// not exist yet on a machine that has never run a build.
await mkdir(path.dirname(NATIVE_STAMP), { recursive: true });
// The verdict is stored, not just the fingerprint: a second pass on the same
// version with the same shell has to reach the same conclusion as the first.
await writeFile(NATIVE_STAMP, JSON.stringify({
  version, hash: nativeHash, shellHash, shellChanged, rebuildNeeded,
}) + '\n');

/* ── The page ── */
let siteInfo = null;
try {
  siteInfo = await buildSite({ root: ROOT, site: SITE, version: announced, history, installer });
} catch (err) {
  die(String(err.message || err));
}

/* ── Say what happened ───────────────────────────────────────── */
const kb = (bundleText.length / 1024).toFixed(0);
console.log('\n  ── ready to upload ───────────────────────────────────');
console.log(`\n  ${SITE}`);
console.log(`    index.html           the website · ${siteInfo.releases} release(s) listed`);
console.log(`    site.css  shots/     how it looks`);
console.log(`    update.json          the manifest, signed`);
console.log(`    ${bundleName}${' '.repeat(Math.max(1, 21 - bundleName.length))}${Object.keys(files).length} files · ${kb} KB`);
if (installerName) console.log(`    ${installerName}`);
console.log(`    update.txt           the same manifest in plain text, for you`);
console.log(`\n  Version announced    ${announced}${hold ? '   (HELD — files are up, nobody is told yet)' : ''}`);
console.log(`  Rollout              ${Math.round(manifest.rollout * 100)}% of installs`);
console.log(`  Notes                ${(notes || []).length} line(s)`);
console.log(`  Update address       ${config.manifestUrl}`);

if (shellChanged) {
  console.log('\n  ⚠  The app shell changed since the last release.');
  console.log('     A file update cannot deliver this one, so the manifest asks');
  console.log('     installs for the new .exe instead. Build it with');
  console.log('     BUILD-WINDOWS.bat (or npm run dist) and re-run this so the');
  console.log('     installer is copied in beside the manifest.');
} else if (!stamp) {
  console.log('\n  (first release — nothing to compare the shell against yet)');
} else {
  console.log('\n  Nothing in the shell changed: this one installs by itself.');
}
console.log(`\n  Download button      ${siteInfo.downloadHref}`);
/**
 * Tell the caller, not just the reader, when an installer is missing.
 *
 * PUBLISH.bat reacts to this: it runs the release, and if the answer is "this
 * one needs a new .exe", it builds one and runs the release again. Behind a
 * flag so the ordinary command still succeeds when there is simply no Windows
 * build yet — which is a normal state, not a failure.
 */
// rebuildNeeded, not shellChanged: PUBLISH.bat is asking "is the .exe on disk
// the right one for this version", which a plain version bump already answers.
const needsExe = has('require-installer')
  && (rebuildNeeded || (!installer && !siteCfg.lastInstaller?.name));

const rel = path.relative(ROOT, SITE) || SITE;
console.log(`\n  Publish it:\n`);
console.log(`    git add ${rel} && git commit -m "Release ${announced}" && git push`);
console.log(`\n  It becomes ${siteInfo.baseUrl}\n`);

/* How heavy is the folder getting? Installers are the only thing here with
   real weight, and git keeps every one it has ever seen. */
let siteBytes = 0;
for (const f of await readdir(SITE)) {
  try { siteBytes += (await stat(path.join(SITE, f))).size; } catch { /* a folder */ }
}
if (siteBytes > 120 * 1024 * 1024) {
  console.log(`  \u26a0  ${rel}/ is ${(siteBytes / 1048576).toFixed(0)} MB, and git keeps every`);
  console.log('     version of the installer it has ever seen. When that starts to');
  console.log('     hurt, upload the .exe to a GitHub Release instead and put its');
  console.log('     download link in "installer" in site/site-config.json.\n');
}

if (needsExe) {
  console.log('  \u25b6  This release needs a Windows build that does not exist yet.');
  console.log('     Building it now, then publishing again.\n');
  process.exit(3);
}
