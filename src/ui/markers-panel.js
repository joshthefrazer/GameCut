import { bus } from '../core/events.js';

/** Every marker in a list: click to go there, name it, colour it, take it out. */
export const MARK_COLORS = ['#ffb454', '#ef4444', '#22c55e', '#38bdf8', '#a855f7', '#ec4899', '#e5e7eb'];
export function initMarkersPanel({ store, cmds, playback }) {
  const el = document.createElement('aside');
  el.className = 'mkp'; el.id = 'markersPanel'; el.hidden = true; el.setAttribute('aria-label', 'Markers');
  document.body.appendChild(el);
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const tc = (t) => { const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.round((t % 1) * (store.doc.fps || 30)); return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`; };
  let drawn = '';
  function draw(force) {
    if (el.hidden) return;
    const key = JSON.stringify(store.doc.markers);
    if (!force && (key === drawn || el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) { if (key !== drawn) return; else return; }
    drawn = key;
    el.innerHTML = '';
    const head = h('div', 'mkp__head');
    head.append(h('b', null, 'Markers'));
    const add = h('button', 'btn btn--ghost btn--sm', '+ Here'); add.id = 'mkAdd'; add.title = 'Add a marker at the playhead (M)'; add.addEventListener('click', () => cmds.addMarker(store.rt.playhead));
    const x = h('button', 'thst__icon', '×'); x.setAttribute('aria-label', 'Close markers'); x.addEventListener('click', () => { el.hidden = true; });
    head.append(add, x); el.appendChild(head);
    const list = h('div', 'mkp__list');
    for (const m of store.doc.markers) {
      const r = h('div', 'mkp__row'); r.dataset.mk = m.id; r.style.setProperty('--c', m.color || MARK_COLORS[0]);
      const flag = h('button', 'mkp__flag'); flag.title = 'Change its colour'; flag.setAttribute('aria-label', flag.title);
      flag.addEventListener('click', () => { const i = MARK_COLORS.indexOf(m.color); cmds.setMarker(m.id, { color: MARK_COLORS[(i + 1) % MARK_COLORS.length] }); draw(true); });
      const go = h('button', 'mkp__t', tc(m.t)); go.title = 'Go there'; go.addEventListener('click', () => { playback.pause(); playback.seek(m.t); bus.emit('timeline:reveal', { start: m.t, duration: 0 }); });
      const name = h('input', 'mkp__name'); name.value = m.label || ''; name.placeholder = 'Add a note'; name.maxLength = 60; name.setAttribute('aria-label', 'Note');
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') name.blur(); });
      name.addEventListener('change', () => cmds.setMarker(m.id, { label: name.value.trim() }));
      name.addEventListener('blur', () => setTimeout(() => draw(), 0));
      const del = h('button', 'mkp__x', '×'); del.title = 'Remove'; del.setAttribute('aria-label', 'Remove this marker'); del.addEventListener('click', () => cmds.removeMarker(m.id));
      r.append(flag, go, name, del); list.appendChild(r);
    }
    if (!store.doc.markers.length) list.appendChild(h('p', 'mkp__none', 'No markers yet. Press M while it plays to flag the good bits, then come back here.'));
    el.appendChild(list);
  }
  const toggle = () => { el.hidden = !el.hidden; if (!el.hidden) draw(true); };
  store.on('doc', () => draw());
  bus.on('markers:open', () => { el.hidden = false; draw(true); });
  bus.emit('palette:add', [{ id: 'markers', name: 'Markers list: notes, colours, jump', sec: 'View', key: 'Shift+M', viaKeymap: true, run: toggle }]);
  return { toggle, get open() { return !el.hidden; } };
}
