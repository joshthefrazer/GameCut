import { clamp } from '../core/time.js';
import { bus } from '../core/events.js';

/** Panel resizing, tab groups, toasts. Pure chrome — no document access. */
export function initShell(store) {
  const app = document.getElementById('app');

  const apply = () => {
    app.style.setProperty('--left-w', store.ui.leftW + 'px');
    app.style.setProperty('--right-w', store.ui.rightW + 'px');
    app.style.setProperty('--timeline-h', store.ui.timelineH + 'px');
  };
  apply();

  /* ── Gutter drags ──────────────────────────────────────────── */
  for (const g of document.querySelectorAll('.gutter')) {
    g.addEventListener('pointerdown', (e) => {
      const kind = g.dataset.resize;
      const startX = e.clientX, startY = e.clientY;
      const from = { left: store.ui.leftW, right: store.ui.rightW, bottom: store.ui.timelineH }[kind];
      g.setPointerCapture(e.pointerId);
      g.classList.add('is-active');
      document.body.style.cursor = kind === 'bottom' ? 'row-resize' : 'col-resize';

      const move = (ev) => {
        if (kind === 'left')  store.ui.leftW  = clamp(from + (ev.clientX - startX), 196, 460);
        if (kind === 'right') store.ui.rightW = clamp(from - (ev.clientX - startX), 220, 480);
        if (kind === 'bottom') store.ui.timelineH = clamp(from - (ev.clientY - startY), 168, window.innerHeight - 300);
        apply();
        bus.emit('layout');
      };
      const up = () => {
        g.classList.remove('is-active');
        document.body.style.cursor = '';
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        savePrefs(store);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /* ── Tab groups ────────────────────────────────────────────── */
  for (const group of document.querySelectorAll('.tabs')) {
    group.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      const body = group.parentElement.querySelector('.panel__body');
      group.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t === tab));
      body.querySelectorAll('.tabpane').forEach(p =>
        p.classList.toggle('is-active', p.dataset.pane === tab.dataset.tab));
      bus.emit('layout');
    });
  }

  /* ── Rail + drawer ─────────────────────────────────────────── */
  const rail = document.getElementById('leftTabs');
  const drawer = document.getElementById('leftPanel');
  const titleEl = document.getElementById('drawerTitle');
  const DRAWER_KEY = 'gamecut.drawer';
  const setDrawer = (open) => {
    app.classList.toggle('drawer-closed', !open);
    try { localStorage.setItem(DRAWER_KEY, open ? 'open' : 'closed'); } catch { /* private */ }
    const c = document.getElementById('btnDrawer');
    if (c) c.title = open ? 'Hide the drawer for a bigger preview' : 'Show the drawer';
    bus.emit('layout');
  };
  /** Open the drawer on one of its panes (media, text, gfx, trans). */
  const showPane = (name) => {
    const tab = rail?.querySelector(`[data-tab="${name}"]`);
    if (!tab || !drawer) return;
    rail.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t === tab));
    drawer.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('is-active', p.dataset.pane === name));
    if (titleEl) titleEl.textContent = tab.querySelector('span')?.textContent === 'Cuts' ? 'Transitions' : (tab.querySelector('span')?.textContent || '');
    if (app.classList.contains('drawer-closed')) setDrawer(true); else bus.emit('layout');
  };
  rail?.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showPane(tab.dataset.tab);
  });
  document.getElementById('btnDrawer')?.addEventListener('click', () => setDrawer(app.classList.contains('drawer-closed')));
  document.getElementById('btnDrawerClose')?.addEventListener('click', () => setDrawer(false));
  bus.on('drawer:show', (name) => showPane(name));
  try { if (localStorage.getItem(DRAWER_KEY) === 'closed') app.classList.add('drawer-closed'); } catch { /* private */ }

  /* ── Toasts ────────────────────────────────────────────────── */
  const stack = document.getElementById('toasts');
  /** Keep the stack centred over the top of the preview, wherever that is. */
  const placeToasts = () => {
    const vp = document.getElementById('previewViewport') || document.getElementById('previewPanel');
    const r = vp?.getBoundingClientRect();
    if (!r || !r.width) { stack.style.removeProperty('--toast-x'); stack.style.removeProperty('--toast-y'); return; }
    stack.style.setProperty('--toast-x', Math.round(r.left + r.width / 2) + 'px');
    stack.style.setProperty('--toast-y', Math.round(r.top + 58) + 'px');
  };
  bus.on('layout', placeToasts);
  window.addEventListener('resize', placeToasts);
  // `ms` is optional: a passing confirmation can go in 2.6s, but something the
  // person actually has to read and act on needs longer than a glance.
  //
  // `action: { label, run }` puts a button in the toast — "Deleted 3 clips
  // [Undo]". It is the cheapest safety net there is: the mistake and the way
  // back are on screen at the same moment, and nobody has to know Ctrl+Z.
  // Clicking it runs the action and takes the toast away.
  //
  // `key` makes a toast replace the previous one with the same key, so ten
  // presses of Ctrl+Z leave one "Undid …" toast rather than a tower of them.
  bus.on('toast', ({ msg, kind, ms, action, key }) => {
    if (key) for (const old of stack.querySelectorAll('.toast')) if (old.dataset.key === key) old.remove();
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ` toast--${kind}` : '') + (action ? ' toast--act' : '');
    if (key) el.dataset.key = key;
    const text = document.createElement('span');
    text.textContent = msg;
    el.appendChild(text);
    let timer = 0;
    const dismiss = () => {
      clearTimeout(timer);
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px)';
      setTimeout(() => el.remove(), 260);
    };
    if (action?.label && typeof action.run === 'function') {
      const b = document.createElement('button');
      b.className = 'toast__act';
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => { dismiss(); action.run(); });
      el.appendChild(b);
    }
    placeToasts();
    stack.appendChild(el);
    // Three at most: an old message is less use than the space it takes.
    while (stack.children.length > 3) stack.firstElementChild.remove();
    // A toast with a button has to stay long enough to reach for it.
    timer = setTimeout(dismiss, Math.max(action ? 4000 : 1200, ms || (action ? 5000 : 2600)));
  });

  window.addEventListener('resize', () => bus.emit('layout'));
  // A timeline you can actually work in: about two fifths of the window,
  // unless you have dragged it to a size you prefer.
  store.ui.timelineH = Math.max(store.ui.timelineH, Math.min(460, Math.round(window.innerHeight * 0.4)));
  apply();
  restorePrefs(store, apply);
}

const KEY = 'gamecut.layout.v2';
export function savePrefs(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      leftW: store.ui.leftW, rightW: store.ui.rightW, timelineH: store.ui.timelineH,
    }));
  } catch {}
}
function restorePrefs(store, apply) {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    Object.assign(store.ui, JSON.parse(raw));
    apply();
  } catch {}
}
