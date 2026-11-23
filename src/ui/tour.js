import { bus } from '../core/events.js';

/**
 * First-run tour: five stops, the first time someone opens the editor.
 *
 * Each stop rings one part of the window and says what it is for in a line or
 * two. Nothing is blocked while it runs — the ring and the card only point —
 * and Skip ends it for good. Help (?) can start it again.
 */

const KEY = 'strike.tourDone';

const STOPS = [
  { sel: '#tabMedia', t: 'Bring in your clips', d: 'Drop recordings anywhere on the window, or press Ctrl+I. The first one goes straight onto the timeline.' },
  { sel: '#tabAnim', t: 'Animations, ready to go', d: 'Kill counters, headshots, titles, subscribe buttons — 61 of them, each with its own sound. Click one to drop it at the playhead.' },
  { sel: '#timelinePanel', t: 'Cut on the timeline', d: 'S splits at the playhead, Delete removes, drag to move. Q shows any frame at full quality.' },
  { sel: '#modes', t: 'Edit · Library · Export', d: 'Library shows every animation big and moving. Export makes the video file when you are done.' },
  { sel: '#btnSearch', t: 'Lost? Ctrl+K', d: 'Type what you want to do — "zoom", "captions", "kill counter" — and it is there.' },
];

export function initTour() {
  let root = null, i = 0;

  function place() {
    if (!root) return;
    const s = STOPS[i];
    const el = document.querySelector(s.sel);
    const hole = root.querySelector('.tourx__hole');
    const card = root.querySelector('.tourx__card');
    const r = el?.getBoundingClientRect();
    if (!r || !r.width) { hole.style.opacity = '0'; card.style.left = `${innerWidth / 2 - 170}px`; card.style.top = `${innerHeight / 2 - 90}px`; }
    else {
      hole.style.opacity = '1';
      Object.assign(hole.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      const cw = 340, ch = card.offsetHeight || 190;
      let x = r.right + 18, y = r.top;
      if (x + cw > innerWidth - 12) x = Math.max(12, r.left - cw - 18);
      if (x < 12 || r.width > innerWidth * 0.6) { x = Math.min(innerWidth - cw - 12, Math.max(12, r.left + r.width / 2 - cw / 2)); y = r.top > innerHeight / 2 ? r.top - ch - 18 : r.bottom + 18; }
      card.style.left = `${x}px`; card.style.top = `${Math.max(12, Math.min(innerHeight - ch - 12, y))}px`;
    }
    card.querySelector('.tourx__steps').innerHTML = STOPS.map((_, k) => `<i class="${k <= i ? 'is-on' : ''}"></i>`).join('');
    card.querySelector('b').textContent = s.t;
    card.querySelector('p').textContent = s.d;
    card.querySelector('[data-next]').textContent = i === STOPS.length - 1 ? 'Start editing' : 'Next';
  }

  function end(done = true) {
    root?.remove(); root = null;
    window.removeEventListener('resize', place);
    if (done) { try { localStorage.setItem(KEY, '1'); } catch { /* private */ } }
  }

  function start() {
    end(false);
    i = 0;
    root = document.createElement('div');
    root.className = 'tourx';
    root.id = 'tourx';
    root.innerHTML = `<div class="tourx__hole"></div>
      <div class="tourx__card" role="dialog" aria-label="Quick tour">
        <div class="tourx__steps"></div><b></b><p></p>
        <div class="tourx__row"><button class="btn btn--primary" data-next>Next</button><button class="tourx__skip" data-skip>Skip the tour</button></div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('[data-next]').addEventListener('click', () => { if (++i >= STOPS.length) end(); else place(); });
    root.querySelector('[data-skip]').addEventListener('click', () => end());
    window.addEventListener('resize', place);
    requestAnimationFrame(place);
  }

  /** The first time the editor itself opens on this computer (never under automated tests). */
  function maybeStart() {
    let done = false;
    try { done = !!localStorage.getItem(KEY); } catch { /* private */ }
    if (done || navigator.webdriver) return;
    setTimeout(() => { if (!document.getElementById('app')?.classList.contains('is-home')) start(); }, 900);
  }
  bus.on('editor:open', maybeStart);
  bus.on('tour:start', start);
  window.addEventListener('keydown', (e) => { if (root && e.key === 'Escape') { e.stopPropagation(); end(); } }, true);
  bus.emit('palette:add', [{ id: 'quicktour', name: 'Quick tour of the editor', sec: 'App', run: start }]);
  return { start, end, get open() { return !!root; } };
}
