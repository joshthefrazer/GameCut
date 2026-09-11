import { bus } from './core/events.js';

/**
 * Desktop integration: application menu, native save dialogs, version.
 *
 * `window.gamecut` is injected by preload.cjs. It should always be present —
 * this is a desktop-only app — so its absence means the preload failed to load,
 * which is worth saying out loud rather than degrading in silence. The editor
 * itself still runs; only the menu and file dialogs are missing.
 */
export function initDesktop({ history }) {
  const api = window.gamecut;
  if (!api?.isDesktop) {
    console.warn('[GameCut] preload bridge missing — menu and save dialogs disabled');
    return { isDesktop: false };
  }

  document.documentElement.classList.add('is-desktop');
  // Only Windows paints its window buttons over our caption area, so only
  // Windows needs the top bar to stop short of them.
  if (api.platform === 'win32') document.documentElement.classList.add('is-win');

  const click = (id) => document.getElementById(id)?.click();

  api.onMenu('menu:import', () => click('filePicker'));
  api.onMenu('menu:export', () => click('btnExport'));
  api.onMenu('menu:undo', () => history.undo());
  api.onMenu('menu:redo', () => history.redo());

  api.version()
    .then((v) => { if (v) document.title = `GameCut ${v}`; })
    .catch(() => {});

  /* The version chip and everything behind it now live in
     ui/updates/updates-panel.js — it has to show what is running, what is
     available and the log of what changed, and two modules both wiring the
     same button is how one of them silently stops working. */

  /**
   * Say it out loud when the graphics card isn't being used.
   *
   * Chromium blocklists some older drivers and quietly draws the whole window
   * on the processor instead. Everything still works and everything is slow,
   * which is indistinguishable from "this laptop can't handle it" unless
   * somebody says otherwise. Updating the graphics driver usually fixes it, so
   * the message says that rather than just reporting a fact.
   */
  api.gpuStatus?.()
    .then((g) => {
      if (!g || g.accelerated) return;
      console.warn('[GameCut] GPU compositing is', g.compositing, '— rendering on the CPU');
      bus.emit('toast', {
        msg: 'Your graphics card is not being used, so the preview will be slow. '
           + 'Updating your graphics driver usually fixes this. '
           + 'Until then, set Preview quality to Quarter.',
        kind: 'err',
        ms: 14000,
      });
    })
    .catch(() => {});

  /** Write bytes to a user-picked path. Returns the path, or null if cancelled. */
  async function save(bytes, { title, defaultPath, filters } = {}) {
    const target = await api.saveAs({ title, defaultPath, filters });
    if (!target) return null;
    await api.writeFile(target, bytes);
    bus.emit('toast', { msg: `Saved ${target.split(/[\\/]/).pop()}`, kind: 'ok' });
    return target;
  }

  return { isDesktop: true, save };
}
