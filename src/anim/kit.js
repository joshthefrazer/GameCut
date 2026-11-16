/**
 * Drawing kit for Strike's animation library.
 *
 * Every animation draws into a virtual box 1000 units wide (its height comes
 * from its own shape), so the same drawing works at any size, in the preview,
 * in a library thumbnail and in a 4K export. Time is the clip's own clock in
 * seconds; `phase()` turns it into "how far in", "how far out".
 */

export const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export const ease = {
  out: (t) => 1 - Math.pow(1 - clamp01(t), 3),
  in: (t) => Math.pow(clamp01(t), 3),
  inOut: (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
  back: (t) => { t = clamp01(t); const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  elastic: (t) => { t = clamp01(t); if (t === 0 || t === 1) return t; return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1; },
  slam: (t) => { t = clamp01(t); return t < 0.7 ? 1 - Math.pow(1 - t / 0.7, 4) : 1 + Math.sin((t - 0.7) / 0.3 * Math.PI) * 0.04; },
};

/**
 * Where an animation is in its life.
 *   pin   0→1 while it arrives
 *   pout  0→1 while it leaves (0 until then)
 *   hold  seconds since it finished arriving
 */
export function phase(t, dur, inDur = 0.4, outDur = 0.3) {
  const i = Math.min(inDur, dur * 0.45), o = Math.min(outDur, dur * 0.4);
  return {
    pin: clamp01(t / Math.max(0.001, i)),
    pout: clamp01((t - (dur - o)) / Math.max(0.001, o)),
    hold: Math.max(0, t - i),
    t, dur,
  };
}

export function rr(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const FONT_DISPLAY = '"Unbounded", "Inter", system-ui, sans-serif';
export const FONT_UI = '"Inter", system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

/**
 * Text with an optional outline, shadow and glow — the look every gaming
 * title wants. Returns the measured width.
 */
export function text(ctx, str, x, y, { size = 80, font = FONT_DISPLAY, weight = 900, color = '#fff', stroke = null,
  strokeW = 0, glow = null, glowR = 0, shadow = null, align = 'center', base = 'middle', italic = false, spacing = 0, maxW = 0 } = {}) {
  ctx.save();
  let px = size;
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${px}px ${font}`;
  if (maxW) {
    const w = ctx.measureText(str).width;
    if (w > maxW) { px = size * maxW / w; ctx.font = `${italic ? 'italic ' : ''}${weight} ${px}px ${font}`; }
  }
  ctx.textAlign = align; ctx.textBaseline = base;
  if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = `${spacing * px}px`;
  ctx.lineJoin = 'round';
  if (glow && glowR) { ctx.shadowColor = glow; ctx.shadowBlur = glowR; ctx.fillStyle = glow; ctx.fillText(str, x, y); ctx.shadowBlur = 0; }
  if (shadow) { ctx.fillStyle = shadow; ctx.fillText(str, x, y + px * 0.08); }
  if (stroke && strokeW) { ctx.strokeStyle = stroke; ctx.lineWidth = strokeW * 2; ctx.strokeText(str, x, y); }
  ctx.fillStyle = color; ctx.fillText(str, x, y);
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

/** A tiny seeded random, so particles land the same way every frame. */
export function rng(seed) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

/** Sparks flying out from (cx, cy). `p` is 0→1 over their life. */
export function burst(ctx, cx, cy, p, { n = 14, r0 = 40, r1 = 300, color = '#C6FF3D', w = 10, seed = 3 } = {}) {
  if (p <= 0 || p >= 1) return;
  const R = rng(seed);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.4;
    const len = 0.5 + R() * 0.5;
    const d0 = lerp(r0, r1 * len, ease.out(p)), d1 = lerp(r0, r1 * len, ease.out(Math.max(0, p - 0.18)));
    ctx.globalAlpha *= 1;
    ctx.lineWidth = w * (1 - p);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * d1, cy + Math.sin(a) * d1);
    ctx.lineTo(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0);
    ctx.stroke();
  }
  ctx.restore();
}

/** An expanding ring — a shockwave. */
export function ring(ctx, cx, cy, p, { r0 = 50, r1 = 520, color = '#fff', w = 18 } = {}) {
  if (p <= 0 || p >= 1) return;
  ctx.save();
  ctx.globalAlpha *= 1 - p;
  ctx.strokeStyle = color; ctx.lineWidth = w * (1 - p * 0.7);
  ctx.beginPath(); ctx.arc(cx, cy, lerp(r0, r1, ease.out(p)), 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

/** A shine sweeping across a box (light glinting off a badge). */
export function shine(ctx, x, y, w, h, p) {
  if (p <= 0 || p >= 1) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const sx = lerp(x - w * 0.4, x + w * 1.2, p);
  const g = ctx.createLinearGradient(sx - h, y, sx + h * 0.2, y + h);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** Colour with alpha, from #rrggbb. */
export function rgba(hex, a) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Black or white, whichever reads on `hex`. */
export function ink(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.slice(0, 6), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#06080F' : '#FFFFFF';
}
