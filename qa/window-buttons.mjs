/**
 * The window as Windows draws it, its own buttons included (a page screenshot leaves
 * them out). Off-screen. Pictures: qa/out/win-*.png
 *   node qa/window-buttons.mjs
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, ROOT } from './harness.mjs';
const OUT = ROOT + '/qa/out';
const T = await launch({ name: 'winbtn', size: [1500, 900] });
const { win, ev, step, fresh, sleep, finish, app } = T;
const ps = OUT + '/win-shoot.ps1';
writeFileSync(ps, `param([long]$h,[string]$out)
Add-Type -AssemblyName System.Drawing
Add-Type 'using System;using System.Runtime.InteropServices;public static class WB{[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr d,uint f);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);public struct R{public int l,t,r,b;}}'
$r=New-Object WB+R;[void][WB]::GetWindowRect([IntPtr]$h,[ref]$r)
$b=New-Object Drawing.Bitmap ($r.r-$r.l),($r.b-$r.t);$g=[Drawing.Graphics]::FromImage($b);$d=$g.GetHdc();[void][WB]::PrintWindow([IntPtr]$h,$d,2);$g.ReleaseHdc($d);$b.Save($out)`);
const handle = await app.evaluate(({ BrowserWindow }) => Number(BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE()));
const shoot = (n) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-h', String(handle), '-out', `${OUT}/win-${n}.png`]);
console.log('\n── window buttons ─────');
await fresh(); await sleep(500);
await step('nothing in the bar runs under the buttons', async () => {
  const bad = await ev(() => { const o = navigator.windowControlsOverlay.getTitlebarAreaRect(); const edge = o.right || innerWidth; return [edge >= innerWidth ? 'no overlay' : '', ...[...document.querySelectorAll('.topbar button,.topbar input')].filter(b => b.getClientRects().length && b.getBoundingClientRect().right > edge + 0.5).map(b => b.id || b.className)].filter(Boolean); });
  if (bad.length) throw new Error(bad.join(' '));
});
const wear = async (t) => { await ev((x) => { const s = JSON.parse(localStorage.getItem('gamecut.settings') || '{}'); localStorage.setItem('gamecut.settings', JSON.stringify({ ...s, theme: x })); window.gc.qol.applySettings(); }, t); await sleep(1300); };
for (const t of ['forest', 'paper', 'sakura']) { await wear(t); shoot(t); }
await wear('forest'); await ev(() => window.gc.keymap.open()); await sleep(500); shoot('dimmed'); await ev(() => window.gc.keymap.close());
await step('on an older program the bar blends instead', async () => {
  const r = await ev(() => ({ now: document.documentElement.classList.contains('old-bar'), seamless: window.gamecut.seamlessBar }));
  if (r.now || !r.seamless) throw new Error(JSON.stringify(r));
});
await ev(() => document.documentElement.classList.add('old-bar')); await sleep(200); await win.screenshot({ path: OUT + '/win-oldbar.png', clip: { x: 700, y: 0, width: 800, height: 60 } });
await finish('WINDOW BUTTONS');
