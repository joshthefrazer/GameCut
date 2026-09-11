import { fontShorthand } from '../../media/fonts.js';
import { evalProp } from '../keyframes.js';

/**
 * Canvas2D text renderer.
 *
 * Paint order is stroke, then fill, so an outline never eats the glyph
 * interior. Glow and shadow are separate passes for the same reason: a glow is
 * centred and coloured, a shadow is offset and dark, and drawing them together
 * makes a smear rather than either.
 *
 * Type is sized against the frame's SHORT edge, so a title composed at 1080p
 * lands identically at 4K and keeps its optical size when the project is
 * reframed 16:9 -> 9:16, instead of ballooning past the safe area.
 */
export const shortEdge = (W, H) => Math.min(W, H);

/**
 * How far into its entrance a clip is, 0..1.
 *
 * Entrances are a named move rather than keyframes on purpose. A person picking
 * "Pop" wants the look, not five keyframes to later discover and unpick; and
 * because it is only a name, changing or removing it is one click. Anyone who
 * wants to hand-animate still can — the keyframe system is untouched and layers
 * on top of this.
 */
function entrance(clip, t) {
  const s = clip.text;
  const kind = s.anim || 'none';
  if (kind === 'none') return null;
  const dur = Math.max(0.05, s.animDur || 0.35);
  const p = Math.max(0, Math.min(1, (t - clip.start) / dur));
  return { kind, p, done: p >= 1 };
}

const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeBack = (p) => {
  const c = 1.70158 + 1;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

export function measureText(ctx, clip, W, H, t = clip.start) {
  const s = clip.text;
  const px = Math.max(4, evalProp(clip, 'text.size', t) * shortEdge(W, H));
  ctx.font = fontShorthand(s, px);
  const maxW = Math.max(0.05, clip.transform.w) * W;
  const lines = wrap(ctx, visibleText(clip, t), maxW, s.letterSpacing * px);
  const lineH = px * (s.lineHeight || 1.15);
  let widest = 0;
  for (const l of lines) widest = Math.max(widest, lineWidth(ctx, l, s.letterSpacing * px));
  return { px, lines, lineH, width: widest, height: lineH * lines.length };
}

/**
 * The characters on screen at time `t`.
 *
 * Only the typewriter entrance changes this. It slices the string rather than
 * fading letters, because a half-faded letter reads as a rendering fault while
 * a missing one reads as typing.
 */
function visibleText(clip, t) {
  const full = String(clip.text.text ?? '');
  const e = entrance(clip, t);
  if (!e || e.kind !== 'type' || e.done) return full;
  const n = Math.ceil(full.length * e.p);
  return full.slice(0, n);
}

export function drawTextClip(ctx, clip, W, H, t, alpha) {
  const s = clip.text;
  if (!s) return;
  const m = measureText(ctx, clip, W, H, t);
  const S = shortEdge(W, H);

  const x = evalProp(clip, 'transform.x', t) * W;
  const y = evalProp(clip, 'transform.y', t) * H;
  let scale = evalProp(clip, 'transform.scale', t);
  const rot = evalProp(clip, 'transform.rotation', t) * Math.PI / 180;

  // Apply the entrance on top of whatever the transform already says, so a
  // hand-keyframed move and a named entrance compose instead of fighting.
  let dy = 0;
  const e = entrance(clip, t);
  if (e && !e.done) {
    if (e.kind === 'pop')   { scale *= 0.6 + 0.4 * easeBack(e.p); alpha *= Math.min(1, e.p * 3); }
    if (e.kind === 'rise')  { dy = (1 - easeOut(e.p)) * m.lineH * 1.1; alpha *= easeOut(e.p); }
    if (e.kind === 'fade')  { alpha *= easeOut(e.p); }
    if (e.kind === 'slam')  { scale *= 1 + (1 - easeOut(e.p)) * 1.6; alpha *= Math.min(1, e.p * 4); }
  }
  if (alpha <= 0.002) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y + dy);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  /* ── Plate ─────────────────────────────────────────────────── */
  const bg = plateKind(s);
  if (bg !== 'none' && m.lines.some(l => l.length)) {
    const pad = (s.bgPad || 0) * S;
    const bw = m.width + pad * 2;
    const bh = m.height + pad * 1.4;
    const r = bg === 'pill' ? bh / 2 : Math.min(bh / 2, (s.bgRadius ?? 0.25) * bh);
    ctx.fillStyle = s.bgColor || '#000000cc';
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, r);
    ctx.fill();
  }

  const top = -m.height / 2 + m.lineH / 2;
  const strokeW = evalProp(clip, 'text.strokeWidth', t) * m.px;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const paint = (fn) => {
    m.lines.forEach((line, i) => {
      const ly = top + i * m.lineH;
      const lx = alignOffset(s.align, m, lineWidth(ctx, line, s.letterSpacing * m.px));
      fn(line, lx, ly);
    });
  };

  /* ── Glow ──────────────────────────────────────────────────────
     Its own pass, drawn beneath everything. Canvas shadows are cheap
     but weak, so the pass is repeated to build the intensity a neon
     caption needs without a blur filter anywhere near the frame. */
  const glow = evalProp(clip, 'text.glow', t);
  if (glow > 0) {
    ctx.save();
    ctx.shadowColor = s.glowColor || '#38bdf8';
    ctx.shadowBlur = glow * S;
    ctx.fillStyle = s.glowColor || '#38bdf8';
    for (let pass = 0; pass < 3; pass++) {
      paint((line, lx, ly) => drawLine(ctx, line, lx, ly, s.letterSpacing * m.px, 'fill'));
    }
    ctx.restore();
  }

  /* ── Shadow, carried by the stroke or the fill, never both ─── */
  const shadow = evalProp(clip, 'text.shadow', t);
  if (shadow > 0) {
    ctx.shadowColor = s.shadowColor || '#000';
    ctx.shadowBlur = shadow * S;
    ctx.shadowOffsetX = (s.shadowX || 0) * S;
    ctx.shadowOffsetY = (s.shadowY || 0) * S;
  }

  if (strokeW > 0) {
    ctx.lineWidth = strokeW * 2;         // half sits inside the glyph
    ctx.strokeStyle = s.strokeColor || '#000';
    paint((line, lx, ly) => drawLine(ctx, line, lx, ly, s.letterSpacing * m.px, 'stroke'));
    ctx.shadowBlur = 0;                  // the outline already cast it
    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  }

  ctx.fillStyle = fillStyle(ctx, s, m);
  paint((line, lx, ly) => drawLine(ctx, line, lx, ly, s.letterSpacing * m.px, 'fill'));

  ctx.restore();
}

/* ── helpers ──────────────────────────────────────────────────── */

/**
 * Older clips said "no plate" by giving bgColor a fully transparent value.
 * Projects made before `bg` existed still have to open correctly, so the
 * absence of the field is read from the colour the way it used to be.
 */
function plateKind(s) {
  if (s.bg) return s.bg;
  const c = String(s.bgColor || '');
  return /^#[0-9a-f]{6}00$/i.test(c) || !c ? 'none' : 'box';
}

function fillStyle(ctx, s, m) {
  if (s.fill !== 'gradient') return s.color || '#fff';
  const a = ((s.gradAngle ?? 90) * Math.PI) / 180;
  // Span the gradient across the text's own box, so it looks the same whatever
  // the words are — not across the whole frame, where short text gets a sliver.
  const r = Math.max(m.width, m.height) / 2;
  const g = ctx.createLinearGradient(
    -Math.cos(a) * r, -Math.sin(a) * r, Math.cos(a) * r, Math.sin(a) * r);
  g.addColorStop(0, s.color || '#ffffff');
  g.addColorStop(1, s.color2 || '#38bdf8');
  return g;
}

function alignOffset(align, m, w) {
  if (align === 'left')  return -m.width / 2 + w / 2;
  if (align === 'right') return  m.width / 2 - w / 2;
  return 0;
}

function lineWidth(ctx, str, spacing) {
  if (!spacing) return ctx.measureText(str).width;
  let w = 0;
  for (const ch of str) w += ctx.measureText(ch).width + spacing;
  return w - spacing;
}

function drawLine(ctx, str, cx, cy, spacing, mode) {
  if (!spacing) { mode === 'fill' ? ctx.fillText(str, cx, cy) : ctx.strokeText(str, cx, cy); return; }
  let x = cx - lineWidth(ctx, str, spacing) / 2;
  ctx.textAlign = 'left';
  for (const ch of str) {
    mode === 'fill' ? ctx.fillText(ch, x, cy) : ctx.strokeText(ch, x, cy);
    x += ctx.measureText(ch).width + spacing;
  }
  ctx.textAlign = 'center';
}

function wrap(ctx, text, maxW, spacing) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (lineWidth(ctx, test, spacing) > maxW && line) { out.push(line); line = w; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
