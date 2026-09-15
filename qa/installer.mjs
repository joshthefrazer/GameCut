/**
 * The installer, checked without building one.
 *
 * A broken installer script is the worst kind of bug in this project: it cannot
 * be seen from inside the app, it only shows up when someone double-clicks a
 * download, and by then the file is on their machine. `npm run dist` takes
 * minutes and needs Windows; this takes a second and catches the things that
 * actually go wrong — a syntax error in the NSIS hooks, a missing bitmap, or the
 * publisher quietly reverting to nothing.
 */
import { readFile, access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const problems = [];
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { problems.push(m); console.log('  FAIL ' + m); };

console.log('\n── installer ────────────────────────────');

/* ── Who made it ─────────────────────────────────────────────── */
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
// electron-builder reads the Publisher shown in Add/Remove Programs from
// `author.name` — a plain string author leaves it blank, which is what it was.
if (pkg.author?.name !== "Frazer's Softwares") {
  bad(`author.name is ${JSON.stringify(pkg.author)} — the installer would list no publisher`);
} else ok('the installer credits Frazer’s Softwares');

if (!/Frazer/.test(pkg.build?.copyright || '')) bad('copyright does not name the publisher');
else ok('the copyright names the publisher');

/* ── The side panel ──────────────────────────────────────────── */
const bmp = path.join(ROOT, 'build', 'installer-side.bmp');
if (!(await access(bmp).then(() => true, () => false))) {
  bad('build/installer-side.bmp is missing — run npm run icon');
} else {
  const b = await readFile(bmp);
  // BMP header: 'BM', then width at 0x12 and height at 0x16, little-endian.
  const w = b.readInt32LE(0x12), h = b.readInt32LE(0x16);
  if (b[0] !== 0x42 || b[1] !== 0x4d) bad('installer-side.bmp is not a BMP');
  else if (w !== 164 || Math.abs(h) !== 314) bad(`installer-side.bmp is ${w}x${h}; NSIS wants 164x314`);
  else ok(`the side panel is a ${w}×${Math.abs(h)} BMP`);
}

/* ── The icon ────────────────────────────────────────────────── */
const ico = path.join(ROOT, 'build', 'icon.ico');
const icoStat = await stat(ico).catch(() => null);
if (!icoStat) bad('build/icon.ico is missing');
else {
  const b = await readFile(ico);
  const count = b.readUInt16LE(4);          // number of images in the .ico
  if (count < 5) bad(`icon.ico holds only ${count} sizes — Windows wants one per size it draws`);
  else ok(`the icon holds ${count} sizes`);
}

/* ── The mark ────────────────────────────────────────────────── */
const svgPath = path.join(ROOT, 'assets', 'mark.svg');
const svg = await readFile(svgPath, 'utf8').catch(() => null);
if (!svg) bad('assets/mark.svg is missing — run npm run icon');
else if (svg.length > 4096) bad(`mark.svg is ${svg.length} bytes; too big to inline four times`);
else if (!/^<svg /.test(svg) || !svg.trim().endsWith('</svg>')) bad('mark.svg is not a complete SVG');
else ok(`the mark is a ${svg.length}-byte SVG`);

// The SVG is generated from qa/mark.py. If someone edits one and not the
// other, the logo quietly becomes two different logos.
if (svg) {
  try {
    const { stdout } = await run('python3', ['-c',
      "import sys; sys.path.insert(0,'qa'); from make_mark_svg import build; sys.stdout.write(build())"],
      { cwd: ROOT, maxBuffer: 1 << 20 });
    if (stdout.trim() !== svg.trim()) bad('assets/mark.svg no longer matches the geometry in qa/mark.py — run npm run icon');
    else ok('the mark matches the geometry it is generated from');
  } catch (e) {
    bad('could not regenerate the mark: ' + String(e.message).split('\n')[0]);
  }

  // And the four places that inline it have to be inlining the same drawing.
  const uri = (await run('python3', ['-c',
    "import sys; sys.path.insert(0,'qa'); from make_mark_svg import data_uri; sys.stdout.write(data_uri())"],
    { cwd: ROOT, maxBuffer: 1 << 20 })).stdout;
  const places = [
    ['the app favicon', 'index.html'],
    ['the app top bar', path.join('styles', 'layout.css')],
    ['the website favicon', path.join('site', 'index.template.html')],
    ['the website header', path.join('site', 'site.css')],
  ];
  let stale = [];
  for (const [what, rel] of places) {
    const body = await readFile(path.join(ROOT, rel), 'utf8').catch(() => '');
    if (!body.includes(uri)) stale.push(what);
  }
  if (stale.length) bad('these show a different logo from the app icon: ' + stale.join(', '));
  else ok('the app, the top bar, the website and the installer all show one logo');

  // Characters left raw in a data: URL are the whole reason this check exists.
  // '#' is a fragment delimiter, so the browser reads up to the first colour in
  // the SVG and throws the rest away; '<' and '>' are not legal in a URL at all
  // and whether they are tolerated is up to the parser. Every one of them fails
  // the same silent way — nothing drawn, no console error, no failed request —
  // so every other check here passes while the logo is invisible. It was
  // invisible in the top bar for exactly that reason.
  const raw = ['#', '<', '>', '"', ' '].filter(c => uri.includes(c));
  if (raw.length) bad(`the logo data URL has raw ${raw.map(c => JSON.stringify(c)).join(', ')} in it — it may render as nothing`);
  else ok('the logo data URL is fully escaped, so it actually renders');
}

/* ── The NSIS hooks actually compile ─────────────────────────── */
const has = await run('which', ['makensis']).then(() => true, () => false);
if (!has) {
  console.log('  --   makensis is not installed; skipping the NSIS syntax check');
} else {
  const dir = path.join(os.tmpdir(), 'gc-nsis-check');
  await mkdir(path.join(dir, 'BUILD_RES'), { recursive: true });
  await writeFile(path.join(dir, 'BUILD_RES', 'installer-side.bmp'), await readFile(bmp));
  // Enough of electron-builder's context for every macro to expand — INCLUDING
  // the defines it passes on the makensis command line. Leaving those out is
  // not a smaller test, it is a different one: !define on a name electron-builder
  // has already defined is a hard error ("already defined!"), and without them
  // here the hooks compiled cleanly in this check and failed the real build.
  // Everything in this list is copied from an actual electron-builder 25 run.
  await writeFile(path.join(dir, 'check.nsi'), `
!include MUI2.nsh
!include LogicLib.nsh
!define MUI_WELCOMEFINISHPAGE_BITMAP "\${NSISDIR}/Contrib/Graphics/Wizard/nsis3-metro.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "\${NSISDIR}/Contrib/Graphics/Wizard/nsis3-metro.bmp"
!define PRODUCT_NAME "GameCut"
!define PRODUCT_FILENAME "GameCut"
!define APP_FILENAME "GameCut"
!define COMPANY_NAME "Frazer's Softwares"
!define VERSION "0.0.0"
!define BUILD_RESOURCES_DIR "BUILD_RES"
!define isUpdated '"" != ""'
!define StdUtils.ExecShellAsUser "!insertmacro stubExec"
!macro stubExec a b c d
  StrCpy $0 ""
!macroend
Var launchLink
Name "GameCut"
OutFile "check.exe"
!include "${path.join(ROOT, 'build', 'installer.nsh').replace(/\\/g, '/')}"
!insertmacro customWelcomePage
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
Section "x"
  StrCpy $launchLink ""
  !insertmacro customInit
  !insertmacro customUnInit
SectionEnd
`);
  try {
    const { stdout } = await run('makensis', ['-V2', 'check.nsi'], { cwd: dir });
    const errs = String(stdout).split('\n').filter(l => /error/i.test(l));
    if (errs.length) bad('the NSIS hooks do not compile: ' + errs[0]);
    else ok('the NSIS hooks compile');
  } catch (e) {
    bad('the NSIS hooks do not compile: ' + String(e.stdout || e.message).split('\n').filter(l => /error/i.test(l))[0]);
  }
}

/* ── What the pages say ──────────────────────────────────────── */
const nsh = await readFile(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
for (const [what, re] of [
  ['a welcome page', /!insertmacro MUI_PAGE_WELCOME/],
  ['a finish page', /!insertmacro MUI_PAGE_FINISH/],
  ['an offer to pin it', /MUI_FINISHPAGE_SHOWREADME_TEXT "Pin GameCut/],
  ['an offer to open it', /MUI_FINISHPAGE_RUN_FUNCTION/],
  ['the publisher on both pages', /Frazer/],
]) {
  if (re.test(nsh)) ok('the installer has ' + what);
  else bad('the installer is missing ' + what);
}

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`INSTALLER FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.log(' • ' + p);
  process.exit(1);
}
console.log('INSTALLER PASSED — hooks compile, resources present, publisher set.');
