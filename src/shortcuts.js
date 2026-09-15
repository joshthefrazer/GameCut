import { zoomAt, zoomFit } from './ui/timeline/zoom.js';
import { bus } from './core/events.js';

const typing = () => {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

export function initShortcuts({ store, cmds, history, playback, timeline, preview, help }) {
  window.addEventListener('keydown', (e) => {
    // Help answers before anything else, including while a field has focus —
    // "how do I get out of this" is exactly the moment you reach for it.
    if (e.key === 'F1' || (e.key === '?' && !typing())) {
      e.preventDefault();
      help?.toggle?.();
      return;
    }
    if (typing()) return;
    const mod = e.ctrlKey || e.metaKey;
    const fps = store.doc.fps;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? history.redo() : history.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); cmds.duplicateSelected(); return; }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      store.select(store.doc.tracks.flatMap(t => t.clips.map(c => c.id)));
      return;
    }
    if (mod) return;

    switch (e.key) {
      case ' ':
        e.preventDefault(); playback.toggle(); break;
      /* Enter on a selected title starts typing on it, the way renaming works
         in every file manager. `typing()` above means this can never fire while
         the field it opens has focus. */
      case 'Enter': {
        const sel = store.selectedClips;
        if (sel.length === 1 && sel[0].clip.type === 'text') {
          e.preventDefault();
          bus.emit('text:edit', { clipId: sel[0].clip.id });
        }
        break;
      }
      case 'ArrowLeft':
        e.preventDefault(); nudge(e.shiftKey ? -fps : -1); break;
      case 'ArrowRight':
        e.preventDefault(); nudge(e.shiftKey ? fps : 1); break;
      case 'ArrowUp': case 'ArrowDown':
        e.preventDefault(); break;
      case 'Home':
        playback.pause(); playback.seek(0); break;
      case 'End':
        playback.pause(); playback.seek(store.rt.duration); break;
      case 'Delete': case 'Backspace':
        e.preventDefault(); cmds.removeSelected(); break;
      case 'Escape':
        store.select([]); break;
      case '+': case '=':
        zoomAt(store, 1.25, timeline.L.W / 2); timeline.syncZoomUI(); timeline.repaint(); break;
      case '-': case '_':
        zoomAt(store, 0.8, timeline.L.W / 2); timeline.syncZoomUI(); timeline.repaint(); break;
      default: {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); cmds.splitAt(store.rt.playhead, store.rt.selection); }
        else if (k === 't') { e.preventDefault(); cmds.addTextClip(store.rt.playhead); }
        else if (k === 'c') { e.preventDefault(); preview?.crop?.toggle?.(); }
        else if (k === 'm') { cmds.addMarker(store.rt.playhead); }
        else if (k === 'l') { document.getElementById('btnLoop').click(); }
        else if (k === 'n') { document.getElementById('btnMagnet').click(); }
        else if (k === 'b') { document.getElementById('btnBeatGrid').click(); }
        else if (k === 'i') { e.preventDefault(); document.getElementById('filePicker').click(); }
        else if (k === 'z' && e.shiftKey) { zoomFit(store, timeline.L.W); timeline.syncZoomUI(); timeline.repaint(); }
        // F is fullscreen everywhere else; it used to force a redundant repaint.
        else if (k === 'f') { e.preventDefault(); preview?.toggleFullscreen?.(); }
      }
    }
  });

  /** Arrow keys nudge the selection when there is one, else the playhead. */
  function nudge(frames) {
    const step = frames / store.doc.fps;
    const sel = store.selectedClips;
    if (!sel.length) { playback.pause(); playback.step(frames); return; }
    history.begin('Nudge', 'nudge');
    for (const { clip } of sel) clip.start = Math.max(0, clip.start + step);
    history.commit();
    bus.emit('inspector:refresh');
  }
}
