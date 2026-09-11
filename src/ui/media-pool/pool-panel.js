import { assets } from '../../media/asset-store.js';
import { importFiles } from '../../media/importer.js';
import { renderBins } from './bins.js';
import { DEFAULT_BINS } from '../../project/presets.js';
import { shortTime } from '../../core/time.js';
import { bus } from '../../core/events.js';
import { placeAsset } from '../timeline/place-asset.js';

const AUDIO_ICON = `<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`;
const EMPTY_ICON = `<svg viewBox="0 0 24 24"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;
const ADD_ICON = `<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;

export function initMediaPool({ store, cmds }) {
  const root = document.getElementById('poolRoot');
  const picker = document.getElementById('filePicker');
  let query = '';

  root.innerHTML = `
    <label class="pool__search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" placeholder="Search media…" id="poolQuery">
    </label>
    <div class="bins" id="binList"></div>
    <div class="pool__title"><span id="poolLabel">All media</span><span id="poolCount"></span></div>
    <div class="assets" id="assetGrid"></div>`;

  const binList = root.querySelector('#binList');
  const grid = root.querySelector('#assetGrid');
  const label = root.querySelector('#poolLabel');
  const count = root.querySelector('#poolCount');

  root.querySelector('#poolQuery').addEventListener('input', (e) => {
    query = e.target.value.toLowerCase().trim();
    paintGrid();
  });

  function paintBins() {
    renderBins(binList, store, (id) => { store.ui.activeBin = id; paintBins(); paintGrid(); });
  }

  /** Put an asset on the timeline at the playhead, sliding past anything there. */
  function add(a) {
    if (a.kind === 'font') {
      bus.emit('toast', { msg: `"${a.family || a.name}" is ready in the font picker`, kind: 'ok' });
      return;
    }
    const clip = placeAsset(store, cmds, a.id, { allowShift: true });
    if (clip) store.select([clip.id]);
  }

  function paintGrid() {
    const list = assets.byBin(store.ui.activeBin)
      .filter(a => !query || a.name.toLowerCase().includes(query));
    // The filter's own name, so the heading always matches what is lit.
    label.textContent =
      (DEFAULT_BINS.find(b => b.id === store.ui.activeBin) || DEFAULT_BINS[0]).name;
    count.textContent = list.length ? `${list.length}` : '';

    if (!list.length) {
      grid.style.display = 'block';
      grid.innerHTML = `<div class="empty">${EMPTY_ICON}
        <b>Drop your footage here</b>
        <span>…or hit <b style="display:inline">Import</b> up top. Roblox cinematics, Minecraft
        captures, Suno tracks, PNG overlays, or a .ttf to load a font.</span></div>`;
      return;
    }
    grid.style.display = 'grid';
    grid.innerHTML = '';

    for (const a of list) {
      const el = document.createElement('div');
      el.className = 'asset';
      el.draggable = true;
      el.dataset.asset = a.id;
      const thumb = a.kind === 'audio' || a.kind === 'font'
        ? `<div class="asset__thumb asset__thumb--audio">${AUDIO_ICON}</div>`
        : `<img class="asset__thumb" src="${a.thumb || ''}" alt="">`;
      const canPlace = a.kind !== 'font';
      el.innerHTML = `${thumb}
        <span class="asset__kind">${a.kind}</span>
        ${a.duration ? `<span class="asset__dur">${shortTime(a.duration)}</span>` : ''}
        ${canPlace ? `<button class="asset__add" title="Add to timeline at the playhead">${ADD_ICON}</button>` : ''}
        <div class="asset__meta">
          <div class="asset__name" title="${a.name}">${a.name}</div>
          <div class="asset__sub">${a.width ? `${a.width}×${a.height}` : (a.family || '—')}</div>
        </div>`;

      el.addEventListener('dragstart', (e) => {
        window.__gc_dragAsset = a.id;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-gamecut-asset', a.id);
      });
      el.addEventListener('dragend', () => { window.__gc_dragAsset = null; });

      el.addEventListener('click', (e) => {
        if (e.target.closest('.asset__add')) { add(a); return; }
        grid.querySelectorAll('.asset').forEach(n => n.classList.toggle('is-sel', n === el));
      });

      // Drag-and-drop onto a canvas is fiddly and was, until now, the only way
      // to get media onto the timeline — so importing a clip looked like it had
      // done nothing. Double-click and the + button both place it directly.
      el.addEventListener('dblclick', () => add(a));

      grid.appendChild(el);
    }
  }

  /* ── Import ───────────────────────────────────────────────── */
  const doImport = async (files) => {
    if (!files?.length) return;
    bus.emit('toast', { msg: `Importing ${files.length} file${files.length > 1 ? 's' : ''}…` });
    await importFiles(files);
    bus.emit('assets');
  };

  document.getElementById('btnImport').addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => { doImport(picker.files); picker.value = ''; });

  // Drop anywhere on the pool.
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  root.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    doImport(e.dataTransfer.files);
  });

  // Block the browser's default "open file" on stray drops.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { if (!e.defaultPrevented) e.preventDefault(); });

  assets.on('change', () => { paintBins(); paintGrid(); });
  bus.on('assets', () => { paintBins(); paintGrid(); });

  paintBins();
  paintGrid();
  return { paintGrid, doImport };
}
