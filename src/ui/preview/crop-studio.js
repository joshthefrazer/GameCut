import { bus } from '../../core/events.js';
import { findHud, magicSelect, maskPng } from './smart-crop.js';
import { sampleFrames } from '../../edit/frame-analysis.js';
import { assets } from '../../media/asset-store.js';
import { askText } from '../widgets/ask.js';
import { freezeFrame } from '../../edit/freeze-frame.js';

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

/** The tool the person used last time, so the room opens the way they left it. */
const TOOL_KEY = 'gamecut.cropTool';
function savedTool() {
  try { const t = localStorage.getItem(TOOL_KEY); return t === 'box' || t === 'smart' ? t : 'brush'; } catch { return 'brush'; }
}
function rememberTool(t) {
  try { localStorage.setItem(TOOL_KEY, t); } catch { /* not fatal */ }
}

/** The smallest box worth keeping, in source 0..1. */
const MIN_BOX = 0.004;
/** Which parts of the box can be grabbed. */
const GRABS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
                  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

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
  let tool = savedTool();        // 'box' | 'brush' | 'smart'
  let found = [];                // smart: pieces found or clicked, see smart-crop.js
  let smartOut = 'box';          // 'box' | 'shape'
  let eachLayer = true;
  let aimg = null;               // smart: the still at analysis size, RGBA
  let paintMode = 'keep';        // 'keep' | 'remove' — what the brush does
  let brush = 0.06;              // fraction of the source's short side
  let feather = 0.15;            // 0..1, scaled to a few source pixels
  let rect = null;               // box tool, in source 0..1
  let aspect = 0;                // box tool: 0 = free, else width ÷ height in source pixels
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
  el.className = 'cropst' + (tool === 'brush' ? ' is-brush' : '');
  el.innerHTML = `
    <div class="cropst__bar">
      <div class="cropst__tools" role="group" aria-label="Crop tools">
        <button class="cst${tool === 'box' ? ' is-on' : ''}" data-tool="box" title="Drag a rectangle around the part you want (M)">
          <svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg><span>Box</span>
        </button>
        <button class="cst${tool === 'brush' ? ' is-on' : ''}" data-tool="brush" title="Paint the exact shape you want (B)">
          <svg viewBox="0 0 24 24"><path d="M4 20s1-3 3-4c2-1 3 .5 3 .5S8 20 4 20Z"/><path d="M10.5 15.5 19 7a2.1 2.1 0 0 0-3-3l-8.5 8.5"/></svg><span>Brush</span>
        </button>
        <button class="cst${tool === 'smart' ? ' is-on' : ''}" data-tool="smart" title="Smart: find the HUD, or click anything on the picture to select it (S)">
          <svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg><span>Smart</span>
        </button>
      </div>

      <div class="cropst__sep"></div>

      <div class="cropst__paint" role="group" aria-label="What the brush does">
        <button class="cst cst--sm is-on" data-paint="keep" title="Paint over the part you want to keep">Keep</button>
        <button class="cst cst--sm" data-paint="remove" title="Paint over the part you want gone">Remove</button>
      </div>

      <label class="cropst__shape" title="Lock the box to a shape. Hold Shift while dragging for a perfect square.">
        <span>Shape</span>
        <select id="cstAspect" class="cst cst--sm">
          <option value="0">Free</option>
          <option value="project">Match my video</option>
          <option value="1.7778">16:9</option>
          <option value="0.5625">9:16</option>
          <option value="1">Square 1:1</option>
          <option value="1.3333">4:3</option>
          <option value="0.8">4:5</option>
        </select>
      </label>

      <label class="cropst__slide" title="Brush size — or press [ and ]">
        <span>Size</span><input type="range" id="cstSize" min="8" max="400" value="60"><b id="cstSizeV">60</b>
      </label>

      <label class="cropst__slide" title="How soft the edge of the cut is">
        <span>Soft</span><input type="range" id="cstSoft" min="0" max="100" value="15"><b id="cstSoftV">15</b>
      </label>

      <div class="cropst__sep"></div>

      <button class="cst cst--sm" id="cstUndo" title="Undo the last stroke or box change (Ctrl+Z)">Undo</button>
      <button class="cst cst--sm" id="cstClear" title="Start this crop again">Clear</button>
      <button class="cst cst--sm" id="cstAll" title="Select the whole frame with the box, then trim it with the handles (A)">Whole frame</button>

      <div class="cropst__spacer"></div>

      <div class="cropst__zoom">
        <button class="cst cst--ic" id="cstOut" title="Zoom out">−</button>
        <b id="cstZoom">100%</b>
        <button class="cst cst--ic" id="cstIn" title="Zoom in">+</button>
        <button class="cst cst--sm" id="cstFit" title="Fit the whole frame on screen">Fit</button>
      </div>

      <button class="cst cst--sm" id="cstFreeze" title="Turn this frame into a still picture: the video pauses here for 2 seconds, then plays on. Shift+F">Freeze frame</button>
      <button class="cst cst--ghost" id="cstCancel">Cancel</button>
      <button class="cst cst--go" id="cstApply">Apply crop</button>
    </div>

    <div class="cropst__stage">
      <canvas class="cropst__cv"></canvas>
      <div class="cropst__hint" id="cstHint"></div>
      <aside class="cropst__smart" id="cstSmart">
        <button class="cst cst--go cropst__find" id="cstFindHud">Find the HUD</button>
        <p class="cropst__note" id="cstSmartNote">Finds what stays still while the game moves — minimap, kill feed, scoreboard. Or click anything on the picture to select it.</p>
        <div class="cropst__found" id="cstFound"></div>
        <div class="cropst__out" id="cstOut2">
          <b>How to cut it</b>
          <label><input type="radio" name="cstOut" value="box" checked> Neat box</label>
          <label><input type="radio" name="cstOut" value="shape"> Exact shape</label>
          <label class="cropst__each"><input type="checkbox" id="cstEach" checked> Each on its own layer</label>
          <label class="cropst__each" title="For things that move — a player, a car. HUD never moves, so leave this off for it."><input type="checkbox" id="cstFollow"> Follow it as it moves</label>
        </div>
      </aside>
    </div>`;

  document.body.appendChild(el);
  // The window's title strip is a drag region; while this room covers it the
  // strip must stop being one (see layout.css), or the buttons under it go dead.
  document.documentElement.classList.add('has-room');
  

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

  /* ── Where the picture sits in the project ─────────────────── */

  /**
   * The whole source frame, measured in the project's own 0..1 space.
   *
   * `bounds` measures what the clip currently *shows*; when the clip is already
   * cropped that is a window onto the source, not the source. So work back to
   * where the whole frame would sit — that is the space a new crop lives in.
   */
  function frameGeometry() {
    const b = comp.bounds(clip, store.rt.playhead);
    const c0 = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
    const fullW = b.w / (c0.w || 1);
    const fullH = b.h / (c0.h || 1);
    return {
      fullW, fullH,
      fullCx: b.cx - (c0.x + c0.w / 2 - 0.5) * fullW,
      fullCy: b.cy - (c0.y + c0.h / 2 - 0.5) * fullH,
    };
  }

  /**
   * The part of the source that actually lands inside the project's frame.
   *
   * A 16:9 recording in a vertical project is cropped by the frame itself; the
   * crop room shows all of it, so without this a box drawn on the cut-off part
   * makes a piece nobody can see, and "nothing happened" is the only possible
   * reading.
   */
  const visible = (() => {
    const g = frameGeometry();
    const v = {
      x0: clamp01((0 - g.fullCx) / g.fullW + 0.5), x1: clamp01((1 - g.fullCx) / g.fullW + 0.5),
      y0: clamp01((0 - g.fullCy) / g.fullH + 0.5), y1: clamp01((1 - g.fullCy) / g.fullH + 0.5),
    };
    const area = (v.x1 - v.x0) * (v.y1 - v.y0);
    v.partial = area < 0.985;
    return v;
  })();

  /* ── The box: drawn, moved and resized ─────────────────────── */

  /** Width ÷ height the box is locked to, in the 0..1 space of the source. */
  const lockRatio = (shift) => {
    const px = aspect || (shift ? 1 : 0);
    return px ? px * fh / fw : 0;
  };

  /**
   * A box hanging off one fixed corner, kept inside the frame and — when
   * locked — to a shape. The largest box of that shape that fits in the room
   * the pointer has marked out.
   */
  function anchored(ax, ay, sx, sy, w, h, r) {
    w = Math.min(w, sx > 0 ? 1 - ax : ax);
    h = Math.min(h, sy > 0 ? 1 - ay : ay);
    if (r) {
      let ww = w, hh = w / r;
      if (hh > h) { hh = h; ww = hh * r; }
      w = ww; h = hh;
    }
    return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
  }

  /** Which part of the box is under a canvas point: a handle, the inside, or nothing. */
  function grabAt(p) {
    if (!rect) return null;
    const a = srcToView(rect.x, rect.y), b = srcToView(rect.x + rect.w, rect.y + rect.h);
    const k = cv.width / (cv.clientWidth || cv.width);
    const R = 10 * k;
    const near = (x, y) => Math.hypot(p.x - x, p.y - y) <= R;
    if (near(a.x, a.y)) return 'nw';
    if (near(b.x, a.y)) return 'ne';
    if (near(b.x, b.y)) return 'se';
    if (near(a.x, b.y)) return 'sw';
    const inX = p.x > a.x + R && p.x < b.x - R, inY = p.y > a.y + R && p.y < b.y - R;
    if (inX && Math.abs(p.y - a.y) <= R) return 'n';
    if (inX && Math.abs(p.y - b.y) <= R) return 's';
    if (inY && Math.abs(p.x - a.x) <= R) return 'w';
    if (inY && Math.abs(p.x - b.x) <= R) return 'e';
    if (p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y) return 'move';
    return null;
  }

  /** Work out the box for the pointer at (u, v) while a drag is in progress. */
  function dragBox(d, u, v, shift) {
    const r0 = d.r0, r = lockRatio(shift);
    u = clamp01(u); v = clamp01(v);
    if (d.mode === 'new' || d.mode.length === 2) {
      const sx = u >= d.ax ? 1 : -1, sy = v >= d.ay ? 1 : -1;
      return anchored(d.ax, d.ay, sx, sy, Math.abs(u - d.ax), Math.abs(v - d.ay), r);
    }
    if (d.mode === 'move') {
      const x = Math.min(1 - r0.w, Math.max(0, r0.x + (u - d.u0)));
      const y = Math.min(1 - r0.h, Math.max(0, r0.y + (v - d.v0)));
      return { x, y, w: r0.w, h: r0.h };
    }
    // One edge. Free: just that edge moves. Locked: the far side stays put and
    // the box grows across the middle of the other axis.
    if (d.mode === 'e' || d.mode === 'w') {
      const sx = d.mode === 'e' ? 1 : -1, ax = d.mode === 'e' ? r0.x : r0.x + r0.w;
      const w = Math.max(MIN_BOX, sx > 0 ? u - ax : ax - u);
      if (!r) return { x: sx > 0 ? ax : ax - w, y: r0.y, w: Math.min(w, sx > 0 ? 1 - ax : ax), h: r0.h };
      const cy = r0.y + r0.h / 2, maxH = 2 * Math.min(cy, 1 - cy);
      let ww = Math.min(w, sx > 0 ? 1 - ax : ax), hh = ww / r;
      if (hh > maxH) { hh = maxH; ww = hh * r; }
      return { x: sx > 0 ? ax : ax - ww, y: cy - hh / 2, w: ww, h: hh };
    }
    const sy = d.mode === 's' ? 1 : -1, ay = d.mode === 's' ? r0.y : r0.y + r0.h;
    const h = Math.max(MIN_BOX, sy > 0 ? v - ay : ay - v);
    if (!r) return { x: r0.x, y: sy > 0 ? ay : ay - h, w: r0.w, h: Math.min(h, sy > 0 ? 1 - ay : ay) };
    const cx = r0.x + r0.w / 2, maxW = 2 * Math.min(cx, 1 - cx);
    let hh = Math.min(h, sy > 0 ? 1 - ay : ay), ww = hh * r;
    if (ww > maxW) { ww = maxW; hh = ww / r; }
    return { x: cx - ww / 2, y: sy > 0 ? ay : ay - hh, w: ww, h: hh };
  }

  /** Re-shape an existing box to the chosen lock, around its own centre. */
  function refitBox() {
    const r = lockRatio(false);
    if (!rect || !r) return;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    let w = rect.w, h = w / r;
    if (h > rect.h) { h = rect.h; w = h * r; }
    rect = { x: clamp01(cx - w / 2), y: clamp01(cy - h / 2), w, h };
    rect.x = Math.min(rect.x, 1 - rect.w); rect.y = Math.min(rect.y, 1 - rect.h);
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
    if (tool === 'smart') {
      const on = found.filter(f => f.on);
      if (!on.length) sctx.fillRect(0, 0, scratch.width, scratch.height);
      for (const f of on) {
        const a = srcToView(f.box.x, f.box.y);
        if (smartOut === 'box') sctx.fillRect(a.x, a.y, f.box.w * w, f.box.h * h);
        else sctx.drawImage(bitsCanvas(f), panX, panY, w, h);
      }
    } else if (tool === 'box') {
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

    /* What the project's frame actually shows of this footage. */
    if (visible.partial) {
      const a = srcToView(visible.x0, visible.y0);
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = 'rgba(251,191,36,.85)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x + .5, a.y + .5, (visible.x1 - visible.x0) * w, (visible.y1 - visible.y0) * h);
      ctx.setLineDash([]);
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(251,191,36,.95)';
      ctx.textBaseline = 'top';
      ctx.fillText('Your video shows this part', a.x + 6, a.y + 6);
    }
    ctx.restore();

    /* Handles and a size readout, so the box reads as something you can edit. */
    if (tool === 'box' && rect) {
      const a = srcToView(rect.x, rect.y), b = srcToView(rect.x + rect.w, rect.y + rect.h);
      const k = cv.width / (cv.clientWidth || cv.width);
      const hs = 4.5 * k;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const pts = [[a.x, a.y], [mx, a.y], [b.x, a.y], [b.x, my], [b.x, b.y], [mx, b.y], [a.x, b.y], [a.x, my]];
      ctx.save();
      ctx.lineWidth = 1.5 * k;
      for (let i = 0; i < pts.length; i++) {
        const edge = i % 2 === 1;
        if (edge && (Math.abs(b.x - a.x) < 40 * k || Math.abs(b.y - a.y) < 40 * k)) continue;
        ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(37,99,235,1)';
        ctx.beginPath(); ctx.rect(pts[i][0] - hs, pts[i][1] - hs, hs * 2, hs * 2); ctx.fill(); ctx.stroke();
      }
      const label = `${Math.round(rect.w * fw)} × ${Math.round(rect.h * fh)}`;
      ctx.font = `600 ${12 * k}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 14 * k;
      const lx = Math.max(4 * k, Math.min(cv.width - tw - 4 * k, a.x));
      const ly = a.y - 16 * k > 4 * k ? a.y - 16 * k : b.y + 16 * k;
      ctx.fillStyle = 'rgba(8,14,26,.9)';
      ctx.fillRect(lx, ly - 10 * k, tw, 20 * k);
      ctx.fillStyle = '#e6efff';
      ctx.fillText(label, lx + 7 * k, ly);
      ctx.restore();
    }

    /* Smart: every piece, named, ticked or not. */
    if (tool === 'smart') {
      const k = cv.width / (cv.clientWidth || cv.width);
      ctx.save();
      for (const f of found) {
        const a = srcToView(f.box.x, f.box.y);
        ctx.setLineDash(f.on ? [] : [5, 4]);
        ctx.lineWidth = 2 * k;
        ctx.strokeStyle = f.on ? '#34d399' : 'rgba(200,210,230,.7)';
        ctx.strokeRect(a.x, a.y, f.box.w * w, f.box.h * h);
        ctx.setLineDash([]);
        ctx.font = `700 ${11 * k}px Inter, system-ui, sans-serif`;
        const label = f.name;
        const tw = ctx.measureText(label).width + 12 * k;
        const ly = a.y - 18 * k > 2 ? a.y - 18 * k : a.y + 2 * k;
        ctx.fillStyle = f.on ? '#059669' : 'rgba(30,41,59,.9)';
        ctx.fillRect(a.x, ly, tw, 16 * k);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, a.x + 6 * k, ly + 8 * k);
      }
      ctx.restore();
    }

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
    cv.__box = rect ? { ...rect } : null;
    cv.__visible = visible;    // likewise: lets a test read the box
    cv.__found = found.map(f => ({ name: f.name, on: f.on, box: { ...f.box } }));
    hint.textContent = tool === 'smart'
      ? (found.length ? 'Click a piece to tick or untick it · Shift+click to keep just one part of it · click anything else to select it too · Enter to cut' : 'Press Find the HUD, or click anything on the picture to select it')
      : tool === 'box'
      ? (rect
        ? 'Drag the box to move it, the handles to resize · Shift keeps it square · Enter to crop · scroll to zoom'
        : 'Drag a rectangle around the part you want · scroll to zoom · space or middle-drag to move')
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

    if (tool === 'smart') {
      const s0 = viewToSrc(p.x, p.y);
      const u = clamp01(s0.u), v = clamp01(s0.v);
      const hitItem = [...found].reverse().find(f => u >= f.box.x && u <= f.box.x + f.box.w && v >= f.box.y && v <= f.box.y + f.box.h);
      // Shift+click a joined piece: keep only the part under the pointer.
      if (hitItem && e.shiftKey && hitItem.parts) {
        const pick = hitItem.parts.find(q => u >= q.box.x && u <= q.box.x + q.box.w && v >= q.box.y && v <= q.box.y + q.box.h);
        splitItem(hitItem, pick);
        return;
      }
      if (hitItem && !e.altKey) { hitItem.on = !hitItem.on; paintFound(); paint(); return; }
      const sel = magicSelect(analysisImage(), u, v);
      if (!sel) { bus.emit('toast', { msg: 'That ran into the whole picture — click inside something with a clear edge.', kind: 'err' }); return; }
      if (sel.box.w * sel.box.h < 0.0004) { bus.emit('toast', { msg: 'That is too small to cut out — zoom in and click again.', kind: 'err' }); return; }
      const n = found.filter(f => f.id.startsWith('sel')).length + 1;
      found.push({ id: 'sel' + n, name: n === 1 ? 'Selection' : `Selection ${n}`, box: sel.box, bits: sel.bits, mw: sel.mw, mh: sel.mh, on: true });
      if (smartOut === 'box' && found.length === 1) setOut('shape');
      paintFound(); paint();
      return;
    }

    if (tool === 'box') {
      const s0 = viewToSrc(p.x, p.y);
      const u = clamp01(s0.u), v = clamp01(s0.v);
      const grab = grabAt(p);
      snapshot();                 // one step of undo per drag, move or resize
      const r0 = rect ? { ...rect } : null;
      drawing = { box: true, mode: grab || 'new', r0, u0: u, v0: v, ax: u, ay: v, fresh: !grab };
      if (grab && grab.length === 2 && grab !== 'move') {
        // Corner: the opposite corner stays where it is.
        drawing.ax = grab.includes('w') ? r0.x + r0.w : r0.x;
        drawing.ay = grab.includes('n') ? r0.y + r0.h : r0.y;
      }
      if (!grab) rect = { x: u, y: v, w: 0, h: 0 };
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
    if (!drawing) {
      if (tool === 'box') cv.style.cursor = CURSORS[grabAt(p)] || 'crosshair';
      if (tool === 'brush') paint();
      return;
    }

    const s = viewToSrc(p.x, p.y);
    if (drawing.box) {
      rect = dragBox(drawing, s.u, s.v, e.shiftKey);
      paint();
      return;
    }
    const now = { u: clamp01(s.u), v: clamp01(s.v) };
    stroke(last, now);
    last = now;
    paint();
  });

  const endDrag = () => {
    if (drawing && drawing.box) {
      // A click that never became a box must not wipe the box that was there,
      // nor leave a step of undo that undoes nothing.
      if (rect && (rect.w < MIN_BOX || rect.h < MIN_BOX)) {
        rect = drawing.r0;
        undo.pop();
      }
      if (rect) {
        // Floating-point drift from the clamps must not push the box past the frame.
        rect = { x: clamp01(rect.x), y: clamp01(rect.y),
                 w: Math.min(rect.w, 1 - clamp01(rect.x)), h: Math.min(rect.h, 1 - clamp01(rect.y)) };
      }
      paint();
    }
    drawing = false; panning = false; panFrom = null; last = null;
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { cursor = null; paint(); });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  // Double-click inside the box is the quickest way to say "yes, that one".
  cv.addEventListener('dblclick', (e) => {
    if (tool === 'box' && rect && grabAt(localPt(e)) === 'move') apply();
  });

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPt(e);
    zoomAt(e.deltaY < 0 ? 1.16 : 1 / 1.16, p.x, p.y);
  }, { passive: false });

  /* ── Toolbar ───────────────────────────────────────────────── */
  function setTool(t) {
    tool = t;
    rememberTool(t);
    for (const x of el.querySelectorAll('[data-tool]')) x.classList.toggle('is-on', x.dataset.tool === tool);
    el.classList.toggle('is-brush', tool === 'brush');
    el.classList.toggle('is-box', tool === 'box');
    el.classList.toggle('is-smart', tool === 'smart');
    cv.style.cursor = '';
    paint();
  }
  el.classList.toggle('is-box', tool === 'box');
  el.classList.toggle('is-smart', tool === 'smart');

  /* ── Smart ─────────────────────────────────────────────────── */
  const AW = 320;
  function analysisImage() {
    if (aimg) return aimg;
    const w = AW, h = Math.max(8, Math.round(AW / (fw / fh)));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(still, 0, 0, w, h);
    aimg = { data: g.getImageData(0, 0, w, h).data, w, h };
    return aimg;
  }
  const bitsCache = new WeakMap();
  function bitsCanvas(f) {
    let c = bitsCache.get(f);
    if (c) return c;
    c = document.createElement('canvas'); c.width = f.mw; c.height = f.mh;
    const g = c.getContext('2d'); const im = g.createImageData(f.mw, f.mh);
    for (let i = 0; i < f.bits.length; i++) if (f.bits[i]) im.data[i * 4 + 3] = 255;
    g.putImageData(im, 0, 0);
    bitsCache.set(f, c);
    return c;
  }
  const foundEl = el.querySelector('#cstFound');
  const noteEl = el.querySelector('#cstSmartNote');
  function paintFound() {
    foundEl.innerHTML = '';
    for (const f of found) {
      const row = document.createElement('label');
      row.className = 'cropst__item';
      row.innerHTML = `<input type="checkbox" ${f.on ? 'checked' : ''}><span class="cropst__nm" title="Double-click to rename"></span><i>${Math.round(f.box.w * fw)}×${Math.round(f.box.h * fh)}</i>`;
      row.querySelector('.cropst__nm').textContent = f.name;
      row.querySelector('input').addEventListener('change', (ev) => { f.on = ev.target.checked; paint(); });
      if (f.parts?.length > 1) {
        const b = document.createElement('button');
        b.className = 'cropst__split';
        b.type = 'button';
        b.textContent = `Split (${f.parts.length})`;
        b.title = 'Break this into the pieces it was joined from, to keep just one';
        b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); splitItem(f, null); });
        row.appendChild(b);
      }
      row.querySelector('.cropst__nm').addEventListener('dblclick', async (ev) => {
        ev.preventDefault();
        const name = await askText({ title: 'Name this piece', label: 'What is it?', value: f.name });
        if (name) { f.name = name.slice(0, 32); paintFound(); paint(); }
      });
      foundEl.appendChild(row);
    }
  }
  /**
   * Replace a joined piece with the pieces it was made from. With `keep`, only
   * that one stays ticked (Shift+click); otherwise all of them are.
   */
  function splitItem(f, keep) {
    const i = found.indexOf(f);
    if (i < 0 || !f.parts) return;
    const parts = f.parts.map(q => ({ ...q, on: keep ? q === keep : true }));
    found.splice(i, 1, ...parts);
    paintFound(); paint();
  }

  function setOut(v) {
    smartOut = v;
    for (const r of el.querySelectorAll('input[name="cstOut"]')) r.checked = r.value === v;
    paint();
  }
  for (const r of el.querySelectorAll('input[name="cstOut"]')) r.addEventListener('change', () => setOut(r.value));
  el.querySelector('#cstEach').addEventListener('change', (e) => { eachLayer = e.target.checked; });

  async function findTheHud() {
    const asset = assets.get(clip.assetId);
    const btn = el.querySelector('#cstFindHud');
    if (!asset?.url || clip.type !== 'video') { noteEl.textContent = 'The HUD finder needs a video clip. Click anything on the picture to select it instead.'; return; }
    btn.disabled = true;
    noteEl.textContent = 'Looking at frames from across the clip…';
    try {
      const sp = clip.speed || 1;
      const a = clip.inPoint, b = clip.inPoint + clip.duration * sp;
      const n = 10;
      const times = Array.from({ length: n }, (_, i) => a + (b - a) * (i + 0.5) / n);
      const img = analysisImage();
      const frames = await sampleFrames(asset, times, (p) => { noteEl.textContent = `Looking at frames from across the clip… ${Math.round(p * 100)}%`; }, img.w);
      const r = findHud(img, frames);
      found = found.filter(f => !f.id.startsWith('hud')).concat(r.items);
      noteEl.textContent = r.items.length
        ? `Found ${r.items.length} piece${r.items.length === 1 ? '' : 's'}. The names are best guesses — double-click one to rename it, untick what you do not want.`
        : r.reason;
      paintFound(); paint();
    } catch (err) {
      noteEl.textContent = `Could not look at the clip: ${err.message}`;
    } finally { btn.disabled = false; }
  }
  el.querySelector('#cstFindHud').addEventListener('click', findTheHud);

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;

    if (b.dataset.tool) {
      setTool(b.dataset.tool);
      return;
    }
    if (b.dataset.paint) {
      paintMode = b.dataset.paint;
      for (const x of el.querySelectorAll('[data-paint]')) x.classList.toggle('is-on', x.dataset.paint === paintMode);
      if (tool !== 'brush') setTool('brush');
      paint();
      return;
    }
    switch (b.id) {
      case 'cstUndo': stepBack(); break;
      case 'cstClear': clearAll(); break;
      case 'cstAll': wholeFrame(); break;
      case 'cstIn': zoomAt(1.25, cv.width / 2, cv.height / 2); break;
      case 'cstOut': zoomAt(1 / 1.25, cv.width / 2, cv.height / 2); break;
      case 'cstFit': fit(); paint(); break;
      case 'cstCancel': close(); break;
      // Pause on the frame being cropped. The studio closes first: the still
      // it makes is selected afterwards, so pressing C crops the still itself.
      case 'cstFreeze': close(); freezeFrame({ store, cmds }); break;
      case 'cstApply': apply(); break;
    }
  });

  function wholeFrame() {
    if (tool !== 'box') setTool('box');
    snapshot();
    rect = { x: 0, y: 0, w: 1, h: 1 };
    refitBox();
    paint();
  }

  const aspectSel = el.querySelector('#cstAspect');
  aspectSel.addEventListener('change', () => {
    aspect = aspectSel.value === 'project'
      ? store.doc.width / store.doc.height
      : +aspectSel.value;
    if (rect && lockRatio(false)) { snapshot(); refitBox(); }
    aspectSel.blur();            // so Enter and the arrow keys go to the studio, not the menu
    paint();
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
    if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) { el.querySelector('[data-tool="smart"]').click(); }
    if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey) { wholeFrame(); }
    if (tool === 'box' && rect && e.key.startsWith('Arrow') && document.activeElement?.tagName !== 'SELECT') {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1);
      const dx = e.key === 'ArrowLeft' ? -step / fw : e.key === 'ArrowRight' ? step / fw : 0;
      const dy = e.key === 'ArrowUp' ? -step / fh : e.key === 'ArrowDown' ? step / fh : 0;
      if (!e.repeat) snapshot();
      rect = { ...rect,
        x: Math.min(1 - rect.w, Math.max(0, rect.x + dx)),
        y: Math.min(1 - rect.h, Math.max(0, rect.y + dy)) };
      paint();
    }
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
    document.documentElement.classList.remove('has-room');
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

  /** Where a crop of the source lands in the project, so it sits over its own pixels. */
  function placeFor(crop) {
    const { fullW, fullH, fullCx, fullCy } = frameGeometry();
    const W = store.doc.width, H = store.doc.height;
    const sw = Math.max(1, crop.w * fw), sh = Math.max(1, crop.h * fh);
    const fitContain = Math.min(W / sw, H / sh);
    const scale = (crop.w * fullW * W) / (sw * fitContain);
    let px = fullCx + (crop.x + crop.w / 2 - 0.5) * fullW;
    let py = fullCy + (crop.y + crop.h / 2 - 0.5) * fullH;
    const offscreen = px < 0 || px > 1 || py < 0 || py > 1;
    if (offscreen) { px = Math.min(0.85, Math.max(0.15, px)); py = Math.min(0.85, Math.max(0.15, py)); }
    return { offscreen, transform: { x: px, y: py, scale: Number.isFinite(scale) && scale > 0 ? scale : 1, rotation: clip.transform?.rotation || 0, opacity: 1 } };
  }

  /** The smart pieces: one layer each, or all as one cut-out. */
  function applySmart() {
    const on = found.filter(f => f.on);
    if (!on.length) { bus.emit('toast', { msg: 'Tick at least one piece, or click something on the picture.', kind: 'err' }); return; }
    const snap = (b, f) => {
      const x0 = Math.floor(b.x * f.mw), y0 = Math.floor(b.y * f.mh);
      const x1 = Math.ceil((b.x + b.w) * f.mw), y1 = Math.ceil((b.y + b.h) * f.mh);
      return { x: x0 / f.mw, y: y0 / f.mh, w: (x1 - x0) / f.mw, h: (y1 - y0) / f.mh };
    };
    const groups = eachLayer ? on.map(f => [f]) : [on];
    const made = [];
    cmds.batch(groups.length > 1 ? `Cut out ${groups.length} pieces` : 'Smart crop', () => {
      for (const g of groups) {
        const x = Math.min(...g.map(f => f.box.x)), y = Math.min(...g.map(f => f.box.y));
        const box = snap({ x, y, w: Math.max(...g.map(f => f.box.x + f.box.w)) - x, h: Math.max(...g.map(f => f.box.y + f.box.h)) - y }, g[0]);
        const crop = { ...box };
        if (smartOut === 'shape') crop.mask = maskPng(g, box, 1);
        const { transform } = placeFor(crop);
        const c = cmds.cropClip(clip.id, { crop, transform }, { label: 'Smart crop' });
        if (c) { c.name = g.length === 1 ? g[0].name : 'HUD pieces'; made.push(c); }
      }
    });
    const follow = el.querySelector('#cstFollow')?.checked;
    if (made.length && follow) {
      const at = store.rt.playhead;
      import('../../edit/follow.js').then(async ({ followCrop }) => {
        for (const c of made) {
          try { await followCrop({ store, cmds, comp }, c.id, at); }
          catch (e) { bus.emit('toast', { msg: `Could not follow “${c.name}”: ${e.message}`, kind: 'err' }); }
        }
      });
    }
    if (made.length) {
      store.select(made.map(c => c.id));
      comp.render();
      bus.emit('toast', { msg: made.length > 1 ? `Cut out ${made.length} pieces, each on its own layer — drag them anywhere` : `Cut out “${made[0].name}” — drag it anywhere`, kind: 'ok', ms: 5200 });
    }
    close();
  }

  function apply() {
    if (tool === 'smart') { applySmart(); return; }
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
    const { fullW, fullH, fullCx, fullCy } = frameGeometry();
    const W = store.doc.width, H = store.doc.height;

    const sw = Math.max(1, crop.w * fw), sh = Math.max(1, crop.h * fh);
    const fitContain = Math.min(W / sw, H / sh);
    const onScreenW = crop.w * fullW;                   // fraction of the frame
    const scale = (onScreenW * W) / (sw * fitContain);

    let px = fullCx + (crop.x + crop.w / 2 - 0.5) * fullW;
    let py = fullCy + (crop.y + crop.h / 2 - 0.5) * fullH;
    /*
     * A piece whose middle is outside the project's frame cannot be seen or
     * grabbed — in a vertical project that is the whole cut-off side of a
     * widescreen recording. Bring it into view rather than make something
     * invisible and let "nothing happened" be the only explanation.
     */
    const offscreen = px < 0 || px > 1 || py < 0 || py > 1;
    if (offscreen) { px = Math.min(0.85, Math.max(0.15, px)); py = Math.min(0.85, Math.max(0.15, py)); }

    const made = cmds.cropClip(clip.id, {
      crop,
      transform: {
        x: px,
        y: py,
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
        rotation: clip.transform?.rotation || 0,
        opacity: 1,
      },
    });

    if (made) {
      comp.render();
      bus.emit('toast', {
        msg: offscreen
          ? 'That part is outside what your video shows, so the piece is placed in view. Drag it where you want it.'
          : crop.mask
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
