import { bus } from '../../core/events.js';
import { GALLERY, myThemes, saveMine, cleanTheme, checkTheme, themePicture, findTheme, mix } from './theme-core.js';

/**
 * Themes: a gallery, and a maker that repaints the whole editor as you change it.
 * A panel at the side, not a box in the middle: you have to be able to see what
 * you are changing.
 */
const COLOURS = [
  ['bg', 'Background', 'Behind everything'], ['panel', 'Panels', 'Boxes, menus, windows'], ['text', 'Text', ''],
  ['accent', 'Buttons', 'Export, Play, sliders'], ['highlight', 'Selection', 'What is picked, snaps, markers'], ['danger', 'Playhead and warnings', ''],
  ['video', 'Video clips', ''], ['audio', 'Sound clips', ''], ['title', 'Text clips', ''],
];
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

export function initThemeStudio({ current, use, preview }) {
  const root = el('aside', 'thst');
  root.id = 'themeStudio';
  root.hidden = true;
  root.setAttribute('aria-label', 'Themes');
  document.body.appendChild(root);
  let draft = null;      // the theme being made
  let before = null;     // what was on when the maker opened
  let isNew = false;
  let history = [], at = 0, commitTimer = 0;

  function open() { root.hidden = false; gallery(); }
  function close() { if (draft) cancel(); root.hidden = true; }
  root.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { if (draft) cancel(); else close(); } if (draft && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); step(e.shiftKey ? 1 : -1); } });

  const header = (title, sub, back) => {
    const h = el('div', 'thst__head');
    if (back) { const b = el('button', 'thst__icon', '‹'); b.title = 'Back'; b.setAttribute('aria-label', 'Back'); b.addEventListener('click', back); h.appendChild(b); }
    const w = el('div', 'thst__title'); w.append(el('b', null, title), el('span', null, sub)); h.appendChild(w);
    const x = el('button', 'thst__icon', '×'); x.id = 'themeClose'; x.title = 'Close'; x.setAttribute('aria-label', 'Close themes'); x.addEventListener('click', close); h.appendChild(x);
    return h;
  };

  /* ── Gallery ──────────────────────────────────────────────── */
  function card(t, own) {
    const wrap = el('div', 'thst__cell');
    const b = el('button', 'thst__card' + (current() === t.id ? ' is-on' : ''));
    b.dataset.theme = t.id;
    b.innerHTML = themePicture(t);
    const n = el('span', 'thst__name'); n.append(el('b', null, t.name), el('i', null, own ? 'Yours' : t.note)); b.appendChild(n);
    b.addEventListener('click', () => { use(t.id); for (const c of root.querySelectorAll('.thst__card')) c.classList.toggle('is-on', c === b); });
    wrap.appendChild(b);
    const acts = el('div', 'thst__cardacts');
    const act = (label, title, run) => { const a = el('button', null, label); a.title = title; a.addEventListener('click', run); acts.appendChild(a); return a; };
    if (own) { act('Edit', `Change ${t.name}`, () => make(t, false)); act('Delete', `Delete ${t.name}`, () => remove(t)); }
    else act('Make my own', `Start a theme of your own from ${t.name}`, () => make(t, true));
    wrap.appendChild(acts);
    return wrap;
  }
  function gallery() {
    draft = null;
    root.innerHTML = '';
    root.appendChild(header('Themes', 'Click one to wear it.'));
    const body = el('div', 'thst__body');
    const mine = myThemes();
    const neu = el('button', 'thst__new', '+ Make a theme'); neu.id = 'themeNew';
    neu.addEventListener('click', () => make(findTheme(current()) || GALLERY[0], true));
    body.appendChild(neu);
    if (mine.length) { body.appendChild(el('h4', null, 'Yours')); const g = el('div', 'thst__grid'); mine.forEach(t => g.appendChild(card(t, true))); body.appendChild(g); body.appendChild(el('h4', null, 'Made for Strike')); }
    const g = el('div', 'thst__grid'); GALLERY.forEach(t => g.appendChild(card(t, false))); body.appendChild(g);
    root.appendChild(body);
  }
  function remove(t) {
    const list = myThemes();
    const i = list.findIndex(x => x.id === t.id);
    if (i < 0) return;
    const wasOn = current() === t.id;
    saveMine(list.filter(x => x.id !== t.id));
    if (wasOn) use('strike');
    gallery();
    bus.emit('toast', { msg: `Deleted ${t.name}`, ms: 7000, action: { label: 'Undo', run: () => { const l = [...myThemes()]; l.splice(i, 0, t); saveMine(l); if (wasOn) use(t.id); if (!root.hidden && !draft) gallery(); } } });
  }

  /* ── Maker ────────────────────────────────────────────────── */
  function make(from, fresh) {
    before = current();
    isNew = fresh;
    const names = new Set([...GALLERY, ...myThemes()].map(t => t.name));
    let name = from.name;
    if (fresh) { name = `My ${from.name}`.slice(0, 26); for (let i = 2; names.has(name); i++) name = `My ${from.name}`.slice(0, 24) + ' ' + i; }
    draft = cleanTheme({ ...from, name }, fresh ? 'my-' + Date.now().toString(36) : from.id);
    history = [JSON.stringify(draft)]; at = 0;
    maker();
    preview(draft);
  }
  function cancel() { clearTimeout(commitTimer); draft = null; use(before); gallery(); }
  function change(patch, { redraw = false } = {}) {
    draft = cleanTheme({ ...draft, ...patch }, draft.id);
    preview(draft);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => { if (!draft) return; const s = JSON.stringify(draft); if (s !== history[at]) { history = history.slice(0, at + 1); history.push(s); if (history.length > 60) history.shift(); at = history.length - 1; } marks(); }, 350);
    if (redraw) maker(); else warn();
  }
  function step(d) {
    clearTimeout(commitTimer);
    if (!draft) return;
    const s = JSON.stringify(draft);
    if (s !== history[at]) { history = history.slice(0, at + 1); history.push(s); at = history.length - 1; }
    const n = at + d;
    if (n < 0 || n >= history.length) return;
    at = n; draft = JSON.parse(history[at]);
    preview(draft); maker();
  }
  function marks() { const u = root.querySelector('#themeUndo'), r = root.querySelector('#themeRedo'); if (u) u.disabled = at <= 0; if (r) r.disabled = at >= history.length - 1; }
  function save() {
    clearTimeout(commitTimer);
    const list = [...myThemes()];
    const i = list.findIndex(t => t.id === draft.id);
    if (i >= 0) list[i] = draft; else list.unshift(draft);
    const old = myThemes();
    if (!saveMine(list)) { saveMine(old); bus.emit('toast', { msg: 'There was no room to save that. Try a smaller picture, or delete a theme with one.', kind: 'err', ms: 6000 }); return; }
    const id = draft.id, name = draft.name;
    draft = null;
    use(id);
    gallery();
    bus.emit('toast', { msg: `${name} saved`, kind: 'ok' });
  }
  function warn() {
    const box = root.querySelector('.thst__warn');
    if (!box || !draft) return;
    const list = checkTheme(draft);
    box.innerHTML = '';
    box.classList.toggle('is-ok', !list.length);
    if (!list.length) { box.appendChild(el('span', null, '✓ Everything is easy to read')); return; }
    for (const p of list.slice(0, 4)) {
      const r = el('div'); r.appendChild(el('span', null, '⚠ ' + p.msg));
      const f = el('button', null, 'Fix'); f.title = `Change it to ${p.fix}`; f.addEventListener('click', () => change({ [p.key]: p.fix }, { redraw: true }));
      r.appendChild(f); box.appendChild(r);
    }
  }
  function maker() {
    const top = root.querySelector('.thst__body')?.scrollTop || 0;
    root.innerHTML = '';
    root.appendChild(header(isNew ? 'Make a theme' : 'Edit theme', 'The editor changes as you go.', cancel));
    const body = el('div', 'thst__body');
    const name = el('input', 'thst__in'); name.id = 'themeName'; name.value = draft.name; name.maxLength = 30; name.setAttribute('aria-label', 'Theme name');
    name.addEventListener('input', () => { draft.name = name.value; });
    body.appendChild(name);
    const warnBox = el('div', 'thst__warn'); warnBox.setAttribute('role', 'status'); body.appendChild(warnBox);

    body.appendChild(el('h4', null, 'Colours'));
    for (const [k, label, note] of COLOURS) {
      const row = el('label', 'thst__col');
      const c = el('input'); c.type = 'color'; c.value = draft[k]; c.dataset.key = k;
      const hex = el('input', 'thst__hex'); hex.value = draft[k]; hex.spellcheck = false; hex.setAttribute('aria-label', label + ' colour code');
      c.addEventListener('input', () => { hex.value = c.value; change({ [k]: c.value }); });
      hex.addEventListener('input', () => { const h = hex.value.trim().replace(/^(?!#)/, '#'); if (/^#[0-9a-f]{6}$/i.test(h)) { c.value = h; change({ [k]: h }); } });
      const t = el('span'); t.append(el('b', null, label)); if (note) t.append(el('i', null, note));
      row.append(c, t, hex); body.appendChild(row);
    }

    const seg = (label, key, opts) => {
      const r = el('div', 'thst__row'); r.appendChild(el('span', null, label));
      const s = el('div', 'thst__seg');
      for (const [v, n] of opts) { const b = el('button', draft[key] === v ? 'is-on' : '', n); b.dataset.v = key + ':' + v; b.addEventListener('click', () => change({ [key]: v }, { redraw: true })); s.appendChild(b); }
      r.appendChild(s); body.appendChild(r);
    };
    const slide = (label, key, max, fmt) => {
      const r = el('div', 'thst__row'); r.appendChild(el('span', null, label));
      const i = el('input', 'rng'); i.type = 'range'; i.min = 0; i.max = max; i.step = 0.01; i.value = draft[key]; i.setAttribute('aria-label', label); i.dataset.key = key;
      const o = el('output', null, fmt(draft[key]));
      i.addEventListener('input', () => { o.textContent = fmt(+i.value); change({ [key]: +i.value }); });
      r.append(i, o); body.appendChild(r);
    };
    const pc = (v) => Math.round(v * 100) + '%';
    body.appendChild(el('h4', null, 'Background'));
    seg('Style', 'backdrop', [['none', 'Plain'], ['glow', 'Glow'], ['gradient', 'Gradient'], ...(draft.image ? [['image', 'Picture']] : [])]);
    if (draft.backdrop === 'gradient') {
      const row = el('label', 'thst__col'); const c = el('input'); c.type = 'color'; c.value = draft.back2;
      c.addEventListener('input', () => change({ back2: c.value }));
      const t = el('span'); t.append(el('b', null, 'Second colour')); row.append(c, t); body.appendChild(row);
    }
    const pick = el('button', 'thst__new', draft.image ? 'Choose another picture…' : 'Use a picture of mine…'); pick.id = 'themePic';
    const file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.hidden = true; file.id = 'themePicFile';
    pick.addEventListener('click', () => file.click());
    file.addEventListener('change', () => { if (file.files[0]) picture(file.files[0]); });
    body.append(pick, file);
    if (draft.backdrop === 'image') slide('Darken it', 'dim', 0.9, pc);
    if (draft.backdrop !== 'none') slide('See-through panels', 'see', 0.45, pc);

    body.appendChild(el('h4', null, 'Shape and feel'));
    seg('Corners', 'radius', [[0.2, 'Sharp'], [0.6, 'Slight'], [1, 'Soft'], [1.6, 'Round']]);
    seg('Text size', 'size', [[0.9, 'Small'], [1, 'Normal'], [1.1, 'Big'], [1.2, 'Biggest']]);
    seg('Animations', 'motion', [[true, 'On'], [false, 'Off']]);
    slide('Glow', 'glow', 1, pc);
    root.appendChild(body);

    const foot = el('div', 'thst__foot');
    const u = el('button', 'thst__icon', '↶'); u.id = 'themeUndo'; u.title = 'Undo'; u.addEventListener('click', () => step(-1));
    const r = el('button', 'thst__icon', '↷'); r.id = 'themeRedo'; r.title = 'Redo'; r.addEventListener('click', () => step(1));
    const no = el('button', 'btn btn--ghost', 'Cancel'); no.id = 'themeCancel'; no.addEventListener('click', cancel);
    const ok = el('button', 'btn btn--primary', 'Save theme'); ok.id = 'themeSave'; ok.addEventListener('click', save);
    foot.append(u, r, el('i', 'thst__gap'), no, ok);
    root.appendChild(foot);
    body.scrollTop = top;
    warn(); marks();
  }
  /** Your picture, made small enough to keep with the theme. */
  async function picture(f) {
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
      if (!draft) return;
      change({ image: c.toDataURL('image/jpeg', 0.82), backdrop: 'image', see: draft.see || 0.2 }, { redraw: true });
    } catch { bus.emit('toast', { msg: 'That picture could not be opened. Try a PNG or JPG.', kind: 'err' }); }
  }

  bus.on('themes:open', open);
  bus.emit('palette:add', [{ id: 'themes', name: 'Themes: pick one or make your own', sec: 'App', run: open }]);
  void mix;
  return { open, close, get draft() { return draft; }, picture };
}
