/**
 * Clip Inbox, main-process side.
 *
 * Watches the folders recordings land in (OBS, Medal, NVIDIA, the Windows
 * Game Bar — all of which save under Videos by default, plus any folder you
 * add) and lists what is there, newest first. Nothing is copied or moved: a
 * recording is opened where it is, through the same gcmedia:// ids as any
 * imported file.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const VIDEO = /\.(mp4|m4v|mov|mkv|webm)$/i;
const MIN_BYTES = 200 * 1024;          // skip half-written stubs and thumbnails
const MAX_ITEMS = 80;

module.exports = function initInbox({ ipcMain, app, dialog, getWin, registerMedia }) {
  const FILE = () => path.join(app.getPath('userData'), 'inbox.json');
  let state = null;

  async function load() {
    if (state) return state;
    try { state = JSON.parse(await fsp.readFile(FILE(), 'utf8')); } catch { state = null; }
    if (!state || !Array.isArray(state.folders)) {
      // First time: the usual places, if this computer has them.
      const vids = (() => { try { return app.getPath('videos'); } catch { return path.join(os.homedir(), 'Videos'); } })();
      const guesses = [
        { path: vids, label: 'Videos (OBS, NVIDIA)' },
        { path: path.join(vids, 'Captures'), label: 'Game Bar' },
        { path: path.join(vids, 'Medal'), label: 'Medal' },
      ];
      const folders = [];
      for (const g of guesses) { try { if ((await fsp.stat(g.path)).isDirectory()) folders.push(g); } catch { /* not here */ } }
      state = { folders, seenAt: 0, used: {} };
      await save();
    }
    return state;
  }
  async function save() {
    try { await fsp.mkdir(path.dirname(FILE()), { recursive: true }); await fsp.writeFile(FILE(), JSON.stringify(state, null, 1)); } catch { /* read-only profile */ }
  }

  /** Recordings in one folder and the folders right under it (NVIDIA files by game). */
  async function walk(dir, depth, out) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0) await walk(p, depth - 1, out); continue; }
      if (!VIDEO.test(e.name)) continue;
      try {
        const st = await fsp.stat(p);
        if (st.size >= MIN_BYTES) out.push({ path: p, name: e.name, bytes: st.size, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }

  async function list() {
    const s = await load();
    const seen = new Set(), items = [];
    for (const f of s.folders) {
      const found = [];
      await walk(f.path, 2, found);
      for (const it of found) {
        if (seen.has(it.path)) continue;
        seen.add(it.path);
        items.push({ ...it, folder: f.label || path.basename(f.path), id: registerMedia(it.path), isNew: it.mtime > (s.seenAt || 0), used: s.used?.[it.path] || null });
      }
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return { folders: s.folders.map(f => ({ path: f.path, label: f.label || path.basename(f.path) })), items: items.slice(0, MAX_ITEMS) };
  }

  /* Watching: a new file in any folder tells the page to look again. */
  const watchers = new Map();
  let pending = null;
  function rewatch() {
    for (const w of watchers.values()) { try { w.close(); } catch { /* gone */ } }
    watchers.clear();
    for (const f of state?.folders || []) {
      try {
        const w = fs.watch(f.path, { recursive: process.platform !== 'linux' }, (_ev, name) => {
          if (name && !VIDEO.test(String(name))) return;
          clearTimeout(pending);
          // A recorder writes for a while; wait for it to go quiet.
          pending = setTimeout(() => getWin()?.webContents.send('inbox:changed'), 2500);
        });
        watchers.set(f.path, w);
      } catch { /* not watchable */ }
    }
  }
  load().then(rewatch).catch(() => {});

  ipcMain.handle('inbox:list', () => list());
  ipcMain.handle('inbox:addFolder', async () => {
    const win = getWin();
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Watch a folder for new recordings', properties: ['openDirectory'] });
    if (canceled || !filePaths?.[0]) return null;
    const s = await load();
    if (!s.folders.some(f => f.path === filePaths[0])) s.folders.push({ path: filePaths[0], label: path.basename(filePaths[0]) });
    await save(); rewatch();
    return list();
  });
  ipcMain.handle('inbox:removeFolder', async (_e, p) => {
    const s = await load();
    s.folders = s.folders.filter(f => f.path !== p);
    await save(); rewatch();
    return list();
  });
  ipcMain.handle('inbox:seen', async () => { const s = await load(); s.seenAt = Date.now(); await save(); return true; });
  ipcMain.handle('inbox:used', async (_e, p, project) => {
    const s = await load();
    if (typeof p === 'string') { s.used = s.used || {}; s.used[p] = String(project || '').slice(0, 80); await save(); }
    return true;
  });
  /** Tests (and "watch a folder" without a dialog) add a folder directly — only one that exists. */
  ipcMain.handle('inbox:addPath', async (_e, p) => {
    if (typeof p !== 'string' || !p) return null;
    try { if (!(await fsp.stat(p)).isDirectory()) return null; } catch { return null; }
    const s = await load();
    if (!s.folders.some(f => f.path === p)) s.folders.push({ path: p, label: path.basename(p) });
    await save(); rewatch();
    return list();
  });
};
