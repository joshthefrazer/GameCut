/** Open a project where you left it: playhead, zoom, scroll. Kept on this computer, not in the project. */
const KEY = 'strike.resume';
export function initResume({ store, library, playback, timeline }) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* storage off */ }
  let last = '';
  function note() {
    if (!library.id || document.getElementById('app')?.classList.contains('is-home') || store.rt.playing) return;
    const v = { p: +store.rt.playhead.toFixed(3), z: +store.ui.zoom.toFixed(4), x: +(store.ui.scrollX || 0).toFixed(3), y: Math.round(store.ui.scrollY || 0) };
    const k = library.id + JSON.stringify(v);
    if (k === last) return;
    last = k;
    all[library.id] = { ...v, at: Date.now() };
    const ids = Object.keys(all);
    if (ids.length > 40) for (const id of ids.sort((a, b) => all[a].at - all[b].at).slice(0, ids.length - 40)) delete all[id];
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage off */ }
  }
  setInterval(note, 3000);
  window.addEventListener('beforeunload', note);
  return {
    note,
    restore() {
      const v = all[library.id];
      if (!v || !Number.isFinite(v.p)) return false;
      if (v.z > 0) store.ui.zoom = v.z;
      store.ui.scrollX = Math.max(0, v.x || 0); store.ui.scrollY = Math.max(0, v.y || 0);
      playback.seek(Math.min(store.rt.duration, Math.max(0, v.p)));
      timeline.syncZoomUI(); timeline.repaint();
      return true;
    },
  };
}
