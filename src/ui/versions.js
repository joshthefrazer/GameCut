import { bus } from '../core/events.js';

/**
 * Version history: go back to how the project looked earlier — an hour ago,
 * before the highlight reel, after a crash. Snapshots are kept in the project
 * file by the library; this is the list you pick from.
 */
export function initVersions({ library }) {
  const el = document.createElement('div');
  el.className = 'pal vers';
  el.id = 'versions';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Version history');
  document.body.appendChild(el);

  const when = (ms) => {
    const d = new Date(ms), now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `Today ${time}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
    return `${d.toLocaleDateString()} ${time}`;
  };
  const len = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function open() {
    const list = library.versions().slice().reverse();
    el.innerHTML = `
      <div class="pal__box vers__box">
        <div class="vers__head"><b>Version history</b><span>Saved automatically every few minutes, and before big automatic edits.</span>
          <button class="btn btn--ghost btn--sm" data-close aria-label="Close">Close</button></div>
        <div class="pal__list vers__list">${list.length ? '' : '<div class="pal__none">No earlier versions yet — one is kept every five minutes while you work.</div>'}</div>
      </div>`;
    const box = el.querySelector('.vers__list');
    for (const v of list) {
      const row = document.createElement('div');
      row.className = 'vers__row';
      row.innerHTML = `<div><b>${when(v.at)}</b><span>${v.label ? v.label + ' · ' : ''}${v.clips} clip${v.clips === 1 ? '' : 's'} · ${len(v.duration || 0)} long</span></div>`;
      const b = document.createElement('button');
      b.className = 'btn btn--ghost btn--sm';
      b.dataset.at = v.at;
      b.textContent = 'Go back to this';
      b.addEventListener('click', () => {
        if (library.restoreVersion(v.at)) {
          close();
          bus.emit('toast', { msg: `Back to ${when(v.at)} — Ctrl+Z if that was not the one`, kind: 'ok', ms: 4200 });
        }
      });
      row.appendChild(b);
      box.appendChild(row);
    }
    el.hidden = false;
  }
  function close() { el.hidden = true; }
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  window.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
  document.getElementById('btnVersions')?.addEventListener('click', open);
  bus.emit('palette:add', [{ id: 'versions', name: 'Version history: go back to an earlier version', sec: 'Project', run: open }]);
  return { open, close };
}
