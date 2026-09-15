/**
 * The website, built and inspected.
 *
 * The page and the update manifest are generated from the same run, and the
 * failure everyone ships at least once is the two disagreeing — a download page
 * advertising a version the updater does not offer, or a Download button
 * pointing at a file that is not in the folder. Both are invisible until a
 * friend asks why their copy says something different, so both are asserted
 * here, against the real output of the real tool.
 *
 * It runs in a temporary copy of the project with a throwaway signing key, so
 * it never touches the real update-config.json and never needs your real key.
 */
import { mkdtemp, cp, rm, readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

const problems = [];
const log = (t, m) => { problems.push(`${t}: ${m}`); console.log(`  !! ${t}: ${m}`); };
const step = async (name, fn) => {
  const before = problems.length;
  try { await fn(); } catch (e) { log('THREW in ' + name, e.message); }
  console.log(`  ${problems.length === before ? 'ok  ' : 'FAIL'} ${name}`);
};

console.log('\n── the website ──────────────────────────');

/* ── A disposable copy of the project ────────────────────────── */
const WORK = await mkdtemp(path.join(tmpdir(), 'gamecut-site-'));
const KEYS = path.join(WORK, 'keys');
const PROJ = path.join(WORK, 'proj');
await mkdir(KEYS, { recursive: true });
await mkdir(PROJ, { recursive: true });

for (const entry of ['tools', 'site', 'src', 'styles', 'vendor', 'assets',
                     'index.html', 'package.json', 'update-config.json',
                     'updater.cjs', 'electron-main.cjs', 'preload.cjs', 'CHANGELOG.md']) {
  const from = path.join(ROOT, entry);
  if (await access(from).then(() => true, () => false)) {
    await cp(from, path.join(PROJ, entry), { recursive: true });
  }
}

const env = { ...process.env, GAMECUT_KEY_DIR: KEYS };
const node = (script, args = []) =>
  run(process.execPath, [path.join(PROJ, 'tools', script), ...args], { cwd: PROJ, env });

/** Same, but reports the exit code instead of throwing on a non-zero one. */
const nodeCode = async (script, args = []) => {
  try { await node(script, args); return 0; } catch (e) { return e.code ?? -1; }
};

const pkg = JSON.parse(await readFile(path.join(PROJ, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const BASE = 'https://example.github.io/gamecut/';
const siteCfg = JSON.parse(await readFile(path.join(PROJ, 'site', 'site-config.json'), 'utf8'));
const SITE = path.join(PROJ, siteCfg.publishDir || path.join('dist', 'site'));

/* ── Setting it up ───────────────────────────────────────────── */
await step('site:init writes the address into both configs', async () => {
  await node('keygen.mjs');
  await node('site-init.mjs', [BASE]);

  const app = JSON.parse(await readFile(path.join(PROJ, 'update-config.json'), 'utf8'));
  const site = JSON.parse(await readFile(path.join(PROJ, 'site', 'site-config.json'), 'utf8'));
  if (app.manifestUrl !== BASE + 'update.json') throw new Error('the app points at ' + app.manifestUrl);
  if (site.baseUrl !== BASE) throw new Error('the site thinks it is at ' + site.baseUrl);
  if (!app.publicKey) throw new Error('keygen did not write a public key');
  if (await access(path.join(PROJ, 'site', 'CNAME')).then(() => true, () => false)) {
    throw new Error('a CNAME was written for a github.io address, which breaks Pages');
  }
});

await step('a bad address is refused rather than half-written', async () => {
  const before = await readFile(path.join(PROJ, 'update-config.json'), 'utf8');
  for (const bad of ['http://plain.example.com/', 'not-a-url', 'https://x.test/?a=1']) {
    let failed = false;
    try { await node('site-init.mjs', [bad]); } catch { failed = true; }
    if (!failed) throw new Error('it accepted ' + bad);
  }
  const after = await readFile(path.join(PROJ, 'update-config.json'), 'utf8');
  if (before !== after) throw new Error('a refused address still changed the config');
});

await step('a real domain gets a CNAME', async () => {
  await node('site-init.mjs', ['https://gamecut.example.com/']);
  const cname = (await readFile(path.join(PROJ, 'site', 'CNAME'), 'utf8')).trim();
  if (cname !== 'gamecut.example.com') throw new Error('CNAME says ' + cname);
  // …and switching back to Pages takes it away again.
  await node('site-init.mjs', [BASE]);
  if (await access(path.join(PROJ, 'site', 'CNAME')).then(() => true, () => false)) {
    throw new Error('the CNAME survived a move back to github.io');
  }
});

/* ── Building it ─────────────────────────────────────────────── */
let html = '';
await step('release builds a page, a manifest and a bundle in one folder', async () => {
  await node('release.mjs');
  const files = await readdir(SITE);
  for (const want of ['index.html', 'site.css', 'shots', 'update.json', 'update.txt',
                      `GameCut-${VERSION}.gcupdate`, '.nojekyll']) {
    if (!files.includes(want)) throw new Error(`missing from ${siteCfg.publishDir}/: ` + want);
  }
  html = await readFile(path.join(SITE, 'index.html'), 'utf8');
});

await step('the page and the manifest agree about the version', async () => {
  const outer = JSON.parse(await readFile(path.join(SITE, 'update.json'), 'utf8'));
  const manifest = JSON.parse(Buffer.from(outer.payload, 'base64').toString('utf8'));
  if (manifest.version !== VERSION) throw new Error('the manifest announces ' + manifest.version);
  if (!html.includes('v' + VERSION)) throw new Error('the page does not say v' + VERSION);
  if (!html.includes(`What&rsquo;s new in ${VERSION}`)) {
    throw new Error('the page does not link to the notes for this version');
  }
});

await step('nothing on the page is still a placeholder', async () => {
  const left = html.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error('unfilled: ' + [...new Set(left)].join(', '));
  if (/CHANGE-ME/i.test(html)) throw new Error('the placeholder address made it onto the page');
  if (/undefined|\[object Object\]|NaN/.test(html)) {
    throw new Error('something rendered as undefined / NaN');
  }
});

/**
 * A note written across several lines in CHANGELOG.md is still one note.
 *
 * Reading only a bullet's first line cut every sentence off at roughly the
 * width of the file, in the app as well as on the page — and it looked like
 * prose that had been truncated, because it was.
 */
await step('a wrapped bullet arrives whole, not cut off at the line break', async () => {
  const md = await readFile(path.join(PROJ, 'CHANGELOG.md'), 'utf8');
  const section = md.split(/^##\s/m).find(s => s.startsWith(VERSION));
  const bullet = section.split(/\n\s*-\s+/)[1];
  if (!bullet || !bullet.includes('\n')) {
    throw new Error('no wrapped bullet in CHANGELOG.md to test with');
  }
  const whole = bullet.split(/\n\s*\n|\n\s*-\s+/)[0]
    .replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const tail = whole.split(' ').slice(-5).join(' ');

  const outer = JSON.parse(await readFile(path.join(SITE, 'update.json'), 'utf8'));
  const manifest = JSON.parse(Buffer.from(outer.payload, 'base64').toString('utf8'));
  const note = (manifest.notes || []).find(n => n.startsWith(whole.slice(0, 30)));
  if (!note) throw new Error('the note is missing from the manifest entirely');
  if (!note.endsWith(tail)) {
    throw new Error(`the note stops early:\n    got  "${note}"\n    want "...${tail}"`);
  }
  if (!html.includes(tail.replace(/&/g, '&amp;'))) {
    throw new Error(`the page is missing the end of that note: "${tail}"`);
  }
});

await step('the page carries the real changelog', async () => {
  const md = await readFile(path.join(PROJ, 'CHANGELOG.md'), 'utf8');
  const section = md.split(/^##\s/m).find(s => s.startsWith(VERSION));
  if (!section) throw new Error('CHANGELOG.md has no section for ' + VERSION);
  const first = section.split('\n').find(l => /^\s*-\s+/.test(l))?.replace(/^\s*-\s+/, '')
    .replace(/\*\*/g, '').trim();
  // Compare on words, since the page escapes punctuation into entities.
  const words = first.split(/\s+/).slice(0, 6).join(' ');
  if (!html.includes(words)) throw new Error(`the page is missing "${words}"`);
  if (!html.includes('class="rel__now"')) throw new Error('nothing is marked as the current version');
});

await step('every file the page asks for is in the folder', async () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1])
    .filter(u => !/^https?:|^data:|^mailto:/.test(u));
  for (const r of refs) {
    const abs = path.join(SITE, r);
    if (!(await access(abs).then(() => true, () => false))) {
      throw new Error(`the page links to ${r}, which is not in ${siteCfg.publishDir}/`);
    }
  }
  if (!refs.includes('site.css')) throw new Error('the stylesheet is not linked');
  if (!refs.some(r => r.startsWith('shots/'))) throw new Error('no screenshots are shown');
});

await step('the download button works before any .exe exists', async () => {
  // No installer has been built in this temporary copy, so the button must say
  // so plainly rather than linking to a file that is not there.
  if (/href="GameCut[^"]*\.exe"/.test(html)) {
    throw new Error('it links to an installer that was never built');
  }
  if (!/No Windows build has been published yet/.test(html)) {
    throw new Error('it does not say that there is no build yet');
  }
});

await step('an installer, once built, becomes the download', async () => {
  const name = `GameCut-${VERSION}-x64.exe`;
  await writeFile(path.join(PROJ, 'dist', name), Buffer.alloc(1024 * 64, 7));
  await node('release.mjs');
  const page = await readFile(path.join(SITE, 'index.html'), 'utf8');
  if (!page.includes(`href="${name}" download`)) throw new Error('the button does not point at the installer');
  if (!(await access(path.join(SITE, name)).then(() => true, () => false))) {
    throw new Error('the installer was not copied into the folder');
  }
  const site = JSON.parse(await readFile(path.join(PROJ, 'site', 'site-config.json'), 'utf8'));
  if (site.lastInstaller?.name !== name) throw new Error('the installer was not remembered');
});

await step('an editor-only release keeps the download working', async () => {
  // Bump the version, write notes, and publish WITHOUT building a new .exe —
  // which is the ordinary case, and the one where a wiped folder would leave
  // the Download button pointing at nothing.
  const next = VERSION.replace(/(\d+)$/, (n) => String(+n + 1));
  const pkgPath = path.join(PROJ, 'package.json');
  const p = JSON.parse(await readFile(pkgPath, 'utf8'));
  p.version = next;
  await writeFile(pkgPath, JSON.stringify(p, null, 2));
  const md = await readFile(path.join(PROJ, 'CHANGELOG.md'), 'utf8');
  await writeFile(path.join(PROJ, 'CHANGELOG.md'),
    md.replace(/^# Changelog/m, `# Changelog\n\n## ${next}\n\n- A small fix nobody will notice`));

  await node('release.mjs');
  const page = await readFile(path.join(SITE, 'index.html'), 'utf8');
  const exe = `GameCut-${VERSION}-x64.exe`;
  if (!page.includes(`href="${exe}"`)) throw new Error('the download stopped working on an editor-only release');
  if (!(await access(path.join(SITE, exe)).then(() => true, () => false))) {
    throw new Error('the previously published installer was deleted from the folder');
  }
  if (!page.includes(`updates to ${next} by itself`)) {
    throw new Error('the page does not explain that the installer self-updates');
  }
  if (!page.includes('A small fix nobody will notice')) throw new Error('the new notes are not on the page');
  // Both versions are in the log.
  if (!page.includes(VERSION)) throw new Error('the previous release fell out of the changelog');
});

/**
 * PUBLISH.bat is a batch file, and batch files can only read exit codes.
 *
 * It runs the release, and when the answer is "this version needs a Windows
 * build that does not exist yet" it builds one and publishes again. That
 * conversation happens entirely through the number this process exits with, so
 * the number is asserted rather than assumed — a silent change here would turn
 * the one-click publish into a page that quietly advertises an old installer.
 */
await step('--require-installer asks for a build only when one is needed', async () => {
  const exe = `GameCut-${VERSION}-x64.exe`;

  // There IS an installer at this point, and nothing native has changed.
  const fine = await nodeCode('release.mjs', ['--require-installer']);
  if (fine !== 0) throw new Error(`it demanded a build when one exists (exit ${fine})`);

  // Change a shell file, which a file-swap update is not allowed to deliver.
  const main = path.join(PROJ, 'electron-main.cjs');
  await writeFile(main, (await readFile(main, 'utf8')) + '\n// touched by the suite\n');
  const asked = await nodeCode('release.mjs', ['--require-installer']);
  if (asked !== 3) throw new Error(`a shell change did not ask for a build (exit ${asked})`);

  // Without the flag the same situation is not an error, because "no Windows
  // build yet" is an ordinary state for someone who has not run npm run dist.
  const quiet = await nodeCode('release.mjs');
  if (quiet !== 0) throw new Error(`the plain command failed (exit ${quiet})`);

  // And the page still points at the installer it last really published.
  const page = await readFile(path.join(SITE, 'index.html'), 'utf8');
  if (!page.includes(exe)) throw new Error('the download button lost its installer');
});

await step('only one installer is kept in the folder', async () => {
  // A ninety-megabyte file per release is the one thing here with real weight.
  await writeFile(path.join(SITE, 'GameCut-0.9.0-x64.exe'), Buffer.alloc(1024));
  await node('release.mjs');
  const exes = (await readdir(SITE)).filter(f => f.endsWith('.exe'));
  if (exes.length !== 1) throw new Error(`${exes.length} installers left behind: ` + exes.join(', '));
});

await step('old update bundles are pruned, not hoarded', async () => {
  const bundles = (await readdir(SITE)).filter(f => f.endsWith('.gcupdate'));
  if (bundles.length > 3) throw new Error(bundles.length + ' bundles are piling up: ' + bundles.join(', '));
  if (!bundles.length) throw new Error('the current bundle is missing');
});

/**
 * The page has to work on a phone, because that is where a link gets opened.
 *
 * The failure this catches is specific and easy to reintroduce: a grid track
 * with a minimum width wider than the screen does not wrap, it overflows, and
 * the whole page scrolls sideways. It looks fine in every desktop window.
 */
await step('nothing overflows a phone screen', async () => {
  const { chromium } = await import('playwright');
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'],
  });
  try {
    const p = await b.newPage({ viewport: { width: 360, height: 780 } });
    await p.goto('file://' + path.join(SITE, 'index.html'));
    await p.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 500) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 30));
      }
    });
    await p.waitForTimeout(600);

    const over = await p.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) throw new Error(`the page scrolls sideways by ${over}px at 360 wide`);

    const broken = await p.evaluate(() => [...document.images]
      .filter(i => !i.complete || i.naturalWidth === 0).map(i => i.getAttribute('src')));
    if (broken.length) throw new Error('images that never loaded: ' + broken.join(', '));

    // And the Download button is reachable without hunting for it.
    const cta = await p.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => /Download for Windows/i.test(x.textContent));
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { top: r.top + window.scrollY, h: r.height, w: r.width };
    });
    if (!cta) throw new Error('no download button on the page');
    if (cta.h < 40) throw new Error(`the download button is only ${Math.round(cta.h)}px tall`);
    if (cta.top > 900) throw new Error('the download button is below the first screenful');
  } finally {
    await b.close();
  }
});

/**
 * The website must not be served from the repository root.
 *
 * The root already has an index.html and it is the EDITOR's — a Pages site
 * pointed at / would hand visitors the app's markup with none of the files it
 * needs, which renders as a blank dark page. Publishing from a subfolder is the
 * whole reason that folder exists, so it is asserted rather than remembered.
 */
await step('the site is published from a folder, not over the app', async () => {
  const dir = siteCfg.publishDir || '';
  if (!dir || dir === '.' || path.resolve(PROJ, dir) === path.resolve(PROJ)) {
    throw new Error('publishDir points at the repository root, where the editor lives');
  }
  const rootIndex = await readFile(path.join(PROJ, 'index.html'), 'utf8');
  const siteIndex = await readFile(path.join(SITE, 'index.html'), 'utf8');
  if (rootIndex === siteIndex) throw new Error('the site overwrote the editor\u2019s index.html');
  if (siteIndex.includes('id="previewCanvas"')) throw new Error('the built page IS the editor');
});

await step('the built page is valid, self-contained HTML', async () => {
  const page = await readFile(path.join(SITE, 'index.html'), 'utf8');
  if (!/^<!doctype html>/i.test(page.trim())) throw new Error('no doctype');
  for (const tag of ['html', 'head', 'body', 'title', 'main', 'footer']) {
    if (!page.includes(`<${tag}`) && !page.includes(`<${tag}>`)) throw new Error('no <' + tag + '>');
  }
  // Nothing may be fetched from anywhere else — no fonts, no analytics, no CDN.
  const remote = [...page.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
  if (remote.length) throw new Error('the page loads from elsewhere: ' + remote.join(', '));
  if (/<script/i.test(page)) throw new Error('the page runs script it does not need');
});

/**
 * A release that needs an installer still says so on the second pass.
 *
 * PUBLISH.bat runs the release twice when the shell has changed: once to find
 * out, then again once the .exe exists so it can be copied in beside the
 * manifest. Both runs have to reach the same verdict. They did not: the stamp
 * that records the shell's fingerprint was rewritten by the first pass, so the
 * second compared itself against itself, concluded nothing had changed, and
 * published `needsInstaller: false` — telling every existing install it could
 * take a release by file swap that specifically could not be delivered that way.
 *
 * Driven through the real script rather than by unit-testing the comparison,
 * because the bug was not in the comparison. It was in when the stamp is
 * written, which only a second run can show.
 */
await step('a release needing an installer still says so when run twice', async () => {
  const readManifest = async () => {
    const raw = JSON.parse(await readFile(path.join(PROJ, 'docs', 'update.json'), 'utf8'));
    return JSON.parse(Buffer.from(raw.payload, 'base64').toString('utf8'));
  };

  const pkgPath = path.join(PROJ, 'package.json');
  const mainPath = path.join(PROJ, 'electron-main.cjs');
  const changelog = path.join(PROJ, 'CHANGELOG.md');
  const bump = async () => {
    const p = JSON.parse(await readFile(pkgPath, 'utf8'));
    const v = p.version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
    p.version = v;
    await writeFile(pkgPath, JSON.stringify(p, null, 2) + '\n');
    const md = await readFile(changelog, 'utf8');
    await writeFile(changelog, md.replace(/^# Changelog\n/, `# Changelog\n\n## ${v}\n\n- A change.\n`));
    return v;
  };

  // A baseline release with a settled shell, so there is something to differ
  // from. Earlier steps in this suite leave the shell mid-change, so this moves
  // to a clean version of its own rather than assuming.
  await bump();
  await node('release.mjs');
  const first = await readManifest();
  if (first.needsInstaller) throw new Error('the baseline release already wants an installer');

  // Now change the shell and move to the version that carries the change —
  // a real release that a file swap cannot deliver.
  await writeFile(mainPath, (await readFile(mainPath, 'utf8')) + '\n// shell change\n');
  const next = await bump();

  await node('release.mjs');
  const pass1 = await readManifest();
  if (!pass1.needsInstaller) {
    throw new Error('the shell changed but the first pass did not ask for an installer');
  }
  if (pass1.minShell !== next) {
    throw new Error(`minShell is ${pass1.minShell}, expected ${next}`);
  }

  // The second pass: same version, same files, installer now built.
  await node('release.mjs');
  const pass2 = await readManifest();
  if (!pass2.needsInstaller) {
    throw new Error('the second pass published needsInstaller:false — old installs would be '
      + 'told to take a file update that cannot carry a new shell');
  }
  if (pass2.minShell !== next) {
    throw new Error(`the second pass dropped minShell (${pass2.minShell}), expected ${next}`);
  }

  // And the release AFTER it, with only the editor touched, must go back to
  // installing by itself — or one release that needed an installer would make
  // every release after it need one too.
  await writeFile(path.join(PROJ, 'src', '__probe.js'), '// renderer-only change\n');
  const after = await bump();
  await node('release.mjs');
  const same = await readManifest();
  if (same.version !== after) throw new Error(`version is ${same.version}, expected ${after}`);
  if (same.needsInstaller) {
    throw new Error('a renderer-only release still asked for an installer');
  }
  await rm(path.join(PROJ, 'src', '__probe.js'), { force: true });
  console.log(`     pass 1 and pass 2 on ${next} both ask for the installer`);
});

await rm(WORK, { recursive: true, force: true });

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`SITE FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.log(' • ' + p);
  process.exit(1);
} else {
  console.log('SITE PASSED — the page, the manifest and the download agree.');
}
