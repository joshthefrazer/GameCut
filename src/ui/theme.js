/**
 * Canvas paint palette.
 *
 * The DOM gets its colors from styles/tokens.css. Canvas can't read CSS custom
 * properties, so this module mirrors them into plain strings at boot by actually
 * reading the computed values off :root — which means tokens.css stays the single
 * source of truth and a retheme is a one-file edit. Every lookup has a literal
 * fallback so a headless context or a missing token can never blank the timeline.
 */

const FALLBACK = {
  '--tl-lane':        '#ffffff',
  '--tl-lane-alt':    '#f7fafd',
  '--tl-lane-active': 'rgba(37,99,235,.07)',
  '--tl-lane-audio':  'rgba(13,148,136,.05)',
  '--tl-lane-line':   'rgba(15,27,51,.075)',
  '--tl-ruler-bg':    '#eef3fb',
  '--tl-ruler-line':  'rgba(15,27,51,.16)',
  '--tl-ruler-tick':  'rgba(15,27,51,.28)',
  '--tl-ruler-text':  'rgba(15,27,51,.62)',
  '--tl-grid':        'rgba(15,27,51,.05)',
  '--tl-edge':        'rgba(15,27,51,.10)',
  '--tl-beat':        'rgba(37,99,235,.30)',
  '--tl-beat-bar':    'rgba(37,99,235,.62)',
  '--tl-playhead':    '#e11d48',
  '--tl-snap':        '#0ea5e9',
  '--tl-ghost-fill':  'rgba(37,99,235,.22)',
  '--tl-ghost-line':  'rgba(37,99,235,.85)',
  '--clip-label':     '#ffffff',
  '--clip-label-dim': 'rgba(255,255,255,.72)',
  '--clip-header':    'rgba(8,20,45,.30)',
  '--clip-sel-ring':  '#1d4ed8',
  '--clip-sel-edge':  '#ffffff',
  '--clip-key':       '#fde047',
  '--clip-wave-mid':  'rgba(255,255,255,.30)',
  '--marker':         '#f59e0b',
  '--acc':            '#2563eb',
  '--acc-2':          '#0ea5e9',
};

/** Resolved palette. Keys are the semantic names the renderers use. */
export const TH = {
  lane: '', laneAlt: '', laneActive: '', laneAudio: '', laneLine: '',
  rulerBg: '', rulerLine: '', rulerTick: '', rulerText: '',
  grid: '', edge: '', beat: '', beatBar: '',
  playhead: '', snap: '', ghostFill: '', ghostLine: '',
  clipLabel: '', clipLabelDim: '', clipHeader: '',
  selRing: '', selEdge: '', key: '', waveMid: '',
  marker: '', acc: '', acc2: '',
};

const MAP = {
  lane: '--tl-lane', laneAlt: '--tl-lane-alt', laneActive: '--tl-lane-active',
  laneAudio: '--tl-lane-audio', laneLine: '--tl-lane-line',
  rulerBg: '--tl-ruler-bg', rulerLine: '--tl-ruler-line',
  rulerTick: '--tl-ruler-tick', rulerText: '--tl-ruler-text',
  grid: '--tl-grid', edge: '--tl-edge',
  beat: '--tl-beat', beatBar: '--tl-beat-bar',
  playhead: '--tl-playhead', snap: '--tl-snap',
  ghostFill: '--tl-ghost-fill', ghostLine: '--tl-ghost-line',
  clipLabel: '--clip-label', clipLabelDim: '--clip-label-dim',
  clipHeader: '--clip-header', selRing: '--clip-sel-ring',
  selEdge: '--clip-sel-edge', key: '--clip-key', waveMid: '--clip-wave-mid',
  marker: '--marker', acc: '--acc', acc2: '--acc-2',
};

/**
 * Pull every token off :root. Safe to call again after a theme swap.
 * Returns TH so callers can `const th = loadTheme()` if they prefer.
 */
export function loadTheme() {
  let cs = null;
  try {
    cs = getComputedStyle(document.documentElement);
  } catch { /* no DOM — fall through to literals */ }

  for (const [key, token] of Object.entries(MAP)) {
    let v = '';
    if (cs) { try { v = cs.getPropertyValue(token).trim(); } catch { v = ''; } }
    TH[key] = v || FALLBACK[token];
  }
  return TH;
}

/**
 * `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb(...)` / `rgba(...)` → rgba string at
 * the given alpha. Anything unparseable degrades to the accent rather than
 * throwing mid-paint, because a bad swatch must never take the canvas down.
 */
export function alpha(color, a) {
  if (Array.isArray(color)) color = color[0];
  if (typeof color !== 'string' || !color) return `rgba(37,99,235,${a})`;

  const s = color.trim();

  if (s.startsWith('rgb')) {
    const n = s.match(/[\d.]+/g);
    if (n && n.length >= 3) return `rgba(${+n[0]},${+n[1]},${+n[2]},${a})`;
    return `rgba(37,99,235,${a})`;
  }

  let h = s.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(c => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || !/^[0-9a-f]{6}$/i.test(h)) return `rgba(37,99,235,${a})`;

  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Perceived luminance 0..1 — used to pick readable label ink on a clip body. */
export function luma(color) {
  const m = alpha(color, 1).match(/[\d.]+/g);
  if (!m) return 0;
  const [r, g, b] = m.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Black or white ink, whichever survives on `bg`. */
export const ink = (bg) => (luma(bg) > 0.6 ? '#0f1b33' : '#ffffff');

loadTheme();
