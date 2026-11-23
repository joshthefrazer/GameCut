/**
 * Colour and blending for one layer: the "Colour" group in the Inspector.
 *
 *   clip.color = { brightness, contrast, saturation, warmth, tint, fade }   each -1..1, 0 = untouched
 *   clip.blend = 'normal' | 'multiply' | 'screen' | …                       how the layer mixes with what is under it
 *
 * Every number is a plain slider with 0 in the middle, so "how far from normal"
 * is what you see. All six are folded into ONE colour matrix and drawn with the
 * canvas's own filter, so a graded layer costs one extra pass on the graphics
 * chip, not six, and the preview, Compare and the export all use this one file.
 *
 * Tools, not autopilot: the preset tiles below are starting points you pick
 * and then adjust; nothing grades a clip by itself.
 */

export const COLOR_KEYS = ['brightness', 'contrast', 'saturation', 'warmth', 'tint', 'fade'];

export const defaultColor = () => ({ brightness: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0, fade: 0 });

/** Is there anything to do? (A clip with no colour change never enters this file.) */
export function colorActive(c) {
  if (!c) return false;
  for (const k of COLOR_KEYS) if (Math.abs(c[k] || 0) > 1e-4) return true;
  return false;
}

/** Starting points, in plain words. Picking one replaces the six numbers; then adjust. */
export const COLOR_PRESETS = [
  { id: 'none',   name: 'None',    note: 'The footage as it was recorded', c: defaultColor() },
  { id: 'vivid',  name: 'Vivid',   note: 'More colour and a little more punch', c: { brightness: 0.02, contrast: 0.15, saturation: 0.35, warmth: 0, tint: 0, fade: 0 } },
  { id: 'punchy', name: 'Punchy',  note: 'Deep shadows, strong contrast', c: { brightness: -0.03, contrast: 0.35, saturation: 0.15, warmth: 0, tint: 0, fade: 0 } },
  { id: 'warm',   name: 'Warm',    note: 'Golden, sunny', c: { brightness: 0.02, contrast: 0.08, saturation: 0.1, warmth: 0.45, tint: 0.05, fade: 0 } },
  { id: 'cool',   name: 'Cool',    note: 'Blue, clean, night-time', c: { brightness: 0, contrast: 0.1, saturation: 0, warmth: -0.45, tint: 0, fade: 0 } },
  { id: 'faded',  name: 'Faded',   note: 'Soft, washed-out film', c: { brightness: 0.04, contrast: -0.18, saturation: -0.25, warmth: 0.1, tint: 0, fade: 0.45 } },
  { id: 'mono',   name: 'Mono',    note: 'Black and white', c: { brightness: 0, contrast: 0.12, saturation: -1, warmth: 0, tint: 0, fade: 0 } },
  { id: 'dream',  name: 'Dreamy',  note: 'Bright, pink-tinted and soft', c: { brightness: 0.08, contrast: -0.1, saturation: 0.05, warmth: 0.1, tint: 0.3, fade: 0.25 } },
];

/** Which preset these numbers are (or null once you have changed anything). */
export function presetOf(c) {
  const cur = { ...defaultColor(), ...(c || {}) };
  for (const p of COLOR_PRESETS) {
    if (COLOR_KEYS.every(k => Math.abs((p.c[k] || 0) - (cur[k] || 0)) < 1e-3)) return p.id;
  }
  return null;
}

/* ── Blend modes ──────────────────────────────────────────────── */

/** In plain words, grouped the way people reach for them. `op` is the canvas's own name. */
export const BLEND_MODES = [
  { id: 'normal',     name: 'Normal',          op: 'source-over', note: 'Covers what is under it' },
  { id: 'multiply',   name: 'Multiply',        op: 'multiply',    note: 'Darkens: white disappears, black stays. For shadows, ink, dirt' },
  { id: 'darken',     name: 'Darken',          op: 'darken',      note: 'Keeps whichever is darker' },
  { id: 'burn',       name: 'Burn',            op: 'color-burn',  note: 'Darkens with extra contrast' },
  { id: 'screen',     name: 'Screen',          op: 'screen',      note: 'Lightens: black disappears. For light leaks, flares, smoke, sparks' },
  { id: 'add',        name: 'Add (glow)',      op: 'lighter',     note: 'Adds the light together: bright and glowing' },
  { id: 'lighten',    name: 'Lighten',         op: 'lighten',     note: 'Keeps whichever is lighter' },
  { id: 'dodge',      name: 'Dodge',           op: 'color-dodge', note: 'Lightens with extra glow' },
  { id: 'overlay',    name: 'Overlay',         op: 'overlay',     note: 'More contrast: textures and grain sit into the picture' },
  { id: 'soft',       name: 'Soft light',      op: 'soft-light',  note: 'A gentle overlay' },
  { id: 'hard',       name: 'Hard light',      op: 'hard-light',  note: 'A strong overlay' },
  { id: 'difference', name: 'Difference',      op: 'difference',  note: 'Inverts where the layers differ: a trippy look' },
  { id: 'exclusion',  name: 'Exclusion',       op: 'exclusion',   note: 'A softer difference' },
  { id: 'hue',        name: 'Hue only',        op: 'hue',         note: 'Takes just the hue of this layer' },
  { id: 'saturation', name: 'Saturation only', op: 'saturation',  note: 'Takes just how colourful this layer is' },
  { id: 'colour',     name: 'Colour only',     op: 'color',       note: 'Colours the picture underneath (tinting)' },
  { id: 'luminosity', name: 'Brightness only', op: 'luminosity',  note: 'Takes just the light and dark of this layer' },
];
const OP = new Map(BLEND_MODES.map(b => [b.id, b.op]));

/** The canvas operation for a clip, or null for normal. */
export function blendOp(clip) {
  const b = clip?.blend;
  if (!b || b === 'normal') return null;
  return OP.get(b) || null;
}

/* ── The colour matrix ────────────────────────────────────────── */

/**
 * The 4×5 matrix (SVG feColorMatrix order, offsets in 0..1) for these numbers.
 * Exported for tests.
 */
export function colorMatrix(cIn) {
  const c = { ...defaultColor(), ...(cIn || {}) };
  // Start from identity, as [r g b a offset] rows.
  let m = [
    [1, 0, 0, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 1, 0],
  ];
  const mul = (b) => {   // m = b · m   (apply b after m)
    const out = [];
    for (let i = 0; i < 4; i++) {
      out.push([0, 0, 0, 0, 0]);
      for (let j = 0; j < 5; j++) {
        let s = j === 4 ? b[i][4] : 0;
        for (let k = 0; k < 4; k++) s += b[i][k] * m[k][j];
        out[i][j] = s;
      }
    }
    m = out;
  };
  // Saturation (Rec. 709 weights). -1 = grey, +1 = twice as colourful.
  const s = 1 + c.saturation;
  const lr = 0.2126, lg = 0.7152, lb = 0.0722;
  mul([
    [lr * (1 - s) + s, lg * (1 - s), lb * (1 - s), 0, 0],
    [lr * (1 - s), lg * (1 - s) + s, lb * (1 - s), 0, 0],
    [lr * (1 - s), lg * (1 - s), lb * (1 - s) + s, 0, 0],
    [0, 0, 0, 1, 0],
  ]);
  // Warmth: towards orange (+) or blue (−). Tint: towards magenta (+) or green (−).
  // A gain AND a small shift, so dark and already-bright parts move too, not only the middle.
  const w = c.warmth * 0.12, t = c.tint * 0.1;
  mul([
    [1 + w, 0, 0, 0, w * 0.4],
    [0, 1 - t, 0, 0, -t * 0.4],
    [0, 0, 1 - w, 0, -w * 0.4],
    [0, 0, 0, 1, 0],
  ]);
  // Contrast around middle grey: −1 flat, +1 twice the contrast.
  const k = c.contrast >= 0 ? 1 + c.contrast : 1 + c.contrast * 0.7;
  const ko = 0.5 * (1 - k);
  // Brightness: a lift of up to ±0.3 of full white.
  const b = c.brightness * 0.3;
  mul([
    [k, 0, 0, 0, ko + b],
    [0, k, 0, 0, ko + b],
    [0, 0, k, 0, ko + b],
    [0, 0, 0, 1, 0],
  ]);
  // Fade: blacks lifted to a soft grey, whites pulled in a little (film look).
  const f = Math.max(0, c.fade) * 0.22;
  mul([
    [1 - f, 0, 0, 0, f * 0.8],
    [0, 1 - f, 0, 0, f * 0.8],
    [0, 0, 1 - f, 0, f * 0.8],
    [0, 0, 0, 1, 0],
  ]);
  return m;
}

/*
 * The canvas filter for a clip: `url(#…)` pointing at an SVG colour matrix kept
 * in the page. Each distinct set of numbers gets one filter element, reused by
 * every frame and every layer that has it; dragging a slider makes a few
 * dozen, so the oldest are dropped past a limit.
 */
const MAX_FILTERS = 96;
const filters = new Map();   // key -> id
let host = null;
let seq = 0;

function svgHost() {
  if (host && host.isConnected) return host;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  svg.id = 'strikeColorFilters';
  (document.body || document.documentElement).appendChild(svg);
  host = svg;
  return host;
}

/** The `ctx.filter` string for these numbers, or '' when there is nothing to do. */
export function colorFilter(c) {
  if (!colorActive(c) || typeof document === 'undefined') return '';
  const key = COLOR_KEYS.map(k => Math.round((c[k] || 0) * 1000)).join(',');
  let id = filters.get(key);
  if (id && document.getElementById(id)) {
    // Most recently used goes to the back of the line.
    filters.delete(key); filters.set(key, id);
    return `url(#${id})`;
  }
  const NS = 'http://www.w3.org/2000/svg';
  id = `sc${++seq}`;
  const f = document.createElementNS(NS, 'filter');
  f.id = id;
  // Work in the picture's own colour space, like the rest of the canvas does.
  f.setAttribute('color-interpolation-filters', 'sRGB');
  const cm = document.createElementNS(NS, 'feColorMatrix');
  cm.setAttribute('type', 'matrix');
  cm.setAttribute('values', colorMatrix(c).flat().map(v => +v.toFixed(5)).join(' '));
  f.appendChild(cm);
  svgHost().appendChild(f);
  filters.set(key, id);
  while (filters.size > MAX_FILTERS) {
    const [oldKey, oldId] = filters.entries().next().value;
    filters.delete(oldKey);
    document.getElementById(oldId)?.remove();
  }
  return `url(#${id})`;
}
