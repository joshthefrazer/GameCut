import { bus } from '../../core/events.js';

/**
 * Clip Inbox, on the home screen: the recordings in your recording folders,
 * newest first, with the ones you have not seen yet marked NEW.
 *
 *   Open in editor   a new video with the recording on the timeline
 *   Quick short      a new 9:16 short, laid out so nothing is cut off
 *
 * The folders are watched, so a clip saved while Strike is open shows up by
 * itself. Nothing is copied: the recording is used where it is.
 */

const fmtDur = (s) => !(s > 0) ? '' : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtSize = (b) => b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString();
};
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A first-frame picture and the length of a recording, read lazily, two at a time. */
const peeks = new Map();
let running = 0;
const queue = [];
function peek(item) {
  if (peeks.has(item.path)) return peeks.get(item.path);
  const p = new Promise((resolve) => queue.push({ item, resolve }));
  peeks.set(item.path, p);
  pump();
  return p;
}
function pump() {
  while (running < 2 && queue.length) {
    const { item, resolve } = queue.shift();
    running++;
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'metadata';
    let done = false;
    const finish = (r) => { if (done) return; done = true; running--; v.removeAttribute('src'); v.load(); resolve(r); pump(); };
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(2, (Number.isFinite(v.duration) ? v.duration : 10) * 0.1); }, { once: true });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 320; c.height = Math.round(320 * (v.videoHeight || 180) / (v.videoWidth || 320));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        finish({ thumb: c.toDataURL('image/jpeg', 0.7), duration: Number.isFinite(v.duration) ? v.duration : 0, w: v.videoWidth, h: v.videoHeight });
      } catch { finish({ thumb: null, duration: v.duration || 0 }); }
    }, { once: true });
    v.addEventListener('error', () => finish({ thumb: null, duration: 0 }), { once: true });
    setTimeout(() => finish({ thumb: null, duration: 0 }), 12000);
    v.src = `gcmedia://${item.id}`;
  }
}

export function initInbox({ store, cmds, startProject, library }) {
  const api = window.gamecut?.inbox;
  const root = document.getElementById('homeInbox');
  if (!root || !api) { if (root) root.hidden = true; return {}; }
  let data = { folders: [], items: [] };
  let showAll = false;

  async function refresh() {
    try { data = await api.list(); } catch { data = { folders: [], items: [] }; }
    paint();
  }

  function paint() {
    const items = showAll ? data.items : data.items.slice(0, 6);
    const fresh = data.items.filter(i => i.isNew).length;
    root.innerHTML = `
      <div class="home__head inbox__head">
        <b>Clip Inbox</b>
        <span class="home__count">${data.items.length ? `${data.items.length} recording${data.items.length === 1 ? '' : 's'}${fresh ? ` · ${fresh} new` : ''}` : ''}</span>
        <span class="inbox__folders">${data.folders.map(f => `<span class="inbox__folder" title="${esc(f.path)}">${esc(f.label)}<button data-unwatch="${esc(f.path)}" aria-label="Stop watching ${esc(f.label)}">×</button></span>`).join('')}</span>
        <button class="home__tidy" id="inboxAdd">+ Watch a folder</button>
      </div>
      ${data.items.length ? `<div class="inbox__grid">${items.map((it, i) => `
        <div class="inbox__item" data-i="${data.items.indexOf(it)}">
          <div class="inbox__pic"><img alt="" hidden><span class="inbox__len"></span>${it.isNew ? '<i class="inbox__new">NEW</i>' : ''}</div>
          <b title="${esc(it.name)}">${esc(it.name)}</b>
          <span class="inbox__meta">${esc(it.folder)} · ${ago(it.mtime)} · ${fmtSize(it.bytes)}${it.used ? ` · used in “${esc(it.used)}”` : ''}</span>
          <div class="inbox__acts">
            <button class="btn btn--ghost btn--sm" data-open="${i}">Open in editor</button>
            <button class="btn btn--primary btn--sm" data-short="${i}">Quick short</button>
          </div>
        </div>`).join('')}</div>
        ${data.items.length > 6 ? `<button class="home__tidy inbox__more" id="inboxMore">${showAll ? 'Show fewer' : `Show all ${data.items.length}`}</button>` : ''}`
        : `<p class="inbox__empty">${data.folders.length ? 'No recordings in your watched folders yet. New ones show up here by themselves.' : 'Watch the folder your recorder saves to (OBS, Medal, NVIDIA) and new clips show up here by themselves.'}</p>`}`;
    root.querySelectorAll('.inbox__item').forEach((card) => {
      const it = data.items[+card.dataset.i];
      peek(it).then((r) => {
        const img = card.querySelector('img');
        if (r?.thumb && img) { img.src = r.thumb; img.hidden = false; }
        const len = card.querySelector('.inbox__len');
        if (len) len.textContent = fmtDur(r?.duration);
      });
    });
  }

  /** Start a project from a recording. `short` makes it a laid-out 9:16. */
  async function use(it, short = false) {
    startProject(short ? 'short-blank' : 'youtube-blank');
    const { importRegistered } = await import('../../media/importer.js');
    const { placeAsset } = await import('../timeline/place-asset.js');
    const asset = await importRegistered({ path: it.path, id: it.id, name: it.name, bytes: it.bytes });
    if (!asset) return null;
    bus.emit('assets');
    const clip = placeAsset(store, cmds, asset.id, { start: 0 });
    if (short) {
      const { applyLayout } = await import('../../edit/layouts.js');
      applyLayout({ store, cmds }, 'blurFill', {});
    }
    api.used?.(it.path, store.doc.name || 'Untitled Project');
    bus.emit('toast', { msg: short ? `${it.name} — a 9:16 short with nothing cut off. Make vertical (on the preview) has more layouts.` : `${it.name} is on the timeline`, kind: 'ok', ms: 5000 });
    return clip;
  }

  root.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open]'), s = e.target.closest('[data-short]');
    const items = showAll ? data.items : data.items.slice(0, 6);
    if (o) { use(items[+o.dataset.open], false); return; }
    if (s) { use(items[+s.dataset.short], true); return; }
    if (e.target.closest('#inboxAdd')) { const r = await api.addFolder(); if (r) { data = r; paint(); } return; }
    if (e.target.closest('#inboxMore')) { showAll = !showAll; paint(); return; }
    const u = e.target.closest('[data-unwatch]');
    if (u) { data = await api.removeFolder(u.dataset.unwatch); paint(); }
  });
  api.onChanged?.(() => refresh());
  bus.on('home:open', () => refresh());
  // Leaving home means the new ones have been seen.
  bus.on('editor:open', () => { api.seen?.(); });
  refresh();
  void library;
  return { refresh, use, get data() { return data; } };
}
