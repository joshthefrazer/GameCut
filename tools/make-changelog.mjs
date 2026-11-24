/**
 * CHANGELOG.md → assets/changelog.json, so the update log is in the app itself
 * (it used to come only from the internet: offline, or on a copy the site does
 * not know yet, it was empty).
 *   node tools/make-changelog.mjs           write it
 *   node tools/make-changelog.mjs --check   fail if it is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export function readChangelog(md) {
  const out = [];
  let rel = null, item = null;
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const h = line.match(/^##\s+(\d+\.\d+\.\d+)\b/);
    if (h) { rel = { version: h[1], intro: '', notes: [] }; out.push(rel); item = null; continue; }
    if (!rel) continue;
    if (/^#/.test(line)) { item = null; continue; }
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) { rel.notes.push(b[1]); item = rel.notes.length - 1; continue; }
    if (!line.trim()) { item = null; continue; }
    if (item != null) rel.notes[item] += ' ' + line.trim();
    else if (!rel.notes.length) rel.intro += (rel.intro ? ' ' : '') + line.trim();
  }
  const tidy = (s) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return out.slice(0, 40).map(r => ({ version: r.version, intro: tidy(r.intro), notes: r.notes.map(tidy) }));
}
const file = path.join(ROOT, 'assets', 'changelog.json');
const text = JSON.stringify(readChangelog(readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')), null, 1) + '\n';
if (process.argv.includes('--check')) {
  let have = '';
  try { have = readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (have !== text) { console.error('assets/changelog.json is out of date: node tools/make-changelog.mjs'); process.exit(1); }
  console.log('the built-in update log matches CHANGELOG.md');
} else { writeFileSync(file, text); console.log('wrote assets/changelog.json'); }
