import { bus } from '../../core/events.js';

/**
 * The crop room.
 *
 * Cropping used to happen by dragging on the preview, at whatever size the
 * preview happened to be — often a few hundred pixels wide with the timeline
 * taking the rest of the screen. Tracing the edge of a scoreboard at that size
 * is guesswork, and guesswork is what "it doesn't work" actually means.
 *
 * So this takes over the window: one frozen frame, as large as the screen
 * allows, zoomable to well past 1:1, with a brush. Everything is decided here
 * and nothing touches the document until Apply.
 *
 * ── Spaces ──────────────────────────────────────────────────────
 *   source   0..1 across the clip's own picture. What gets stored.
 *   mask     pixels of the mask canvas, which covers the whole source frame
 *            at a capped resolution. Painting happens here.
 *   view     screen pixels inside the studio canvas. zoom + pan of source.
 *
 * The mask is stored on the clip as a PNG, sized to the crop box rather than
 * the whole frame, so a small cut-out costs a small file. It is baked with its
 * softness already blurred in — blurring a mask once, here, instead of on every
 * frame of playback, which this editor has learned the price of.
 */

/** Longest side of the painting surface. Beyond this the cost stops buying detail. */
const MASK_MAX = 1400;
/** How many strokes back Undo can reach inside the studio. */
const UNDO_DEPTH = 24;

const clamp01 = (n) => Math.min(1, Math.max(0, n));

export function openCropStudio({ clip, source, store, cmds, comp, onApply }) {
  /* ── The frozen frame ──────────────────────────────────────── */
  const fw = source?.videoWidth || source?.naturalWidth || store.doc.width;
  const fh = source?.videoHeight || source?.naturalHeight || store.doc.height;

  const still = document.createElement('canvas');
  still.width = fw; still.height = fh;
  try {
    still.getContext('2d').drawImage(source, 0, 0, fw, fh);
  } catch {
    bus.emit('toast', { msg: 'That frame is not ready yet — give it a moment and try again.', kind: 'err' });
    return null;
  }

  /* ── The mask ──────────────────────────────────────────────── */
  const mscale = Math.min(1, MASK_MAX / Math.max(fw, fh));
  const mask = document.createElement('canvas');
  mask.width = Math.max(2, Math.round(fw * mscale));
  mask.height = Math.max(2, Math.round(fh * mscale));
  const mctx = mask.getContext('2d', { willReadFrequently: true });

  const undo = [];
  let maskTouched = false;

  /**
   * One step of history holds the mask AND the box.
   *
   * Undo used to restore only the painted mask, so pressing Clear by mistake in
   * Box mode and then pressing Undo — which the button's own tooltip offers —
   * brought back nothing, and the rectangle you had just traced around a
   * scoreboard was gone for good.
   */
  function snapshot() {
    if (undo.length >= UNDO_DEPTH) undo.shift();
    const c = document.createElement('canvas');
    c.width = mask.width; c.height = mask.height;
    c.getContext('2d').drawImage(mask, 0, 0);
    undo.push({ canvas: c, rect: rect ? { ...rect } : null, touched: maskTouched });
  }
  function stepBack() {
    const snap = undo.pop();
    if (!snap) return;
    mctx.globalCompositeOperation = 'copy';
    mctx.drawImage(snap.canvas, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    rect = snap.rect ? { ...snap.rect } : null;
    maskTouched = snap.touched ?? (undo.length > 0 || hasInk());
    paint();
  }
  function hasInk() {
    const d = mctx.getImageData(0, 0, mask.width, mask.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
    return false;
  }

  /* ── State ─────────────────────────────────────────────────── */
  let tool = 'brush';            // 'box' | 'brush'
  let paintMode = 'keep';        // 'keep' | 'remove' — what the brush does
  let brush = 0.06;              // fraction of the source's short side
  let feather = 0.15;            // 0..1, scaled to a few source pixels
  let rect = null;               // box tool, in source 0..1
  let zoom = 1, panX = 0, panY = 0, fitZoom = 1;
  let cursor = null;             // {x, y} in view pixels, for the brush ring

  /**
   * Which way the very first stroke goes decides where the mask starts.
   *
   * Painting what you want to keep starts from nothing. Painting what you want
   * gone starts from everything — otherwise the first stroke of a Remove brush
   * would appear to do nothing at all, because there was nothing there to take
   * away.
   */
  function primeMask(mode) {
    if (maskTouched) return;
    mctx.clearRect(0, 0, mask.width, mask.height);
    if (mode === 'remove') {
      mctx.fillStyle = '#fff';
      mctx.fillRect(0, 0, mask.width, mask.height);
    }
  }

  /* ── DOM ───────────────────────────────────────────────────── */
  const el = document.createElement('div');
  el.className = 'cropst is-brush';
  el.innerHTML = `
    <div class="cropst__bar">
      <div class="cropst__tools" role="group" aria-label="Crop tools">
        <button class="cst" data-tool="box" title="Drag a rectangle around the part you want">
          <svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg><span>Box</span>
        </button>
        <button class="cst is-on" data-tool="brush" title="Paint the exact shape you want">
          <svg viewBox="0 0 24 24"><path d="M4 20s1-3 3-4c2-1 3 .5 3 .5S8 20 4 20Z"/><path d="M10.5 15.5 19 7a2.1 2.1 0 0 0-3-3l-8.5 8.5"/></svg><span>Brush</span>
        </button>
      </div>

      <div class="cropst__sep"></div>

      <div class="cropst__paint" role="group" aria-label="What the brush does">
        <button class="cst cst--sm is-on" data-paint="keep" title="Paint over the part you want to keep">Keep</button>
        <button class="cst cst--sm" data-paint="remove" title="Paint over the part you want gone">Remove</button>
      </div>

      <label class="cropst__slide" title="Brush size — or press [ and ]">
        <span>Size</span><input type="range" id="cstSize" min="8" max="400" value="60"><b id="cstSizeV">60</b>
      </label>

      <label class="cropst__slide" title="How soft the edge of the cut is">
        <span>Soft</span><input type="range" id="cstSoft" min="0" max="100" value="15"><b id="cstSoftV">15</b>
      </label>

      <div class="cropst__sep"></div>

      <button class="cst cst--sm" id="cstUndo" title="Undo the last stroke (Ctrl+Z)">Undo</button>
      <button class="cst cst--sm" id="cstClear" title="Start this crop again">Clear</button>

      <div class="cropst__spacer"></div>

      <div class="cropst__zoom">
        <button class="cst cst--ic" id="cstOut" title="Zoom out">−</button>
        <b id="cstZoom">100%</b>
        <button class="cst cst--ic" id="cstIn" title="Zoom in">+</button>
        <button class="cst cst--sm" id="cstFit" title="Fit the whole frame on screen">Fit</button>
      </div>

      <button class="cst cst--ghost" id="cstCancel">Cancel</button>
      <button class="cst cst--go" id="cstApply">Apply crop</button>
    </div>

    <div class="cropst__stage">
      <canvas class="cropst__cv"></canvas>
      <div class="cropst__hint" id="cstHint"></div>
    </div>`;

  document.body.appendChild(el);

  const cv = el.querySelector('.cropst__cv');
  const stage = el.querySelector('.cropst__stage');
  const ctx = cv.getContext('2d');
  const hint = el.querySelector('#cstHint');
  const zoomLabel = el.querySelector('#cstZoom');
  const sizeInput = el.querySelector('#cstSize');
  const softInput = el.querySelector('#cstSoft');

  /* A scratch canvas for the dimmed overlay. Reused rather than made per frame:
     allocating a screen-sized canvas 60 times a second is how a paint tool ends
     up feeling like it is running underwater. */
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');

  /* ── View maths ────────────────────────────────────────────── */
  const srcToView = (u, v) => ({ x: panX + u * fw * zoom, y: panY + v * fh * zoom });
  const viewToSrc = (x, y) => ({ u: (x - panX) / (fw * zoom), v: (y - panY) / (fh * zoom) });

  function fit() {
    const pad = 48;
    const w = cv.width - pad * 2, h = cv.height - pad * 2;
    fitZoom = Math.max(0.02, Math.min(w / fw, h / fh));
    zoom = fitZoom;
    panX = (cv.width - fw * zoom) / 2;
    panY = (cv.height - fh * zoom) / 2;
  }

  function zoomAt(factor, cx, cy) {
    const before = viewToSrc(cx, cy);
    zoom = Math.max(fitZoom * 0.5, Math.min(24, zoom * factor));
    panX = cx - before.u * fw * zoom;
    panY = cy - before.v * fh * zoom;
    paint();
  }

  /**
   * Re-measure without throwing away where the person is looking.
   *
   * Resizing the window, going fullscreen, or dragging to a monitor with a
   * different pixel ratio all land here. Calling `fit()` unconditionally, which
   * is what this did, meant zooming to 800% to trace the edge of a killfeed and
   * then losing the spot the instant the window moved.
   */
  function resize() {
    const first = !cv.width;
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    // The source point currently under the middle of the canvas.
    const mid = first ? null : viewToSrc(cv.width / 2, cv.height / 2);
    const before = zoom, wasFit = Math.abs(zoom - fitZoom) < 1e-6;

    cv.width = Math.max(2, Math.round(r.width * dpr));
    cv.height = Math.max(2, Math.round(r.height * dpr));
    cv.style.width = r.width + 'px';
    cv.style.height = r.height + 'px';
    scratch.width = cv.width; scratch.height = cv.height;

    fit();                       // recomputes fitZoom for the new size
    if (mid && !wasFit) {
      zoom = Math.max(fitZoom * 0.5, Math.min(24, before));
      panX = cv.width / 2 - mid.u * fw * zoom;
      panY = cv.height / 2 - mid.v * fh * zoom;
    }
    paint();
  }

  /* ── Painting the studio ───────────────────────────────────── */
  function paint() {
    ctx.clearRect(0, 0, cv.width, cv.height);

    /* Checkerboard behind, so "removed" reads as gone rather than as black. */
    const s = 16;
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(120,170,255,.045)';
    for (let y = 0; y < cv.height; y += s * 2)
      for (let x = 0; x < cv.width; x += s * 2) {
        ctx.fillRect(x, y, s, s);
        ctx.fillRect(x + s, y + s, s, s);
      }

    const w = fw * zoom, h = fh * zoom;
    ctx.imageSmoothingEnabled = zoom < 3;   // past 3× you want to see the pixels
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(still, panX, panY, w, h);

    /* Dim everything that is not being kept. */
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    sctx.fillStyle = 'rgba(4,8,16,.82)';
    sctx.fillRect(0, 0, scratch.width, scratch.height);
    sctx.globalCompositeOperation = 'destination-out';
    if (tool === 'box') {
      if (rect) {
        const a = srcToView(rect.x, rect.y);
        sctx.fillRect(a.x, a.y, rect.w * w, rect.h * h);
      } else {
        sctx.fillRect(0, 0, scratch.width, scratch.height);   // nothing drawn yet
      }
    } else if (maskTouched) {
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(mask, panX, panY, w, h);
    }
    sctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(scratch, 0, 0);

    /*
     * A wash over what is being kept.
     *
     * Dimming the rest is not enough on dark footage — a night-time game frame
     * at 26% and the same frame at 100% look like the same dark frame, and you
     * cannot tell whether your stroke landed. A faint blue tint over the kept
     * area is unambiguous at any exposure.
     */
    if (tool === 'brush' && maskTouched) {
      sctx.clearRect(0, 0, scratch.width, scratch.height);
      sctx.fillStyle = 'rgba(96,165,250,.16)';
      sctx.fillRect(0, 0, scratch.width, scratch.height);
      sctx.globalCompositeOperation = 'destination-in';
      sctx.drawImage(mask, panX, panY, w, h);
      sctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(scratch, 0, 0);
    }

    /* Edges. A dashed rectangle for the box; the frame's own border always. */
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(96,165,250,.95)';
    if (tool === 'box' && rect) {
      const a = srcToView(rect.x, rect.y);
      ctx.strokeRect(a.x + .5, a.y + .5, rect.w * w, rect.h * h);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(120,170,255,.25)';
    ctx.strokeRect(panX + .5, panY + .5, w, h);
    ctx.restore();

    /* The brush ring, so the size slider means something before you draw. */
    if (tool === 'brush' && cursor) {
      const r = brushViewRadius();
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = paintMode === 'keep' ? 'rgba(96,165,250,.95)' : 'rgba(244,63,94,.95)';
      ctx.beginPath(); ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.arc(cursor.x, cursor.y, r + 1.5, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    zoomLabel.textContent = Math.round(zoom * 100) + '%';

    /* Where the frame currently sits, in the canvas's own CSS pixels. Nothing
       in the app reads this; it is here so a test can aim at a part of the
       picture rather than at a guess about the layout. */
    const dpr = cv.width / (cv.clientWidth || cv.width);
    cv.__frame = { x: panX / dpr, y: panY / dpr, w: w / dpr, h: h / dpr };
    hint.textContent = tool === 'box'
      ? 'Drag a rectangle around the part you want · scroll to zoom · space or middle-drag to move'
      : paintMode === 'keep'
        ? 'Paint over what you want to KEEP · scroll to zoom · [ and ] change the brush'
        : 'Paint over what you want GONE · scroll to zoom · [ and ] change the brush';
  }

  const brushViewRadius = () => (brush * Math.min(fw, fh) / 2) * zoom;

  /* ── Input ─────────────────────────────────────────────────── */
  let drawing = false, panning = false, spaceDown = false;
  let last = null, panFrom = null;

  const localPt = (e) => {
    const r = cv.getBoundingClientRect();
    const dpr = cv.width / r.width;
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  };

  function stroke(a, b) {
    const rad = brush * Math.min(mask.width, mask.height) / 2;
    mctx.save();
    mctx.globalCompositeOperation = paintMode === 'keep' ? 'source-over' : 'destination-out';
    mctx.strokeStyle = '#fff';
    mctx.fillStyle = '#fff';
    mctx.lineWidth = rad * 2;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.beginPath();
    mctx.moveTo(a.u * mask.width, a.v * mask.height);
    mctx.lineTo(b.u * mask.width, b.v * mask.height);
    mctx.stroke();
    mctx.restore();
    maskTouched = true;
  }

  cv.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || spaceDown || e.button === 2) {
      panning = true; panFrom = { ...localPt(e), panX, panY };
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = localPt(e);

    if (tool === 'box') {
      const s0 = viewToSrc(p.x, p.y);
      drawing = { x0: clamp01(s0.u), y0: clamp01(s0.v) };
      rect = { x: drawing.x0, y: drawing.y0, w: 0, h: 0 };
      paint();
      return;
    }

    primeMask(paintMode);
    snapshot();
    drawing = true;
    const s0 = viewToSrc(p.x, p.y);
    last = { u: clamp01(s0.u), v: clamp01(s0.v) };
    stroke(last, last);
    paint();
  });

  cv.addEventListener('pointermove', (e) => {
    const p = localPt(e);
    cursor = p;

    if (panning && panFrom) {
      panX = panFrom.panX + (p.x - panFrom.x);
      panY = panFrom.panY + (p.y - panFrom.y);
      paint();
      return;
    }
    if (!drawing) { if (tool === 'brush') paint(); return; }

    const s = viewToSrc(p.x, p.y);
    if (tool === 'box') {
      const u = clamp01(s.u), v = clamp01(s.v);
      rect = {
        x: Math.min(drawing.x0, u), y: Math.min(drawing.y0, v),
        w: Math.abs(u - drawing.x0), h: Math.abs(v - drawing.y0),
      };
      paint();
      return;
    }
    const now = { u: clamp01(s.u), v: clamp01(s.v) };
    stroke(last, now);
    last = now;
    paint();
  });

  const endDrag = () => { drawing = false; panning = false; panFrom = null; last = null; };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { cursor = null; paint(); });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPt(e);
    zoomAt(e.deltaY < 0 ? 1.16 : 1 / 1.16, p.x, p.y);
  }, { passive: false });

  /* ── Toolbar ───────────────────────────────────────────────── */
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;

    if (b.dataset.tool) {
      tool = b.dataset.tool;
      for (const x of el.querySelectorAll('[data-tool]')) x.classList.toggle('is-on', x.dataset.tool === tool);
      el.classList.toggle('is-brush', tool === 'brush');
      paint();
      return;
    }
    if (b.dataset.paint) {
      paintMode = b.dataset.paint;
      for (const x of el.querySelectorAll('[data-paint]')) x.classList.toggle('is-on', x.dataset.paint === paintMode);
      if (tool !== 'brush') { tool = 'brush'; el.classList.add('is-brush');
        for (const x of el.querySelectorAll('[data-tool]')) x.classList.toggle('is-on', x.dataset.tool === 'brush'); }
      paint();
      return;
    }
    switch (b.id) {
      case 'cstUndo': stepBack(); break;
      case 'cstClear': clearAll(); break;
      case 'cstIn': zoomAt(1.25, cv.width / 2, cv.height / 2); break;
      case 'cstOut': zoomAt(1 / 1.25, cv.width / 2, cv.height / 2); break;
      case 'cstFit': fit(); paint(); break;
      case 'cstCancel': close(); break;
      case 'cstApply': apply(); break;
    }
  });

  function clearAll() {
    snapshot();
    mctx.clearRect(0, 0, mask.width, mask.height);
    maskTouched = false;
    rect = null;
    paint();
  }

  sizeInput.addEventListener('input', () => {
    brush = (+sizeInput.value) / 1000;
    el.querySelector('#cstSizeV').textContent = sizeInput.value;
    paint();
  });
  softInput.addEventListener('input', () => {
    feather = (+softInput.value) / 100;
    el.querySelector('#cstSoftV').textContent = softInput.value;
  });
  brush = (+sizeInput.value) / 1000;

  /* ── Keys ──────────────────────────────────────────────────── */
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply(); return; }
    if (e.code === 'Space') { spaceDown = true; el.classList.add('is-panning'); e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); stepBack(); }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      const v = Math.max(8, Math.min(400, (+sizeInput.value) * (e.key === '[' ? 0.8 : 1.25)));
      sizeInput.value = Math.round(v);
      sizeInput.dispatchEvent(new Event('input'));
    }
    if (e.key === 'b' || e.key === 'B') { el.querySelector('[data-tool="brush"]').click(); }
    if (e.key === 'm' || e.key === 'M') { el.querySelector('[data-tool="box"]').click(); }
    // Nothing below this line should reach the editor while the studio is open.
    e.stopPropagation();
  }
  function onKeyUp(e) {
    if (e.code === 'Space') { spaceDown = false; el.classList.remove('is-panning'); }
    e.stopPropagation();
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('resize', resize);

  /* ── Finishing ─────────────────────────────────────────────── */

  function close() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('resize', resize);
    el.remove();
    onApply?.(false);
  }

  /** Tight box around everything the mask keeps, in source 0..1. */
  function maskBounds() {
    const { data } = mctx.getImageData(0, 0, mask.width, mask.height);
    let x0 = mask.width, y0 = mask.height, x1 = -1, y1 = -1;
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (data[(y * mask.width + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return {
      x: x0 / mask.width, y: y0 / mask.height,
      w: (x1 - x0 + 1) / mask.width, h: (y1 - y0 + 1) / mask.height,
      px: { x0, y0, x1, y1 },
    };
  }

  /**
   * The mask, cropped to its own bounds and softened, as a PNG.
   *
   * Softening happens exactly once — here — because a blur is expensive and the
   * answer never changes. Playback then only has to draw the result.
   */
  function bakeMask(b) {
    const pad = Math.ceil(feather * 0.06 * Math.min(mask.width, mask.height));
    const w = b.px.x1 - b.px.x0 + 1, h = b.px.y1 - b.px.y0 + 1;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const o = out.getContext('2d');
    if (pad > 0) o.filter = `blur(${pad}px)`;
    o.drawImage(mask, b.px.x0, b.px.y0, w, h, 0, 0, w, h);
    o.filter = 'none';
    return out.toDataURL('image/png');
  }

  function apply() {
    let crop = null;

    if (tool === 'box' || (!maskTouched && rect)) {
      if (!rect || rect.w < 0.004 || rect.h < 0.004) {
        bus.emit('toast', { msg: 'Drag a rectangle first — there is nothing to crop yet.', kind: 'err' });
        return;
      }
      crop = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    } else {
      if (!maskTouched) {
        bus.emit('toast', { msg: 'Paint over the part you want first.', kind: 'err' });
        return;
      }
      const b = maskBounds();
      if (!b || b.w < 0.004 || b.h < 0.004) {
        bus.emit('toast', { msg: 'That is too small to cut out.', kind: 'err' });
        return;
      }
      crop = { x: b.x, y: b.y, w: b.w, h: b.h, mask: bakeMask(b) };
    }

    /*
     * Land the piece exactly where it came from.
     *
     * Nothing appears to happen at the moment you press Apply, and that is
     * right: the cut-out is sitting on top of the pixels it was made from, and
     * every change after this is one you chose. Dropping it centred and
     * full-size would look like the crop had gone wrong.
     */
    const b = comp.bounds(clip, store.rt.playhead);
    const W = store.doc.width, H = store.doc.height;

    /*
     * `bounds` measures what the clip currently *shows*. When the clip is
     * already cropped that is a window onto the source, not the source — so
     * work back to where the whole frame would sit, because that is the space
     * the new crop is expressed in.
     */
    const c0 = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
    const fullW = b.w / (c0.w || 1);
    const fullH = b.h / (c0.h || 1);
    const fullCx = b.cx - (c0.x + c0.w / 2 - 0.5) * fullW;
    const fullCy = b.cy - (c0.y + c0.h / 2 - 0.5) * fullH;

    const sw = Math.max(1, crop.w * fw), sh = Math.max(1, crop.h * fh);
    const fitContain = Math.min(W / sw, H / sh);
    const onScreenW = crop.w * fullW;                   // fraction of the frame
    const scale = (onScreenW * W) / (sw * fitContain);

    const made = cmds.cropClip(clip.id, {
      crop,
      transform: {
        x: fullCx + (crop.x + crop.w / 2 - 0.5) * fullW,
        y: fullCy + (crop.y + crop.h / 2 - 0.5) * fullH,
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
        rotation: clip.transform?.rotation || 0,
        opacity: 1,
      },
    });

    if (made) {
      comp.render();
      bus.emit('toast', {
        msg: crop.mask
          ? 'Cut out. Drag it to move, or the handles to resize — the original is untouched underneath.'
          : 'Cropped. Drag it to move, or the corner handles to resize — the original is untouched underneath.',
        ms: 5200,
      });
    }
    close();
  }

  requestAnimationFrame(() => resize());
  return { close, el };
}
