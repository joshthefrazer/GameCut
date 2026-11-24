import { evalProp } from '../keyframes.js';
import { roundRect } from './text-layer.js';
import { fxActive, drawFx } from './fx.js';

/**
 * Draws a video frame / still image with fit-contain framing, then applies the
 * clip transform around the frame centre. Because the transform is normalized,
 * switching a project from 16:9 to 9:16 reframes every clip predictably.
 */
/**
 * Which part of the source picture this clip shows, in source pixels.
 *
 * One definition, used by the painter and by the gizmo that measures the clip
 * on screen. They disagreed once — the selection box was drawn around the whole
 * frame while the picture was a small crop of it — and the fix is for both to
 * ask the same function rather than each work it out.
 */
export function sourceRect(clip, src, t = null) {
  // A <video>, an <img>, or a WebCodecs VideoFrame straight from the export's decoder.
  const fw = src?.videoWidth || src?.naturalWidth || src?.displayWidth || 0;
  const fh = src?.videoHeight || src?.naturalHeight || src?.displayHeight || 0;
  const c = clip.crop;
  if (!c || !fw || !fh) return { sx: 0, sy: 0, sw: fw, sh: fh };
  const sw = Math.max(1, Math.round(c.w * fw));
  const sh = Math.max(1, Math.round(c.h * fh));
  const { x, y } = t == null ? c : cropAt(clip, t);
  return {
    sx: Math.min(fw - sw, Math.max(0, Math.round(x * fw))),
    sy: Math.min(fh - sh, Math.max(0, Math.round(y * fh))),
    sw, sh,
  };
}

/**
 * Where a crop's box is at timeline time `t`.
 *
 * A crop that follows something ("Follow it as it moves") carries a path of
 * box positions keyed by SOURCE time, so trimming, splitting or re-timing the
 * clip never knocks the box off what it was following.
 */
export function cropAt(clip, t) {
  const c = clip.crop, path = c?.path;
  if (!path?.length) return { x: c.x, y: c.y };
  const st = (clip.inPoint || 0) + (t - clip.start) * (clip.speed || 1);
  if (st <= path[0].t) return path[0];
  const last = path[path.length - 1];
  if (st >= last.t) return last;
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (path[mid].t <= st) lo = mid; else hi = mid; }
  const a = path[lo], b = path[hi], u = (st - a.t) / Math.max(1e-6, b.t - a.t);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/**
 * Painted crop masks, decoded once and kept.
 *
 * The mask is a PNG on the clip, so it survives save and reload — but decoding
 * a data URL on every frame would be absurd. Keyed by the string itself, which
 * means two clips cut with the same mask share one image, and re-cropping a
 * clip simply parks a new entry beside the old one.
 */
const MASKS = new Map();
function maskImage(url) {
  let img = MASKS.get(url);
  if (img === undefined) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'sync';
    img.src = url;
    MASKS.set(url, img);
    // A mask that fails to load must not black out the clip forever.
    img.addEventListener('error', () => MASKS.set(url, null), { once: true });
  }
  return img && img.complete && img.naturalWidth ? img : null;
}

/**
 * Scratch canvas for masking. One, reused.
 *
 * Masking needs an off-screen copy of the piece so the alpha can be punched out
 * of it before it reaches the frame; allocating that canvas per clip per frame
 * is the kind of thing that shows up as stutter on a busy timeline rather than
 * as an error anywhere.
 */
let scratch = null, sctx = null;
function scratchAt(w, h) {
  if (!scratch) {
    scratch = document.createElement('canvas');
    sctx = scratch.getContext('2d');
  }
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, Math.ceil(w));
    scratch.height = Math.max(scratch.height, Math.ceil(h));
  }
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  return sctx;
}

export function drawVisualClip(ctx, clip, src, W, H, t, alpha) {
  const { sx, sy, sw, sh } = sourceRect(clip, src, t);
  if (!sw || !sh) return;

  const fitMode = clip.fit || 'cover';
  const scaleFit = fitMode === 'cover'
    ? Math.max(W / sw, H / sh)
    : Math.min(W / sw, H / sh);

  const scale = evalProp(clip, 'transform.scale', t);
  const x = evalProp(clip, 'transform.x', t) * W;
  const y = evalProp(clip, 'transform.y', t) * H;
  const rot = evalProp(clip, 'transform.rotation', t) * Math.PI / 180;

  const dw = sw * scaleFit * scale;
  const dh = sh * scaleFit * scale;

  /*
   * 'blur' fit: the whole picture, contained, over a soft blurred copy of
   * itself that fills the frame — how a landscape clip goes into a tall or
   * square video without black bars and without losing its sides.
   */
  if (fitMode === 'blur') {
    try {
      const cf = Math.max(W / sw, H / sh), cw = sw * cf, ch = sh * cf;
      const bw = 40, bh = Math.max(4, Math.round(40 * ch / Math.max(1, cw)));
      const bc = softBackdrop(src, sx, sy, sw, sh, bw, bh);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(bc, 0, 0, bw, bh, (W - cw) / 2, (H - ch) / 2, cw, ch);
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    } catch { /* frame not ready */ }
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  if (clip.flipH || clip.flipV) ctx.scale(clip.flipH ? -1 : 1, clip.flipV ? -1 : 1);
  ctx.imageSmoothingQuality = 'high';

  /**
   * A drawn crop clips the picture to the shape instead of the box.
   *
   * The points live in the source's own 0..1 space, the same as the crop
   * rectangle, so they survive a change of resolution or preview quality. They
   * are mapped into the drawn rectangle here — which is the only place that
   * knows how big it ended up.
   *
   * The edge is crisp rather than feathered on purpose: softening it means
   * blurring a mask every frame, and a per-frame blur is the exact cost this
   * editor spent a long day removing.
   */
  const pts = clip.crop?.shape;
  if (pts && pts.length > 2 && sw && sh) {
    const fw = src.videoWidth || src.naturalWidth || src.displayWidth || sw;
    const fh = src.videoHeight || src.naturalHeight || src.displayHeight || sh;
    // A followed crop carries its shape along with the box.
    const ox = clip.crop.path?.length ? sx - Math.round(clip.crop.x * fw) : 0;
    const oy = clip.crop.path?.length ? sy - Math.round(clip.crop.y * fh) : 0;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const u = (pts[i][0] * fw + ox - sx) / sw;
      const v = (pts[i][1] * fh + oy - sy) / sh;
      const px = -dw / 2 + u * dw;
      const py = -dh / 2 + v * dh;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.clip();
  }

  /**
   * Anything that needs the layer as its own picture first.
   *
   * A painted crop mask and a look (glow, outline, tilt) both need the layer
   * built off to one side before it can be composited — the mask because a soft
   * edge cannot be had from `clip()`, the effects because they are drawn from
   * the layer's own silhouette. So they share one path and one scratch canvas
   * rather than each making their own copy.
   */
  const maskUrl = clip.crop?.mask;
  const mimg = maskUrl ? maskImage(maskUrl) : null;
  const fx = clip.fx;
  const wantsFx = fxActive(fx);

  if (mimg || wantsFx) {
    /*
     * The masked/effected piece is built at most 4096 px on its longer side and
     * enlarged on the way out. A huge layer (a big zoom, a 4K export) used to
     * skip this whole path past 8192 px — dropping the painted cut-out mask so
     * the whole rectangle showed, and every effect with it. Building it smaller
     * costs nothing visible: the source is being enlarged at that size anyway.
     */
    const k = Math.min(1, 4096 / Math.max(1, Math.ceil(dw), Math.ceil(dh)));
    const cw = Math.max(1, Math.ceil(dw * k)), ch = Math.max(1, Math.ceil(dh * k));
    {
      const s = scratchAt(cw, ch);
      try {
        s.imageSmoothingQuality = 'high';
        s.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
        if (mimg) {
          s.globalCompositeOperation = 'destination-in';
          s.drawImage(mimg, 0, 0, cw, ch);
          s.globalCompositeOperation = 'source-over';
        }
        if (wantsFx) {
          // The piece is exactly cw×ch of a bigger canvas, so hand the effects
          // a tight copy rather than the whole scratch.
          drawFx(ctx, cropCanvas(scratch, cw, ch), fx, dw, dh, alpha);
        } else {
          ctx.drawImage(scratch, 0, 0, cw, ch, -dw / 2, -dh / 2, dw, dh);
        }
        ctx.restore();
        return;
      } catch { /* frame not ready — fall through to the plain draw */ }
    }
  }

  /*
   * A soft backdrop (the blurred fill behind a vertical layout): the picture
   * is shrunk to a few dozen pixels and stretched back up, which blurs it for
   * almost nothing, then darkened so what sits on it reads.
   */
  if (clip.backdrop) {
    try {
      const bw = 40, bh = Math.max(4, Math.round(40 * dh / Math.max(1, dw)));
      const bc = softBackdrop(src, sx, sy, sw, sh, bw, bh);
      ctx.drawImage(bc, 0, 0, bw, bh, -dw / 2, -dh / 2, dw, dh);
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(0.85, clip.backdrop))})`;
      ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
    } catch { /* frame not ready */ }
    ctx.restore();
    return;
  }

  try {
    // Nine-argument form: take only the cropped rectangle out of the source.
    // An uncropped clip passes the whole frame, so there is one code path.
    ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  } catch { /* frame not ready */ }
  ctx.restore();
}

let backdropCanvas = null;
function backdropAt(w, h) {
  if (!backdropCanvas) backdropCanvas = document.createElement('canvas');
  if (backdropCanvas.width !== w || backdropCanvas.height !== h) { backdropCanvas.width = w; backdropCanvas.height = h; }
  return backdropCanvas.getContext('2d');
}

/**
 * The picture as a 40-pixel-wide smear, for the blurred fill behind a vertical layout.
 *
 * It used to be drawn straight from the full-size frame onto a 40-pixel canvas.
 * Measured on a real export (qa/export-bench.mjs, --scene vblur against vcover),
 * the blurred background alone cost about 14 ms a frame, more than decoding the
 * footage. The suspected cause: Chromium keeps canvases that small on the
 * processor rather than giving them a graphics-card surface, so every frame the
 * whole 1080p picture was read BACK from the graphics card just to be shrunk.
 *
 * So it takes two steps. The first shrinks on the graphics card to a canvas big
 * enough to stay there (at least 130×130 pixels); the second shrinks that one to
 * the 40 pixels, which then reads back a few dozen kilobytes instead of eight
 * megabytes. The picture it ends up with is the same smear.
 *
 * NOT YET MEASURED after the change: re-run the same two scenes. If vblur does
 * not move, the cause is something else and this is just two cheap draws.
 */
let midCanvas = null;
function softBackdrop(src, sx, sy, sw, sh, bw, bh) {
  // Test switch, never set by the app: qa/speed-test.mjs turns it on to time the old one-step shrink.
  if (globalThis.__strikeLegacyBackdrop) {
    const old = backdropAt(bw, bh);
    old.imageSmoothingQuality = 'high';
    old.drawImage(src, sx, sy, sw, sh, 0, 0, bw, bh);
    return old.canvas;
  }
  const mw =Math.max(130, Math.round(Math.sqrt(24000 * sw / Math.max(1, sh))));
  const mh = Math.max(130, Math.round(mw * sh / Math.max(1, sw)));
  if (!midCanvas) midCanvas = document.createElement('canvas');
  if (midCanvas.width !== mw || midCanvas.height !== mh) { midCanvas.width = mw; midCanvas.height = mh; }
  const m = midCanvas.getContext('2d');
  m.imageSmoothingQuality = 'high';
  m.drawImage(src, sx, sy, sw, sh, 0, 0, mw, mh);
  const b = backdropAt(bw, bh);
  b.imageSmoothingQuality = 'high';
  b.drawImage(midCanvas, 0, 0, mw, mh, 0, 0, bw, bh);
  return b.canvas;
}

/**
 * The top-left w×h of a scratch canvas, as a canvas of exactly that size.
 *
 * The effects code measures its input, and a scratch canvas is deliberately
 * bigger than what is in it — handing that over would put the layer in the
 * corner of a much larger transparent rectangle and throw every offset out.
 */
let tight = null;
function cropCanvas(from, w, h) {
  if (!tight) tight = document.createElement('canvas');
  if (tight.width !== w || tight.height !== h) { tight.width = w; tight.height = h; }
  const c = tight.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.drawImage(from, 0, 0, w, h, 0, 0, w, h);
  return tight;
}

/**
 * Ring, arrow, spotlight and hide: the "point at it" shapes.
 *   ring:  an outline round the box (s.stroke = thickness, fraction of the short edge), with a soft pulse
 *   arrow: a bobbing arrow above the box, pointing down at it
 *   spot:  everything outside the box goes dark (s.dark 0..1), with a soft edge
 *   hide:  what is inside the box is pixelated (s.blocks = how many blocks across)
 * `local` is seconds into the clip, for the little movements.
 */
let hideCv = null;
function drawMarker(ctx, s, x, y, w, h, W, H, local, alpha) {
  const S = Math.min(W, H);
  const col = s.fill && typeof s.fill === 'string' ? s.fill : '#C6FF3D';
  ctx.save();
  ctx.globalAlpha = alpha;
  if (s.kind === 'ring') {
    const pulse = s.pulse === false ? 1 : 1 + 0.035 * Math.sin(local * Math.PI * 2 * 1.2);
    const lw = Math.max(2, (s.stroke ?? 0.008) * S);
    ctx.lineWidth = lw;
    ctx.strokeStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = lw * 2.2;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(2, w / 2 * pulse), Math.max(2, h / 2 * pulse), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.kind === 'arrow') {
    const size = Math.max(S * 0.045, Math.min(S * 0.12, Math.max(w, h) * 0.55));
    const bob = Math.sin(local * Math.PI * 2 * 1.4) * size * 0.12;
    const tip = y - h / 2 - S * 0.012 + bob;
    ctx.translate(x, tip);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size * 0.5, -size * 0.55);
    ctx.lineTo(-size * 0.18, -size * 0.55);
    ctx.lineTo(-size * 0.18, -size * 1.15);
    ctx.lineTo(size * 0.18, -size * 1.15);
    ctx.lineTo(size * 0.18, -size * 0.55);
    ctx.lineTo(size * 0.5, -size * 0.55);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.strokeStyle = '#06080F';
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fill();
  } else if (s.kind === 'spot') {
    const dark = Math.max(0, Math.min(1, s.dark ?? 0.72));
    const rx = Math.max(4, w / 2), ry = Math.max(4, h / 2);
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, rx, 0, 0, rx * (1 + (s.soft ?? 0.45)));
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${dark})`);
    ctx.fillStyle = g;
    const far = (W + H) * 2 * Math.max(1, rx / ry);
    ctx.fillRect(-far, -far * rx / ry, far * 2, far * 2 * rx / ry);
  } else if (s.kind === 'hide') {
    // Pixelate what is already drawn under the box.
    const bx = Math.max(0, Math.floor(x - w / 2)), by = Math.max(0, Math.floor(y - h / 2));
    const bw = Math.min(W - bx, Math.ceil(w)), bh = Math.min(H - by, Math.ceil(h));
    if (bw > 2 && bh > 2) {
      const n = Math.max(3, Math.round(s.blocks ?? 9));
      const cw = n, ch = Math.max(2, Math.round(n * bh / bw));
      hideCv ||= document.createElement('canvas');
      if (hideCv.width !== cw || hideCv.height !== ch) { hideCv.width = cw; hideCv.height = ch; }
      const hc = hideCv.getContext('2d');
      hc.imageSmoothingEnabled = true;
      hc.drawImage(ctx.canvas, bx, by, bw, bh, 0, 0, cw, ch);
      ctx.beginPath();
      if (s.round !== false) ctx.ellipse(x, y, bw / 2, bh / 2, 0, 0, Math.PI * 2); else ctx.rect(bx, by, bw, bh);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(hideCv, 0, 0, cw, ch, bx, by, bw, bh);
    }
  }
  ctx.restore();
}

/** Solid / gradient shape layer — used for lower thirds, bars, letterboxes. */
export function drawShapeClip(ctx, clip, W, H, t, alpha) {
  const s = clip.shape || {};
  const x = evalProp(clip, 'transform.x', t) * W;
  const y = evalProp(clip, 'transform.y', t) * H;
  const w = evalProp(clip, 'transform.w', t) * W * evalProp(clip, 'transform.scale', t);
  const h = evalProp(clip, 'transform.h', t) * H * evalProp(clip, 'transform.scale', t);
  const rot = evalProp(clip, 'transform.rotation', t) * Math.PI / 180;

  // Pointers and highlights (most often stuck to something tracked, see stick.js).
  if (s.kind === 'ring' || s.kind === 'arrow' || s.kind === 'spot' || s.kind === 'hide') {
    drawMarker(ctx, s, x, y, w, h, W, H, t - clip.start, alpha);
    return;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);

  if (Array.isArray(s.fill)) {
    const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    s.fill.forEach((c, i) => g.addColorStop(i / Math.max(1, s.fill.length - 1), c));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = s.fill || '#2563eb';
  }

  if (s.kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    roundRect(ctx, -w / 2, -h / 2, w, h, (s.radius || 0) * H);
    ctx.fill();
  }
  ctx.restore();
}
