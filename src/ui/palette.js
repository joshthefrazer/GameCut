import { bus } from '../core/events.js';
import { freezeFrame } from '../edit/freeze-frame.js';
import { COMBOS } from './inspector/motion-panel.js';
import { ASPECTS } from '../project/presets.js';
import { defaultMotion } from '../engine/motion.js';
import { assets } from '../media/asset-store.js';
import { EFFECTS } from '../engine/layers/effects.js';

/**
 * Ctrl+K: do anything by typing a few letters of it.
 *
 * Every action in the editor is in one list with its shortcut beside it, so
 * the palette is also how the shortcuts get learned. It searches your clips
 * and media as well — type "clutch" to jump to that title. Features added
 * later register their own actions on `palette:add`.
 */
/**
 * A time typed by a person: "1:23", "1:23.5", "0:01:23", "83", "83s",
 * "1m20s", "1m". Null when it is not a time.
 */
export function parseTime(raw) {
  const q = String(raw || '').trim().toLowerCase();
  if (!q) return null;
  let m;
  if ((m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d+))?$/.exec(q))) {
    const parts = [m[1], m[2], m[3]].filter(v => v != null).map(Number);
    const frac = m[4] ? Number('0.' + m[4]) : 0;
    const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return secs + frac;
  }
  if ((m = /^(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$/.exec(q)) && (m[1] || m[2])) {
    return (Number(m[1] || 0) * 60) + Number(m[2] || 0);
  }
  if (/^\d+(\.\d+)?$/.test(q)) return Number(q);
  return null;
}
export const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(s % 1 ? 1 : 0)}`;
};

export function initPalette({ store, cmds, history, playback, timeline, preview, help }) {
  const RECENT_KEY = 'gamecut.palette.recent';
  const click = (id) => () => document.getElementById(id)?.click();
  const sel1 = () => store.selectedClips.length === 1 ? store.selectedClips[0] : null;
  const needSel = (fn) => () => {
    if (!store.rt.selection.length) { bus.emit('toast', { msg: 'Select a clip first.' }); return; }
    fn();
  };

  const actions = [
    { id: 'play', name: 'Play / pause', key: 'Space', sec: 'Playback', run: () => playback.toggle() },
    { id: 'start', name: 'Go to the start', key: 'Home', sec: 'Playback', run: () => { playback.pause(); playback.seek(0); } },
    { id: 'end', name: 'Go to the end', key: 'End', sec: 'Playback', run: () => { playback.pause(); playback.seek(store.rt.duration); } },
    { id: 'loop', name: 'Loop playback on / off (loops In to Out when both are set)', key: 'Shift+L', sec: 'Playback', run: click('btnLoop') },
    { id: 'fullscreen', name: 'Fullscreen preview', key: 'F', sec: 'Playback', run: () => preview?.toggleFullscreen?.() },

    { id: 'split', name: 'Split at the playhead', key: 'S', sec: 'Edit', run: () => cmds.splitAt(store.rt.playhead, store.rt.selection) },
    { id: 'splitall', name: 'Split every lane at the playhead', sec: 'Edit', run: () => cmds.splitAt(store.rt.playhead, []) },
    { id: 'delete', name: 'Delete what is selected', key: 'Del', sec: 'Edit', run: () => cmds.removeSelected() },
    { id: 'dup', name: 'Duplicate', key: 'Ctrl+D', sec: 'Edit', run: () => cmds.duplicateSelected() },
    { id: 'selall', name: 'Select every clip', key: 'Ctrl+A', sec: 'Edit', run: () => store.select(cmds.selectableIds()) },
    { id: 'undo', name: 'Undo', key: 'Ctrl+Z', sec: 'Edit', run: () => history.undo() },
    { id: 'redo', name: 'Redo', key: 'Ctrl+Shift+Z', sec: 'Edit', run: () => history.redo() },
    { id: 'gaps', name: 'Close every gap on the main lane', sec: 'Edit', run: () => cmds.closeAllGaps() },
    { id: 'freeze', name: 'Freeze frame here (2 seconds)', key: 'Shift+F', sec: 'Edit', run: () => freezeFrame({ store, cmds }) },
    { id: 'marker', name: 'Add a marker', key: 'M', sec: 'Edit', run: () => cmds.addMarker(store.rt.playhead) },
    { id: 'text', name: 'Add text at the playhead', key: 'T', sec: 'Add', run: () => cmds.addTextClip(store.rt.playhead) },
    { id: 'import', name: 'Import media', key: 'Ctrl+I', sec: 'Add', run: click('filePicker') },
    { id: 'crop', name: 'Crop a region onto its own layer', key: 'C', sec: 'Picture', run: () => preview?.crop?.toggle?.() },
    ...EFFECTS.map(e => ({ id: 'fx-' + e.id, name: `Effect: ${e.name}`, key: e.id === 'zoom' ? 'Z' : '', sec: 'Effects',
      run: () => { const c = cmds.addEffect(e.id, store.rt.playhead); if (c) store.select([c.id]); } })),
    { id: 'd-fx', name: 'Open Effects', sec: 'View', run: () => bus.emit('drawer:show', 'fx') },

    { id: 'extract', name: 'Take the sound out onto its own lane', sec: 'Clip', run: needSel(() => { const s = sel1(); if (s) cmds.extractAudio(s.clip.id); }) },
    { id: 'speed2', name: 'Speed: 2× faster', sec: 'Clip', run: needSel(() => { for (const { clip } of store.selectedClips) if (clip.type !== 'text') cmds.setClipSpeed(clip.id, 2); }) },
    { id: 'speedhalf', name: 'Speed: half speed (slow motion)', sec: 'Clip', run: needSel(() => { for (const { clip } of store.selectedClips) if (clip.type !== 'text') cmds.setClipSpeed(clip.id, 0.5); }) },
    { id: 'speed1', name: 'Speed: back to normal', sec: 'Clip', run: needSel(() => { for (const { clip } of store.selectedClips) if (clip.type !== 'text') cmds.setClipSpeed(clip.id, 1); }) },
    { id: 'ramp-hit', name: 'Speed ramp: slow into the moment at the playhead, snap back', sec: 'Clip', run: needSel(() => { const s = sel1(); if (s) cmds.speedRamp(s.clip.id, store.rt.playhead, 'hit'); }) },
    { id: 'ramp-smooth', name: 'Speed ramp: smooth slow motion around the playhead', sec: 'Clip', run: needSel(() => { const s = sel1(); if (s) cmds.speedRamp(s.clip.id, store.rt.playhead, 'smooth'); }) },
    { id: 'ramp-rush', name: 'Speed ramp: fast forward up to the moment, then slow', sec: 'Clip', run: needSel(() => { const s = sel1(); if (s) cmds.speedRamp(s.clip.id, store.rt.playhead, 'rush'); }) },
    { id: 'clean', name: 'Voice clean-up on the selected clip', sec: 'Sound', run: needSel(() => { for (const { clip } of store.selectedClips) if (clip.type === 'video' || clip.type === 'audio') cmds.setClipProp(clip.id, 'clean', !clip.clean, { merge: false, label: 'Voice clean-up' }); }) },
    { id: 'duck', name: 'Auto-duck the music under voice and game sound', sec: 'Sound', run: () => {
      const t = store.doc.tracks.find(x => x.kind === 'audio' && /music/i.test(x.name)) || store.doc.tracks.find(x => x.kind === 'audio' && x.clips.length);
      if (!t) { bus.emit('toast', { msg: 'Add some music first.' }); return; }
      cmds.setTrackFlag(t.id, 'duck', { depth: 0.7, ...(t.duck || {}), on: !t.duck?.on });
      bus.emit('toast', { msg: t.duck?.on ? `“${t.name}” now dips under voice and game sound` : `Auto-duck off on “${t.name}”`, kind: 'ok' });
    } },
    { id: 'copylook', name: 'Copy look (crop, look, motion, size)', key: 'Ctrl+Alt+C', sec: 'Clip', run: needSel(() => cmds.copyLook(store.rt.selection[0])) },
    { id: 'pastelook', name: 'Paste look onto the selected clips', key: 'Ctrl+Alt+V', sec: 'Clip', run: needSel(() => cmds.pasteLook(store.rt.selection)) },
    { id: 'compare', name: 'Compare before / after', sec: 'View', run: click('btnCompare') },
    { id: 'mute', name: 'Mute / unmute the selected clip', sec: 'Clip', run: needSel(() => { for (const { clip } of store.selectedClips) cmds.setClipProp(clip.id, 'muted', !clip.muted, { merge: false, label: 'Mute clip' }); }) },

    { id: 'tool-select', name: 'Select tool', key: 'V', sec: 'Tools', run: () => bus.emit('timeline:tool', 'select') },
    { id: 'tool-razor', name: 'Razor tool: click a clip to cut it', key: 'B', sec: 'Tools', run: () => bus.emit('timeline:tool', 'razor') },
    { id: 'tool-hand', name: 'Hand tool: drag to look around', key: 'H', sec: 'Tools', run: () => bus.emit('timeline:tool', 'hand') },
    { id: 'snap', name: 'Snap on / off', key: 'N', sec: 'Tools', run: click('btnMagnet') },
    { id: 'ripple', name: 'Ripple on / off', sec: 'Tools', run: click('btnRipple') },
    { id: 'beat', name: 'Beat sync on / off', key: 'Shift+B', sec: 'Tools', run: click('btnBeatGrid') },
    { id: 'fit', name: 'Zoom the timeline to fit everything', key: 'Shift+Z', sec: 'View', run: () => timeline.fitAll() },
    { id: 'zin', name: 'Zoom the timeline in', key: '+', sec: 'View', run: click('btnZoomIn') },
    { id: 'zout', name: 'Zoom the timeline out', key: '−', sec: 'View', run: click('btnZoomOut') },
    { id: 'lanes', name: 'Lane height: fit / small / medium / large', sec: 'View', run: click('btnTrackSize') },
    { id: 'guides', name: 'Safe-area guides on / off', sec: 'View', run: click('tglGuides') },
    { id: 'grid', name: 'Rule-of-thirds grid on / off', sec: 'View', run: click('tglGrid') },
    { id: 'drawer', name: 'Show / hide the left drawer', sec: 'View', run: click('btnDrawer') },
    { id: 'd-media', name: 'Open Media', sec: 'View', run: () => bus.emit('drawer:show', 'media') },
    { id: 'd-text', name: 'Open Text', sec: 'View', run: () => bus.emit('drawer:show', 'text') },
    { id: 'd-gfx', name: 'Open Graphics', sec: 'View', run: () => bus.emit('drawer:show', 'gfx') },
    { id: 'd-trans', name: 'Open Transitions', sec: 'View', run: () => bus.emit('drawer:show', 'trans') },

    { id: 'export', name: 'Export the video', sec: 'Project', run: click('btnExport') },
    { id: 'save', name: 'Save now', key: 'Ctrl+S', sec: 'Project', run: click('saveChip') },
    { id: 'projects', name: 'Back to your projects', sec: 'Project', run: click('btnHome') },
    { id: 'help', name: 'How everything works', key: '?', sec: 'Help', run: () => help?.toggle?.() },
  ];
  for (const [k, p] of Object.entries(ASPECTS)) {
    actions.push({ id: 'ar' + k, name: `Make the project ${k} (${p.label})`, sec: 'Project', run: () => document.querySelector(`#aspectSeg [data-ar="${k}"]`)?.click() });
  }
  for (const [v, label] of [['0', 'Auto'], ['1', 'Full'], ['0.5', 'Half'], ['0.25', 'Quarter']]) {
    actions.push({ id: 'pq' + v, name: `Preview quality: ${label}`, sec: 'View', run: () => {
      const q = document.getElementById('previewQuality'); if (!q) return;
      q.value = v; q.dispatchEvent(new Event('change'));
    } });
  }
  for (const c of COMBOS) {
    actions.push({ id: 'combo-' + c.id, name: `Motion: ${c.name}`, sec: 'Motion', run: needSel(() => {
      cmds.batch(`Motion: ${c.name}`, () => {
        for (const { clip, track } of store.selectedClips) {
          if (track.kind === 'audio' || (c.text && clip.type !== 'text')) continue;
          if (clip.type === 'text') cmds.setClipProp(clip.id, 'text', { ...clip.text, ...c.m }, { merge: false, label: `Motion: ${c.name}` });
          else cmds.setClipProp(clip.id, 'motion', { ...defaultMotion(), ...(clip.motion || {}), ...c.m }, { merge: false, label: `Motion: ${c.name}` });
        }
      });
    }) });
  }
  bus.on('palette:list', (fn) => fn(actions));
  bus.on('palette:add', (list) => { for (const a of [].concat(list)) if (!actions.some(x => x.id === a.id)) actions.push(a); });

  /* ── The sheet ───────────────────────────────────────────────── */
  const el = document.createElement('div');
  el.className = 'pal';
  el.id = 'palette';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Find any action');
  el.innerHTML = `
    <div class="pal__box">
      <div class="pal__in">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="paletteInput" type="text" placeholder="Type what you want to do, or a clip's name…" autocomplete="off" spellcheck="false">
        <kbd>Esc</kbd>
      </div>
      <div class="pal__list" id="paletteList" role="listbox"></div>
      <div class="pal__foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> do it</span><span>Shortcuts are on the right — next time, just press them</span></div>
    </div>`;
  document.body.appendChild(el);
  const input = el.querySelector('input');
  const list = el.querySelector('#paletteList');
  let items = [], cursor = 0;

  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
  const remember = (id) => {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter(x => x !== id)].slice(0, 6))); } catch { /* private */ }
  };

  /** Letters in order, with a bonus for word starts and for whole words. */
  function score(q, text) {
    const t = text.toLowerCase();
    if (!q) return 1;
    if (t.includes(q)) return 100 - t.indexOf(q) + (/\s/.test(t[t.indexOf(q) - 1] || ' ') ? 20 : 0);
    let i = 0, s = 0, run = 0;
    for (let k = 0; k < t.length && i < q.length; k++) {
      if (t[k] === q[i]) { i++; run++; s += run * 2 + (k === 0 || t[k - 1] === ' ' ? 6 : 0); } else run = 0;
    }
    return i === q.length ? s : 0;
  }

  function sources(q) {
    const out = actions.map(a => ({ kind: 'action', a, text: a.name + ' ' + (a.sec || '') }));
    if (q) {
      for (const t of store.doc.tracks) for (const c of t.clips) {
        const name = c.type === 'text' ? (c.text?.text || c.name || 'Text').split('\n')[0] : (c.name || c.type);
        out.push({ kind: 'clip', c, name, text: name + ' clip ' + t.name });
      }
      for (const a of assets.all()) {
        if (a.kind === 'font' || a.bundled) continue;
        out.push({ kind: 'asset', asset: a, text: a.name + ' add media' });
      }
    }
    return out;
  }

  function paint() {
    const q = input.value.trim().toLowerCase();
    let found = sources(q).map(x => ({ ...x, s: score(q, x.text) })).filter(x => x.s > 0);
    // A time typed in ("1:23", "83s", "go to 2:05") jumps there.
    const t = parseTime(q.replace(/^(go ?to|jump ?to|at)\s*/, ''));
    if (t != null) {
      const at = Math.min(t, store.rt.duration);
      found.unshift({ kind: 'action', s: 1e6, a: { id: 'goto', sec: 'Jump', name: `Go to ${fmtTime(at)}${t > store.rt.duration ? ' (the end)' : ''}`,
        run: () => { playback.pause(); playback.seek(at); bus.emit('timeline:reveal', { start: at, duration: 0 }); } } });
    }
    if (!q) {
      const r = recent();
      found.sort((a, b) => (r.indexOf(b.a?.id) + 1 ? 1000 - r.indexOf(b.a.id) : 0) - (r.indexOf(a.a?.id) + 1 ? 1000 - r.indexOf(a.a.id) : 0));
    } else found.sort((a, b) => b.s - a.s);
    items = found.slice(0, 40);
    cursor = Math.min(cursor, Math.max(0, items.length - 1));
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = `<div class="pal__none">Nothing called that. Try fewer letters, or press ? for the full guide.</div>`;
      return;
    }
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.className = 'pal__item' + (i === cursor ? ' is-on' : '');
      b.setAttribute('role', 'option');
      b.dataset.i = i;
      if (it.kind === 'action') {
        b.innerHTML = `<span class="pal__sec">${it.a.sec || ''}</span><span class="pal__name"></span>${it.a.key ? `<kbd>${it.a.key}</kbd>` : ''}`;
        b.querySelector('.pal__name').textContent = it.a.name;
      } else if (it.kind === 'clip') {
        b.innerHTML = `<span class="pal__sec">Clip</span><span class="pal__name"></span><span class="pal__meta"></span>`;
        b.querySelector('.pal__name').textContent = `Go to “${it.name}”`;
        b.querySelector('.pal__meta').textContent = `${it.c.start.toFixed(1)}s`;
      } else {
        b.innerHTML = `<span class="pal__sec">Media</span><span class="pal__name"></span>`;
        b.querySelector('.pal__name').textContent = `Add ${it.asset.name} at the playhead`;
      }
      list.appendChild(b);
    });
    list.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' });
  }

  async function run(it) {
    close();
    if (!it) return;
    if (it.kind === 'action') { remember(it.a.id); await it.a.run(); return; }
    if (it.kind === 'clip') {
      store.select([it.c.id]);
      playback.pause();
      playback.seek(it.c.start);
      bus.emit('timeline:reveal', { trackId: it.c.trackId, start: it.c.start, duration: it.c.duration });
      return;
    }
    const { placeAsset } = await import('./timeline/place-asset.js');
    const c = placeAsset(store, cmds, it.asset.id, { allowShift: true });
    if (c) store.select([c.id]);
  }

  function open(q = '') {
    el.hidden = false;
    input.value = q;
    cursor = 0;
    paint();
    input.focus();
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true;
    input.blur();
  }

  input.addEventListener('input', () => { cursor = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(items.length - 1, cursor + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(items[cursor]); }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.pal__item');
    if (b) run(items[+b.dataset.i]);
  });
  list.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.pal__item');
    if (b && +b.dataset.i !== cursor) { cursor = +b.dataset.i; for (const x of list.children) x.classList.toggle('is-on', x === b); }
  });
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'p') && !e.shiftKey) {
      if (document.getElementById('app')?.classList.contains('is-home')) return;
      e.preventDefault();
      el.hidden ? open() : close();
    }
  }, true);
  document.getElementById('btnSearch')?.addEventListener('click', () => open());
  return { open, close, actions };
}
