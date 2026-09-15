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
export function sourceRect(clip, src) {
  const fw = src?.videoWidth || src?.naturalWidth || 0;
  const fh = src?.videoHeight || src?.naturalHeight || 0;
  const c = clip.crop;
  if (!c || !fw || !fh) return { sx: 0, sy: 0, sw: fw, sh: fh };
  const sw = Math.max(1, Math.round(c.w * fw));
  const sh = Math.max(1, Math.round(c.h * fh));
  return {
    sx: Math.min(fw - sw, Math.max(0, Math.round(c.x * fw))),
    sy: Math.min(fh - sh, Math.max(0, Math.round(c.y * fh))),
    sw, sh,
  };
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
  const { sx, sy, sw, sh } = sourceRect(clip, src);
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
    const fw = src.videoWidth || src.naturalWidth || sw;
    const fh = src.videoHeight || src.naturalHeight || sh;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const u = (pts[i][0] * fw - sx) / sw;
      const v = (pts[i][1] * fh - sy) / sh;
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
    const cw = Math.max(1, Math.ceil(dw)), ch = Math.max(1, Math.ceil(dh));
    // Absurd sizes come from a layer scaled up 20×; building a 30k-pixel canvas
    // would hang the frame, and falling back to the plain picture is a far
    // better failure than a stall.
    if (cw <= 8192 && ch <= 8192) {
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

  try {
    // Nine-argument form: take only the cropped rectangle out of the source.
    // An uncropped clip passes the whole frame, so there is one code path.
    ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  } catch { /* frame not ready */ }
  ctx.restore();
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

/** Solid / gradient shape layer — used for lower thirds, bars, letterboxes. */
export function drawShapeClip(ctx, clip, W, H, t, alpha) {
  const s = clip.shape || {};
  const x = evalProp(clip, 'transform.x', t) * W;
  const y = evalProp(clip, 'transform.y', t) * H;
  const w = evalProp(clip, 'transform.w', t) * W * evalProp(clip, 'transform.scale', t);
  const h = evalProp(clip, 'transform.h', t) * H * evalProp(clip, 'transform.scale', t);
  const rot = evalProp(clip, 'transform.rotation', t) * Math.PI / 180;

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
