/** Stars: the things you reach for most, kept on this computer. */
import { bus } from '../core/events.js';
const KEY = 'strike.stars';
let data = {};
try { data = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* storage off */ }
export const starred = (kind) => Array.isArray(data[kind]) ? data[kind] : [];
export const isStarred = (kind, id) => starred(kind).includes(id);
export function toggleStar(kind, id) {
  const on = !isStarred(kind, id);
  data[kind] = on ? [...starred(kind), id] : starred(kind).filter(x => x !== id);
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage off */ }
  bus.emit('stars', { kind, id, on });
  return on;
}
/** A star on a tile. A span, because the tile itself is a button. */
export function starEl(kind, id, name) {
  const s = document.createElement('span');
  s.className = 'star'; s.setAttribute('role', 'button'); s.tabIndex = 0;
  s.innerHTML = '<svg viewBox="0 0 24 24"><path d="m12 3.2 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1L3.2 9.6l6.1-.8z"/></svg>';
  const paint = () => { const on = isStarred(kind, id); s.classList.toggle('is-on', on); s.setAttribute('aria-pressed', String(on)); s.title = on ? `Take the star off ${name}` : `Star ${name}`; s.setAttribute('aria-label', s.title); };
  const go = (e) => { e.preventDefault(); e.stopPropagation(); toggleStar(kind, id); paint(); if (isStarred(kind, id)) { s.classList.add('is-pop'); setTimeout(() => s.classList.remove('is-pop'), 320); } };
  s.addEventListener('click', go);
  s.addEventListener('pointerdown', (e) => e.stopPropagation());
  s.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
  paint();
  return s;
}
