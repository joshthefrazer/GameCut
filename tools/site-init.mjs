/**
 * Point everything at your website, once.
 *
 *   npm run site:init https://yourname.github.io/gamecut/
 *   npm run site:init https://gamecut.example.com/
 *
 * One address goes in three places and they must agree, so this writes all
 * three rather than leaving them to be kept in step by hand:
 *
 *   update-config.json   where the app looks for updates (compiled into the .exe)
 *   site/site-config.json  what the page says about itself
 *   site/CNAME           for a custom domain, so GitHub serves it from there
 *
 * Getting this wrong is quiet: the app checks an address that does not exist and
 * simply never finds an update, which looks identical to there being none. So it
 * is checked here instead — the address has to be https (or localhost), it has to
 * end in a folder, and it must not still say CHANGE-ME.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_CONFIG = path.join(ROOT, 'update-config.json');
const SITE_CONFIG = path.join(ROOT, 'site', 'site-config.json');
const CNAME = path.join(ROOT, 'site', 'CNAME');

const raw = process.argv[2];
if (!raw) {
  console.log(`
  Where is the site going to live?

    npm run site:init https://yourname.github.io/gamecut/

  For a GitHub Pages site that is https://<your username>.github.io/<repo name>/
  — note the trailing slash. Later, when you buy a domain, run it again with the
  domain and rebuild the .exe once.
`);
  process.exit(1);
}

let url;
try {
  url = new URL(raw.endsWith('/') ? raw : raw + '/');
} catch {
  die(`"${raw}" is not a web address. It should look like https://yourname.github.io/gamecut/`);
}

const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
if (url.protocol !== 'https:' && !loopback) {
  die('The address has to be https. GitHub Pages and every host worth using give you that for free.');
}
if (/CHANGE-ME/i.test(url.href)) die('That is still the placeholder address.');
if (url.search || url.hash) die('No query strings or #fragments — it is a plain folder address.');

const base = url.href;
const manifestUrl = base + 'update.json';

/* ── Write it everywhere ─────────────────────────────────────── */
const app = JSON.parse(await readFile(APP_CONFIG, 'utf8'));
const hadKey = !!app.publicKey;
app.manifestUrl = manifestUrl;
await writeFile(APP_CONFIG, JSON.stringify(app, null, 2) + '\n');

const site = JSON.parse(await readFile(SITE_CONFIG, 'utf8'));
site.baseUrl = base;
await writeFile(SITE_CONFIG, JSON.stringify(site, null, 2) + '\n');

/**
 * CNAME only for a real domain.
 *
 * GitHub reads this file to know which domain to serve the site from. Leaving
 * one behind that says `yourname.github.io` makes Pages fight itself, so a
 * github.io address removes it rather than writing one.
 */
const isGithubIo = /\.github\.io$/i.test(url.hostname);
if (isGithubIo || loopback) {
  await rm(CNAME, { force: true });
} else {
  await writeFile(CNAME, url.hostname + '\n');
}

/* ── Say what happens next, in terms of THIS repository ──────── */

/**
 * A github.io address tells us the account and the repository, so the
 * instructions can name them rather than leaving the reader to translate
 * "your username" into their own.
 */
const gh = isGithubIo
  ? { user: url.hostname.replace(/\.github\.io$/i, ''),
      repo: url.pathname.replace(/^\/|\/$/g, '') }
  : null;

console.log('\n  ── the site is aimed ─────────────────────────────────\n');
console.log(`  Address            ${base}`);
console.log(`  Updates read       ${manifestUrl}`);
console.log(`  Published from     ${site.publishDir || 'docs'}/  (committed to the repo)`);
console.log(`  Custom domain      ${isGithubIo || loopback ? 'no \u2014 github.io' : url.hostname + ' \u2014 site/CNAME written'}`);
console.log(`  Signing key        ${hadKey ? 'already set' : 'NOT SET'}`);

if (!hadKey) {
  console.log(`
  \u2716 No signing key yet. Nothing can be published until there is one:

      npm run keygen`);
}

console.log(`
  Next:

      npm run dist        build the .exe (carries this address and your key)
      npm run release     build the site into ${site.publishDir || 'docs'}/
      git add -A && git commit -m "Release" && git push
`);

if (gh) {
  console.log(`  Then, once, on GitHub:

      github.com/${gh.user}/${gh.repo}/settings/pages
      Source: Deploy from a branch \u2192 your default branch \u2192 /${site.publishDir || 'docs'}

  The repository root already has an index.html \u2014 that one is the EDITOR.
  Serving Pages from / would hand people the app instead of the website, which
  is why the site is published from ${site.publishDir || 'docs'}/ instead.

  Note the capitals: ${base} is case-sensitive.
`);
} else if (!loopback) {
  console.log(`  Point ${url.hostname} at your host, and serve the ${site.publishDir || 'docs'}/ folder.\n`);
}

function die(msg) {
  console.error('\n  ✖ ' + msg + '\n');
  process.exit(1);
}
