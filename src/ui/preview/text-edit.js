import { bus } from '../../core/events.js';
import { evalProp } from '../../engine/keyframes.js';
import { shortEdge } from '../../engine/layers/text-layer.js';

/**
 * Typing on the picture.
 *
 * Text used to be changed in a box in the Inspector, several inches from the
 * words themselves. That is fine once you know where the box is and miserable
 * before — and it separates the two things you are actually comparing, the
 * letters and the shot they sit on.
 *
 * So: double-click the words and type. The field is a real <textarea> laid over
 * the canvas and styled to match what the renderer draws, and the canvas copy
 * is suppressed while it is open so nothing is drawn twice. Everything else —
 * glow, gradient fills, entrances, keyframes — is left to the renderer, which
 * is why this only has to match the shape of the type and not reproduce it.
 */
export function initTextEdit({ overlay, frame, store, comp, cmds, playback }) {
  let cur = null;        // { clip, ta, before }

  const isEditing = () => !!cur;
  const editingId = () => cur?.clip.id || null;

  /* ── Opening ───────────────────────────────────────────────── */

  function start(clip) {
    if (!clip || clip.type !== 'text') return;
    if (cur?.clip === clip) { cur.ta.focus(); return; }
    stop(true);

    playback.pause();
    // The entrance animation is mid-flight at the very start of a clip, which
    // would have you typing into letters that are still flying in. Park on a
    // moment where the layer is simply there.
    const settle = clip.start + Math.min(clip.duration * 0.5,
      Math.max(0.05, (clip.text?.animDur || 0.35) + 0.05));
    if (Math.abs(store.rt.playhead - settle) > 1e-3
        && (store.rt.playhead < clip.start || store.rt.playhead >= clip.start + clip.duration)) {
      playback.seek(settle);
    }

    const ta = document.createElement('textarea');
    ta.className = 'tedit';
    ta.spellcheck = false;
    ta.value = String(clip.text.text ?? '');
    ta.setAttribute('aria-label', 'Text on the picture');
    overlay.appendChild(ta);

    cur = { clip, ta, before: String(clip.text.text ?? '') };
    comp.hidden.add(clip.id);
    comp.render();
    place();

    ta.focus();
    ta.select();

    ta.addEventListener('input', onInput);
    ta.addEventListener('blur', () => stop(true));
    ta.addEventListener('keydown', onKey);
    // Typing must never reach the editor's own shortcuts — S would split the
    // clip you are writing on.
    ta.addEventListener('keyup', (e) => e.stopPropagation());
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  function onInput() {
    if (!cur) return;
    cur.clip.text.text = cur.ta.value;
    // Straight onto the object while typing, then one undo step on the way out:
    // a history entry per keystroke makes Ctrl+Z useless.
    store.emit('rt', {});
    place();
    bus.emit('inspector:refresh');
  }

  function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      const { clip, before } = cur;
      clip.text.text = before;
      stop(false);
      comp.render();
      return;
    }
    // Enter makes a new line, because a title with two lines is the common
    // case. Ctrl/Cmd+Enter is "done", and so is clicking away.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      stop(true);
    }
  }

  /* ── Closing ───────────────────────────────────────────────── */

  function stop(commit) {
    if (!cur) return;
    const { clip, ta, before } = cur;
    cur = null;                         // first, so blur doesn't re-enter

    comp.hidden.delete(clip.id);
    ta.remove();

    if (commit && clip.text.text !== before) {
      // Put the old value back, then set it through the command, so undo has
      // exactly one step to step over rather than one per letter.
      const after = clip.text.text;
      clip.text.text = before;
      cmds.setClipProp(clip.id, 'text.text', after, { merge: false, label: 'Edit text' });
    }
    comp.render();
    bus.emit('inspector:refresh');
  }

  /* ── Laying the field over the words ───────────────────────── */

  /**
   * Match the renderer closely enough that the caret lands where the letters
   * are. Everything here is read from the same style object the canvas reads,
   * and sized against the frame's short edge the same way.
   */
  function place() {
    if (!cur) return;
    const { clip, ta } = cur;
    const s = clip.text;
    const r = frame.getBoundingClientRect();
    const or_ = overlay.getBoundingClientRect();
    const W = r.width, H = r.height;
    if (!W || !H) return;

    const t = store.rt.playhead;
    const px = Math.max(4, evalProp(clip, 'text.size', t) * shortEdge(W, H));
    const scale = evalProp(clip, 'transform.scale', t);
    const cx = evalProp(clip, 'transform.x', t) * W + (r.left - or_.left);
    const cy = evalProp(clip, 'transform.y', t) * H + (r.top - or_.top);
    const rot = evalProp(clip, 'transform.rotation', t);
    const boxW = Math.max(0.05, clip.transform.w) * W;

    const lines = Math.max(1, String(ta.value).split('\n').length);
    const lineH = px * (s.lineHeight || 1.15) * scale;
    const h = lineH * lines;

    Object.assign(ta.style, {
      left: `${cx - (boxW * scale) / 2}px`,
      top: `${cy - h / 2}px`,
      width: `${boxW * scale}px`,
      height: `${h}px`,
      transform: `rotate(${rot}deg)`,
      font: `${s.italic ? 'italic ' : ''}${s.weight || 800} ${px * scale}px "${s.font || 'Inter'}", var(--f-ui)`,
      lineHeight: `${lineH}px`,
      letterSpacing: `${(s.letterSpacing || 0) * px * scale}px`,
      textAlign: s.align || 'center',
      color: s.fill === 'gradient' ? (s.color || '#fff') : (s.color || '#fff'),
      textShadow: s.glow > 0
        ? `0 0 ${s.glow * px}px ${s.glowColor || '#38bdf8'}`
        : `0 2px 6px rgba(0,0,0,.6)`,
      WebkitTextStroke: s.strokeWidth > 0
        ? `${s.strokeWidth * px * 0.5}px ${s.strokeColor || '#000'}` : '0',
    });
  }

  /* ── Ways in ───────────────────────────────────────────────── */

  overlay.addEventListener('dblclick', (e) => {
    // Not `e.target === overlay`: the selection gizmo puts its own box over the
    // layer, so on a clip you have already selected — which is most of them —
    // the double-click lands on the gizmo and this never fired.
    if (e.target.closest?.('.tedit')) return;
    const r = overlay.getBoundingClientRect();
    const hit = comp.hitTest((e.clientX - r.left) / r.width,
                             (e.clientY - r.top) / r.height, store.rt.playhead);
    if (hit?.type === 'text') { e.preventDefault(); start(hit); }
  });

  bus.on('text:edit', ({ clipId } = {}) => {
    const clip = clipId
      ? store.doc.tracks.flatMap(t => t.clips).find(c => c.id === clipId)
      : store.selectedClips?.[0]?.clip;
    if (clip?.type === 'text') start(clip);
  });

  // Keep the field over the words when anything moves underneath it.
  store.on('playhead', place);
  window.addEventListener('resize', place);
  bus.on('preview:fit', place);

  // Selecting something else must not leave a field floating over a layer that
  // is no longer there.
  store.on('selection', () => {
    if (cur && !store.rt.selection.includes(cur.clip.id)) stop(true);
  });

  /**
   * An undo replaces the whole document with a clone, so `cur.clip` becomes an
   * object that is no longer in the project — typing into it would change
   * nothing, and the id would stay stuck in `comp.hidden` so the canvas never
   * painted that layer again.
   *
   * Undo does not emit a selection change, only a document one, so the guard
   * above cannot catch it. Re-resolve by id here: if the layer is still there
   * point at the new object, and if it is gone, close.
   */
  store.on('doc', () => {
    if (!cur) return;
    const live = store.doc.tracks.flatMap(t => t.clips).find(c => c.id === cur.clip.id);
    if (!live) {
      const { clip, ta } = cur;
      cur = null;
      comp.hidden.delete(clip.id);
      ta.remove();
      comp.render();
      return;
    }
    if (live !== cur.clip) {
      cur.clip = live;
      // Whatever is in the field is what the person typed; the fresh clone has
      // the old words, and silently replacing theirs would be worse.
      live.text.text = cur.ta.value;
      place();
    }
  });

  return { start, stop, isEditing, editingId, place };
}
