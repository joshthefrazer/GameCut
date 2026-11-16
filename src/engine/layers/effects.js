import { hash } from '../motion.js';

/**
 * Effect clips: moments you drop on the timeline that change everything
 * under them — a punch-in zoom on the crosshair, a screen shake on a hit, a
 * white flash on a kill, a glitch, a vignette, black and white.
 *
 * An effect is a clip of its own (type 'effect') on a picture lane, so it is
 * moved, trimmed, split and undone like any clip, and its length IS the
 * effect's length. It acts on whatever has been painted beneath it — lanes
 * lower in the list — and leaves text above it alone, which is what you want
 * for a shake that should not wobble your title. Nothing to keyframe: each
 * effect has one strength and shapes itself over its own length.
 */
export const EFFECTS = [
  { id: 'zoom',     name: 'Punch-in zoom', dur: 1.0,  note: 'Zooms fast onto a point, holds, eases back' },
  { id: 'shake',    name: 'Screen shake',  dur: 0.6,  note: 'A hit that rattles the picture, then settles' },
  { id: 'flash',    name: 'White flash',   dur: 0.35, note: 'A flash of white that fades out fast' },
  { id: 'glitch',   name: 'Glitch',        dur: 0.7,  note: 'Torn, jumping slices of picture' },
  { id: 'rgb',      name: 'RGB split',     dur: 0.6,  note: 'Colour channels pulled apart' },
  { id: 'vignette', name: 'Vignette',      dur: 3,    note: 'Darkens the edges to pull the eye in' },
  { id: 'bw',       name: 'Black & white', dur: 3,    note: 'Drains the colour' },
  { id: 'pop',      name: 'Colour pop',    dur: 3,    note: 'Richer colour and contrast' },
  { id: 'blur',     name: 'Blur',          dur: 2,    note: 'Soft focus, for behind a title' },
];

export const effectInfo = (kind) => EFFECTS.find(e => e.id === kind) || EFFECTS[0];

export const defaultEffect = (kind = 'zoom') => ({ kind, amount: 0.6, x: 0.5, y: 0.5 });

const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** How strong the effect is `t` seconds into the clip, 0..1. */
export function envelope(kind, local, dur, style = 'smooth') {
  const p = clamp01(local / Math.max(1e-3, dur));
  switch (kind) {
    case 'zoom': {
      /*
       * How a zoom moves (Smart Zoom's styles):
       *   smooth  glides in, holds, glides out (the original)
       *   snap    on the frame, eases back out
       *   bounce  overshoots on the way in, settles
       *   impact  snaps in; the shake is drawn by applyEffect
       */
      if (style === 'snap' || style === 'impact') {
        const att = 0.04, rel = Math.min(0.5, dur * 0.45);
        if (local < att) return local / att;
        if (local > dur - rel) return easeInOut(clamp01((dur - local) / rel));
        return 1;
      }
      if (style === 'bounce') {
        const att = Math.min(0.32, dur * 0.3), rel = Math.min(0.4, dur * 0.35);
        if (local < att) { const x = local / att, c = 2.2; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); }
        if (local > dur - rel) return easeInOut(clamp01((dur - local) / rel));
        return 1;
      }
      const att = Math.min(0.18, Math.max(0.06, dur * 0.15));
      const rel = Math.min(0.45, dur * 0.4);
      if (local < att) return easeOut(local / att);
      if (local > dur - rel) return easeInOut(clamp01((dur - local) / rel));
      return 1;
    }
    case 'shake': return Math.pow(1 - p, 1.4);
    case 'flash': return Math.pow(1 - p, 2.2);
    case 'glitch': case 'rgb': return local < dur - 0.08 ? 1 : clamp01((dur - local) / 0.08);
    default: {
      const ramp = Math.min(0.2, dur / 4);
      return Math.min(1, local / ramp, (dur - local) / ramp);
    }
  }
}

let scratch = null, sctx = null, tintA = null, tintB = null;
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function grab(canvas, W, H) {
  if (!scratch || scratch.width !== W || scratch.height !== H) { scratch = makeCanvas(W, H); sctx = scratch.getContext('2d'); }
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalCompositeOperation = 'copy';
  sctx.drawImage(canvas, 0, 0);
  sctx.globalCompositeOperation = 'source-over';
  return scratch;
}
function tinted(which, src, W, H, colour) {
  let c = which === 'a' ? tintA : tintB;
  if (!c || c.width !== W || c.height !== H) { c = makeCanvas(W, H); if (which === 'a') tintA = c; else tintB = c; }
  const g = c.getContext('2d');
  g.globalCompositeOperation = 'copy';
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = colour;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * Apply one effect to everything already on `ctx` (whose canvas is
 * `canvas`, W×H), at timeline time `t`.
 */
export function applyEffect(ctx, canvas, clip, t, W, H) {
  const e = clip.effect || defaultEffect();
  const amount = Math.max(0, Math.min(1, e.amount ?? 0.6));
  const local = t - clip.start;
  const env = envelope(e.kind, local, clip.duration, e.style) * amount;
  if (env <= 0.002) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  const S = Math.min(W, H);
  switch (e.kind) {
    case 'zoom': {
      const src = grab(canvas, W, H);
      const k = 1 + env * 0.9;
      const px = (e.x ?? 0.5) * W, py = (e.y ?? 0.5) * H;
      if (e.style === 'impact' && local < 0.35) {
        // A hit of shake as it lands, fading over a third of a second.
        const f = Math.floor(local * 50), fall = 1 - local / 0.35;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.translate((hash(f * 3 + 1) - 0.5) * S * 0.03 * fall, (hash(f * 5 + 7) - 0.5) * S * 0.03 * fall);
      }
      ctx.translate(px, py); ctx.scale(k, k); ctx.translate(-px, -py);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0);
      break;
    }
    case 'shake': {
      const src = grab(canvas, W, H);
      const f = Math.floor(local * 40);
      const dx = (hash(f * 3 + 1) - 0.5) * 2 * S * 0.045 * env;
      const dy = (hash(f * 5 + 7) - 0.5) * 2 * S * 0.045 * env;
      const rot = (hash(f * 7 + 3) - 0.5) * 0.03 * env;
      const k = 1 + 0.08 * env;                  // overscan so no black edge shows
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.translate(W / 2 + dx, H / 2 + dy); ctx.rotate(rot); ctx.scale(k, k); ctx.translate(-W / 2, -H / 2);
      ctx.drawImage(src, 0, 0);
      break;
    }
    case 'flash': {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, env * 1.05)})`;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'glitch': {
      const src = grab(canvas, W, H);
      const f = Math.floor(local * 24);
      const n = 9;
      for (let i = 0; i < n; i++) {
        if (hash(f * 13 + i) < 0.45) continue;
        const y = Math.floor(hash(f * 17 + i * 3) * H);
        const h = Math.max(2, Math.floor(hash(f * 19 + i) * H * 0.12));
        const dx = (hash(f * 23 + i * 7) - 0.5) * W * 0.16 * env;
        ctx.drawImage(src, 0, y, W, h, dx, y, W, h);
      }
      if (hash(f * 29) > 0.6) {
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = hash(f) > 0.5 ? `rgba(255,0,200,${0.18 * env})` : `rgba(0,255,240,${0.18 * env})`;
        const y = hash(f * 31) * H;
        ctx.fillRect(0, y, W, H * 0.06);
      }
      break;
    }
    case 'rgb': {
      const src = grab(canvas, W, H);
      const d = S * 0.022 * env;
      const red = tinted('a', src, W, H, '#ff0000');
      const cyan = tinted('b', src, W, H, '#00ffff');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(cyan, d, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(red, -d, 0);
      break;
    }
    case 'vignette': {
      const g = ctx.createRadialGradient(W / 2, H / 2, S * 0.28, W / 2, H / 2, Math.hypot(W, H) * 0.55);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${0.9 * env})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'bw': case 'pop': case 'blur': {
      const src = grab(canvas, W, H);
      ctx.filter = e.kind === 'bw' ? 'grayscale(1) contrast(1.08)'
        : e.kind === 'pop' ? `saturate(${(1 + 1.1 * env).toFixed(3)}) contrast(${(1 + 0.25 * env).toFixed(3)})`
        : `blur(${Math.max(0.5, S * 0.012 * env).toFixed(1)}px)`;
      ctx.globalAlpha = e.kind === 'bw' ? Math.min(1, env * 1.4) : 1;
      ctx.drawImage(src, 0, 0);
      break;
    }
    default: break;
  }
  ctx.restore();
}
