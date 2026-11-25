/**
 * The uninstaller and installer leave other programs alone. Runs the real macros
 * in a temp folder, silently; touches nothing else (its registry keys are its own).
 *   node qa/installer-safe.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis');
const nsis = readdirSync(cache).filter(d => /^nsis-\d/.test(d)).map(d => path.join(cache, d)).find(d => existsSync(path.join(d, 'Bin', 'makensis.exe')));
const dir = mkdtempSync(path.join(tmpdir(), 'strike-safe-'));
const src = readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
const only = src.slice(src.indexOf('!macro StrikeForeign'), src.indexOf('; ── Dark window'));
writeFileSync(path.join(dir, 'm.nsh'), '\ufeff' + only);
const KEY = 'Software\\StrikeInstallerTest';
writeFileSync(path.join(dir, 't.nsi'), '\ufeff' + `Unicode true
!include LogicLib.nsh
!define INSTALL_REGISTRY_KEY "${KEY}"
!define UNINSTALL_REGISTRY_KEY "${KEY}\\Un"
!include "${path.join(dir, 'm.nsh')}"
Name x
OutFile "${path.join(dir, 't.exe')}"
RequestExecutionLevel user
SilentInstall silent
Section
  StrCpy $INSTDIR "${dir}\\shared"
  !insertmacro StrikeForeign "$INSTDIR"
  FileOpen $9 "${dir}\\r.txt" w
  FileWrite $9 "shared=$1$\\r$\\n"
  !insertmacro StrikeForeign "${dir}\\own"
  FileWrite $9 "own=$1$\\r$\\n"
  !insertmacro StrikeForeign "${dir}\\none"
  FileWrite $9 "none=$1$\\r$\\n"
  FileClose $9
  WriteRegStr HKCU "${KEY}" "InstallLocation" "${dir}\\shared"
  WriteRegStr HKCU "${KEY}\\Un" "UninstallString" "x"
  !insertmacro StrikeGuardOld HKCU
  ReadRegStr $4 HKCU "${KEY}\\Un" "UninstallString"
  FileOpen $9 "${dir}\\r2.txt" w
  FileWrite $9 "old=[$4] dir=$INSTDIR"
  FileClose $9
  DeleteRegKey HKCU "${KEY}"
  StrCpy $INSTDIR "${dir}\\own"
  !insertmacro customRemoveFiles
SectionEnd
`);
const put = (d, files) => files.forEach(f => { const p = path.join(dir, d, f); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, 'x'); });
const ours = readdirSync(path.join(ROOT, 'dist', 'win-unpacked'), { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(path.join(ROOT, 'dist', 'win-unpacked'), path.join(e.parentPath || e.path, e.name)));
put('own', [...ours, 'Uninstall Strike.exe']);
put('shared', ['Strike.exe', 'ffmpeg.dll', 'resources/app.asar', 'STRIKE Launcher.exe', 'strike.ico', 'saves/world.dat', 'resources/app.asar.alpha4']);
let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
try {
  execFileSync(path.join(nsis, 'Bin', 'makensis.exe'), ['-V2', '-WX', path.join(dir, 't.nsi')], { env: { ...process.env, NSISDIR: nsis } });
  execFileSync(path.join(dir, 't.exe'), [], { env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' } });
  const r = readFileSync(path.join(dir, 'r.txt'), 'utf8');
  ok(/shared=yes/.test(r) && /own=no/.test(r) && /none=no/.test(r), 'another program in the folder is noticed');
  ok(['STRIKE Launcher.exe', 'strike.ico', 'saves/world.dat', 'resources/app.asar.alpha4'].every(f => existsSync(path.join(dir, 'shared', f))), "the other program's files stay");
  ok(!existsSync(path.join(dir, 'shared', 'Strike.exe')), "Strike's own files go");
  const r2 = readFileSync(path.join(dir, 'r2.txt'), 'utf8');
  ok(/old=\[\]/.test(r2) && r2.includes('shared'), 'an old uninstaller that empties folders is not run: ' + r2);
  const left = existsSync(path.join(dir, 'own')) ? readdirSync(path.join(dir, 'own'), { recursive: true }) : [];
  ok(!left.length, 'a folder that is only Strike is removed completely' + (left.length ? ': left ' + left : ''));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(bad ? 'INSTALLER SAFE FAILED' : 'INSTALLER SAFE PASSED'); process.exit(bad ? 1 : 0);
