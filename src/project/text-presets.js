/**
 * Ready-made text looks.
 *
 * The point of these is that nobody should have to know what "stroke width" or
 * "gradient angle" means to get text that looks deliberate. You click a look,
 * you get it, and every control underneath is still there if you want to push
 * it further. Anything you change can be saved back as your own look.
 *
 * Each preset is a partial text style — only the fields that make the look.
 * Everything unnamed stays as it was, so applying a preset to existing text
 * keeps your words, your size and your position.
 */
export const TEXT_PRESETS = [
  {
    id: 'clean',
    name: 'Clean',
    note: 'Plain white, readable on anything',
    style: {
      font: 'Inter', weight: 800, fill: 'solid', color: '#ffffff',
      strokeWidth: 0, glow: 0, shadow: 0.014, shadowColor: '#000000',
      shadowX: 0, shadowY: 0.006, bg: 'none', letterSpacing: 0, anim: 'none',
    },
  },
  {
    id: 'impact',
    name: 'Impact',
    note: 'Heavy outline — the gaming-title look',
    style: {
      font: 'Impact', weight: 900, fill: 'solid', color: '#ffffff',
      strokeWidth: 0.05, strokeColor: '#0b1220', glow: 0,
      shadow: 0.02, shadowColor: '#000000', shadowY: 0.012,
      bg: 'none', letterSpacing: 0.004, anim: 'slam',
    },
  },
  {
    id: 'neon',
    name: 'Neon',
    note: 'Glowing edges, dark scenes',
    style: {
      font: 'Inter', weight: 900, fill: 'solid', color: '#ffffff',
      strokeWidth: 0.012, strokeColor: '#0ea5e9',
      glow: 0.045, glowColor: '#38bdf8', shadow: 0,
      bg: 'none', letterSpacing: 0.02, anim: 'fade',
    },
  },
  {
    id: 'gradient',
    name: 'Gradient',
    note: 'Two colours through the letters',
    style: {
      font: 'Inter', weight: 900, fill: 'gradient',
      color: '#ffffff', color2: '#38bdf8', gradAngle: 90,
      strokeWidth: 0.02, strokeColor: '#0b1220',
      glow: 0.02, glowColor: '#2563eb', shadow: 0,
      bg: 'none', anim: 'pop',
    },
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    note: 'Dark plate, always legible',
    style: {
      font: 'Inter', weight: 600, fill: 'solid', color: '#ffffff',
      strokeWidth: 0, glow: 0, shadow: 0,
      bg: 'box', bgColor: '#0b1220d9', bgPad: 0.016, bgRadius: 0.22,
      letterSpacing: 0, anim: 'none',
    },
  },
  {
    id: 'pill',
    name: 'Pill',
    note: 'Rounded badge, good for labels',
    style: {
      font: 'Inter', weight: 700, fill: 'solid', color: '#0b1220',
      strokeWidth: 0, glow: 0, shadow: 0,
      bg: 'pill', bgColor: '#38bdf8', bgPad: 0.018,
      letterSpacing: 0.01, anim: 'pop',
    },
  },
  {
    id: 'typed',
    name: 'Typed',
    note: 'Letters appear as if typed',
    style: {
      font: 'Inter', weight: 700, fill: 'solid', color: '#ffffff',
      strokeWidth: 0, glow: 0.012, glowColor: '#38bdf8', shadow: 0.01,
      bg: 'none', letterSpacing: 0.01, anim: 'type', animDur: 1.1,
    },
  },
  {
    id: 'ghost',
    name: 'Ghost',
    note: 'Outline only, no fill weight',
    style: {
      font: 'Inter', weight: 900, fill: 'solid', color: '#ffffff00',
      strokeWidth: 0.028, strokeColor: '#ffffff',
      glow: 0.02, glowColor: '#ffffff', shadow: 0,
      bg: 'none', letterSpacing: 0.03, anim: 'rise',
    },
  },
];

/** The entrance choices, in the order they are offered. */
export const TEXT_ANIMS = [
  { id: 'none', name: 'None' },
  { id: 'fade', name: 'Fade' },
  { id: 'pop',  name: 'Pop' },
  { id: 'rise', name: 'Rise' },
  { id: 'slam', name: 'Slam' },
  { id: 'type', name: 'Type' },
];

/** Colours offered as one-click swatches. Blue-family plus the neutrals. */
export const TEXT_SWATCHES = [
  '#ffffff', '#0b1220', '#38bdf8', '#2563eb', '#6366f1',
  '#22d3ee', '#34d399', '#fbbf24', '#f43f5e', '#a855f7',
];

/* ── Your own saved looks ─────────────────────────────────────────
   Kept in this browser profile rather than in the project, because a
   look is yours and belongs to every project, not to one of them. */

const KEY = 'gamecut.textLooks';

export function savedLooks() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    // Private windows and cleared site data both land here. A missing list of
    // saved looks must never stop the editor loading.
    return [];
  }
}

export function saveLook(name, style) {
  const list = savedLooks();
  const id = 'own_' + Date.now().toString(36);
  list.unshift({ id, name: String(name || 'My look').slice(0, 40), own: true, style });
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 40))); } catch { /* not fatal */ }
  return id;
}

export function deleteLook(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify(savedLooks().filter(l => l.id !== id)));
  } catch { /* not fatal */ }
}

/** The fields a saved look captures — everything about the look, nothing about the words. */
export const LOOK_FIELDS = [
  'font', 'weight', 'italic', 'fill', 'color', 'color2', 'gradAngle',
  'letterSpacing', 'lineHeight', 'strokeWidth', 'strokeColor',
  'glow', 'glowColor', 'shadow', 'shadowColor', 'shadowX', 'shadowY',
  'bg', 'bgColor', 'bgPad', 'bgRadius', 'anim', 'animDur',
];

export function lookFrom(style) {
  const out = {};
  for (const k of LOOK_FIELDS) if (style[k] !== undefined) out[k] = style[k];
  return out;
}
