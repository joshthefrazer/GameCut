import { bus } from '../core/events.js';
import { typing, editorCovered } from '../shortcuts.js';

/**
 * Your own keys.
 *
 * Every action the palette knows (Ctrl+K) can be given any key. The editor's own
 * keys keep working until you give an action a different one; then its old key does
 * nothing, so nothing happens twice.
 */
const KEY = 'strike.keys';
const FIXED = new Set(['Left', 'Right', 'Up', 'Down', 'Shift+Left', 'Shift+Right', 'Alt+Left', 'Alt+Right', 'Home', 'End', 'Enter', 'Esc', 'Tab', 'Shift+Tab', 'Backspace', 'F1', '?', 'Ctrl+K', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y', 'Ctrl+E', 'Alt+F4', 'Ctrl+W', 'Ctrl+R', 'Ctrl+Q', 'F5', 'F11', 'F12']);
const STAY = new Set(['undo', 'redo', 'palette']);   // also in the window's own menu: these keys cannot be taken away
const NAMES = { ' ': 'Space', Delete: 'Del', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc' };

/** A key press as text: "Ctrl+Shift+S", "Alt+1", "Space". Empty for a bare modifier. */
export function comboOf(e) {
  let k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Process', 'Unidentified'].includes(k)) return '';
  if (/^Key[A-Z]$/.test(e.code) && (e.altKey || e.ctrlKey || k.length !== 1)) k = e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) k = 'Num' + e.code.slice(6);
  k = NAMES[k] || (k.length === 1 ? k.toUpperCase() : k);
  const symbol = k.length === 1 && !/[A-Z0-9]/.test(k) && k.toLowerCase() === k.toUpperCase();
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && !symbol ? 'Shift+' : '') + k;
}
const norm = (k) => String(k || '').replace('−', '-').trim();

export function initKeymap() {
  let mine = {};
  try { mine = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* storage off */ }
  let actions = [], count = -1, byCombo = new Map(), dead = new Set();

  function index(force) {
    let list = [];
    bus.emit('palette:list', (a) => { list = a; });
    if (!force && list.length === count) return;
    actions = list; count = list.length;
    byCombo = new Map(); dead = new Set();
    for (const a of actions) {
      if (a.key0 === undefined) a.key0 = norm(a.key);
      const own = mine[a.id];
      a.key = own !== undefined ? own : a.key0;
      if (own) byCombo.set(own, a);
      else if (own === undefined && a.viaKeymap && a.key0) byCombo.set(a.key0, a);
      if (own !== undefined && own !== a.key0 && a.key0 && !STAY.has(a.id)) dead.add(a.key0);
    }
    for (const a of actions) if (mine[a.id] === undefined && a.key0) dead.delete(a.key0);
    for (const k of byCombo.keys()) dead.delete(k);
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(mine)); } catch { /* storage off */ } index(true); bus.emit('keys:changed'); }

  window.addEventListener('keydown', (e) => {
    if (typing() || editorCovered() || window.gc?.pads?.recording) return;
    const c = comboOf(e);
    if (!c) return;
    index();
    const a = byCombo.get(c);
    if (a) { e.preventDefault(); e.stopImmediatePropagation(); a.run(); return; }
    if (dead.has(c)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  /** Who has this key now (not counting `except`). */
  const holder = (combo, except) => actions.find(a => a.id !== except && a.key === combo) || null;
  function set(id, combo) {
    const a = actions.find(x => x.id === id);
    if (!a) return { ok: false };
    if (combo && FIXED.has(combo) && combo !== a.key0) return { ok: false, why: `${combo} always does the same thing in Strike, so it cannot be used for something else.` };
    if (combo && /^(Shift\+)?[^+]{0,0}$/.test(combo)) return { ok: false, why: 'Press a key.' };
    const other = combo ? holder(combo, id) : null;
    if (other && STAY.has(other.id)) return { ok: false, why: `${combo} is ${other.name}, which has to keep its key.` };
    if (other) mine[other.id] = '';
    if (combo === a.key0) delete mine[id]; else mine[id] = combo;
    save();
    return { ok: true, took: other };
  }
  function reset(id) {
    index(true);
    if (!id) { mine = {}; save(); return { ok: true }; }
    const a = actions.find(x => x.id === id);
    if (!a) return { ok: false };
    const other = a.key0 ? holder(a.key0, id) : null;
    if (other) mine[other.id] = '';
    delete mine[id]; save();
    return { ok: true, took: other };
  }

  /* ── The sheet ────────────────────────────────────────────── */
  const el = document.createElement('div');
  el.className = 'pal qold'; el.id = 'keysPanel'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Keyboard shortcuts');
  document.body.appendChild(el);
  let recording = null, query = '', note = '';
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  function open() { index(true); recording = null; query = ''; note = ''; el.hidden = false; draw(); el.querySelector('#keysFind')?.focus(); }
  function close() { recording = null; el.hidden = true; }
  function draw() {
    const top = el.querySelector('.keys__list')?.scrollTop || 0;
    el.innerHTML = '';
    const box = h('div', 'pal__box qold__box keys__box');
    const head = h('div', 'vers__head');
    head.append(h('b', null, 'Keyboard shortcuts'), h('span', null, 'Click a key to change it, then press the new one. Anything in Strike can have a key.'));
    const done = h('button', 'btn btn--ghost btn--sm', 'Done'); done.id = 'keysDone'; done.addEventListener('click', close); head.appendChild(done);
    const bar = h('div', 'keys__bar');
    const find = h('input'); find.id = 'keysFind'; find.type = 'search'; find.placeholder = 'Find an action or a key'; find.value = query;
    find.addEventListener('input', () => { query = find.value; rows(); });
    const n = Object.keys(mine).length;
    const all = h('button', 'btn btn--ghost btn--sm', n ? `Reset all (${n} changed)` : 'All as they came'); all.id = 'keysReset'; all.disabled = !n;
    all.addEventListener('click', () => { const keep = { ...mine }; reset(); note = 'Every key is back to how it came.'; draw(); bus.emit('toast', { msg: 'Shortcuts reset', ms: 7000, action: { label: 'Undo', run: () => { mine = keep; save(); if (!el.hidden) draw(); } } }); });
    bar.append(find, all);
    const say = h('div', 'keys__note', note); say.setAttribute('role', 'status'); say.hidden = !note;
    const list = h('div', 'pal__list keys__list');
    box.append(head, bar, say, list); el.appendChild(box);
    function rows() {
      list.innerHTML = '';
      const q = query.trim().toLowerCase();
      const secs = new Map();
      for (const a of actions) {
        if (q && !(a.name + ' ' + a.key + ' ' + (a.sec || '')).toLowerCase().includes(q)) continue;
        const s = a.sec || 'Other'; if (!secs.has(s)) secs.set(s, []); secs.get(s).push(a);
      }
      for (const [s, as] of secs) {
        list.appendChild(h('h4', 'keys__sec', s));
        for (const a of as) {
          const r = h('div', 'keys__row'); r.dataset.id = a.id;
          r.appendChild(h('span', null, a.name));
          const k = h('button', 'keys__key' + (recording === a.id ? ' is-rec' : '') + (mine[a.id] !== undefined ? ' is-mine' : ''), recording === a.id ? 'Press a key…' : a.key || 'None');
          k.title = 'Change this key';
          k.addEventListener('click', () => { recording = recording === a.id ? null : a.id; note = recording ? 'Press the new key. Esc cancels, Backspace leaves it with no key.' : ''; draw(); });
          r.appendChild(k);
          const x = h('button', 'keys__x', '↺'); x.title = a.key0 ? `Back to ${a.key0}` : 'Back to no key'; x.setAttribute('aria-label', x.title); x.style.visibility = mine[a.id] !== undefined ? '' : 'hidden';
          x.addEventListener('click', () => { const res = reset(a.id); note = res.took ? `Back to ${a.key0}. “${res.took.name}” had it, and has no key now.` : ''; draw(); });
          r.appendChild(x); list.appendChild(r);
        }
      }
      if (!list.children.length) list.appendChild(h('div', 'pal__none', `Nothing matches “${query}”.`));
    }
    rows();
    list.scrollTop = top;
    if (recording) document.activeElement?.blur?.();
  }
  window.addEventListener('keydown', (e) => {
    if (el.hidden) return;
    if (recording) {
      const c = comboOf(e);
      e.preventDefault(); e.stopImmediatePropagation();
      if (!c) return;
      const id = recording;
      if (c === 'Esc') { recording = null; note = ''; draw(); return; }
      const res = set(id, c === 'Backspace' ? '' : c);
      if (!res.ok) { note = res.why || 'That key cannot be used.'; draw(); return; }
      recording = null;
      note = res.took ? `${c} was “${res.took.name}”, which has no key now.` : c === 'Backspace' ? 'It has no key now.' : `${c} it is.`;
      draw();
    } else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }, true);
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  bus.on('keys:open', open);
  bus.emit('palette:add', [{ id: 'keys', name: 'Change keyboard shortcuts', sec: 'App', run: open }]);
  setTimeout(() => index(true), 0);
  return { open, close, set, reset, comboOf, get mine() { return { ...mine }; }, get actions() { index(); return actions; } };
}
