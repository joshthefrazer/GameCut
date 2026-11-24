import { freezeFrame } from './edit/freeze-frame.js';
import { zoomAt, zoomFit } from './ui/timeline/zoom.js';
import { bus } from './core/events.js';

/**
 * Input types you type INTO. Everything else that is an <input> — a slider, a
 * checkbox, a colour swatch — is a control you click, and must not swallow the
 * editor's keys. Treating every INPUT as "typing" meant that touching a slider
 * once (which leaves it focused) silently switched off S, Delete, Space and the
 * rest until you happened to click somewhere else.
 */
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'number', 'password', 'url', 'tel',
  'date', 'time', 'datetime-local', 'month', 'week']);

/** The keyboard editing tools (src/edit/edit-tools.js), once main.js has made them. */
const tools = () => window.gc?.editTools || null;

const typing = () => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  // A focused <select> owns its arrow keys (and letters jump to options), so
  // it counts as typing too — the arrows used to be preventDefault'ed out from
  // under it.
  if (el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  return false;
};

/** A focused control that uses the arrow keys itself (a slider). */
const arrowOwner = () => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'INPUT' && (el.type === 'range')) return true;
  return el.getAttribute?.('role') === 'slider';
};

/**
 * True when the editor is not what you are looking at.
 *
 * On the projects screen the last project is still loaded underneath, so Ctrl+A
 * then Delete there selected and deleted every clip of a saved project you
 * could not even see. The same was true behind the Export dialog, the Help
 * sheet and the Updates panel. Anything shown as a modal dialog
 * (aria-modal="true") that is actually on screen counts.
 */
export function editorCovered() {
  if (document.getElementById('app')?.classList.contains('is-home')) return true;
  for (const d of document.querySelectorAll('[aria-modal="true"]')) {
    if (d.getClientRects().length) return true;
  }
  return false;
}

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
    // A control that handled the key itself (a slider stepping its value) has
    // said so; doing something else with the same press would be two actions.
    if (e.defaultPrevented) return;
    if (editorCovered()) return;
    const mod = e.ctrlKey || e.metaKey;
    const fps = store.doc.fps;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? history.redo() : history.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); cmds.duplicateSelected(); return; }
    if (mod && e.altKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      const s = store.selectedClips;
      if (s.length) cmds.copyLook(s[0].clip.id); else bus.emit('toast', { msg: 'Select the clip whose look you want to copy.' });
      return;
    }
    if (mod && e.altKey && e.key.toLowerCase() === 'v') { e.preventDefault(); cmds.pasteLook(store.rt.selection); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); bus.emit('frame:save'); return; }
    if (mod && e.key.toLowerCase() === 'h') { e.preventDefault(); bus.emit('history:open'); return; }
    if (mod && e.key === ',') { e.preventDefault(); bus.emit('settings:open'); return; }
    // Import moved to Ctrl+I in 3.0: I and O now mark In and Out, as in other editors.
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); document.getElementById('filePicker').click(); return; }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); tools()?.openGoTo(); return; }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      // Clips on a locked track (or locked themselves) are not yours to edit,
      // so they are not part of "everything".
      store.select(cmds.selectableIds());
      return;
    }
    if (mod) return;

    // Alt + [ / ]: trim the clip at the playhead (before [ and ] jump between markers).
    if (e.altKey && (e.key === '[' || e.key === ']' || e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      e.preventDefault();
      tools()?.trimToPlayhead(e.code === 'BracketLeft' || e.key === '[' ? 'in' : 'out');
      return;
    }
    if (e.altKey && e.code === 'KeyX') { e.preventDefault(); tools()?.clearMarks(); return; }
    // Alt + , / . : slip (Shift for ten frames).
    if (e.altKey && (e.code === 'Comma' || e.code === 'Period')) {
      e.preventDefault();
      tools()?.slip((e.code === 'Comma' ? -1 : 1) * (e.shiftKey ? 10 : 1));
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (tools()?.rate && tools().rate !== 1) { tools().stopShuttle(); break; }
        tools()?.stopShuttle();
        playback.toggle(); break;
      case ',': e.preventDefault(); tools()?.stopShuttle(); playback.step(-1); break;
      case '.': e.preventDefault(); tools()?.stopShuttle(); playback.step(1); break;
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
      /*
       * Left / Right always move the PLAYHEAD — one frame, or a second with
       * Shift. They used to move the selected clip instead whenever anything
       * was selected, and since clicking a clip selects it, the arrows turned
       * into "shove my clip by a frame" exactly when you were trying to find the
       * frame to cut on. Moving clips is Alt + arrows.
       */
      case 'ArrowLeft': case 'ArrowRight': {
        if (arrowOwner()) return;
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const frames = dir * (e.shiftKey ? Math.round(fps) : 1);
        if (e.altKey) {
          if (!cmds.nudgeSelected(frames) && !store.rt.selection.length) {
            bus.emit('toast', { msg: 'Select a clip first — Alt + arrows move it a frame at a time.' });
          }
          bus.emit('inspector:refresh');
        } else {
          playback.pause();
          playback.step(frames);
        }
        break;
      }
      // Up / Down jump the playhead to the previous / next cut.
      case 'ArrowUp': case 'ArrowDown': {
        if (arrowOwner()) return;
        e.preventDefault();
        const to = cmds.nextEdit(store.rt.playhead, e.key === 'ArrowDown' ? 1 : -1);
        if (to != null) { playback.pause(); playback.seek(to); }
        break;
      }
      case 'Home':
        playback.pause(); playback.seek(0); break;
      case 'End':
        playback.pause(); playback.seek(store.rt.duration); break;
      case 'Delete': case 'Backspace':
        e.preventDefault(); cmds.removeSelected({ ripple: e.shiftKey }); break;
      case 'Escape':
        // Out of Razor or Hand first; a second Escape clears the selection.
        if (store.ui.tool && store.ui.tool !== 'select') bus.emit('timeline:tool', 'select');
        else store.select([]);
        break;
      case '+': case '=':
        zoomAt(store, 1.25, timeline.L.W / 2); timeline.syncZoomUI(); timeline.repaint(); break;
      case '-': case '_':
        zoomAt(store, 0.8, timeline.L.W / 2); timeline.syncZoomUI(); timeline.repaint(); break;
      default: {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); cmds.splitAt(store.rt.playhead, store.rt.selection); }
        else if (k === 't') { e.preventDefault(); cmds.addTextClip(store.rt.playhead); }
        else if (k === 'c' && e.shiftKey) { e.preventDefault(); window.gc?.captionEditor?.toggle(); }
        else if (k === 'c') { e.preventDefault(); preview?.crop?.toggle?.(); }
        else if (k === 'm') { cmds.addMarker(store.rt.playhead); }
        // J K L shuttle; loop moved to Shift+L.
        else if (k === 'l' && e.shiftKey) { document.getElementById('btnLoop').click(); }
        else if (k === 'l') { e.preventDefault(); tools()?.shuttle(1); }
        else if (k === 'j') { e.preventDefault(); tools()?.shuttle(-1); }
        else if (k === 'k') { e.preventDefault(); tools()?.shuttle(0); }
        else if (k === 'i' && e.shiftKey) { e.preventDefault(); tools()?.goMark('in'); }
        else if (k === 'o' && e.shiftKey) { e.preventDefault(); tools()?.goMark('out'); }
        else if (k === 'i') { e.preventDefault(); tools()?.setMark('in'); }
        else if (k === 'o') { e.preventDefault(); tools()?.setMark('out'); }
        else if (k === 'n') { document.getElementById('btnMagnet').click(); }
        else if (k === 'b' && e.shiftKey) { document.getElementById('btnBeatGrid').click(); }
        else if (k === 'b') { bus.emit('timeline:tool', store.ui.tool === 'razor' ? 'select' : 'razor'); }
        else if (k === 'v') { bus.emit('timeline:tool', 'select'); }
        else if (k === 'h') { bus.emit('timeline:tool', store.ui.tool === 'hand' ? 'select' : 'hand'); }
        else if (e.key === ']') { window.gc?.markerNav?.jumpMarker(1); }
        else if (e.key === '[') { window.gc?.markerNav?.jumpMarker(-1); }
        else if (k === 'q') { e.preventDefault(); bus.emit('quicklook'); }
        else if (k === 'a' && e.shiftKey) { e.preventDefault(); window.gc?.animLib?.setMode(window.gc.animLib.mode === 'library' ? 'edit' : 'library'); }
        else if (k === 'z' && !e.shiftKey && !e.altKey) { e.preventDefault(); const c = cmds.addEffect('zoom', store.rt.playhead); if (c) store.select([c.id]); }
        else if (k === 'z' && e.shiftKey) { zoomFit(store, timeline.L.W); timeline.syncZoomUI(); timeline.repaint(); }
        // F is fullscreen everywhere else; it used to force a redundant repaint.
        else if (k === 'f' && e.shiftKey) { e.preventDefault(); freezeFrame({ store, cmds }); }
        else if (k === 'f') { e.preventDefault(); preview?.toggleFullscreen?.(); }
      }
    }
  });
}
