/**
 * GameCut — Electron host.
 *
 * Content is served over a custom `app://` protocol rather than a localhost
 * HTTP server. That matters for three reasons:
 *   1. No TCP bind, so no Windows Firewall prompt on first launch and no
 *      "port 5173 already in use" failure when another dev server is running.
 *   2. `protocol.handle` can still attach COOP/COEP, which is what unlocks
 *      SharedArrayBuffer for the WebCodecs / FFmpeg.wasm export path.
 *   3. Nothing on the machine's network can reach the editor.
 */

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const APP_SCHEME = 'app';
const APP_HOST = 'gamecut';
const MEDIA_SCHEME = 'gcmedia';
const ROOT = __dirname;

/**
 * Live updates without rebuilding the .exe.
 *
 * The interface is plain ES modules, CSS and one HTML file, loaded over app://
 * with no bundler and no build step. Nothing in the executable changes when the
 * editor changes — only the files it reads. So an update does not have to mean
 * npm install and three minutes of electron-builder; it can be those files,
 * dropped somewhere writable, and a restart.
 *
 * Files here win over the ones baked into the package. Deleting the folder puts
 * the built-in version back, which is the escape hatch if an update is bad.
 *
 * Hard boundary: only the things app:// already serves can be replaced —
 * index.html and the src / styles / vendor / assets folders. electron-main.cjs
 * and preload.cjs run with Node's full privileges and are NEVER updatable this
 * way; a change to either genuinely needs a rebuild, and the installer says so.
 */
const UPDATE_DIR = path.join(app.getPath('userData'), 'app-update');
const UPDATE_STAMP = path.join(UPDATE_DIR, '.version.json');
const START_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
const isDev = !app.isPackaged;

/**
 * Where this build looks for updates, and whose signature it trusts.
 *
 * Read from a file that ships INSIDE the package, next to the main process —
 * which means an update can never change it, because an update may only write
 * the files app:// serves. That is deliberate: the one thing a hijacked update
 * must not be able to do is redirect the next update to somewhere else.
 */
const UPDATE_CONFIG = (() => {
  const fallback = { manifestUrl: '', publicKey: '', checkEveryHours: 6, autoCheck: true };
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'update-config.json'), 'utf8');
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
})();

const { createUpdater } = require('./updater.cjs');
/** @type {ReturnType<typeof createUpdater>|null} */
let updater = null;

/** @type {BrowserWindow|null} */
let win = null;
/** Set when an update from an older build was discarded at startup. */
let staleUpdate = null;

/* ── MIME ──────────────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.wasm': 'application/wasm',
  '.map':  'application/json; charset=utf-8',
};

/**
 * What the protocol will hand out, by location rather than by extension.
 *
 * Traversal is already blocked in `resolveWithin`, so this is not the security
 * boundary — it is what stops the renderer from fetching files that merely
 * happen to sit in the app root and share an extension with a web asset
 * (server.js, electron-main.cjs, package.json). Scoping to the asset folders
 * means anything added to the root later is excluded by default instead of
 * needing a new deny entry.
 */
const SERVE_DIRS = ['src', 'styles', 'vendor', 'assets'];
const SERVE_FILES = ['index.html'];

/**
 * Content-Security-Policy.
 *
 * Sent as a header rather than a <meta> tag: a meta CSP only takes effect once
 * the parser reaches it, so anything injected earlier in the document would run
 * unpoliced. The allowances are exactly what the editor needs and nothing more:
 *   blob:  imported media — URL.createObjectURL() for every video and audio file
 *   data:  thumbnails baked with canvas.toDataURL(), and the inline SVG favicon
 *   'unsafe-inline' for STYLE only — the UI writes element.style constantly,
 *          which CSP counts as inline style; scripts get no such exemption
 * There is no 'unsafe-eval' and no remote origin anywhere, so even a malicious
 * font or media file has nothing to reach.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: gcmedia:",
  "media-src 'self' blob: gcmedia:",
  "font-src 'self' data: blob:",
  // gcmedia: is fetched too, not only played: reopening a project rebuilds each
  // waveform by reading the audio back off disk rather than storing it.
  "connect-src 'self' blob: data: gcmedia:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/* The renderer needs cross-origin isolation for SharedArrayBuffer. */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
};

/* GameCut is a local tool: nothing about a project should ever leave the
   machine. Chromium's own background services (component/variations updates,
   crash upload, speech) are the only things that would otherwise dial out, so
   they are switched off here rather than left to default. */
app.commandLine.appendSwitch('disable-features',
  'ComponentUpdater,OptimizationHints,MediaRouter,Translate,SpeechRecognition');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('metrics-recording-only');

/* Ask for the GPU.

   Chromium keeps a blocklist of drivers it refuses to accelerate, and a laptop
   with an older integrated chip or a stale driver often lands on it. It then
   falls back to rendering the entire window on the CPU, where every scaled
   video frame, every shadow and every rounded corner is drawn by hand. Editing
   video on that path is hopeless, and nothing in the app can make up for it —
   so ask for hardware acceleration rather than accept the fallback silently.

   These only ever ask; if the driver genuinely cannot do it, Chromium still
   falls back, and `reportGpu()` below tells the person so in plain words
   instead of leaving them to conclude their laptop is broken. */
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('canvas-oop-rasterization');

// Must run before `ready`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    /**
     * Media the person has opened, streamed from wherever it actually lives.
     *
     * A blob: URL dies with the window, so a saved project could never find its
     * footage again. Copying the footage into the app instead is not an option
     * either: these are hour-long gaming recordings, and a project should not
     * cost a second copy of five gigabytes. So a project stores the path, and
     * this scheme serves the file from there — the same thing Premiere and
     * Resolve do, with the same consequence, which is that moving a file makes
     * it "offline" until it is pointed at again.
     */
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

/**
 * Resolve a request pathname to a real file inside ROOT, or null if it escapes.
 * Confinement is checked on the *resolved* path so `..`, encoded separators and
 * symlinked directories all fail closed.
 */
function resolveWithin(pathname, root = ROOT) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;                                  // malformed percent-encoding
  }
  if (rel.includes('\0')) return null;

  const target = path.resolve(root, '.' + path.posix.normalize(rel));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/** True when `abs` is index.html or sits inside one of the asset folders. */
function isServable(abs, root = ROOT) {
  const base = path.resolve(root);
  const rel = path.relative(base, abs);
  if (rel === '') return true;                                  // the root itself → index.html
  if (SERVE_FILES.includes(rel)) return true;
  const first = rel.split(path.sep)[0];
  return SERVE_DIRS.includes(first);
}

function serve(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.createReadStream(filePath);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isDev ? 'no-store' : 'public, max-age=3600',
      ...ISOLATION_HEADERS,
    },
  });
}

/**
 * Paths the renderer is allowed to read, keyed by an opaque id.
 *
 * The page never names a path; it asks for an id it was given when the file was
 * opened or when a project was loaded. Nothing else on the disk is reachable,
 * which is the same boundary the app:// handler holds for the editor's own
 * files.
 */
const mediaPaths = new Map();
let mediaSeq = 0;

function registerMedia(abs) {
  if (typeof abs !== 'string' || !abs) return null;
  for (const [id, p] of mediaPaths) if (p === abs) return id;
  const id = 'f' + (++mediaSeq).toString(36) + Date.now().toString(36);
  mediaPaths.set(id, abs);
  return id;
}

/** Serve a registered file, honouring byte ranges. */
async function serveMedia(request) {
  let id;
  try { id = new URL(request.url).hostname; } catch { return new Response('Bad request', { status: 400 }); }
  const abs = mediaPaths.get(id);
  if (!abs) return new Response('Unknown media', { status: 404 });

  let st;
  try { st = await fsp.stat(abs); } catch {
    // The file moved or was deleted since the project was saved.
    return new Response('Media offline', { status: 410 });
  }

  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';

  /**
   * `cross-origin`, deliberately, and it is load-bearing.
   *
   * The page is cross-origin isolated (COEP: require-corp) so that WebCodecs
   * has SharedArrayBuffer. Under require-corp, every subresource from another
   * origin must opt in with CORP — and gcmedia:// IS another origin from
   * app://. Sending the editor's usual `same-origin` header here silently
   * blocked every video: the import produced no asset at all, with no error
   * that named the cause.
   */
  const MEDIA_HEADERS = {
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
  };
  const range = request.headers.get('Range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);

  /**
   * Ranges are not optional here.
   *
   * Without them a video element cannot seek: it asks for the bytes around the
   * timestamp, gets the whole file from the start instead, and lands back at
   * zero. Measured exactly that before this was written — a 40-second clip
   * asked to seek to 30s reported "seeked" and sat at 0. Scrubbing an
   * hour-long recording is entirely this code path.
   */
  if (!m) {
    return new Response(fs.createReadStream(abs), {
      status: 200,
      headers: { 'Content-Length': String(st.size), 'Content-Type': type,
                 'Accept-Ranges': 'bytes', ...MEDIA_HEADERS },
    });
  }
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = Math.min(m[2] ? parseInt(m[2], 10) : st.size - 1, st.size - 1);
  if (!(start >= 0) || start > end) {
    return new Response('Bad range', { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
  }
  return new Response(fs.createReadStream(abs, { start, end }), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': String(end - start + 1),
      'Content-Type': type, 'Accept-Ranges': 'bytes', ...MEDIA_HEADERS,
    },
  });
}

function registerProtocol() {
  protocol.handle(MEDIA_SCHEME, serveMedia);

  protocol.handle(APP_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    // Query strings and hashes are not part of the file path.
    let pathname = url.pathname || '/';
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // An installed update is checked first and the package second, so a partial
    // update still runs: any file it did not carry comes from the build.
    for (const root of updateInstalled() ? [UPDATE_DIR, ROOT] : [ROOT]) {
      const file = resolveWithin(pathname, root);
      if (!file || !isServable(file, root)) continue;
      try {
        const st = await fsp.stat(file);
        if (st.isDirectory()) {
          const idx = path.join(file, 'index.html');
          await fsp.access(idx, fs.constants.R_OK);
          return serve(idx);
        }
        return serve(file);
      } catch { /* not in this root; try the next */ }
    }

    // Distinguish "you may not ask for that" from "it is not here", because the
    // first is a bug in the page and the second is usually a missing file.
    const probe = resolveWithin(pathname, ROOT);
    if (!probe || !isServable(probe, ROOT)) {
      return new Response('Forbidden', { status: 403, headers: ISOLATION_HEADERS });
    }
    return new Response('Not found', { status: 404, headers: ISOLATION_HEADERS });
  });
}

/**
 * Hard guarantee behind the "nothing leaves this machine" promise: the renderer
 * can only load from `app:`, `blob:` and `data:`. A media file or a font that
 * tried to phone home — or a future dependency quietly added to the page — is
 * refused at the session layer rather than trusted not to try.
 */
function lockDownNetwork() {
  // gcmedia: belongs here for the same reason app: does — it is this process
  // handing the page a local file it already opened, never a network fetch.
  // Leaving it out blocked every video import with ERR_BLOCKED_BY_CLIENT and no
  // message that named the cause.
  const ALLOWED = /^(app|gcmedia|blob|data|devtools):/i;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !ALLOWED.test(details.url) });
  });

  /**
   * Permissions: everything refused except going fullscreen.
   *
   * This handler used to refuse the lot, which is why the fullscreen button in
   * the preview had never worked once — not since the first build. Chromium
   * routes `element.requestFullscreen()` through the same permission gate as the
   * camera and the microphone, so "deny everything" quietly denied that too, and
   * the promise rejected with no message worth reading. Nothing here wants a
   * camera, a microphone, a location or a notification, and that stays true;
   * filling the screen with the picture you are editing is not that kind of
   * request.
   *
   * Both handlers matter: the async one answers a live request, the sync one
   * answers the check Chromium makes before it will even offer the button.
   */
  const ALLOWED_PERMS = new Set(['fullscreen', 'window-placement', 'window-management']);
  session.defaultSession.setPermissionRequestHandler(
    (_wc, perm, cb) => cb(ALLOWED_PERMS.has(perm)));
  session.defaultSession.setPermissionCheckHandler(
    (_wc, perm) => ALLOWED_PERMS.has(perm));

  /**
   * Test seam. Electron gives no way to read a permission handler back, and a
   * live `requestFullscreen()` cannot tell "refused" from "this machine has no
   * window manager" — under a bare X server it simply never settles, which is
   * exactly how the refusal went unnoticed for the life of the project. So the
   * decision itself is readable, and the suite asserts on it.
   */
  globalThis.__gcPermitted = (perm) => ALLOWED_PERMS.has(perm);
}

/* ── Window ────────────────────────────────────────────────────── */
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 940,
    minWidth: 1100,
    minHeight: 660,
    show: false,                       // avoid the white flash before first paint
    backgroundColor: '#070b14',        // matches --bg-0 so the reveal is seamless
    title: 'GameCut',
    /**
     * The app draws its own top bar.
     *
     * A native title strip plus a menu bar above a dark editor read as two
     * different programs stacked on each other. `hidden` keeps the real window
     * controls — so minimise, maximise and close still behave exactly as
     * Windows expects — while the caption area becomes ours to fill.
     *
     * The menu is hidden rather than removed: Alt still opens it, which is what
     * keeps "Update → Go back to the built-in version" reachable even if the
     * page itself will not start.
     */
    ...(process.platform === 'linux'
      // Linux has no window-control overlay, so hiding the title bar there
      // leaves a window with no way to close it. Keep the frame.
      ? {}
      : {
          titleBarStyle: 'hidden',
          ...(process.platform === 'win32'
            ? { titleBarOverlay: { color: '#0b1120', symbolColor: '#b8c9e4', height: 52 } }
            : {}),
        }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,                  // preload needs require() for ipcRenderer
      spellcheck: false,
      backgroundThrottling: false,     // keep playback timing honest when unfocused
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  /**
   * Save before the window goes.
   *
   * The renderer owns the document, so closing is a handshake: hold the close,
   * ask the page to save, then let go. `closing` stops the second close event
   * (the one we send ourselves) from starting the conversation again.
   *
   * If the page cannot answer — it is wedged, or an update broke it — a short
   * timeout lets the window close anyway. Refusing to shut down would be a far
   * worse failure than losing the last few seconds of edits.
   */
  let closing = false;
  win.on('close', (e) => {
    if (closing || !win) return;
    e.preventDefault();
    closing = true;

    /**
     * The message on the way out is shown IN the window, not as a dialog.
     *
     * A modal here has to be dismissed before the app can quit, every single
     * time you close it — and under an automated run nobody ever clicks it, so
     * the window simply never goes. That is how this was found: every test
     * suite hung on shutdown. The renderer shows a toast and then tells us it
     * is done, which is a message you see and never have to answer.
     *
     * A failed save is the exception: that one is worth stopping for.
     */
    const done = (result) => {
      if (result && result.saved === false && result.failed) {
        dialog.showMessageBox(win, {
          type: 'warning', buttons: ['Close anyway'], title: 'Could not save',
          message: `"${result.name}" could not be saved.`,
          detail: result.reason || 'The project file could not be written.',
        }).catch(() => {}).finally(() => { if (win && !win.isDestroyed()) win.destroy(); });
        return;
      }
      if (win && !win.isDestroyed()) win.destroy();
    };

    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; done(r); } };
    setTimeout(() => finish(null), 4000);
    win.webContents.send('app:closing');
    ipcMain.once('app:closed', (_e, result) => finish(result));
  });

  win.on('closed', () => { win = null; });

  // Never let the app navigate away from itself, and send real links to the
  // user's browser instead of opening a chrome-less Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    dialog.showErrorBox('GameCut stopped responding',
      `The editor process exited (${details.reason}). The window will reload.`);
    if (win && !win.isDestroyed()) win.reload();
  });

  win.loadURL(START_URL);
}

/* ── Menu ──────────────────────────────────────────────────────── */
function buildMenu() {
  const send = (channel) => () => win?.webContents.send(channel);

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: send('menu:import') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: send('menu:export') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      /**
       * In the native menu on purpose.
       *
       * If an update ever leaves the editor unable to start, the page cannot
       * offer you a way out of it — but the menu belongs to the main process
       * and is still there. "Go back to the built-in version" is the escape
       * hatch, and it has to live somewhere a broken page cannot take away.
       */
      label: 'Update',
      submenu: [
        {
          label: 'Install update file…',
          click: async () => {
            if (!win) return;
            const { canceled, filePaths } = await dialog.showOpenDialog(win, {
              title: 'Install a GameCut update',
              properties: ['openFile'],
              filters: [{ name: 'GameCut update', extensions: ['gcupdate', 'json'] }],
            });
            if (canceled || !filePaths?.[0]) return;
            const r = await installUpdate(filePaths[0]);
            if (!r.ok) {
              dialog.showErrorBox('Update not installed', r.reason);
              return;
            }
            reloadEditor();
          },
        },
        {
          label: 'Go back to the built-in version',
          click: async () => { await revertUpdate(); reloadEditor(); },
        },
        { type: 'separator' },
        {
          label: 'What am I running?',
          click: () => {
            const u = updateInstalled();
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'GameCut version',
              message: u
                ? `Update ${u.version}`
                : `Built-in version ${app.getVersion()}`,
              detail: u
                ? `${u.files} files, installed ${new Date(u.installedAt).toLocaleString()}.\n` +
                  `The .exe itself is still ${app.getVersion()}.`
                : 'No update installed — this is the version that came with the build.',
            });
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('menu:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About GameCut',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'About GameCut',
            message: `GameCut ${app.getVersion()}`,
            detail: 'Local video editor for gaming clips.\nNothing leaves this machine.',
            buttons: ['OK'],
          }),
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({ role: 'appMenu' });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── IPC (reachable from the renderer via preload) ─────────────────
   Media import deliberately does NOT go through here. The renderer's
   <input type="file"> hands back a disk-backed File; pulling a 2 GB
   capture through IPC would copy the whole thing into memory twice.
   Only the save path — which produces bytes the renderer already holds
   — needs the main process.                                        */

/**
 * Hand a finished export over to YouTube's upload page.
 *
 * The renderer cannot name the destination. It asks for "youtube-upload" and
 * this decides what that means — anything else is refused. A renderer that
 * could pass its own URL to shell.openExternal would be a way to launch
 * arbitrary things on the machine, which is precisely the boundary the preload
 * bridge exists to hold.
 *
 * Nothing is sent anywhere from inside the app: this opens the normal browser,
 * where the person is already signed in, and reveals the file so it can be
 * dragged in. The app's own network block is untouched.
 */
const EXTERNAL_TARGETS = {
  'youtube-upload': 'https://www.youtube.com/upload',
};

ipcMain.handle('shell:openTarget', async (_e, key) => {
  const url = EXTERNAL_TARGETS[key];
  if (!url) return false;
  await shell.openExternal(url);
  return true;
});

/** Show a file in the OS file manager, selected and ready to drag. */
ipcMain.handle('shell:revealFile', async (_e, target) => {
  if (typeof target !== 'string' || !target) return false;
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return false;
  shell.showItemInFolder(abs);
  return true;
});

ipcMain.handle('dialog:saveAs', async (_e, opts = {}) => {
  if (!win) return null;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: opts.title || 'Save',
    defaultPath: opts.defaultPath || undefined,
    filters: opts.filters || [
      { name: 'GameCut Project', extensions: ['gcproj'] },
      { name: 'MP4 Video', extensions: ['mp4'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled ? null : filePath;
});

ipcMain.handle('fs:writeFile', async (_e, filePath, data) => {
  if (typeof filePath !== 'string' || !filePath) throw new Error('bad path');
  await fsp.writeFile(filePath, Buffer.from(data));
  return true;
});

/* ── Project library ───────────────────────────────────────────── */

/**
 * Projects live in the app's own folder, not wherever you last browsed to.
 *
 * That is what makes a home screen possible: there is one place to list. The
 * footage stays where it is — a project records the path to it, never a copy —
 * so the library is small no matter how much video the projects reference.
 */
const PROJ_DIR = path.join(app.getPath('userData'), 'projects');
const projFile = (id) => path.join(PROJ_DIR, `${safeId(id)}.gcproj`);

/** Ids are ours, but they end up in a filename, so they are checked anyway. */
function safeId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return s.slice(0, 60) || 'project';
}

async function listProjects() {
  let names = [];
  try { names = await fsp.readdir(PROJ_DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.gcproj')) continue;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(PROJ_DIR, n), 'utf8'));
      const st = await fsp.stat(path.join(PROJ_DIR, n));
      out.push({
        id: raw.id, name: raw.name || 'Untitled Project',
        duration: raw.duration || 0,
        clips: raw.clips || 0,
        thumb: raw.thumb || null,
        savedAt: raw.savedAt || st.mtimeMs,
        bytes: st.size,
      });
    } catch { /* a corrupt file should not hide the rest of the library */ }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

async function saveProject(payload) {
  if (!payload || !payload.id) return { ok: false, reason: 'Nothing to save.' };
  await fsp.mkdir(PROJ_DIR, { recursive: true });
  const body = { ...payload, savedAt: Date.now(), schema: 1 };
  // Write beside, then rename: a crash mid-write must not destroy the last
  // good copy of somebody's edit.
  const tmp = projFile(payload.id) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(body), 'utf8');
  await fsp.rename(tmp, projFile(payload.id));
  return { ok: true, savedAt: body.savedAt };
}

async function loadProject(id) {
  try {
    const raw = JSON.parse(await fsp.readFile(projFile(id), 'utf8'));
    // Hand back a media id for every asset that still has a file behind it.
    for (const a of raw.assets || []) {
      if (!a.path) { a.missing = true; continue; }
      try {
        await fsp.access(a.path, fs.constants.R_OK);
        a.mediaId = registerMedia(a.path);
      } catch {
        a.missing = true;
      }
    }
    return { ok: true, project: raw };
  } catch (err) {
    return { ok: false, reason: 'That project could not be opened.' };
  }
}

ipcMain.handle('proj:list', () => listProjects());
ipcMain.handle('proj:save', (_e, payload) => saveProject(payload));
ipcMain.handle('proj:load', (_e, id) => loadProject(id));
ipcMain.handle('proj:delete', async (_e, id) => {
  try { await fsp.rm(projFile(id), { force: true }); return { ok: true }; }
  catch { return { ok: false }; }
});

/**
 * Turn dropped/picked Files into ids this process will stream.
 *
 * The renderer cannot read a File's path itself — Electron removed `File.path`
 * — so it hands the File objects to the preload, which asks `webUtils` and
 * passes the paths here. Registering is what makes a file reachable over
 * gcmedia:; nothing else on the disk is.
 */
ipcMain.handle('media:register', (_e, paths) => {
  const out = {};
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p) continue;
    out[p] = registerMedia(p);
  }
  return out;
});

/** Point a moved file at its project again. */
ipcMain.handle('media:relink', async (_e, name) => {
  if (!win) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: name ? `Find "${name}"` : 'Find the missing file',
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.[0]) return null;
  return { path: filePaths[0], id: registerMedia(filePaths[0]) };
});

/* ── Updates ───────────────────────────────────────────────────── */

/**
 * Throw away an update that belongs to an older build.
 *
 * An installed update shadows the editor files inside the .exe, and it did so
 * permanently — which meant rebuilding the app with newer code changed nothing
 * you could see, because the old update was still winning. That is exactly how
 * a freshly built projects screen failed to appear: the executable had it, the
 * update folder did not, and the update folder came first.
 *
 * So an update is only honoured on the build it was installed against. Rebuild
 * the app and any older overlay is dropped, which is the behaviour you would
 * assume without being told.
 */
function dropStaleUpdate() {
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(UPDATE_STAMP, 'utf8')); } catch { return null; }
  if (!stamp) return null;
  if (stamp.appVersion === app.getVersion()) return null;

  try { fs.rmSync(UPDATE_DIR, { recursive: true, force: true }); } catch { /* nothing to drop */ }
  return {
    was: stamp.version || 'unknown',
    builtFor: stamp.appVersion || 'an earlier build',
    now: app.getVersion(),
  };
}

/** The version stamp of an installed update, or null if running the built-in. */
function updateInstalled() {
  try {
    const raw = fs.readFileSync(UPDATE_STAMP, 'utf8');
    const v = JSON.parse(raw);
    return v && v.version ? v : null;
  } catch {
    return null;
  }
}

/**
 * Install an update bundle.
 *
 * The bundle is JSON, not a zip, for one reason: Node has no zip reader built
 * in, and adding a dependency for this would mean the very `npm install` this
 * feature exists to avoid. Every file the editor serves is text, so a plain
 * object of path -> contents does the job with nothing to install.
 *
 * Only paths app:// already serves are written. A bundle naming
 * electron-main.cjs, preload.cjs or anything outside those folders has that
 * entry ignored and reported, because those run as Node with full privileges
 * and must only ever change through a real rebuild.
 */
async function installUpdate(bundlePath) {
  let bundle;
  try {
    bundle = JSON.parse(await fsp.readFile(bundlePath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'That file is not a GameCut update.' };
  }
  if (!bundle || bundle.kind !== 'gamecut-update' || !bundle.files) {
    return { ok: false, reason: 'That file is not a GameCut update.' };
  }

  const entries = Object.entries(bundle.files);
  if (!entries.length) return { ok: false, reason: 'That update is empty.' };

  const staging = UPDATE_DIR + '.new';
  await fsp.rm(staging, { recursive: true, force: true });

  const written = [];
  const refused = [];
  for (const [rel, body] of entries) {
    const abs = resolveWithin('/' + rel, staging);
    // Refused entries are reported rather than silently dropped: a bundle that
    // expects to replace the main process should say so out loud.
    if (!abs || !isServable(abs, staging)) { refused.push(rel); continue; }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, typeof body === 'string' ? body : String(body), 'utf8');
    written.push(rel);
  }

  if (!written.includes('index.html') && !written.some(f => f.startsWith('src/'))) {
    await fsp.rm(staging, { recursive: true, force: true });
    return { ok: false, reason: 'That update has no editor files in it.' };
  }

  await fsp.writeFile(path.join(staging, '.version.json'), JSON.stringify({
    version: String(bundle.version || 'unknown'),
    note: String(bundle.note || ''),
    installedAt: Date.now(),
    files: written.length,
    // WHICH BUILD this was installed on top of. See dropStaleUpdate().
    appVersion: app.getVersion(),
  }), 'utf8');

  // Swap only once the new copy is complete, so a failure part way through
  // leaves the previous version running rather than a half-updated one.
  await fsp.rm(UPDATE_DIR, { recursive: true, force: true });
  await fsp.rename(staging, UPDATE_DIR);

  return { ok: true, version: String(bundle.version || 'unknown'),
           files: written.length, refused };
}

async function revertUpdate() {
  await fsp.rm(UPDATE_DIR, { recursive: true, force: true });
  await fsp.rm(UPDATE_DIR + '.new', { recursive: true, force: true });
  return { ok: true };
}

/** Reload the window so the newly-installed files are the ones running. */
function reloadEditor() {
  if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
}

/* Test seam: the installer is otherwise only reachable behind a native file
   picker, which a test cannot answer. Exposing the functions themselves — not
   a way to bypass their checks — is what lets the refusal be asserted. */
globalThis.__gcInstallUpdate = installUpdate;
globalThis.__gcDropStale = dropStaleUpdate;
globalThis.__gcRevertUpdate = revertUpdate;

/**
 * Start the network side of updates.
 *
 * Everything it needs is decided here rather than read from the manifest: which
 * address, which key, and which version counts as "what is running" — the
 * installed update if there is one, because comparing against the shell's own
 * version would mean offering the same update forever.
 */
function startUpdater() {
  const running = updateInstalled();
  updater = createUpdater({
    appVersion: app.getVersion(),
    runningVersion: running?.version || app.getVersion(),
    config: UPDATE_CONFIG,
    userDataDir: app.getPath('userData'),
    onState: (st) => {
      if (win && !win.isDestroyed()) win.webContents.send('update:state', st);
    },
  });
  updater.start();
}

/* Test seam: the whole point of this feature is code arriving from elsewhere,
   so the suite has to be able to stand up a server and watch the app refuse the
   wrong things. This rebuilds the updater against a different address and key —
   it does not weaken a single check. */
globalThis.__gcRestartUpdater = (config) => {
  updater?.stop();
  Object.assign(UPDATE_CONFIG, config);
  const running = updateInstalled();
  updater = createUpdater({
    appVersion: app.getVersion(),
    runningVersion: running?.version || app.getVersion(),
    config: UPDATE_CONFIG,
    userDataDir: app.getPath('userData'),
    onState: (st) => {
      if (win && !win.isDestroyed()) win.webContents.send('update:state', st);
    },
  });
  return UPDATE_CONFIG;
};
globalThis.__gcCheckUpdate = () => updater?.check({ manual: true });
globalThis.__gcUpdaterState = () => updater?.state;

/* Put the machine back to "never updated", so one test's leftovers cannot
   answer the next test's question. Main-process only, like the seams above —
   the renderer has no `require` and cannot reach any of this. */
globalThis.__gcUpdateTestReset = () => {
  const dir = app.getPath('userData');
  for (const f of ['update-state.json', 'staged.gcupdate']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* not there */ }
  }
  try { fs.rmSync(UPDATE_DIR, { recursive: true, force: true }); } catch { /* none */ }
  return true;
};
/** Read a file out of the installed update, to prove the right bytes landed. */
globalThis.__gcReadInstalled = (rel) => {
  try { return fs.readFileSync(path.join(UPDATE_DIR, rel), 'utf8'); } catch { return null; }
};

ipcMain.handle('update:status', () => ({
  built: app.getVersion(),
  running: updateInstalled(),
  // Reported once so the editor can say why it looks different from last time.
  dropped: staleUpdate,
  net: updater ? updater.state : null,
  whatsNew: updater ? updater.unseenNotes(updateInstalled()?.version || app.getVersion()) : null,
}));

/** Ask the server now, because somebody pressed the button. */
ipcMain.handle('update:check', async () => {
  if (!updater) return { phase: 'off' };
  return updater.check({ manual: true });
});

/**
 * Install the update that was already downloaded and verified.
 *
 * It goes through exactly the same installer a hand-picked file does, so the
 * path allowlist, the refusal to write shell files and the atomic swap all
 * apply unchanged. Arriving over the network earns it no privileges.
 */
ipcMain.handle('update:applyStaged', async () => {
  if (!updater) return { ok: false, reason: 'Updates are switched off in this build.' };
  const staged = updater.stagedPath;
  if (!staged) return { ok: false, reason: 'There is no downloaded update waiting.' };
  const r = await installUpdate(staged);
  if (r.ok) {
    await updater.clearStaged(r.version);
    setTimeout(reloadEditor, 400);
  }
  return r;
});

/** The "what's new" card has been read; do not show it again. */
ipcMain.handle('update:markSeen', (_e, version) => {
  updater?.markSeen(String(version || ''));
  return true;
});

/**
 * Open the download page for a release that needs the full installer.
 *
 * `shell.openExternal` is the only outbound action in the app that is not a
 * plain GET, and it is limited to the one origin this build already trusts —
 * a manifest cannot use it to open anything it likes.
 */
ipcMain.handle('update:openInstaller', async (_e, url) => {
  const { sameOrigin } = require('./updater.cjs');
  if (!url || !sameOrigin(String(url), UPDATE_CONFIG.manifestUrl || '')) {
    return { ok: false, reason: 'That download address is not the one this build trusts.' };
  }
  await shell.openExternal(String(url));
  return { ok: true };
});

ipcMain.handle('update:pick', async () => {
  if (!win) return { ok: false, reason: 'No window.' };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Install a GameCut update',
    properties: ['openFile'],
    filters: [{ name: 'GameCut update', extensions: ['gcupdate', 'json'] }],
  });
  if (canceled || !filePaths?.[0]) return { ok: false, cancelled: true };
  const r = await installUpdate(filePaths[0]);
  if (r.ok) setTimeout(reloadEditor, 400);
  return r;
});

ipcMain.handle('update:revert', async () => {
  const r = await revertUpdate();
  setTimeout(reloadEditor, 400);
  return r;
});

ipcMain.handle('app:version', () => app.getVersion());

/**
 * Whether this machine is drawing the window with its graphics card or its CPU.
 *
 * `getGPUFeatureStatus()` reports per-feature strings like 'enabled' or
 * 'disabled_software'. Compositing is the one that matters: with it software,
 * every frame of the preview is scaled and blended by the processor, and an
 * editor that is perfectly smooth elsewhere will crawl. Worth naming.
 */
ipcMain.handle('app:gpuStatus', () => {
  let status = {};
  try { status = app.getGPUFeatureStatus() || {}; } catch { /* pre-ready or headless */ }
  const compositing = status.gpu_compositing || 'unknown';
  return {
    accelerated: compositing === 'enabled' || compositing === 'enabled_on',
    compositing,
    rasterization: status.rasterization || 'unknown',
  };
});

/* ── Lifecycle ─────────────────────────────────────────────────── */

// A second launch focuses the existing window instead of starting a rival copy
// that would fight over the same project files.
if (!app.requestSingleInstanceLock()) {
  // Normally this means GameCut is already open, and the running copy gets
  // focused by the 'second-instance' handler below. It can also mean a stale
  // lock left by an unclean exit, in which case nothing is there to focus and
  // the app would vanish without a word — so say why before going.
  console.error(
    '[GameCut] Another instance holds the single-instance lock; exiting.\n' +
    '          If no GameCut window is open, the lock is stale. Remove it:\n' +
    `            ${path.join(app.getPath('userData'), 'SingletonLock')}`);
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerProtocol();
    lockDownNetwork();
    // Before anything loads: an overlay from a previous build must not shadow
    // the editor this .exe actually ships with.
    staleUpdate = dropStaleUpdate();
    buildMenu();
    createWindow();
    startUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err) => {
    dialog.showErrorBox('GameCut failed to start', String(err?.stack || err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

process.on('uncaughtException', (err) => {
  // Surface it instead of dying silently behind a blank window.
  try {
    dialog.showErrorBox('GameCut — unexpected error', String(err?.stack || err));
  } catch { /* dialog unavailable pre-ready */ }
});
