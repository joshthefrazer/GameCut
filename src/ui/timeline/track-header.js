export const GROUP_LABEL = { text: 'TEXT & GRAPHICS', video: 'VIDEO', audio: 'AUDIO' };

const KIND_COLOR = { video: '#3b82f6', audio: '#14b8a6', text: '#8b5cf6' };

const ICON = {
  eyeOn:  `<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24"><path d="M4 4l16 16"/><path d="M9.9 5.3A9.7 9.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.4 7.4A17 17 0 0 0 2 12s4 7 10 7c1.4 0 2.7-.3 3.8-.8"/></svg>`,
  lock:   `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  unlock: `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-1.9"/></svg>`,
  trash:  `<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>`,
  speaker:`<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>`,
  muted:  `<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/></svg>`,
  chev:   `<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>`,
  plus:   `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
};

/**
 * DOM track headers, row for row with the canvas lanes.
 *
 * Lanes are grouped by what they hold — TEXT & GRAPHICS, VIDEO, AUDIO — with
 * the group's name on a band that folds it away and a + that adds a lane of
 * that kind exactly where it belongs. The lowest picture lane is labelled
 * "main" (it is what the finished video is built on) and the lanes above it
 * "front", because the top of the list is always in front in the picture.
 * Double-click a lane's name to rename it.
 */
export function renderTrackHeaders(root, store, L, cmds, menu = null, { fold } = {}) {
  root.innerHTML = `<div class="th-spacer">Tracks</div>`;
  const wrap = document.createElement('div');
  wrap.className = 'th-wrap';
  wrap.style.transform = `translateY(${-store.ui.scrollY}px)`;
  root.appendChild(wrap);

  const laneH = L.laneH ? L.laneH() : 54;
  const mainId = [...store.doc.tracks].reverse().find(t => t.kind === 'video')?.id;
  let kind = null;
  for (const track of store.doc.tracks) {
    if (track.kind !== kind) {
      kind = track.kind;
      const folded = !!store.ui.folded?.[kind];
      const n = store.doc.tracks.filter(t => t.kind === kind).length;
      const g = document.createElement('div');
      g.className = 'thg' + (folded ? ' is-folded' : '');
      g.dataset.group = kind;
      g.style.setProperty('--th-color', KIND_COLOR[kind]);
      g.innerHTML = `
        <button class="thg__fold" data-fold="${kind}" aria-expanded="${!folded}" title="${folded ? 'Show' : 'Fold away'} these lanes">${ICON.chev}<span>${GROUP_LABEL[kind]}</span>${folded ? `<i>${n}</i>` : ''}</button>
        <button class="thg__add" data-add="${kind}" title="Add a ${kind} lane" aria-label="Add a ${kind} lane">${ICON.plus}</button>`;
      wrap.appendChild(g);
    }
    if (store.ui.folded?.[kind]) continue;

    const el = document.createElement('div');
    el.className = 'th' + (store.rt.activeTrack === track.id ? ' is-active' : '') + (track.locked ? ' is-locked' : '');
    el.style.height = laneH + 'px';
    el.style.setProperty('--th-color', track.color || KIND_COLOR[track.kind]);
    el.dataset.track = track.id;
    const tag = track.id === mainId ? 'main' : track.kind === 'video' ? 'front' : '';
    el.innerHTML = `
      <span class="th__grip" data-grip title="Drag to move this lane up or down"><span class="th__dot"></span></span>
      <div class="th__label">
        <div class="th__name" title="Double-click to rename">${escape(track.name)}</div>
        ${tag ? `<span class="th__tag th__tag--${tag}">${tag}</span>` : ''}
      </div>
      <div class="th__btns">
        ${track.kind === 'audio'
          ? `<button class="th__b ${track.solo ? 'is-on' : ''}" data-flag="solo" title="Solo: hear only this lane">S</button>`
          : `<button class="th__b ${track.hidden ? 'is-off' : ''}" data-flag="hidden" title="${track.hidden ? 'Show' : 'Hide'} this lane">${track.hidden ? ICON.eyeOff : ICON.eyeOn}</button>`}
        ${track.kind === 'text' ? '' :
          `<button class="th__b ${track.muted ? 'is-off' : ''}" data-flag="muted" title="${track.muted ? 'Unmute' : 'Mute'} this lane">${track.muted ? ICON.muted : ICON.speaker}</button>`}
        <button class="th__b ${track.locked ? 'is-off' : ''}" data-flag="locked" title="${track.locked ? 'Unlock' : 'Lock: nothing on this lane can be changed'}">${track.locked ? ICON.lock : ICON.unlock}</button>
        <button class="th__b th__del" data-del title="Delete this lane" aria-label="Delete track ${escape(track.name)}">${ICON.trash}</button>
      </div>`;
    wrap.appendChild(el);
  }

  root.onclick = (e) => {
    const f = e.target.closest('[data-fold]');
    if (f) { fold?.(f.dataset.fold); return; }
    const addBtn = e.target.closest('[data-add]');
    if (addBtn && menu?.forAddLane) {
      // The ready-made lanes of this group's kind (Voice / Music / SFX for sound).
      const r = addBtn.getBoundingClientRect();
      menu.forAddLane(r.left, r.bottom + 4, addBtn.dataset.add);
      return;
    }
    if (addBtn) {
      const made = cmds.addTrack(addBtn.dataset.add);
      if (made) {
        if (store.ui.folded?.[made.kind]) fold?.(made.kind);
        store.setRT({ activeTrack: made.id });
      }
      return;
    }
    const b = e.target.closest('[data-flag]');
    const row = e.target.closest('.th');
    if (!row?.dataset.track) return;
    const track = store.doc.tracks.find(t => t.id === row.dataset.track);
    if (!track) return;
    if (e.target.closest('[data-del]')) {
      const r = e.target.closest('[data-del]').getBoundingClientRect();
      if (menu) menu.deleteTrack(track, r.left, r.bottom + 4);
      else if (!track.clips.length) cmds.removeTrack(track.id);
      return;
    }
    if (b) {
      const flag = b.dataset.flag;
      cmds.setTrackFlag(track.id, flag, !track[flag]);
    } else {
      store.setRT({ activeTrack: track.id });
    }
  };

  root.ondblclick = (e) => {
    const name = e.target.closest('.th__name');
    const row = e.target.closest('.th');
    if (!name || !row) return;
    const track = store.doc.tracks.find(t => t.id === row.dataset.track);
    if (!track) return;
    const input = document.createElement('input');
    input.className = 'th__rename';
    input.value = track.name;
    input.setAttribute('aria-label', 'Lane name');
    name.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (keep && v && v !== track.name) cmds.renameTrack(track.id, v.slice(0, 40));
      else renderTrackHeaders(root, store, L, cmds, menu, { fold });
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  };

  /* Drag a lane's grip up or down to reorder it among lanes of its kind. */
  root.onpointerdown = (e) => {
    const grip = e.target.closest('[data-grip]');
    const row = grip?.closest('.th');
    if (!row || e.button !== 0) return;
    const track = store.doc.tracks.find(t => t.id === row.dataset.track);
    if (!track) return;
    e.preventDefault();
    const rows = [...root.querySelectorAll('.th')].filter(r => store.doc.tracks.find(t => t.id === r.dataset.track)?.kind === track.kind);
    let target = null;
    row.classList.add('is-dragging');
    const move = (ev) => {
      target = null;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        r.classList.toggle('is-drop', false);
        if (ev.clientY >= b.top && ev.clientY < b.bottom && r !== row) { target = r; r.classList.add('is-drop'); }
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      row.classList.remove('is-dragging');
      rows.forEach(r => r.classList.remove('is-drop'));
      if (target) {
        const to = store.doc.tracks.findIndex(t => t.id === target.dataset.track);
        cmds.moveTrackTo(track.id, to);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  root.onscroll = () => { if (root.scrollTop) root.scrollTop = 0; };
  root.scrollTop = 0;

  root.oncontextmenu = (e) => {
    const row = e.target.closest('.th');
    const track = row?.dataset.track && store.doc.tracks.find(t => t.id === row.dataset.track);
    if (!track || !menu) return;
    e.preventDefault();
    menu.forTrack(track, e.clientX, e.clientY);
  };
}

const escape = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
