import { bus } from '../core/events.js';
import { askText } from './widgets/ask.js';
import { savePrefs } from './shell.js';
import { LANE_H } from './timeline/timeline-panel.js';

/**
 * Workspaces: how the panels are laid out, kept under a name. Four to start with
 * (Alt+1 to Alt+4); arrange the editor however you like and keep that too.
 */
const KEY = 'strike.workspaces';
const READY = [
  { id: 'cutting', name: 'Cutting', note: 'Big timeline', w: { drawer: false, right: 0.2, timeline: 0.52, lanes: 'M' } },
  { id: 'picture', name: 'Picture and colour', note: 'Big preview, wide Inspector', w: { drawer: false, right: 0.29, timeline: 0.28, lanes: 'A' } },
  { id: 'words', name: 'Text and captions', note: 'Text open, roomy preview', w: { drawer: true, pane: 'text', left: 0.25, right: 0.25, timeline: 0.34, lanes: 'A' } },
  { id: 'sound', name: 'Sound', note: 'Pads open, tall lanes', w: { drawer: true, pane: 'pads', left: 0.22, right: 0.22, timeline: 0.52, lanes: 'L' } },
];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function initWorkspaces({ store }) {
  const app = document.getElementById('app');
  let mine = [], on = '';
  try { mine = JSON.parse(localStorage.getItem(KEY) || '[]').filter(x => x && x.id && x.w).slice(0, 20); on = localStorage.getItem(KEY + '.on') || ''; } catch { /* storage off */ }
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(mine)); localStorage.setItem(KEY + '.on', on); return true; } catch { return false; } };
  const all = () => [...READY, ...mine];

  /** How it is laid out now, as shares of the window, so it fits any screen. */
  function capture() {
    const W = innerWidth, H = innerHeight;
    return { drawer: !app.classList.contains('drawer-closed'), pane: document.querySelector('#leftTabs .tab.is-active')?.dataset.tab || 'media',
      left: store.ui.leftW / W, right: store.ui.rightW / W, timeline: store.ui.timelineH / H, lanes: store.ui.trackSize || 'A' };
  }
  function apply(id) {
    const ws = all().find(x => x.id === id);
    if (!ws) return false;
    const W = innerWidth, H = innerHeight, w = ws.w;
    app.classList.add('is-arranging');
    if (w.left) store.ui.leftW = clamp(Math.round(w.left * W), 196, 460);
    if (w.right) store.ui.rightW = clamp(Math.round(w.right * W), 220, 480);
    if (w.timeline) store.ui.timelineH = clamp(Math.round(w.timeline * H), 168, H - 300);
    app.style.setProperty('--left-w', store.ui.leftW + 'px');
    app.style.setProperty('--right-w', store.ui.rightW + 'px');
    app.style.setProperty('--timeline-h', store.ui.timelineH + 'px');
    if (w.drawer) { bus.emit('drawer:show', w.pane || 'media'); if (app.classList.contains('drawer-closed')) document.getElementById('btnDrawer')?.click(); }
    else if (!app.classList.contains('drawer-closed')) document.getElementById('btnDrawer')?.click();
    const size = LANE_H[w.lanes] ? w.lanes : 'A';
    for (let i = 0; i < 4 && (store.ui.trackSize || 'A') !== size; i++) document.getElementById('btnTrackSize')?.click();
    savePrefs(store);
    on = id; keep();
    bus.emit('layout');
    setTimeout(() => { app.classList.remove('is-arranging'); bus.emit('layout'); }, 260);
    bus.emit('toast', { msg: ws.name, ms: 1400, key: 'workspace' });
    return true;
  }

  /** A little picture of the layout. */
  function picture(w) {
    const L = w.drawer ? clamp((w.left || 0.2) * 100, 14, 30) : 0, R = clamp((w.right || 0.22) * 100, 14, 32), T = clamp((w.timeline || 0.35) * 60, 14, 32), top = 60 - T;
    const x0 = 5 + (L ? L + 1.5 : 0), cw = 100 - x0 - R - 1.5;
    const lane = w.lanes === 'L' ? 7 : w.lanes === 'M' ? 5 : 4;
    let lanes = '';
    for (let y = top + 3, i = 0; y + lane < 58; y += lane + 1.6, i++) lanes += `<rect x="${4 + (i * 13) % 22}" y="${y}" width="${52 - (i * 9) % 26}" height="${lane}" rx="1" class="${['b', 'a', 'c'][i % 3]}"/>`;
    return `<svg viewBox="0 0 100 60" aria-hidden="true"><rect width="100" height="60" rx="4" class="g"/><rect x="1.5" y="4" width="2.5" height="${top - 6}" rx="1" class="p"/>${L ? `<rect x="5" y="4" width="${L}" height="${top - 6}" rx="1.6" class="p"/>` : ''}<rect x="${x0}" y="4" width="${cw}" height="${top - 6}" rx="1.6" class="p"/><rect x="${x0 + cw * 0.16}" y="${4 + (top - 6) * 0.16}" width="${cw * 0.68}" height="${(top - 6) * 0.62}" rx="1" class="v"/><rect x="${98.5 - R}" y="4" width="${R}" height="${top - 6}" rx="1.6" class="p"/><rect x="1.5" y="${top}" width="97" height="${T - 2}" rx="1.6" class="p"/>${lanes}</svg>`;
  }

  /* ── The menu ─────────────────────────────────────────────── */
  const btn = document.createElement('button');
  btn.className = 'btn btn--ghost btn--icon'; btn.id = 'btnWorkspace'; btn.title = 'Workspaces: switch how the editor is laid out (Alt+1 to Alt+4)'; btn.setAttribute('aria-label', 'Workspaces'); btn.setAttribute('aria-haspopup', 'menu');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v9M3 13h18"/></svg>';
  document.getElementById('btnSettings')?.before(btn);
  const pop = document.createElement('div');
  pop.className = 'wsp'; pop.id = 'workspaces'; pop.hidden = true; pop.setAttribute('role', 'menu');
  document.body.appendChild(pop);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const shut = () => { pop.hidden = true; };
  function draw() {
    pop.innerHTML = '';
    const grid = el('div', 'wsp__grid');
    all().forEach((ws, i) => {
      const own = mine.includes(ws);
      const c = el('div', 'wsp__cell');
      const b = el('button', 'wsp__card' + (on === ws.id ? ' is-on' : '')); b.dataset.ws = ws.id; b.setAttribute('role', 'menuitem');
      b.innerHTML = picture(ws.w);
      const t = el('span', 'wsp__t'); t.append(el('b', null, ws.name), el('i', null, own ? 'Yours' : ws.note)); b.appendChild(t);
      const kb = i < 9 ? window.gc?.keymap?.actions.find(a => a.id === 'ws-' + (i + 1))?.key : ''; if (kb) b.appendChild(el('kbd', null, kb));
      b.addEventListener('click', () => { apply(ws.id); shut(); });
      c.appendChild(b);
      if (own) {
        const a = el('div', 'wsp__acts');
        const up = el('button', null, 'Update'); up.title = 'Keep the layout you have now under this name'; up.addEventListener('click', () => { const was = ws.w; ws.w = capture(); on = ws.id; keep(); draw(); bus.emit('toast', { msg: `${ws.name} updated`, kind: 'ok', action: { label: 'Undo', run: () => { ws.w = was; keep(); } } }); });
        const de = el('button', null, 'Delete'); de.addEventListener('click', () => { const at = mine.indexOf(ws); mine.splice(at, 1); keep(); draw(); bus.emit('toast', { msg: `Deleted ${ws.name}`, ms: 7000, action: { label: 'Undo', run: () => { mine.splice(at, 0, ws); keep(); if (!pop.hidden) draw(); } } }); });
        a.append(up, de); c.appendChild(a);
      }
      grid.appendChild(c);
    });
    const add = el('button', 'wsp__add', '+ Keep the layout I have now'); add.id = 'workspaceSave';
    add.addEventListener('click', async () => { shut(); const w = capture(); const name = await askText({ title: 'Keep this layout', label: 'What is it for?', placeholder: 'Montages', ok: 'Keep', maxLength: 24 }); if (name) saveAs(name, w); });
    pop.append(grid, add);
  }
  function saveAs(name, w = capture()) {
    const ws = { id: 'w' + Date.now().toString(36), name: String(name).slice(0, 24), w };
    mine.push(ws); on = ws.id;
    if (!keep()) { mine.pop(); bus.emit('toast', { msg: 'That could not be saved on this computer.', kind: 'err' }); return null; }
    bus.emit('toast', { msg: `Kept “${ws.name}”`, kind: 'ok' });
    return ws;
  }
  btn.addEventListener('click', () => {
    if (!pop.hidden) { shut(); return; }
    draw(); pop.hidden = false;
    const r = btn.getBoundingClientRect();
    pop.style.top = r.bottom + 8 + 'px';
    pop.style.left = clamp(r.right - pop.offsetWidth, 8, innerWidth - pop.offsetWidth - 8) + 'px';
  });
  window.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) shut(); }, true);
  window.addEventListener('keydown', (e) => { if (!pop.hidden && e.key === 'Escape') { e.stopPropagation(); shut(); } }, true);

  bus.emit('palette:add', Array.from({ length: 9 }, (_, i) => ({ id: 'ws-' + (i + 1), name: i < READY.length ? `Workspace: ${READY[i].name}` : `Workspace ${i + 1} (your own)`, sec: 'View', key: 'Alt+' + (i + 1), viaKeymap: true,
    run: () => { const ws = all()[i]; if (ws) apply(ws.id); else bus.emit('toast', { msg: `You have no workspace ${i + 1} yet. The layout button next to Settings keeps one.` }); } })));
  return { apply, capture, saveAs, all, picture, get current() { return on; } };
}
