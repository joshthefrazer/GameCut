/**
 * Look at the site before you push it.
 *
 *   npm run site:preview
 *
 * Serves the built site on http://localhost:8080 so you can see exactly what your
 * friends will see. It is the built folder, not the template — what you are
 * looking at is the thing that gets published, byte for byte.
 *
 * Bound to 127.0.0.1 on purpose: this is for you, not for the neighbours.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(await readFile(path.join(ROOT, 'site', 'site-config.json'), 'utf8'));
const SITE = path.isAbsolute(cfg.publishDir || '')
  ? cfg.publishDir
  : path.join(ROOT, cfg.publishDir || path.join('dist', 'site'));
const REL = path.relative(ROOT, SITE) || SITE;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.exe': 'application/octet-stream',
  '.gcupdate': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

if (!(await stat(SITE).then(s => s.isDirectory(), () => false))) {
  console.error(`\n  \u2716 ${REL}/ does not exist yet. Run \`npm run release\` first.\n`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';

  // Never serve outside the folder, however creative the request is.
  const abs = path.join(SITE, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(SITE)) { res.writeHead(403); res.end('no'); return; }

  try {
    const body = await readFile(abs);
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h1>404</h1><p>Not in ${REL}.</p>`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  GameCut site → http://localhost:${PORT}\n`);
  console.log(`  This is ${REL}/, exactly as GitHub Pages will serve it.`);
  console.log('  Ctrl+C to stop.\n');
});
