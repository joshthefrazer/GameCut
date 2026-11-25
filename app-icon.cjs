/**
 * The app's icon follows the theme: the window and taskbar at once, and the
 * shortcuts Strike's installer made (desktop, Start menu, pinned), so Windows
 * shows the same picture before Strike is open.
 *
 * Only shortcuts that open this very Strike.exe are touched, and only their picture.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SIZES = [16, 24, 32, 48, 256];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Is this a PNG of exactly `size` × `size`, and not a huge one? */
function goodPng(buf, size) {
  return Buffer.isBuffer(buf) && buf.length > 60 && buf.length < 200000 && buf.subarray(0, 8).equals(PNG)
    && buf.readUInt32BE(16) === size && buf.readUInt32BE(20) === size;
}

/** PNGs (by size) as one .ico file. */
function makeIco(pngs) {
  const list = SIZES.filter(s => pngs[s]).map(s => [s, pngs[s]]);
  const head = Buffer.alloc(6 + 16 * list.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(list.length, 4);
  let at = head.length;
  list.forEach(([s, b], i) => {
    const o = 6 + 16 * i;
    head[o] = s === 256 ? 0 : s; head[o + 1] = s === 256 ? 0 : s;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(b.length, o + 8); head.writeUInt32LE(at, o + 12);
    at += b.length;
  });
  return Buffer.concat([head, ...list.map(([, b]) => b)]);
}

/** Every shortcut in these folders (and one level down) that opens `exe`. */
function shortcutsFor(exe, folders, shell) {
  const out = [];
  const look = (dir, deep) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) { if (deep) look(p, false); continue; }
      if (!/\.lnk$/i.test(n.name)) continue;
      try { const l = shell.readShortcutLink(p); if (l.target && path.resolve(l.target).toLowerCase() === path.resolve(exe).toLowerCase()) out.push({ path: p, link: l }); } catch { /* not a shortcut Windows can read */ }
    }
  };
  for (const f of folders) look(f, true);
  return out;
}

/** Give those shortcuts this icon (null: the one in the exe). Returns how many changed. */
function dressShortcuts({ exe, folders, shell, ico, iconDir }) {
  let icon = exe;
  if (ico) {
    fs.mkdirSync(iconDir, { recursive: true });
    // A new name for new pixels: Windows remembers icons by file name.
    icon = path.join(iconDir, `strike-${crypto.createHash('sha1').update(ico).digest('hex').slice(0, 12)}.ico`);
    if (!fs.existsSync(icon)) fs.writeFileSync(icon, ico);
  }
  let n = 0, failed = 0;
  for (const s of shortcutsFor(exe, folders, shell)) {
    if ((s.link.icon || exe).toLowerCase() === icon.toLowerCase()) continue;
    try { if (shell.writeShortcutLink(s.path, 'update', { target: s.link.target, icon, iconIndex: 0 })) n++; else failed++; } catch { failed++; }
  }
  // Old pictures nothing points at any more.
  if (!failed) try { for (const f of fs.readdirSync(iconDir)) if (/^strike-[0-9a-f]{12}\.ico$/.test(f) && path.join(iconDir, f) !== icon) fs.unlinkSync(path.join(iconDir, f)); } catch { /* none yet */ }
  return n;
}

function setup({ ipcMain, app, shell, nativeImage, getWin, quiet }) {
  const HEX = /^#[0-9a-f]{6}$/i;
  ipcMain.handle('icon:set', (e, opts) => {
    const win = getWin();
    if (!win || e.sender !== win.webContents) return { error: 'No window' };
    const o = opts && typeof opts === 'object' ? opts : {};
    if (process.platform === 'win32' && HEX.test(o.bar || '') && HEX.test(o.barText || '')) {
      try { win.setTitleBarOverlay({ color: o.bar, symbolColor: o.barText, height: 52 }); } catch { /* no overlay on this Windows */ }
    }
    if (!o.png) return { ok: true, icon: false };
    const pngs = {};
    for (const s of SIZES) {
      const raw = o.png[s];
      const b = raw instanceof Uint8Array ? Buffer.from(raw) : null;
      if (!goodPng(b, s)) return { error: 'That icon could not be used' };
      pngs[s] = b;
    }
    const img = nativeImage.createEmpty();
    for (const s of [16, 24, 32, 48, 256]) img.addRepresentation({ scaleFactor: s / 16, width: s, height: s, buffer: pngs[s] });
    win.setIcon(img);
    let shortcuts = 0;
    if (process.platform === 'win32' && app.isPackaged && !quiet) {
      const roaming = app.getPath('appData');
      shortcuts = dressShortcuts({
        exe: process.execPath, shell, iconDir: path.join(app.getPath('userData'), 'icons'),
        folders: [app.getPath('desktop'), path.join(roaming, 'Microsoft/Windows/Start Menu/Programs'), path.join(roaming, 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar')],
        ico: o.stock ? null : makeIco(pngs),
      });
    }
    return { ok: true, icon: true, shortcuts };
  });
}
module.exports = { setup, makeIco, dressShortcuts, goodPng, SIZES };
