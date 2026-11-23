/**
 * Static check, no app needed: every relative import in src/ points at a file
 * that exists and exports the names imported from it.
 *   node qa/check-imports.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) files.push(p);
  }
})(path.join(root, 'src'));

const exportsOf = new Map();
function exp(file) {
  if (exportsOf.has(file)) return exportsOf.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const s = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) s.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) s.add(n); }
  }
  if (/export\s+default/.test(src)) s.add('default');
  if (/export\s*\*\s*from/.test(src)) s.add('*');
  exportsOf.set(file, s);
  return s;
}

let problems = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /import\s+([\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const spec = m[2] || m[3] || m[4];
    const target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) { problems++; console.log(`MISSING FILE  ${path.relative(root, f)} -> ${spec}`); continue; }
    if (!m[1]) continue;
    const clause = m[1];
    const names = [];
    const brace = clause.match(/\{([\s\S]*)\}/);
    if (brace) for (const part of brace[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (n) names.push(n); }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, '').trim();
    if (def) names.push('default');
    const ex = exp(target);
    if (ex.has('*')) continue;
    for (const n of names) if (!ex.has(n)) { problems++; console.log(`NO EXPORT     ${path.relative(root, f)} imports '${n}' from ${spec}`); }
  }
}
console.log(`checked ${files.length} files, problems: ${problems}`);
process.exit(problems ? 1 : 0);
