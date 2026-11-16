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
  {
    id: 'kinetic',
    name: 'Kinetic',
    note: 'Each letter pops in one after another',
    style: {
      font: 'Inter', weight: 900, fill: 'solid', color: '#ffffff',
      strokeWidth: 0.03, strokeColor: '#0b1220', glow: 0, shadow: 0.016, shadowColor: '#000000', shadowY: 0.008,
      bg: 'none', letterSpacing: 0.006,
      anim: 'pop', animDur: 0.3, animUnit: 'letter', animSpread: 0.5,
      animOut: 'fade', animOutDur: 0.25,
    },
  },
  {
    id: 'bounce',
    name: 'Bounce',
    note: 'Words drop in and bounce',
    style: {
      font: 'Inter', weight: 900, fill: 'solid', color: '#fbbf24',
      strokeWidth: 0.04, strokeColor: '#0b1220', glow: 0, shadow: 0.02, shadowColor: '#000000', shadowY: 0.012,
      bg: 'none', letterSpacing: 0.004,
      anim: 'drop', animDur: 0.55, animUnit: 'word', animSpread: 0.45,
      animOut: 'fade', animOutDur: 0.25,
    },
  },
  {
    id: 'glitch',
    name: 'Glitch',
    note: 'Jitters in, flickers while it is up',
    style: {
      font: 'Inter', weight: 900, fill: 'solid', color: '#e6faff',
      strokeWidth: 0.01, strokeColor: '#22d3ee', glow: 0.03, glowColor: '#f43f5e', shadow: 0,
      bg: 'none', letterSpacing: 0.02,
      anim: 'glitch', animDur: 0.6, animLoop: 'flicker', animOut: 'glitch', animOutDur: 0.4,
    },
  },
  {
    id: 'wave',
    name: 'Wave',
    note: 'Letters ripple up and down',
    style: {
      font: 'Inter', weight: 900, fill: 'gradient', color: '#38bdf8', color2: '#a855f7', gradAngle: 0,
      strokeWidth: 0.02, strokeColor: '#0b1220', glow: 0.015, glowColor: '#6366f1', shadow: 0,
      bg: 'none', letterSpacing: 0.012,
      anim: 'rise', animDur: 0.35, animUnit: 'letter', animSpread: 0.4, animLoop: 'wave',
    },
  },
  {
    id: 'hype',
    name: 'Hype',
    note: 'Slams in, rainbow colours, shakes',
    style: {
      font: 'Impact', weight: 900, fill: 'solid', color: '#ffffff',
      strokeWidth: 0.05, strokeColor: '#0b1220', glow: 0.02, glowColor: '#f43f5e', shadow: 0.02, shadowColor: '#000000', shadowY: 0.012,
      bg: 'none', letterSpacing: 0.006,
      anim: 'slam', animDur: 0.3, animLoop: 'rainbow', animOut: 'slam', animOutDur: 0.2,
    },
  },
  {
    id: 'lower',
    name: 'Lower third',
    note: 'Slides in on a plate, slides out',
    style: {
      font: 'Inter', weight: 700, fill: 'solid', color: '#ffffff',
      strokeWidth: 0, glow: 0, shadow: 0,
      bg: 'box', bgColor: '#2563ebf2', bgPad: 0.018, bgRadius: 0.12, letterSpacing: 0.004,
      anim: 'slideL', animDur: 0.45, animOut: 'slideL', animOutDur: 0.35,
    },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    note: 'Typed with a blinking cursor',
    style: {
      font: 'Consolas', weight: 600, fill: 'solid', color: '#34d399',
      strokeWidth: 0, glow: 0.018, glowColor: '#34d399', shadow: 0,
      bg: 'box', bgColor: '#0b1220e6', bgPad: 0.02, bgRadius: 0.12, letterSpacing: 0.004,
      anim: 'type', animDur: 1.4, animOut: 'type', animOutDur: 0.5, typeCursor: true,
    },
  },
];

/** How text can arrive, in the order offered. Leaving plays the same moves backwards. */
export const TEXT_IN = [
  { id: 'none',   name: 'None' },
  { id: 'fade',   name: 'Fade' },
  { id: 'pop',    name: 'Pop' },
  { id: 'rise',   name: 'Rise up' },
  { id: 'fall',   name: 'Settle down' },
  { id: 'drop',   name: 'Drop & bounce' },
  { id: 'slam',   name: 'Slam' },
  { id: 'grow',   name: 'Grow' },
  { id: 'slideL', name: 'Slide from left' },
  { id: 'slideR', name: 'Slide from right' },
  { id: 'spin',   name: 'Spin in' },
  { id: 'flip',   name: 'Flip' },
  { id: 'wipe',   name: 'Wipe' },
  { id: 'glitch', name: 'Glitch' },
  { id: 'type',   name: 'Typewriter' },
];
/** Kept so anything that still asks for the old name gets the full list. */
export const TEXT_ANIMS = TEXT_IN;

/** How text can leave. The same moves as arriving, named for what you see. */
export const TEXT_OUT = [
  { id: 'none',   name: 'None' },
  { id: 'fade',   name: 'Fade' },
  { id: 'pop',    name: 'Shrink' },
  { id: 'rise',   name: 'Sink' },
  { id: 'fall',   name: 'Lift away' },
  { id: 'drop',   name: 'Bounce up' },
  { id: 'slam',   name: 'Zoom away' },
  { id: 'grow',   name: 'Shrink out' },
  { id: 'slideL', name: 'Slide left' },
  { id: 'slideR', name: 'Slide right' },
  { id: 'spin',   name: 'Spin out' },
  { id: 'flip',   name: 'Flip' },
  { id: 'wipe',   name: 'Wipe' },
  { id: 'glitch', name: 'Glitch' },
  { id: 'type',   name: 'Erase' },
];

/** What text can keep doing while it is on screen. */
export const TEXT_LOOPS = [
  { id: 'none',    name: 'Still' },
  { id: 'pulse',   name: 'Pulse' },
  { id: 'float',   name: 'Float' },
  { id: 'wave',    name: 'Wave' },
  { id: 'wobble',  name: 'Wobble' },
  { id: 'shake',   name: 'Shake' },
  { id: 'flicker', name: 'Flicker' },
  { id: 'rainbow', name: 'Rainbow' },
];

/** What moves as one piece. */
export const TEXT_UNITS = [
  { id: 'all',    name: 'All at once' },
  { id: 'word',   name: 'Word by word' },
  { id: 'letter', name: 'Letter by letter' },
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
  'bg', 'bgColor', 'bgPad', 'bgRadius',
  'anim', 'animDur', 'animOut', 'animOutDur', 'animLoop', 'animUnit', 'animSpread', 'typeCursor',
];

export function lookFrom(style) {
  const out = {};
  for (const k of LOOK_FIELDS) if (style[k] !== undefined) out[k] = style[k];
  return out;
}

/* ── Your saved texts ─────────────────────────────────────────────
   Words and the look they were in, kept together: a channel name, a
   "follow for more", a catchphrase. One click puts it on the picture
   exactly as it was. Kept beside the saved looks, for the same reason. */

const TEXT_KEY = 'gamecut.textLibrary';

export function savedTexts() {
  try {
    const raw = localStorage.getItem(TEXT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveTextEntry(name, text, style) {
  const list = savedTexts();
  const id = 'txt_' + Date.now().toString(36);
  list.unshift({ id, name: String(name || text || 'My text').slice(0, 40), text: String(text || ''), style });
  try { localStorage.setItem(TEXT_KEY, JSON.stringify(list.slice(0, 60))); } catch { /* not fatal */ }
  return id;
}

export function deleteTextEntry(id) {
  try {
    localStorage.setItem(TEXT_KEY, JSON.stringify(savedTexts().filter(l => l.id !== id)));
  } catch { /* not fatal */ }
}
