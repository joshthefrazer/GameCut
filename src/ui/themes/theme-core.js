/**
 * Themes as data. A theme is a dozen choices; every one of the ~80 design tokens
 * the stylesheets and the timeline canvas read is worked out from them, so a theme
 * made by hand is as complete as a built-in one.
 */
import { alpha } from '../theme.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const hex = (c) => '#' + c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
/** `k` of b into a. */
export const mix = (a, b, k) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * k)); };
const lum = (h) => { const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** How well one colour reads on another: 1 (not at all) to 21. */
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const isLight = (t) => lum(t.panel) > 0.4;
const inkOn = (c) => contrast(c, '#06080f') >= contrast(c, '#ffffff') ? '#06080f' : '#ffffff';
/** The same colour pushed towards `to` until it reads on `on`. */
export function readable(c, on, want = 4.5) {
  const to = lum(on) > 0.35 ? '#000000' : '#ffffff';
  for (let k = 0; k <= 1; k += 0.05) { const m = mix(c, to, k); if (contrast(m, on) >= want) return m; }
  return to;
}

const base = { radius: 1, size: 1, motion: true, glow: 0.5, see: 0, backdrop: 'glow', back2: '', image: '', dim: 0.5 };
const T = (id, name, note, bg, panel, text, accent, highlight, video, audio, title, more = {}) =>
  ({ ...base, id, name, note, bg, panel, text, accent, highlight, danger: '#ff5a3c', video, audio, title, ...more });

/** The gallery. `css` themes are drawn by strike.css as they always were. */
export const GALLERY = [
  T('strike', 'Strike', 'The original', '#06080f', '#121829', '#eef3ff', '#3b5bff', '#c6ff3d', '#3b5bff', '#0e9384', '#7c3aed', { css: true }),
  T('volt', 'Volt', 'Black and lime', '#08090b', '#15181c', '#f3f6ee', '#c6ff3d', '#c6ff3d', '#3f7d20', '#0e8f80', '#8a7a12', { backdrop: 'none', glow: 0.25 }),
  T('black', 'Pitch black', 'Darkest, for OLED', '#000000', '#0e0e0e', '#f4f6fb', '#3b5bff', '#c6ff3d', '#3b5bff', '#0e9384', '#7c3aed', { css: true, backdrop: 'none' }),
  T('graphite', 'Graphite', 'Plain greys, colours stay true', '#161616', '#242424', '#ededed', '#5b9dff', '#ffc24b', '#3f6fb5', '#3a8f6b', '#8a63b8', { backdrop: 'none', glow: 0, radius: 0.6 }),
  T('midnight', 'Midnight', 'Deep blue and ice', '#050b1f', '#0e1938', '#e6f0ff', '#38bdf8', '#8be9ff', '#2563eb', '#0d9488', '#6366f1'),
  T('neon', 'Neon night', 'Violet and pink', '#0e0620', '#1e0f3d', '#f6eeff', '#e040fb', '#c6ff3d', '#7c3aed', '#0e9384', '#c026d3', { css: true }),
  T('sakura', 'Sakura', 'Plum and blossom', '#1a0d16', '#2b1725', '#ffeef5', '#ff7eb6', '#ffc1dc', '#b5457f', '#5f8f7b', '#8c5bc2', { radius: 1.6 }),
  T('retro', 'Retro CRT', 'Green phosphor', '#020a05', '#07180d', '#c9ffd6', '#2bff77', '#b6ff3d', '#0f7a3a', '#0d6f66', '#6f7d10', { radius: 0.2, glow: 0.9 }),
  T('blood', 'Blood red', 'Black and crimson', '#0c0406', '#1e0b10', '#ffecee', '#ff2e4d', '#ffb02e', '#a3162d', '#7a5a1a', '#7c2d8f'),
  T('ocean', 'Ocean', 'Teal and coral', '#04161b', '#0b2831', '#e4fbff', '#1fc8db', '#ff9270', '#0e7490', '#0f8a6a', '#b4553a'),
  T('forest', 'Forest', 'Moss and amber', '#0b120c', '#172219', '#eef6e9', '#7cc15a', '#ffc857', '#3c7a3a', '#2f7f7a', '#9a6b1f', { radius: 1.2, backdrop: 'gradient', back2: '#1c2a16', glow: 0.2 }),
  T('dusk', 'Dusk', 'Orange to purple sky', '#170d24', '#251636', '#fff0e6', '#ff8a4c', '#ffd166', '#8b3fa8', '#2f7f8f', '#c0503f', { backdrop: 'gradient', back2: '#4a1f2e', see: 0.12 }),
  T('day', 'Daylight', 'For bright rooms', '#eef1f7', '#ffffff', '#0b1020', '#3b5bff', '#3b5bff', '#3b5bff', '#0e9384', '#7c3aed', { css: true, backdrop: 'none' }),
  T('paper', 'Paper', 'Warm and quiet', '#ece5d8', '#faf6ee', '#2a2118', '#a4481f', '#a4481f', '#3f6d8c', '#4d7a4f', '#8a5a94', { backdrop: 'none', glow: 0, danger: '#c0281f' }),
  T('contrast', 'High contrast', 'Easiest to read', '#000000', '#000000', '#ffffff', '#ffe600', '#ffe600', '#0050d8', '#007a3d', '#a100c2', { backdrop: 'none', glow: 0, radius: 0.5, size: 1.1, danger: '#ff6b5e' }),
];
export const galleryTheme = (id) => GALLERY.find(t => t.id === id) || null;

/** Anything (an old save, a file from someone else) into a theme that is safe to use. */
export function cleanTheme(raw, id = raw?.id) {
  const d = GALLERY[1];
  const t = { ...base, id: String(id || 'my-theme').replace(/[^\w-]/g, '').slice(0, 40), name: String(raw?.name || 'My theme').slice(0, 30), note: String(raw?.note || '').slice(0, 60) };
  for (const k of ['bg', 'panel', 'text', 'accent', 'highlight', 'danger', 'video', 'audio', 'title']) t[k] = isHex(raw?.[k]) ? raw[k].toLowerCase() : d[k];
  t.back2 = isHex(raw?.back2) ? raw.back2 : mix(t.bg, t.accent, 0.25);
  const num = (k, a, b) => { const v = Number(raw?.[k]); t[k] = Number.isFinite(v) ? clamp(v, a, b) : base[k]; };
  num('radius', 0, 1.8); num('size', 0.9, 1.2); num('glow', 0, 1); num('see', 0, 0.45); num('dim', 0, 0.9);
  t.motion = raw?.motion !== false;
  t.backdrop = ['none', 'glow', 'gradient', 'image'].includes(raw?.backdrop) ? raw.backdrop : 'glow';
  t.image = typeof raw?.image === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.image) ? raw.image : '';
  if (t.backdrop === 'image' && !t.image) t.backdrop = 'glow';
  return t;
}

/** Every CSS token for a theme. */
export function themeVars(t) {
  const L = isLight(t);
  const a = alpha;
  const line = L ? mix(t.text, t.accent, 0.12) : mix(t.text, t.accent, 0.35);
  const bg1 = mix(t.bg, t.panel, 0.42);
  const accTxt = readable(t.accent, L ? t.bg : t.panel, 4.8);
  const hi = L ? readable(t.highlight, t.panel, 3) : t.highlight;
  const op = 1 - t.see;
  const lane = L ? t.panel : mix(t.bg, t.panel, 0.3);
  const v = {
    '--bg-0': t.bg, '--bg-1': bg1, '--bg-2': t.panel,
    '--well': a(line, 0.055), '--surface': a(line, L ? 0.06 : 0.08), '--surface-hi': a(line, L ? 0.11 : 0.15),
    '--field': L ? mix(t.panel, '#ffffff', 0.6) : mix(t.bg, t.panel, 0.55),
    '--glass-bg': a(mix(t.bg, t.panel, 0.7), 0.95 * op), '--glass-bg-2': a(mix(t.bg, t.panel, 0.5), 0.97 * op), '--glass-end': a(bg1, op),
    '--glass-hi': a(line, 0.12), '--glass-line': a(line, 0.14), '--glass-line-2': a(line, 0.26),
    '--txt-0': t.text, '--txt-1': readable(mix(t.text, t.panel, 0.16), t.panel, 7), '--txt-2': readable(mix(t.text, t.panel, 0.4), L ? t.bg : t.panel, 4.8), '--txt-3': readable(mix(t.text, t.panel, 0.52), L ? t.bg : t.panel, 4),
    '--acc': t.accent, '--acc-hi': mix(t.accent, '#ffffff', 0.22), '--acc-lo': mix(t.accent, '#000000', 0.18), '--acc-2': hi,
    '--acc-glow': a(t.accent, t.glow), '--acc-soft': a(t.accent, 0.17), '--acc-line': a(accTxt, 0.6), '--acc-txt': accTxt, '--on-acc': inkOn(t.accent),
    '--volt': hi, '--volt-hi': mix(hi, '#ffffff', 0.4), '--volt-soft': a(hi, 0.14), '--volt-line': a(hi, 0.55), '--on-volt': inkOn(hi),
    '--ember': t.danger, '--ember-soft': a(t.danger, 0.16), '--danger': t.danger, '--ok': hi, '--warn': L ? '#a16207' : '#fbbf24', '--tint': line,
    '--clip-video': t.video, '--clip-video-2': mix(t.video, '#ffffff', 0.28), '--clip-audio': t.audio, '--clip-audio-2': mix(t.audio, '#ffffff', 0.35),
    '--clip-text': t.title, '--clip-text-2': mix(t.title, '#ffffff', 0.4),
    '--tl-lane': lane, '--tl-lane-alt': mix(lane, t.panel, 0.35), '--tl-lane-active': a(t.accent, 0.1), '--tl-lane-audio': a(t.audio, 0.06), '--tl-lane-line': a(line, 0.09),
    '--tl-ruler-bg': mix(t.bg, t.panel, 0.12), '--tl-ruler-line': a(line, 0.18), '--tl-ruler-tick': a(line, 0.38), '--tl-ruler-text': a(t.text, 0.72),
    '--tl-grid': a(line, 0.055), '--tl-edge': a(line, 0.12), '--tl-beat': a(hi, 0.22), '--tl-beat-bar': a(hi, 0.6), '--tl-playhead': t.danger, '--tl-snap': hi,
    '--tl-ghost-fill': a(t.accent, 0.26), '--tl-ghost-line': a(mix(t.accent, '#ffffff', 0.2), 0.95),
    '--clip-sel-ring': L ? t.text : hi, '--clip-sel-edge': L ? t.panel : t.bg, '--marker': hi,
    '--sh-panel': L ? `0 1px 0 rgba(255,255,255,.6) inset,0 12px 30px -20px rgba(0,0,0,.35)` : `0 1px 0 ${a(line, 0.08)} inset,0 18px 44px -22px rgba(0,0,0,.9),0 1px 3px rgba(0,0,0,.5)`,
    '--sh-pop': L ? `0 24px 56px -24px rgba(0,0,0,.4),0 0 0 1px ${a(line, 0.16)}` : `0 24px 56px -20px rgba(0,0,0,.92),0 0 0 1px ${a(line, 0.14)}`,
    '--glow-soft': `0 0 26px -6px ${a(t.accent, 0.8 * t.glow)}`,
    '--backdrop': backdropOf(t),
    // Round the picture it stays dark in every theme: colours judged against white look wrong.
    '--stage': L ? '#17181b' : mix(t.bg, '#08080a', 0.4),
  };
  return v;
}

function backdropOf(t) {
  if (t.backdrop === 'none') return t.bg;
  if (t.backdrop === 'gradient') return `linear-gradient(135deg,${t.bg} 10%,${t.back2 || mix(t.bg, t.accent, 0.25)} 100%)`;
  if (t.backdrop === 'image' && t.image) return `linear-gradient(${alpha(t.bg, t.dim)},${alpha(t.bg, t.dim)}),url("${imageUrl(t.image)}") center/cover no-repeat,${t.bg}`;
  return `radial-gradient(46vw 46vw at 4% -6%,${alpha(t.accent, 0.26)},transparent 64%),radial-gradient(40vw 40vw at 97% -2%,${alpha(t.highlight, 0.1)},transparent 64%),radial-gradient(62vw 34vw at 54% 106%,${alpha(t.title, 0.16)},transparent 66%),${t.bg}`;
}

/** A picture kept as text, as a blob the stylesheet can point at (a long data: URL in a
 *  custom property is copied every time anything inherits it). One at a time. */
let held = { src: '', url: '' };
function imageUrl(src) {
  if (held.src === src) return held.url;
  if (held.url) URL.revokeObjectURL(held.url);
  const [head, body] = src.split(',');
  const bin = atob(body), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  held = { src, url: URL.createObjectURL(new Blob([bytes], { type: /data:([^;]+)/.exec(head)[1] })) };
  return held.url;
}

/** What would be hard to read in this theme, in words, with the colour that would fix it. */
export function checkTheme(t) {
  const out = [];
  const add = (key, want, on, msg) => { const r = contrast(t[key], on); if (r < want) out.push({ key, msg, ratio: r, fix: readable(t[key], on, want + 0.2) }); };
  add('text', 7, t.panel, 'Text is hard to read on the panels');
  if (contrast(t.text, t.bg) < 5) add('text', 5, t.bg, 'Text is hard to read on the background');
  add('accent', 2.2, t.panel, 'Buttons barely show against the panels');
  add('highlight', 2.2, isLight(t) ? t.panel : t.bg, 'The selection colour barely shows');
  add('danger', 2.2, t.panel, 'Warnings barely show');
  for (const [k, n] of [['video', 'Video'], ['audio', 'Audio'], ['title', 'Title']]) {
    if (contrast(t[k], '#ffffff') < 2.1) out.push({ key: k, msg: `${n} clip names (white) are hard to read`, ratio: contrast(t[k], '#ffffff'), fix: (() => { for (let i = 0; i <= 1; i += 0.05) { const m = mix(t[k], '#000000', i); if (contrast(m, '#ffffff') >= 3) return m; } return '#333333'; })() });
    if (contrast(t[k], mix(t.bg, t.panel, 0.3)) < 1.25) out.push({ key: k, msg: `${n} clips disappear into the timeline`, ratio: contrast(t[k], t.bg), fix: isLight(t) ? mix(t[k], '#000000', 0.35) : mix(t[k], '#ffffff', 0.3) });
  }
  return out;
}

/* ── Yours ────────────────────────────────────────────────────── */
const KEY = 'strike.themes';
let mine = null;
export function myThemes() {
  if (mine) return mine;
  try { mine = JSON.parse(localStorage.getItem(KEY) || '[]').map(t => cleanTheme(t)); } catch { mine = []; }
  return mine;
}
/** Save the list. False when this computer has no room for it (a big picture). */
export function saveMine(list) {
  mine = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}
export const findTheme = (id) => galleryTheme(id) || myThemes().find(t => t.id === id) || null;

/** A little picture of the editor in this theme. */
export function themePicture(t) {
  const L = mix(t.bg, t.panel, 0.3), r = 2 + 2 * t.radius;
  const line = alpha(t.text, 0.14);
  return `<svg viewBox="0 0 160 96" aria-hidden="true" style="stroke:none"><rect width="160" height="96" fill="${t.backdrop === 'gradient' ? `${t.back2 || t.bg}` : t.bg}"/>
<rect x="5" y="5" width="9" height="7" rx="${r / 2}" fill="${t.highlight}"/><rect x="132" y="5" width="23" height="7" rx="${r / 2}" fill="${t.accent}"/><rect x="18" y="7" width="26" height="3" rx="1.5" fill="${t.text}" opacity=".8"/>
<rect x="5" y="16" width="34" height="40" rx="${r}" fill="${t.panel}" stroke="${line}"/><rect x="43" y="16" width="74" height="40" rx="${r}" fill="${t.panel}" stroke="${line}"/><rect x="121" y="16" width="34" height="40" rx="${r}" fill="${t.panel}" stroke="${line}"/>
<rect x="50" y="20" width="60" height="32" rx="${r * 0.7}" fill="${mix(t.accent, '#000000', 0.55)}"/><circle cx="80" cy="36" r="7" fill="${t.accent}"/><path d="M78 32.5l6 3.5-6 3.5z" fill="${inkOn(t.accent)}"/>
<rect x="9" y="21" width="22" height="3" rx="1.5" fill="${t.text}" opacity=".9"/><rect x="9" y="28" width="26" height="9" rx="${r * 0.6}" fill="${alpha(t.text, 0.12)}"/><rect x="9" y="41" width="26" height="9" rx="${r * 0.6}" fill="${alpha(t.accent, 0.35)}"/>
<rect x="126" y="21" width="16" height="3" rx="1.5" fill="${t.text}" opacity=".9"/><rect x="126" y="29" width="24" height="2.5" rx="1" fill="${alpha(t.text, 0.25)}"/><rect x="126" y="29" width="14" height="2.5" rx="1" fill="${t.accent}"/><rect x="126" y="37" width="24" height="2.5" rx="1" fill="${alpha(t.text, 0.25)}"/><rect x="126" y="37" width="8" height="2.5" rx="1" fill="${t.accent}"/>
<rect x="5" y="60" width="150" height="31" rx="${r}" fill="${L}" stroke="${line}"/><rect x="22" y="64" width="34" height="7" rx="1.5" fill="${t.title}"/><rect x="10" y="73" width="62" height="7" rx="1.5" fill="${t.video}"/><rect x="74" y="73" width="54" height="7" rx="1.5" fill="${t.video}" stroke="${t.highlight}" stroke-width="1.4"/><rect x="10" y="82" width="104" height="6" rx="1.5" fill="${t.audio}"/><rect x="86" y="61" width="1.4" height="29" fill="${t.danger}"/></svg>`;
}
