import { bus } from '../core/events.js';

/** Paste some of a copied look: tick the parts, see how many clips take them. */
export const LOOK_PARTS = [
  { id: 'transform', name: 'Size and position', note: 'Place, scale, rotation, opacity', d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' },
  { id: 'crop', name: 'Crop', note: 'What part of the recording shows', d: 'M6 2v16h16M2 6h16v16' },
  { id: 'color', name: 'Colour', note: 'Brightness, contrast, warmth…', d: 'M12 3a9 9 0 1 0 0 18c1.8 0 2-1.3 1.3-2.3-.8-1.2 0-2.7 1.5-2.7H17a4 4 0 0 0 4-4c0-5-4-9-9-9z' },
  { id: 'fx', name: 'Look', note: 'Shadow, glow, outline, 3D', d: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z' },
  { id: 'motion', name: 'Motion', note: 'How it arrives, moves and leaves', d: 'M3 12h11M10 7l5 5-5 5M19 5v14' },
  { id: 'blend', name: 'Blend', note: 'Screen, Multiply…', d: 'M9 5a7 7 0 1 0 0 14A7 7 0 0 0 9 5zM15 5a7 7 0 1 1 0 14' },
  { id: 'fit', name: 'Framing and flips', note: 'Fill, fit, blur behind, mirrored', d: 'M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4' },
  { id: 'transIn', name: 'Transition', note: 'The one on the cut before it', d: 'M3 6h7v12H3zM14 6h7v12h-7zM10 12h4' },
  { id: 'sound', name: 'Sound', note: 'Volume, fades, voice clean-up', d: 'M11 5 6 9H3v6h3l5 4zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12' },
  { id: 'text', name: 'Text style', note: 'Font, colours, outline (not the words)', d: 'M5 6V4h14v2M12 4v16M9 20h6' },
];
const OLD = ['transform', 'crop', 'color', 'fx', 'motion', 'blend', 'fit', 'text'];
const KEY = 'strike.pasteParts';

export function initLookPaste({ store, cmds }) {
  const el = document.createElement('div');
  el.className = 'pal qold'; el.id = 'pasteParts'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Paste parts of a look');
  document.body.appendChild(el);
  let picked = new Set(OLD);
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (Array.isArray(s)) picked = new Set(s); } catch { /* storage off */ }
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const close = () => { el.hidden = true; };
  function open() {
    const look = cmds.copiedLook;
    if (!look) { bus.emit('toast', { msg: 'Copy a look first: pick a clip and press Ctrl+Alt+C.' }); return; }
    if (!store.rt.selection.length) { bus.emit('toast', { msg: 'Pick the clips to paste onto first.' }); return; }
    el.innerHTML = '';
    const box = h('div', 'pal__box qold__box pp__box');
    const head = h('div', 'vers__head');
    head.append(h('b', null, 'Paste parts of a look'), h('span', null, `From “${look.name || look.from}”`));
    const grid = h('div', 'pp__grid');
    const has = cmds.lookParts(look);
    const foot = h('div', 'pp__foot');
    const go = h('button', 'btn btn--primary'); go.id = 'ppGo';
    const paint = () => {
      const parts = [...picked].filter(p => has.includes(p));
      const n = parts.length ? cmds.lookTargets(store.rt.selection, parts) : 0;
      go.disabled = !n;
      go.textContent = !parts.length ? 'Tick something to paste' : n ? `Paste onto ${n} clip${n === 1 ? '' : 's'}` : 'Those clips cannot take that';
    };
    for (const p of LOOK_PARTS) {
      if (!has.includes(p.id)) continue;
      const b = h('button', 'pp__part' + (picked.has(p.id) ? ' is-on' : '')); b.dataset.part = p.id; b.setAttribute('aria-pressed', String(picked.has(p.id)));
      b.innerHTML = `<svg viewBox="0 0 24 24"><path d="${p.d}"/></svg><span><b></b><i></i></span><em><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></em>`;
      b.querySelector('b').textContent = p.name; b.querySelector('i').textContent = p.note;
      b.addEventListener('click', () => { const on = !picked.has(p.id); on ? picked.add(p.id) : picked.delete(p.id); b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); paint(); });
      grid.appendChild(b);
    }
    const none = h('button', 'btn btn--ghost', 'Untick all'); none.addEventListener('click', () => { picked.clear(); open(); });
    const no = h('button', 'btn btn--ghost', 'Cancel'); no.addEventListener('click', close);
    go.addEventListener('click', () => { try { localStorage.setItem(KEY, JSON.stringify([...picked])); } catch { /* storage off */ } close(); cmds.pasteLook(store.rt.selection, [...picked].filter(p => has.includes(p))); window.gc?.comp?.render?.(); });
    foot.append(none, h('i'), no, go);
    box.append(head, grid, foot); el.appendChild(box);
    paint(); el.hidden = false; go.focus();
  }
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  window.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
  bus.on('look:parts', open);
  bus.emit('palette:add', [{ id: 'pasteparts', name: 'Paste parts of a look…', sec: 'Clip', key: 'Ctrl+Alt+Shift+V', viaKeymap: true, run: open }]);
  return { open, close };
}
