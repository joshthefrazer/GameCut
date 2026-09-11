/**
 * Preload bridge.
 *
 * `.cjs` on purpose: package.json declares "type": "module" for the renderer's
 * ES modules, which would otherwise make Node parse a `.js` preload as ESM and
 * fail on require().
 *
 * Only these functions cross the isolation boundary. The renderer never gets
 * `require`, `ipcRenderer`, or a raw filesystem handle.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const MENU_CHANNELS = ['menu:import', 'menu:export', 'menu:undo', 'menu:redo'];

contextBridge.exposeInMainWorld('gamecut', {
  isDesktop: true,
  platform: process.platform,
  version: () => ipcRenderer.invoke('app:version'),

  /**
   * Is the graphics card actually being used?
   *
   * Resolves to { accelerated, renderer }. When Chromium falls back to drawing
   * the window on the CPU, everything the editor does gets an order of
   * magnitude slower and no setting inside the app can compensate — so the
   * renderer asks, and says so plainly rather than letting it look like the
   * machine is simply too slow.
   */
  gpuStatus: () => ipcRenderer.invoke('app:gpuStatus'),

  /**
   * Open a known external destination in the normal browser.
   *
   * Takes a key, never a URL — the main process owns the list of what those
   * keys mean. Letting the page name its own URL would turn this into a way to
   * launch anything on the machine.
   */
  openTarget: (key) => ipcRenderer.invoke('shell:openTarget', String(key || '')),

  /**
   * The window is closing: save, then answer.
   *
   * The main process holds the close until this replies, so the handler must
   * always settle. It is given a few seconds before the window goes anyway.
   */
  onCloseRequest: (fn) => {
    ipcRenderer.on('app:closing', async () => {
      let result = null;
      try { result = await fn(); } catch { /* answer anyway */ }
      ipcRenderer.send('app:closed', result);
    });
  },

  /* ── Projects ──────────────────────────────────────────────── */
  listProjects: () => ipcRenderer.invoke('proj:list'),
  saveProject: (payload) => ipcRenderer.invoke('proj:save', payload),
  loadProject: (id) => ipcRenderer.invoke('proj:load', id),
  deleteProject: (id) => ipcRenderer.invoke('proj:delete', id),
  relinkMedia: (name) => ipcRenderer.invoke('media:relink', name),

  /**
   * The real paths of Files the person opened, mapped to ids the app can
   * stream from.
   *
   * Electron removed `File.path`, so `webUtils.getPathForFile` is the only way
   * to learn where a dropped file actually lives — and knowing that is what
   * lets a saved project find its footage again tomorrow. The page never sees
   * a path it did not already hand in.
   */
  registerMedia: async (files) => {
    const paths = [];
    for (const f of files) {
      try { const p = webUtils.getPathForFile(f); if (p) paths.push(p); }
      catch { /* not a real file (a Blob, say) — it simply gets no path */ }
    }
    if (!paths.length) return {};
    return ipcRenderer.invoke('media:register', paths);
  },
  pathFor: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },

  /** What version is running, and whether it came from an update. */
  updateStatus: () => ipcRenderer.invoke('update:status'),
  /** Pick an update file and install it. Reloads the editor on success. */
  installUpdate: () => ipcRenderer.invoke('update:pick'),
  /** Throw the update away and go back to the version inside the .exe. */
  revertUpdate: () => ipcRenderer.invoke('update:revert'),

  /* ── Updates over the network ──────────────────────────────────
     The renderer can ask, and can say "install the one you already have". It
     cannot name an address, a file or a version — every one of those decisions
     is made in the main process against the key compiled into the build. */
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  applyStagedUpdate: () => ipcRenderer.invoke('update:applyStaged'),
  markUpdateSeen: (v) => ipcRenderer.invoke('update:markSeen', String(v || '')),
  openInstallerPage: (url) => ipcRenderer.invoke('update:openInstaller', String(url || '')),
  /** Told whenever the updater has something new to say. */
  onUpdateState: (fn) => {
    const h = (_e, state) => { try { fn(state); } catch { /* renderer's problem */ } };
    ipcRenderer.on('update:state', h);
    return () => ipcRenderer.removeListener('update:state', h);
  },

  /** Reveal a saved file in Explorer / Finder, selected. */
  revealFile: (p) => ipcRenderer.invoke('shell:revealFile', String(p || '')),

  /** Native save dialog → absolute path, or null if cancelled. */
  saveAs: (opts) => ipcRenderer.invoke('dialog:saveAs', opts),
  writeFile: (p, data) => ipcRenderer.invoke('fs:writeFile', p, data),

  /**
   * Subscribe to an application-menu command. Returns an unsubscribe function.
   * The channel allowlist stops the page from wiring itself to arbitrary IPC.
   */
  onMenu: (channel, fn) => {
    if (!MENU_CHANNELS.includes(channel) || typeof fn !== 'function') return () => {};
    const handler = () => fn();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
