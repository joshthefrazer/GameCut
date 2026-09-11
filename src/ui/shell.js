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

  /* ── Toasts ────────────────────────────────────────────────── */
  const stack = document.getElementById('toasts');
  // `ms` is optional: a passing confirmation can go in 2.6s, but something the
  // person actually has to read and act on needs longer than a glance.
  bus.on('toast', ({ msg, kind, ms }) => {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ` toast--${kind}` : '');
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, Math.max(1200, ms || 2600));
  });

  window.addEventListener('resize', () => bus.emit('layout'));
  restorePrefs(store, apply);
}

const KEY = 'gamecut.layout.v1';
function savePrefs(store) {
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
