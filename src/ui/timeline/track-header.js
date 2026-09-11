const KIND_COLOR = { video: '#4f7dff', audio: '#20c997', text: '#ffa93c' };

const ICON = {
  eyeOn:  `<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24"><path d="M4 4l16 16"/><path d="M9.9 5.3A9.7 9.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.4 7.4A17 17 0 0 0 2 12s4 7 10 7c1.4 0 2.7-.3 3.8-.8"/></svg>`,
  lock:   `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  unlock: `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-1.9"/></svg>`,
};

/** DOM track headers, vertically synced with the canvas track area. */
export function renderTrackHeaders(root, store, L, cmds) {
  root.innerHTML = `<div class="th-spacer">Tracks</div>`;
  const wrap = document.createElement('div');
  wrap.style.transform = `translateY(${-store.ui.scrollY}px)`;
  root.appendChild(wrap);

  for (const track of store.doc.tracks) {
    const el = document.createElement('div');
    el.className = 'th' + (store.rt.activeTrack === track.id ? ' is-active' : '');
    el.style.height = track.height + 'px';
    el.style.setProperty('--th-color', KIND_COLOR[track.kind]);
    el.dataset.track = track.id;
    el.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="th__name">${escape(track.name)}</div>
        <div class="th__kind">${track.kind}</div>
      </div>
      <div class="th__btns">
        ${track.kind === 'audio'
          ? `<button class="th__b ${track.solo ? 'is-on' : ''}" data-flag="solo" title="Solo">S</button>`
          : `<button class="th__b ${track.hidden ? 'is-off' : 'is-on'}" data-flag="hidden" title="Hide track">${track.hidden ? ICON.eyeOff : ICON.eyeOn}</button>`}
        ${track.kind === 'text' ? '' :
          `<button class="th__b ${track.muted ? 'is-off' : ''}" data-flag="muted" title="Mute this track">M</button>`}
        <button class="th__b ${track.locked ? 'is-off' : ''}" data-flag="locked" title="Lock track">${track.locked ? ICON.lock : ICON.unlock}</button>
      </div>`;
    wrap.appendChild(el);
  }

  const add = document.createElement('div');
  add.className = 'th th--add';
  add.style.height = '30px';
  // Spelled out rather than "+V / +T / +A". The abbreviations saved 30 pixels
  // and cost every first-time user a guess about what a lane even is.
  add.innerHTML = `<button class="th__add" data-add="video">+ Video</button>
                   <button class="th__add" data-add="text">+ Text</button>
                   <button class="th__add" data-add="audio">+ Audio</button>`;
  wrap.appendChild(add);

  root.onclick = (e) => {
    const addBtn = e.target.closest('[data-add]');
    if (addBtn) { cmds.addTrack(addBtn.dataset.add); return; }
    const b = e.target.closest('[data-flag]');
    const row = e.target.closest('.th');
    if (!row?.dataset.track) return;
    const track = store.doc.tracks.find(t => t.id === row.dataset.track);
    if (!track) return;
    if (b) {
      const flag = b.dataset.flag;
      cmds.setTrackFlag(track.id, flag, !track[flag]);
    } else {
      store.setRT({ activeTrack: track.id });
    }
  };
  void L;
}

const escape = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
