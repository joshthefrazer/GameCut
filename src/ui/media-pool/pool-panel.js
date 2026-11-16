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
    <div class="smart" id="smartStrip">
      <button class="smart__b" id="btnHighlights" title="Listens to the game sound and marks the loud moments in red">
        <svg viewBox="0 0 24 24"><path d="M3 12h3l3-8 4 16 3-8h5"/></svg>Find highlights</button>
      <button class="smart__b" id="btnReel" title="Takes the loudest moments of every recording here and lays them out as a first cut">
        <svg viewBox="0 0 24 24"><rect x="3" y="6" width="5" height="12" rx="1"/><rect x="10" y="6" width="4" height="12" rx="1"/><rect x="16" y="6" width="5" height="12" rx="1"/></svg>Highlight reel</button>
      <button class="smart__b" id="btnBeatSong" title="Finds the tempo of your song so cuts snap to the beat">
        <svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>Find the beat</button>
      <button class="smart__b" id="btnCutBeat" title="Makes every shot on the main lane a whole number of beats long">
        <svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="m7 8 5 4-5 4"/><path d="m17 8-5 4 5 4"/></svg>Cut to the beat</button>
    </div>
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
    const at = store.rt.playhead;
    const clip = placeAsset(store, cmds, a.id, { allowShift: true });
    if (!clip) return;
    store.select([clip.id]);
    // The playhead spot was taken, so it went to the first gap after it —
    // often the end of a long recording, far off screen. Show it, and say so,
    // or it looks like nothing happened.
    bus.emit('timeline:reveal', { trackId: clip.trackId, start: clip.start, duration: clip.duration });
    if (clip.start > at + 0.5) {
      const m = Math.floor(clip.start / 60), sec = Math.floor(clip.start % 60);
      bus.emit('toast', { msg: `${a.name} went in at ${m}:${String(sec).padStart(2, '0')}, after what was under the playhead. Drag it onto a lane to put it somewhere else.`, ms: 6000 });
    }
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

      /*
       * Drag-and-drop onto a canvas is fiddly and was, until now, the only way
       * to get media onto the timeline — so importing a clip looked like it had
       * done nothing. Double-click and the + button both place it directly.
       *
       * Exactly once, though. The + sits in the middle of the tile, which is
       * where a double-click lands — and a double-click is two clicks and then
       * a dblclick, so it used to add the clip three times: once for each click
       * on the +, and again when the dblclick bubbled up to the tile. A click
       * is only the + when it is the first click of a run (`detail` counts
       * them), and the dblclick ignores anything that started on the + .
       */
      el.addEventListener('click', (e) => {
        if (e.target.closest('.asset__add')) {
          if (e.detail <= 1) add(a);
          return;
        }
        grid.querySelectorAll('.asset').forEach(n => n.classList.toggle('is-sel', n === el));
      });
      el.addEventListener('dblclick', (e) => {
        if (e.target.closest('.asset__add')) return;
        add(a);
      });

      grid.appendChild(el);
    }
  }

  /* ── Import ───────────────────────────────────────────────── */
  const timelineEmpty = () => !store.doc.tracks.some(t => t.clips.length);

  const doImport = async (files) => {
    if (!files?.length) return;
    bus.emit('toast', { msg: `Importing ${files.length} file${files.length > 1 ? 's' : ''}…` });
    const wasEmpty = timelineEmpty();
    const made = await importFiles(files);
    bus.emit('assets');
    if (wasEmpty && timelineEmpty()) startTimeline(made || []);
  };

  /**
   * The first import into an empty project goes straight onto the timeline.
   *
   * Importing used to fill the Media panel and leave the timeline blank, and a
   * first-time user is then looking at their footage in a little tile with no
   * idea that the next step is to drag it somewhere. When there is nothing on
   * the timeline yet there is only one sensible place for it: the recording on
   * the main video track at 0:00, a song on the music lane at 0:00. The
   * timeline zooms to fit it on its own (see timeline-panel). After that,
   * importing only adds to the panel — by then you know where things go, and
   * a clip appearing on its own in the middle of an edit would be in the way.
   */
  function startTimeline(made) {
    const videos = made.filter(a => a.kind === 'video');
    const song = made.find(a => a.kind === 'audio');
    if (!videos.length && !song) return;
    let first = null;
    cmds.batch('Add media', () => {
      if (videos[0]) first = placeAsset(store, cmds, videos[0].id, { start: 0 });
      if (song) {
        const s = placeAsset(store, cmds, song.id, { start: 0 });
        first ||= s;
      }
    });
    if (first) store.select([first.id]);
    const rest = videos.length - 1;
    bus.emit('toast', {
      msg: rest > 0
        ? `Put ${videos[0].name} on the timeline — the other ${rest} ${rest === 1 ? 'is' : 'are'} in Media: press + on a tile to add it.`
        : 'Your footage is on the timeline. Press Space to play, S to cut.',
      kind: 'ok', ms: 5200,
    });
  }

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
