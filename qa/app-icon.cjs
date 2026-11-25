/**
 * The theme's icon on shortcuts: in a temp folder only, with no window.
 *   node_modules/electron/dist/electron.exe qa/app-icon.cjs
 */
const { app, shell, nativeImage } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');
const { makeIco, dressShortcuts, goodPng, SIZES } = require('../app-icon.cjs');
const out = [];
const ok = (c, m) => { out.push((c ? '  ok   ' : '  FAIL ') + m); if (!c) process.exitCode = 1; };
app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strike-icon-'));
  try {
    const png = (col) => Object.fromEntries(SIZES.map(s => { const b = Buffer.alloc(s * s * 4); for (let i = 0; i < b.length; i += 4) { b[i] = col[0]; b[i + 1] = col[1]; b[i + 2] = col[2]; b[i + 3] = 255; } return [s, nativeImage.createFromBitmap(b, { width: s, height: s }).toPNG()]; }));
    const a = png([40, 80, 255]), b = png([40, 255, 80]);
    ok(goodPng(a[48], 48) && !goodPng(a[48], 32) && !goodPng(Buffer.from('not a picture at all'.repeat(9)), 48), 'only real pictures of the right size are accepted');
    const ico = makeIco(a); const f = path.join(dir, 't.ico'); fs.writeFileSync(f, ico);
    const back = nativeImage.createFromPath(f);
    ok(!back.isEmpty() && back.getSize().width >= 16, 'Windows reads the .ico: ' + JSON.stringify(back.getSize()));
    const sub = path.join(dir, 'links', 'Strike'); fs.mkdirSync(sub, { recursive: true });
    const mine = [path.join(dir, 'links', 'Strike.lnk'), path.join(sub, 'Strike.lnk')], other = path.join(dir, 'links', 'Other.lnk');
    for (const m of mine) shell.writeShortcutLink(m, 'create', { target: process.execPath, args: '--x', description: 'Keep me', appUserModelId: 'com.gamecut.studio' });
    shell.writeShortcutLink(other, 'create', { target: 'C:\\Windows\\notepad.exe' });
    const was = fs.readFileSync(other);
    const go = (i) => dressShortcuts({ exe: process.execPath, folders: [path.join(dir, 'links'), path.join(dir, 'nope')], shell, ico: i, iconDir: path.join(dir, 'icons') });
    ok(go(ico) === 2, 'both of its shortcuts change');
    const l = shell.readShortcutLink(mine[1]);
    ok(/strike-[0-9a-f]{12}\.ico$/.test(l.icon) && l.args === '--x' && l.description === 'Keep me' && l.appUserModelId === 'com.gamecut.studio', 'only the picture changes: ' + JSON.stringify(l));
    ok(go(ico) === 0, 'the same theme again writes nothing');
    ok(go(makeIco(b)) === 2 && fs.readdirSync(path.join(dir, 'icons')).length === 1, 'another theme swaps it and leaves one picture behind');
    ok(go(null) === 2 && shell.readShortcutLink(mine[0]).icon.toLowerCase() === process.execPath.toLowerCase(), 'Strike puts the original back');
    ok(was.equals(fs.readFileSync(other)), 'other programs\' shortcuts are left alone');
  } catch (e) { ok(false, e.stack); }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'app-icon.txt'), out.join('\n') + '\n' + (process.exitCode ? 'APP ICON FAILED' : 'APP ICON PASSED'));
  app.exit(process.exitCode || 0);
});
