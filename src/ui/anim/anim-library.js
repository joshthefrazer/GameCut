import { ANIMATIONS, CATS, animById, valuesFor } from '../../anim/defs.js';
import { bus } from '../../core/events.js';
import { liveThumb } from './thumbs.js';

/**
 * The animation library, in two places:
 *
 *   the Animations drawer   a compact list beside the preview — click a card
 *                           to drop it at the playhead, or drag it onto a lane
 *   Library mode            the whole window: big moving cards, a detail view
 *                           to set the words and colours before it goes in
 *
 * Both share the search, the categories and the stars (kept per computer).
 */

const STAR_KEY = 'strike.animStars';
const RECENT_KEY = 'strike.animRecent';
const readList = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const writeList = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private */ } };

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STAR_SVG = '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>';

export function initAnimLibrary({ store, cmds, comp }) {
  let stars = new Set(readList(STAR_KEY));
  const recent = () => readList(RECENT_KEY);
  const used = (id) => writeList(RECENT_KEY, [id, ...recent().filter(x => x !== id)].slice(0, 8));
  const listeners = new Set();
  const starsChanged = () => { writeList(STAR_KEY, [...stars]); for (const f of listeners) f(); };
  const toggleStar = (id) => { stars.has(id) ? stars.delete(id) : stars.add(id); starsChanged(); };

  function filtered(q, cat) {
    q = q.trim().toLowerCase();
    let list = ANIMATIONS;
    if (cat === 'starred') list = list.filter(a => stars.has(a.id));
    else if (cat === 'recent') list = recent().map(animById).filter(Boolean);
    else if (cat && cat !== 'all') list = list.filter(a => a.cat === cat);
    if (q) list = list.filter(a => `${a.name} ${a.note} ${CATS.find(c => c.id === a.cat)?.name || ''} ${a.id}`.toLowerCase().includes(q));
    return list;
  }

  /** Put one in at the playhead (or `at`), select it, and say how to change it. */
  function add(id, p = {}, at = store.rt.playhead) {
    const def = animById(id);
    const clip = cmds.addAnimation(id, at, { p });
    if (!clip) return null;
    used(id);
    store.select([clip.id]);
    comp.render();
    bus.emit('toast', { msg: `${def.name} added — change its words and colours under Customize`, ms: 3400 });
    return clip;
  }

  function card(def, { big = false, onPick } = {}) {
    const el = document.createElement('div');
    el.className = 'acard' + (big ? ' acard--big' : '');
    el.dataset.anim = def.id;
    el.draggable = true;
    el.tabIndex = 0;
    el.title = big ? def.note : `${def.note} — click to add at the playhead, or drag onto the timeline`;
    el.innerHTML = `<canvas class="acard__cv"></canvas>
      <button class="acard__star${stars.has(def.id) ? ' is-on' : ''}" title="Star it — starred ones get their own tab" aria-label="Star">${STAR_SVG}</button>
      <div class="acard__meta"><b>${esc(def.name)}</b><span>${esc(def.note)}</span></div>`;
    const thumb = liveThumb(el.querySelector('canvas'), def, { always: big, hoverEl: el });
    el.querySelector('.acard__star').addEventListener('click', (e) => { e.stopPropagation(); toggleStar(def.id); });
    el.addEventListener('click', () => onPick(def));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(def); } });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-strike-anim', def.id);
      e.dataTransfer.effectAllowed = 'copy';
      window.__strike_dragAnim = def.id;
    });
    el.addEventListener('dragend', () => { window.__strike_dragAnim = null; });
    el._thumb = thumb;
    return el;
  }

  const chipsHtml = (cur) => [['all', 'All'], ['starred', 'Starred'], ['recent', 'Recent'], ...CATS.map(c => [c.id, c.name])]
    .map(([id, name]) => `<button class="achip${id === cur ? ' is-on' : ''}" data-cat="${id}">${name}</button>`).join('');

  /* ── The drawer ─────────────────────────────────────────── */
  const root = document.getElementById('animRoot');
  let dq = '', dcat = 'all';
  function paintDrawer() {
    if (!root) return;
    const grid = root.querySelector('.agrid');
    grid.querySelectorAll('.acard').forEach(c => c._thumb?.drop());
    grid.innerHTML = '';
    const list = filtered(dq, dcat);
    for (const def of list) grid.appendChild(card(def, { onPick: (d) => add(d.id) }));
    root.querySelector('.achips').innerHTML = chipsHtml(dcat);
    root.querySelector('.aempty').hidden = list.length > 0;
    root.querySelector('.aempty').textContent = dcat === 'starred' ? 'Star an animation and it shows up here.'
      : dcat === 'recent' ? 'Animations you add show up here.' : 'Nothing matches that.';
  }
  if (root) {
    root.innerHTML = `
      <div class="asearch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="animSearch" placeholder="Search animations" spellcheck="false"></div>
      <div class="achips"></div>
      <div class="agrid"></div>
      <p class="aempty" hidden></p>
      <button class="alib-open" id="btnOpenLibrary">Open the full library</button>`;
    root.querySelector('#animSearch').addEventListener('input', (e) => { dq = e.target.value; paintDrawer(); });
    root.querySelector('.achips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]'); if (!b) return;
      dcat = b.dataset.cat; paintDrawer();
    });
    root.querySelector('#btnOpenLibrary').addEventListener('click', () => setMode('library'));
    paintDrawer();
  }

  /* ── Library mode ───────────────────────────────────────── */
  const view = document.createElement('section');
  view.className = 'libview';
  view.id = 'libView';
  view.hidden = true;
  view.innerHTML = `
    <div class="libview__side">
      <h2 class="libview__title">Library</h2>
      <p class="libview__lead">Pop-ups, counters, titles and callouts that move the way gaming videos do. Each one comes with its own sound.</p>
      <div class="asearch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="libSearch" placeholder="Search the library" spellcheck="false"></div>
      <nav class="libview__cats"></nav>
    </div>
    <div class="libview__main"><div class="libview__grid"></div><p class="aempty" hidden></p></div>
    <aside class="libview__detail" hidden></aside>`;
  document.getElementById('app')?.appendChild(view);
  let lq = '', lcat = 'all', picked = null, pickedThumb = null;

  function paintLibrary() {
    const cats = view.querySelector('.libview__cats');
    const count = (id) => filtered('', id).length;
    cats.innerHTML = [['all', 'Everything'], ['starred', 'Starred'], ['recent', 'Recently used'], ...CATS.map(c => [c.id, c.name])]
      .map(([id, name]) => `<button class="libcat${id === lcat ? ' is-on' : ''}" data-cat="${id}"><span>${name}</span><i>${count(id)}</i></button>`).join('');
    const grid = view.querySelector('.libview__grid');
    grid.querySelectorAll('.acard').forEach(c => c._thumb?.drop());
    grid.innerHTML = '';
    const list = filtered(lq, lcat);
    for (const def of list) {
      const el = card(def, { big: true, onPick: (d) => pick(d) });
      el.classList.toggle('is-picked', picked?.def.id === def.id);
      grid.appendChild(el);
    }
    const empty = view.querySelector('.libview__main .aempty');
    empty.hidden = list.length > 0;
    empty.textContent = lcat === 'starred' ? 'Nothing starred yet — click the star on any card.' : 'Nothing matches that.';
  }

  /** The detail panel: a big preview and the words/colours, before it goes in. */
  function pick(def) {
    picked = { def, p: {} };
    const d = view.querySelector('.libview__detail');
    pickedThumb?.drop();
    d.hidden = false;
    const fields = def.params.filter(p => p.type === 'text' || p.type === 'color').map(p => p.type === 'text'
      ? `<label class="libf"><span>${esc(p.label)}</span><input data-k="${p.key}" value="${esc(p.def)}" spellcheck="false"></label>`
      : `<label class="libf libf--col"><span>${esc(p.label)}</span><input type="color" data-k="${p.key}" value="${p.def}"></label>`).join('');
    d.innerHTML = `
      <button class="libview__x" title="Close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <canvas class="libview__cv"></canvas>
      <b class="libview__name">${esc(def.name)}</b>
      <span class="libview__note">${esc(def.note)} · ${def.dur.toFixed(1)} s${def.sound ? ' · with sound' : ''}</span>
      <div class="libview__fields">${fields}</div>
      <button class="btn btn--primary libview__add" id="libAdd">Add at the playhead</button>
      <p class="libview__hint">Everything else — timing, sound, position — is under Customize once it is in.</p>`;
    pickedThumb = liveThumb(d.querySelector('canvas'), def, { always: true });
    d.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('input', () => {
      picked.p[inp.dataset.k] = inp.value;
      pickedThumb.set({ ...picked.p });
    }));
    d.querySelector('.libview__x').addEventListener('click', () => { d.hidden = true; pickedThumb?.drop(); picked = null; paintLibrary(); });
    d.querySelector('#libAdd').addEventListener('click', () => {
      const c = add(def.id, { ...picked.p });
      if (c) setMode('edit');
    });
    view.querySelectorAll('.acard').forEach(c => c.classList.toggle('is-picked', c.dataset.anim === def.id));
  }

  view.querySelector('#libSearch').addEventListener('input', (e) => { lq = e.target.value; paintLibrary(); });
  view.querySelector('.libview__cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    lcat = b.dataset.cat; paintLibrary();
  });
  listeners.add(() => { paintDrawer(); if (!view.hidden) paintLibrary(); });

  /* ── Modes: Edit · Library · Export ─────────────────────── */
  const modes = document.getElementById('modes');
  let mode = 'edit';
  function setMode(m) {
    if (m === 'export') {
      document.getElementById('btnExport')?.click();
      return;
    }
    mode = m;
    const app = document.getElementById('app');
    app?.classList.toggle('is-library', m === 'library');
    view.hidden = m !== 'library';
    modes?.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('is-on', b.dataset.mode === m));
    if (m === 'library') { paintLibrary(); setTimeout(() => view.querySelector('#libSearch')?.focus(), 30); }
    else { view.querySelectorAll('.acard').forEach(c => c._thumb?.drop()); bus.emit('layout'); }
  }
  modes?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode === 'library' && !document.querySelector('.modal:not([hidden]), .pal:not([hidden])')) setMode('edit');
  });
  bus.on('home:open', () => setMode('edit'));

  // Every animation is one search away (Ctrl+K "kill", "subscribe"…).
  bus.emit('palette:add', [
    { id: 'anim-library', name: 'Open the animation library', sec: 'Animate', run: () => setMode('library') },
    ...ANIMATIONS.map(a => ({ id: 'anim-' + a.id, name: `Add animation: ${a.name}`, sec: 'Animate', run: () => add(a.id) })),
  ]);

  return { add, setMode, get mode() { return mode; }, filtered, toggleStar, stars: () => [...stars] };
}

export { valuesFor };
