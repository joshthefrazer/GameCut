/**
 * Pack the editor's files into a single .gcupdate for GameCut to install.
 *
 *   node tools/make-update.mjs 1.1.0 "What changed"
 *
 * Writes dist/GameCut-<version>.gcupdate — one JSON file holding index.html and
 * everything under src/ styles/ vendor/ assets/, which is exactly the set the
 * app serves over app://.
 *
 * Why JSON rather than a zip: Node has no zip reader built in, and adding a
 * dependency for this would reintroduce the `npm install` that the whole point
 * of this format is to avoid. Every file involved is text, so an object of
 * path -> contents does the job with nothing to install on either side.
 *
 * It deliberately cannot carry electron-main.cjs, preload.cjs or package.json.
 * Those run as Node with full privileges, so they only ever change through a
 * real rebuild — and this script SAYS SO when it notices they have changed
 * since the last packed update, because that is the moment a plain file swap
 * stops being enough and a rebuild is genuinely required.
 */
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIRS = ['src', 'styles', 'vendor', 'assets'];
const FILES = ['index.html'];
/** Changing any of these means the .exe has to be rebuilt. */
const NATIVE = ['electron-main.cjs', 'preload.cjs', 'package.json'];
const STAMP = path.join(ROOT, 'dist', '.native-hash');

const version = process.argv[2] || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const note = process.argv[3] || '';

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
let bytes = 0;
for (const f of FILES) {
  files[f] = await readFile(path.join(ROOT, f), 'utf8');
  bytes += files[f].length;
}
for (const d of DIRS) {
  for (const abs of await walk(path.join(ROOT, d))) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const body = await readFile(abs, 'utf8');
    files[rel] = body;
    bytes += body.length;
  }
}

/* Has anything that needs a rebuild changed since the last update was packed? */
const h = createHash('sha256');
for (const n of NATIVE) {
  try { h.update(await readFile(path.join(ROOT, n))); } catch { /* absent */ }
}
const nativeHash = h.digest('hex').slice(0, 16);
let previous = null;
try { previous = (await readFile(STAMP, 'utf8')).trim(); } catch { /* first run */ }

const bundle = {
  kind: 'gamecut-update',
  version,
  note,
  builtAt: new Date().toISOString(),
  needsRebuild: previous !== null && previous !== nativeHash,
  files,
};

await mkdir(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', `GameCut-${version}.gcupdate`);
await writeFile(out, JSON.stringify(bundle));
await writeFile(STAMP, nativeHash);

const kb = (JSON.stringify(bundle).length / 1024).toFixed(0);
console.log(`\n  ${out}`);
console.log(`  ${Object.keys(files).length} files · ${kb} KB · version ${version}`);
if (bundle.needsRebuild) {
  console.log('\n  ⚠  electron-main.cjs / preload.cjs / package.json changed.');
  console.log('     This update alone is NOT enough — the .exe has to be rebuilt.\n');
} else if (previous === null) {
  console.log('\n  (first pack — no rebuild comparison available yet)\n');
} else {
  console.log('\n  Nothing native changed: installing this file is enough.\n');
}
