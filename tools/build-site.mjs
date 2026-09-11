/**
 * Render the website into the publish folder (docs/ by default).
 *
 * Called by `npm run release` so the page and the update manifest are always
 * built from the same numbers — a download page advertising a version the
 * updater does not offer is the sort of thing nobody notices until a friend
 * asks why their copy says something different.
 *
 * Everything on the page comes from somewhere that already exists:
 *   version   package.json
 *   notes     CHANGELOG.md
 *   address   site/site-config.json  (written by `npm run site:init`)
 * There is no content to keep in two places.
 */
import { readFile, writeFile, mkdir, readdir, copyFile, access, rm } from 'node:fs/promises';
import path from 'node:path';

/** HTML-escape. Release notes are your prose, and prose contains & and <. */
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const fmtDate = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

const fmtBytes = (n) => {
  if (!n) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

/**
 * Build the page.
 *
 * @param {object} o
 *   root        the project folder
 *   site        where to write it
 *   version     the version being announced
 *   history     [{version, published, notes}] newest first
 *   installer   { name, bytes } or null — the .exe sitting beside the page
 */
export async function buildSite({ root, site, version, history, installer }) {
  const srcDir = path.join(root, 'site');
  const cfg = JSON.parse(await readFile(path.join(srcDir, 'site-config.json'), 'utf8'));
  const template = await readFile(path.join(srcDir, 'index.template.html'), 'utf8');

  if (!cfg.baseUrl) {
    throw new Error('The site has no address yet. Run: npm run site:init https://yourname.github.io/gamecut/');
  }

  /* ── Where Download points ─────────────────────────────────── */
  let href = '#changes';
  let attrs = '';
  let note = '';
  const external = cfg.installer && cfg.installer !== 'folder';

  if (external) {
    href = String(cfg.installer);
    attrs = ' rel="noopener"';
    note = `Windows 10 and 11 · free · no account`;
  } else if (installer) {
    href = installer.name;
    attrs = ' download';
    note = `Windows 10 and 11 · ${fmtBytes(installer.bytes)} · free · no account`;
  } else if (cfg.lastInstaller?.name) {
    // An editor-only release does not rebuild the .exe. The button keeps
    // pointing at the last one that was published rather than breaking.
    href = cfg.lastInstaller.name;
    attrs = ' download';
    note = `Windows 10 and 11 · installer v${cfg.lastInstaller.version} · `
         + `updates to ${version} by itself on first run`;
  } else {
    note = 'No Windows build has been published yet — run npm run dist, then npm run release again.';
  }

  /* ── The changelog ─────────────────────────────────────────── */
  const releases = (history || []).map((r, i) => {
    const items = (r.notes || []).map(n => `          <li>${esc(n)}</li>`).join('\n');
    return `      <article class="rel">
        <div class="rel__head">
          <span class="rel__v">${esc(r.version)}</span>
          ${i === 0 ? '<span class="rel__now">Current</span>' : ''}
          <span class="rel__when">${esc(fmtDate(r.published))}</span>
        </div>
${items ? `        <ul>\n${items}\n        </ul>` : ''}
      </article>`;
  }).join('\n');

  const html = template
    .replaceAll('{{NAME}}', esc(cfg.name || 'GameCut'))
    .replaceAll('{{TAGLINE}}', esc(cfg.tagline || ''))
    .replaceAll('{{BLURB}}', esc(cfg.blurb || ''))
    .replaceAll('{{VERSION}}', esc(version))
    .replaceAll('{{BASE}}', esc(cfg.baseUrl))
    .replaceAll('{{INSTALLER_HREF}}', esc(href))
    .replaceAll('{{INSTALLER_ATTRS}}', attrs)
    .replaceAll('{{INSTALLER_NOTE}}', esc(note))
    .replaceAll('{{CHANGELOG}}', releases || '<p>Nothing published yet.</p>');

  const left = html.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error('the page still has placeholders in it: ' + [...new Set(left)].join(', '));

  /* ── Write ─────────────────────────────────────────────────── */
  await mkdir(path.join(site, 'shots'), { recursive: true });
  await writeFile(path.join(site, 'index.html'), html);
  await copyFile(path.join(srcDir, 'site.css'), path.join(site, 'site.css'));

  for (const f of await readdir(path.join(srcDir, 'shots'))) {
    if (f.startsWith('.')) continue;
    await copyFile(path.join(srcDir, 'shots', f), path.join(site, 'shots', f));
  }

  // Stops GitHub Pages running the whole folder through Jekyll, which would
  // otherwise quietly drop anything it does not recognise.
  await writeFile(path.join(site, '.nojekyll'), '');

  const cname = path.join(srcDir, 'CNAME');
  if (await access(cname).then(() => true, () => false)) {
    await copyFile(cname, path.join(site, 'CNAME'));
  } else {
    await rm(path.join(site, 'CNAME'), { force: true });
  }

  /* Remember the installer so the next editor-only release can still link it. */
  if (installer) {
    cfg.lastInstaller = { name: installer.name, version };
    await writeFile(path.join(srcDir, 'site-config.json'), JSON.stringify(cfg, null, 2) + '\n');
  }

  return { baseUrl: cfg.baseUrl, downloadHref: href, releases: (history || []).length };
}
