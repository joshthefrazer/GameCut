import { bus } from '../../core/events.js';

/**
 * Draw a rectangle on the preview to lift that part of the picture onto its own
 * layer — the effect where a counter in the corner of a game is cut out and
 * blown up in the middle of the frame while the gameplay carries on behind it.
 *
 * Two coordinate spaces meet here and it is worth being precise about them:
 *
 *   frame space   0..1 across the project frame. What you drew, and what the
 *                 gizmo and hit testing already speak.
 *   source space  0..1 across the source video's own picture. What a crop has
 *                 to be stored in, so it survives a change of project
 *                 resolution, a different preview quality, or the clip being
 *                 moved and scaled afterwards.
 *
 * The conversion is the inverse of the clip's placement, and `Compositor.bounds`
 * already reports that placement, so the two can never drift apart.
 */
export function initCropTool({ overlay, store, comp, cmds, playback, onDone }) {
  let armed = false;
  let layer = null;
  /**
   * 'box' drags a rectangle; 'draw' traces a shape freehand.
   *
   * Remembered between sessions: someone who cuts round shapes cuts round
   * shapes, and making them press Draw again every single time is the kind of
   * small friction that adds up over an evening of editing.
   */
  const MODE_KEY = 'gamecut.crop.mode';
  let mode = 'box';
  try { if (localStorage.getItem(MODE_KEY) === 'draw') mode = 'draw'; } catch { /* no storage */ }

  const isArmed = () => armed;

  /** Frame-space point from a pointer event. */
  const pt = (e) => {
    const r = overlay.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  /**
   * Frame-space point → the clip's own picture, 0..1.
   *
   * Undoes the clip's rotation, position and scale, then folds in any crop the
   * clip already has so that cropping a cropped layer refines it rather than
   * addressing the wrong pixels.
   */
  function toSource(clip, p, t) {
    const b = comp.bounds(clip, t);
    const a = -b.rot * Math.PI / 180;
    const dx = p.x - b.cx, dy = p.y - b.cy;
    let u = (dx * Math.cos(a) - dy * Math.sin(a)) / b.w + 0.5;
    let v = (dx * Math.sin(a) + dy * Math.cos(a)) / b.h + 0.5;
    if (clip.flipH) u = 1 - u;
    if (clip.flipV) v = 1 - v;
    const c = clip.crop;
    if (c) { u = c.x + u * c.w; v = c.y + v * c.h; }
    return { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) };
  }

  /* ── The drawing surface ──────────────────────────────────── */

  function build() {
    layer = document.createElement('div');
    layer.className = 'crop';
    layer.innerHTML =
      `<div class="crop__dim" data-d="t"></div><div class="crop__dim" data-d="r"></div>` +
      `<div class="crop__dim" data-d="b"></div><div class="crop__dim" data-d="l"></div>` +
      `<div class="crop__box"><span class="crop__size"></span></div>` +
      `<svg class="crop__ink" preserveAspectRatio="none" viewBox="0 0 1000 1000">` +
        `<path d="" /></svg>` +
      `<div class="crop__modes">` +
        `<button data-mode="box" title="Drag a rectangle around the part you want">Box</button>` +
        `<button data-mode="draw" title="Trace any shape freehand — only what you draw around is kept">Draw</button>` +
      `</div>` +
      `<div class="crop__hint"></div>`;
    overlay.appendChild(layer);

    // The mode switch has to be clickable even though the layer ignores
    // pointers, or you could see the buttons and never press them.
    const modes = layer.querySelector('.crop__modes');
    modes.style.pointerEvents = 'auto';
    modes.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
    modes.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      mode = b.dataset.mode;
      try { localStorage.setItem(MODE_KEY, mode); } catch { /* no storage */ }
      syncMode();
    });
    syncMode();
    return layer;
  }

  function syncMode() {
    if (!layer) return;
    for (const b of layer.querySelectorAll('.crop__modes button')) {
      b.classList.toggle('is-on', b.dataset.mode === mode);
    }
    layer.querySelector('.crop__hint').textContent = mode === 'box'
      ? 'Drag a box around the part you want to lift out · Esc to cancel'
      : 'Draw around the part you want to lift out · Esc to cancel';
    overlay.classList.toggle('is-drawing', mode === 'draw');
  }

  /** Position the four dimmed panels and the bright rectangle between them. */
  function paint(rect) {
    const box = layer.querySelector('.crop__box');
    const pct = (n) => (n * 100).toFixed(3) + '%';
    if (!rect) {
      box.style.display = 'none';
      for (const d of layer.querySelectorAll('.crop__dim')) {
        d.style.cssText = d.dataset.d === 't' ? 'inset:0' : 'display:none';
      }
      return;
    }
    box.style.display = '';
    Object.assign(box.style, {
      left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h),
    });
    // Four panels rather than one huge box-shadow: a 9999px shadow is
    // re-rasterized on every pointer move, and this editor has already been
    // taught what that costs.
    const set = (d, css) => { layer.querySelector(`[data-d="${d}"]`).style.cssText = css; };
    set('t', `left:0;top:0;right:0;height:${pct(rect.y)}`);
    set('b', `left:0;top:${pct(rect.y + rect.h)};right:0;bottom:0`);
    set('l', `left:0;top:${pct(rect.y)};width:${pct(rect.x)};height:${pct(rect.h)}`);
    set('r', `left:${pct(rect.x + rect.w)};top:${pct(rect.y)};right:0;height:${pct(rect.h)}`);

    const size = layer.querySelector('.crop__size');
    size.textContent = `${Math.round(rect.w * store.doc.width)} × ${Math.round(rect.h * store.doc.height)}`;
  }

  /* ── Arm / disarm ─────────────────────────────────────────── */

  function arm() {
    if (armed) return;
    const t = store.rt.playhead;
    const hasPicture = comp.activeClips(t)
      .some(({ clip }) => clip.type === 'video' || clip.type === 'image');
    if (!hasPicture) {
      bus.emit('toast', {
        msg: 'Move the playhead over some footage first — there is no picture here to crop.',
        kind: 'err',
      });
      return;
    }
    armed = true;
    playback.pause();
    overlay.classList.add('is-cropping');
    build();
    paint(null);
    onDone?.(true);
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    overlay.classList.remove('is-cropping');
    layer?.remove();
    layer = null;
    onDone?.(false);
  }

  const toggle = () => (armed ? disarm() : arm());

  /* ── Drawing ──────────────────────────────────────────────── */

  overlay.addEventListener('pointerdown', (e) => {
    if (!armed || e.button !== 0) return;
    // Stop the normal click-to-select handler from also running.
    e.stopPropagation();
    e.preventDefault();

    const p0 = pt(e);
    const t = store.rt.playhead;

    // Whatever is on top at the point the drag began, as long as it has a
    // picture — a title sitting over the footage must not become the thing
    // that gets cropped. Otherwise fall back to the topmost clip that does,
    // so starting the drag on a caption still crops the obvious thing.
    const hasPicture = (c) => c && (c.type === 'video' || c.type === 'image');
    const hit = comp.hitTest(p0.x, p0.y, t);
    const clip = hasPicture(hit) ? hit
      : comp.activeClips(t).filter(({ clip: c }) => hasPicture(c)).pop()?.clip;
    if (!clip) { disarm(); return; }

    let rect = null;
    /** Freehand points, in frame space, collected while drawing. */
    const path = mode === 'draw' ? [p0] : null;

    const move = (ev) => {
      const p = pt(ev);
      if (path) {
        // Sample by distance rather than by event: a fast drag fires far fewer
        // moves than a slow one, and an evenly spaced path traces the same
        // shape either way.
        const last = path[path.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 0.004) path.push(p);
        rect = bboxOf(path);
        paintInk(path);
        paint(rect);
        return;
      }
      rect = {
        x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y),
        w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y),
      };
      paint(rect);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // Anything smaller than this is a stray click, not a rectangle.
      if (!rect || rect.w < 0.01 || rect.h < 0.01) { disarm(); return; }
      if (path && path.length < 4) { disarm(); return; }
      apply(clip, rect, t, path);
      disarm();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, true);

  /* ── Turning a drawn rectangle into a layer ───────────────── */

  function apply(clip, rect, t, path) {
    const a = toSource(clip, { x: rect.x, y: rect.y }, t);
    const b = toSource(clip, { x: rect.x + rect.w, y: rect.y + rect.h }, t);
    const crop = {
      x: Math.min(a.u, b.u), y: Math.min(a.v, b.v),
      w: Math.abs(b.u - a.u), h: Math.abs(b.v - a.v),
    };

    /**
     * A drawn shape is stored beside the box, not instead of it.
     *
     * The box still describes where the piece sits and how big it is, so
     * everything that already reasons about a crop — the gizmo, the inspector,
     * the layer's on-screen size — keeps working untouched. The shape only
     * decides which pixels inside that box are painted.
     */
    if (path && path.length > 3) {
      crop.shape = path.map(pp => {
        const q = toSource(clip, pp, t);
        return [+q.u.toFixed(5), +q.v.toFixed(5)];
      });
    }
    if (crop.w < 0.002 || crop.h < 0.002) {
      bus.emit('toast', { msg: 'That region is too small to crop.', kind: 'err' });
      return;
    }

    /**
     * Land the new layer exactly over the rectangle that was drawn.
     *
     * Nothing appears to happen at the moment of the crop, which is the point:
     * the piece is sitting perfectly on top of where it came from, and every
     * change after that is one you made deliberately. Dropping it centred and
     * full-size instead would look like the crop had gone wrong.
     */
    const src = comp.pool.peek(clip);
    const fw = src?.videoWidth || src?.naturalWidth || store.doc.width;
    const fh = src?.videoHeight || src?.naturalHeight || store.doc.height;
    const W = store.doc.width, H = store.doc.height;
    const sw = Math.max(1, crop.w * fw), sh = Math.max(1, crop.h * fh);
    const fitContain = Math.min(W / sw, H / sh);
    const scale = (rect.w * W) / (sw * fitContain);

    const made = cmds.cropClip(clip.id, {
      crop,
      transform: {
        x: rect.x + rect.w / 2,
        y: rect.y + rect.h / 2,
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
        rotation: clip.transform?.rotation || 0,
        opacity: 1,
      },
    });

    if (made) {
      // The timeline redraws itself off the `doc` event the command already
      // emitted; only the canvas needs telling.
      comp.render();
      bus.emit('toast', {
        msg: crop.shape
          ? 'Cropped to your shape. Drag it to move, or the handles to resize — the original is untouched underneath.'
          : 'Cropped. Drag it to move, or the corner handles to resize — the original is untouched underneath.',
        ms: 5200,
      });
    }
  }

  /** Bounding box of a freehand path, in frame space. */
  function bboxOf(pts) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  /** Show the line as it is drawn, in the overlay's own 0..1000 space. */
  function paintInk(pts) {
    const el = layer?.querySelector('.crop__ink path');
    if (!el) return;
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      d += (i ? 'L' : 'M') + (pts[i].x * 1000).toFixed(1) + ' ' + (pts[i].y * 1000).toFixed(1);
    }
    el.setAttribute('d', d + (pts.length > 2 ? 'Z' : ''));
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && armed) { e.preventDefault(); disarm(); }
  });

  return { arm, disarm, toggle, isArmed };
}
