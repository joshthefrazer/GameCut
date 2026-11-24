/**
 * Look at the installer's pages without installing anything (Windows).
 *   node qa/installer-preview.mjs
 * Builds a stand-in with the real pages from build/installer.nsh and an
 * install step that only waits. It closes nothing, writes nothing outside its
 * temp folder, and its window opens off-screen. Pictures of every page go to
 * qa/out/installer-*.png.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'qa', 'out');
mkdirSync(OUT, { recursive: true });
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis');
const nsis = readdirSync(cache).filter(d => /^nsis-\d/.test(d)).map(d => path.join(cache, d)).find(d => existsSync(path.join(d, 'Bin', 'makensis.exe')));
if (!nsis) { console.error('NSIS is not in electron-builder\'s cache yet: run npm run dist once.'); process.exit(2); }
const dir = mkdtempSync(path.join(tmpdir(), 'strike-inst-'));
writeFileSync(path.join(dir, 'p.nsi'), `
Unicode true
!define BUILD_RESOURCES_DIR "${path.join(ROOT, 'build')}"
!define APP_FILENAME "Strike"
!define PRODUCT_NAME "Strike"
!define isUpdated '"0" == "1"'
!include "${path.join(ROOT, 'build', 'installer.nsh')}"
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!define StdUtils.ExecShellAsUser "!insertmacro noExec"
!macro noExec a b c d
!macroend
Var launchLink
Var hasPerMachineInstallation
Var isForceCurrentInstall
Name "Strike"
OutFile "${path.join(dir, 'p.exe')}"
RequestExecutionLevel user
ShowInstDetails nevershow
!define MUI_ICON "${path.join(ROOT, 'build', 'icon.ico')}"
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
!insertmacro customHeader
Function .onInit
  StrCpy $INSTDIR "${path.join(dir, 'Strike')}"
  StrCpy $hasPerMachineInstallation "0"
  !insertmacro customInstallMode
FunctionEnd
Section "x"
  StrCpy $launchLink ""
  DetailPrint "Extracting Strike..."
  Sleep 2500
  Sleep 1500
SectionEnd
Section "y"
  Sleep 2500
SectionEnd
`);
const built = execFileSync(path.join(nsis, 'Bin', 'makensis.exe'), ['-V2', '-WX', path.join(dir, 'p.nsi')], { env: { ...process.env, NSISDIR: nsis }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (built.trim()) console.log(built.trim());
console.log('  ok   the pages compile with no warnings');

writeFileSync(path.join(dir, 'shoot.ps1'), `
param([int]$target, [string]$out)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int t, uint f);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public struct R { public int l, t, r, b; }
  public static IntPtr Find(int pid) { IntPtr f = IntPtr.Zero; EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h) && GetDlgItem(h, 1) != IntPtr.Zero) { f = h; return false; } return true; }, IntPtr.Zero); return f; }
  public static string Text(IntPtr h) { var s = new StringBuilder(200); GetWindowText(h, s, 200); return s.ToString(); }
}
'@
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 200 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 25; $h = [W]::Find($target) }
if ($h -eq [IntPtr]::Zero) { 'no window'; exit 1 }
[void][W]::SetWindowPos($h, [IntPtr]::Zero, 4000, 80, 0, 0, 0x15)
function Shoot($name) {
  $r = New-Object W+R; [void][W]::GetWindowRect($h, [ref]$r)
  $b = New-Object Drawing.Bitmap ($r.r - $r.l), ($r.b - $r.t); $g = [Drawing.Graphics]::FromImage($b); $dc = $g.GetHdc(); [void][W]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc)
  $b.Save((Join-Path $out "installer-$name.png")); "$name : button '" + [W]::Text([W]::GetDlgItem($h, 1)) + "'"
}
function Press { [void][W]::PostMessage($h, 0x111, [IntPtr]1, [W]::GetDlgItem($h, 1)) }
Start-Sleep -Milliseconds 900; Shoot 'start'
Press; Start-Sleep -Milliseconds 4700; Shoot 'working'
for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 250; if ([W]::Text([W]::GetDlgItem($h, 1)) -eq 'Finish') { break } }
Start-Sleep -Milliseconds 700; Shoot 'ready'
`);
// __COMPAT_LAYER keeps Windows from asking for admin rights because of the word "installer".
const app = spawn(path.join(dir, 'p.exe'), [], { env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' }, windowsHide: false });
let code = 1;
try {
  const said = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'shoot.ps1'), '-target', String(app.pid), '-out', OUT], { encoding: 'utf8', timeout: 60000 });
  console.log(said.trim());
  code = /ready : button 'Finish'/.test(said) ? 0 : 1;
} finally {
  app.kill();       // never reaches Finish, so nothing is opened or pinned
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* still closing */ } console.log(code ? 'PREVIEW FAILED' : 'PREVIEW PASSED'); process.exit(code); }, 800);
}
