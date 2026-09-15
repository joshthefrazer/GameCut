/**
 * Looks for a picture layer — glow, shadow, sticker outline, rounded corners,
 * tint, and a fake third dimension.
 *
 * This exists because "graphics" in a gaming edit is almost never just an image
 * dropped on the frame. It is a logo with a glow behind it, a cut-out with a
 * white sticker edge, a panel tilted a few degrees so it sits in the scene. All
 * of that is achievable with Canvas2D if you are willing to be careful about
 * how many times the picture is touched per frame, which is what this file is.
 *
 * ── The one rule ───────────────────────────────────────────────
 * Every effect is drawn from a SILHOUETTE — a solid-colour copy of the layer's
 * own alpha — rather than from the picture. That is what makes a glow follow
 * the shape of a cut-out PNG instead of sitting in a rectangle around it, and
 * it is the difference between this looking like a design tool and looking like
 * a border.
 *
 * ── Cost ───────────────────────────────────────────────────────
 * Canvas `shadowBlur` is a real blur and it is not free, but it is done once
 * per layer per frame on a canvas the size of the layer — not the size of the
 * window, and never on something re-rasterised as things move behind it. A
 * couple of glowing graphics costs a fraction of a millisecond; the editor's
 * old sin was full-window `backdrop-filter`, which is a different thing
 * entirely. Layers with no effects set never enter this file at all.
 */

export const defaultFx = () => ({
  radius: 0,          // corner rounding, fraction of the layer's short side
  glow: 0,            // 0..1 → blur size
  glowColor: '#38bdf8',
  glowStrength: 1,    // how many passes' worth of intensity, 0..2
  shadow: 0,          // 0..1 → blur size
  shadowColor: '#000000',
  shadowX: 0,
  shadowY: 0.03,      // fraction of the layer's short side
  outline: 0,         // sticker edge, fraction of the short side
  outlineColor: '#ffffff',
  tint: '#22d3ee',
  tintAmount: 0,      // 0..1
  tiltX: 0,           // degrees — top/bottom lean
  tiltY: 0,           // degrees — left/right lean
  depth: 0,           // 0..1 → extruded thickness under a tilted layer
});

/** Is there anything here worth the extra canvases? */
export function fxActive(fx) {
  if (!fx) return false;
  return !!(fx.radius || fx.glow || fx.shadow || fx.outline
    || (fx.tintAmount > 0) || fx.tiltX || fx.tiltY || fx.depth);
}

/* ── Scratch canvases ─────────────────────────────────────────
   A fixed set, grown to fit and reused. Allocating canvases inside a
   render loop is how a smooth editor becomes a stuttering one, and the
   garbage collector makes it stutter at random moments rather than
   predictable ones, which is worse. */
const pool = new Map();
function scratch(key, w, h) {
  let c = pool.get(key);
  if (!c) { c = document.createElement('canvas'); pool.set(key, c); }
  const W = Math.max(1, Math.ceil(w)), H = Math.max(1, Math.ceil(h));
  if (c.width < W || c.height < H) {
    c.width = Math.max(c.width, W);
    c.height = Math.max(c.height, H);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.clearRect(0, 0, c.width, c.height);
  return { c, ctx };
}

/** Rounded-rectangle path. Radius is clamped so it can never fold inside out. */
export function roundedPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * A solid-colour copy of a layer's alpha.
 *
 * `source-in` keeps the fill only where the source already had pixels, which is
 * the whole trick: a PNG of a mascot comes back as a mascot-shaped block of one
 * colour, ready to be blurred into a glow or offset into an outline.
 *
 * ── Why every draw in this file names its source rectangle ─────
 * Scratch canvases are grown to fit and never shrunk, so one is almost always
 * bigger than the picture inside it. `drawImage(c, x, y, w, h)` scales the
 * WHOLE canvas into w×h, which quietly shrinks the layer to a fraction of its
 * size — the effect still draws, still looks like something, and is wrong. The
 * nine-argument form says which part of the source is meant, and that is the
 * only form used here.
 */
function silhouette(src, sw, sh, w, h, colour, key = 'sil') {
  const { c, ctx } = scratch(key, w, h);
  ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * Draw one layer with its effects, centred on the current origin.
 *
 * `piece` is the finished picture — already cropped, already masked, already
 * the right size. Everything here is about what surrounds it.
 *
 * @param ctx    destination
 * @param piece  a canvas or image holding the layer, drawn at its natural size
 * @param fx     the effect block
 * @param dw,dh  how big to draw it, in destination pixels
 * @param alpha  the layer's own opacity
 */
export function drawFx(ctx, piece, fx, dw, dh, alpha = 1) {
  const short = Math.min(dw, dh);
  const pad = Math.ceil(
    Math.max(
      (fx.glow || 0) * short * 1.6,
      (fx.shadow || 0) * short * 1.6 + Math.abs((fx.shadowY || 0) * short) + Math.abs((fx.shadowX || 0) * short),
      (fx.outline || 0) * short * 2.2,
    ) + 2,
  );

  const W = dw + pad * 2, H = dh + pad * 2;
  // Beyond this the layer is so magnified that the effect canvases would cost
  // more than the picture. Skipping the effects beats dropping the frame.
  if (W > 6000 || H > 6000) { plain(ctx, piece, dw, dh, alpha, fx); return; }

  const { c: out, ctx: o } = scratch('fx', W, H);

  /* Rounded corners are cut into the piece itself, so every effect below
     follows the rounded shape rather than the original rectangle. */
  let shaped = piece;
  if (fx.radius > 0) {
    const { c: rc, ctx: r } = scratch('round', dw, dh);
    roundedPath(r, 0, 0, dw, dh, fx.radius * short);
    r.clip();
    r.drawImage(piece, 0, 0, dw, dh);
    shaped = rc;
  }
  // A shaped copy is bigger than the piece it came from; draw only the part
  // that matters.
  const sw = shaped === piece ? piece.width : dw;
  const sh = shaped === piece ? piece.height : dh;

  /*
   * ── Shadow and glow ─────────────────────────────────────────
   *
   * Both are canvas shadows cast by the silhouette. The silhouette itself must
   * not appear — a hard black shape sitting under a soft one is exactly what a
   * bad drop shadow looks like — so it is drawn well off the left edge and the
   * shadow is pushed back by the same distance.
   *
   * Getting that second half wrong is silent: the silhouette vanishes as
   * intended and so does the shadow, and the effect simply does nothing. It did
   * exactly that until a test counted the lit pixels outside the layer.
   */
  const OFF = W * 3;

  if (fx.shadow > 0) {
    const sil = silhouette(shaped, sw, sh, dw, dh, fx.shadowColor || '#000', 'silS');
    o.save();
    o.globalAlpha = 0.85;
    o.shadowColor = fx.shadowColor || '#000';
    o.shadowBlur = fx.shadow * short;
    o.shadowOffsetX = (fx.shadowX || 0) * short + OFF;
    o.shadowOffsetY = (fx.shadowY || 0) * short;
    o.drawImage(sil, 0, 0, dw, dh, pad - OFF, pad, dw, dh);
    o.restore();
  }

  if (fx.glow > 0) {
    const sil = silhouette(shaped, sw, sh, dw, dh, fx.glowColor || '#38bdf8', 'silG');
    const passes = Math.max(1, Math.round(1 + (fx.glowStrength ?? 1)));
    o.save();
    o.shadowColor = fx.glowColor || '#38bdf8';
    o.shadowBlur = fx.glow * short;
    o.shadowOffsetX = OFF;
    o.globalAlpha = Math.min(1, 0.55 * (fx.glowStrength ?? 1));
    for (let i = 0; i < passes; i++) {
      o.drawImage(sil, 0, 0, dw, dh, pad - OFF, pad, dw, dh);
    }
    o.restore();
  }

  /* ── Sticker outline ──────────────────────────────────────── */
  if (fx.outline > 0) {
    const t = fx.outline * short;
    const sil = silhouette(shaped, sw, sh, dw, dh, fx.outlineColor || '#fff', 'silO');
    o.save();
    // Sixteen offsets rather than eight: at any useful thickness eight leaves
    // visible flats on diagonals, and the extra draws are of a small canvas.
    const N = 16;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      o.drawImage(sil, 0, 0, dw, dh,
        pad + Math.cos(a) * t, pad + Math.sin(a) * t, dw, dh);
    }
    o.restore();
  }

  /* ── The picture ──────────────────────────────────────────── */
  o.drawImage(shaped, 0, 0, sw, sh, pad, pad, dw, dh);

  /* ── Tint, over the picture only ──────────────────────────── */
  if (fx.tintAmount > 0) {
    o.save();
    // `source-atop` paints only where the composite already has pixels, so the
    // colour never bleeds past the layer's own shape.
    o.globalCompositeOperation = 'source-atop';
    o.globalAlpha = Math.min(1, fx.tintAmount);
    o.fillStyle = fx.tint || '#22d3ee';
    o.fillRect(pad, pad, dw, dh);
    o.restore();
  }

  /* ── Onto the frame, tilted if asked ──────────────────────── */
  ctx.save();
  ctx.globalAlpha = alpha;
  if (fx.tiltX || fx.tiltY) {
    drawTilted(ctx, out, W, H, -W / 2, -H / 2, fx);   // out's meaningful area is W×H
  } else {
    ctx.drawImage(out, 0, 0, W, H, -W / 2, -H / 2, W, H);
  }
  ctx.restore();
}

/** No effects worth a detour — but still honour opacity. */
function plain(ctx, piece, dw, dh, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(piece, 0, 0, piece.width, piece.height, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

/**
 * Fake perspective.
 *
 * Canvas2D can only do affine transforms, which means it can shear a picture
 * but not make one edge genuinely smaller than the other. So the layer is cut
 * into thin strips and each strip is drawn at its own scale and offset — the
 * far edge's strips are shorter and closer together, the near edge's are taller
 * and wider apart, and the result is a real vanishing point.
 *
 * Strips are drawn with a one-pixel overlap. Without it the seams show as a fine
 * comb of background colour, which is the giveaway that ruins the illusion.
 */
function drawTilted(ctx, img, w, h, x, y, fx) {
  // w,h are both how big to draw it AND which part of `img` means anything —
  // the scratch canvas behind it is larger. Slicing the whole canvas instead
  // squeezes the layer into a corner, which looks like a tilt gone wrong rather
  // than like a bug, and is why this is spelled out.
  const ax = (fx.tiltX || 0) * Math.PI / 180;   // lean about the horizontal axis
  const ay = (fx.tiltY || 0) * Math.PI / 180;   // lean about the vertical axis

  const N = 48;
  const persp = 0.8;                             // how strong the foreshortening reads

  /*
   * Depth: an extruded slab under the layer.
   *
   * It has to be the layer's own SHAPE, repeated backwards — a star gets a
   * star-shaped slab. Filling the bounding box instead gives a dark rectangle
   * hanging behind a cut-out, which is not "thickness", it is a mistake that
   * happens to be tilted correctly.
   */
  if (fx.depth > 0) {
    const d = fx.depth * Math.min(w, h) * 0.55;
    const steps = Math.max(3, Math.min(20, Math.round(d / 1.5)));
    const dark = silhouette(img, w, h, w, h, '#070d18', 'silD');
    const base = ctx.globalAlpha || 1;
    for (let i = steps; i >= 1; i--) {
      const k = i / steps;
      ctx.save();
      ctx.translate(Math.sin(ay) * d * k, Math.sin(ax) * -d * k);
      // Nearer slices a little darker, so the slab has a direction to it.
      ctx.globalAlpha = base * (0.5 + 0.5 * (1 - k));
      strips(ctx, dark, w, h, x, y, N, ax, ay, persp, null);
      ctx.restore();
    }
    ctx.globalAlpha = base;
  }

  strips(ctx, img, w, h, x, y, N, ax, ay, persp, null);
}

/**
 * Where each strip starts and how wide it is, 0..1 along the layer.
 *
 * Strips are not evenly spaced under perspective — the far ones bunch up. The
 * widths are summed and normalised so the layer stays exactly its original size
 * however hard it is tilted, which is what stops a tilt from also looking like
 * a resize. Computed once per draw rather than once per strip.
 */
function spans(N, angle, persp) {
  const w = new Float64Array(N);
  let total = 0;
  for (let k = 0; k < N; k++) {
    const u = (k + 0.5) / N - 0.5;
    w[k] = 1 / (1 + Math.sin(angle) * persp * (u * 2));
    total += w[k];
  }
  const starts = new Float64Array(N + 1);
  for (let k = 0; k < N; k++) starts[k + 1] = starts[k] + w[k] / total;
  return starts;
}

function strips(ctx, img, w, h, x, y, N, ax, ay, persp, flatColour) {
  const vertical = Math.abs(ay) >= Math.abs(ax);
  const angle = vertical ? ay : ax;
  const at = spans(N, angle, persp);

  if (vertical) {
    const sw = w / N;                            // source strip, in `img` pixels
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N - 0.5;
      const depth = 1 + Math.sin(ay) * persp * (u * 2);
      const sh = h / depth;
      const dx = x + w * at[i];
      const dw = w * (at[i + 1] - at[i]) + 1;   // +1: overlap, or the seams comb
      const dy = y + (h - sh) / 2;
      if (flatColour) {
        ctx.fillStyle = flatColour;
        ctx.fillRect(dx, dy, dw, sh);
      } else {
        ctx.drawImage(img, i * sw, 0, sw, h, dx, dy, dw, sh);
      }
    }
    return;
  }

  const sh = h / N;
  for (let i = 0; i < N; i++) {
    const v = (i + 0.5) / N - 0.5;
    const depth = 1 + Math.sin(ax) * persp * (v * 2);
    const dwid = w / depth;
    const dy = y + h * at[i];
    const dh = h * (at[i + 1] - at[i]) + 1;
    const dx = x + (w - dwid) / 2;
    if (flatColour) {
      ctx.fillStyle = flatColour;
      ctx.fillRect(dx, dy, dwid, dh);
    } else {
      ctx.drawImage(img, 0, i * sh, w, sh, dx, dy, dwid, dh);
    }
  }
}
