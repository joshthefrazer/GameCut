import { bus } from '../core/events.js';
import { parseTime, fmtTime } from './palette.js';
import { loadTheme } from './theme.js';
import { CLIP_COLORS } from '../core/schema.js';
import { findTheme, themeVars, isLight, mix, themePicture } from './themes/theme-core.js';
import { markUrl, dressApp } from './themes/theme-icon.js';
import { initThemeStudio } from './themes/theme-studio.js';

/**
 * Quality-of-life pieces that belong to no one panel:
 *   History    — every step, click one to go back to it
 *   Jump       — click the timecode under the preview and type a time
 *   Snapshot   — save the frame under the playhead as a PNG
 *   Settings   — accent colour and layout size
 *   What's new — a short tour of a new version, once
 */
export const VERSION_TOUR = '2.0.0';

const ACCENTS = [
  { id: 'auto',    name: 'Theme',   c: null },
  { id: 'violet',  name: 'Violet',  c: '#8b5cf6', hi: '#a78bfa', lo: '#7c3aed' },
  { id: 'emerald', name: 'Emerald', c: '#10b981', hi: '#34d399', lo: '#059669' },
  { id: 'amber',   name: 'Amber',   c: '#f59e0b', hi: '#fbbf24', lo: '#d97706' },
  { id: 'rose',    name: 'Rose',    c: '#f43f5e', hi: '#fb7185', lo: '#e11d48' },
  { id: 'cyan',    name: 'Cyan',    c: '#06b6d4', hi: '#22d3ee', lo: '#0891b2' },
];
const SETTINGS_KEY = 'gamecut.settings';
const DEFAULTS = { theme: 'strike', accent: 'auto', density: 'comfy', tips: true, appIcon: true };

export function readSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  // 1.9 called the stock colour "blue"; in Strike that is the theme's own.
  if (s.accent === 'blue') s.accent = 'auto';
  return s;
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* private */ }
  return next;
}

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const ACC_VARS = ['--acc', '--acc-hi', '--acc-lo', '--acc-glow', '--acc-soft', '--acc-line', '--tl-lane-active', '--tl-ghost-fill', '--tl-ghost-line'];

/** Paint the theme, accent and density onto the page (and the timeline canvas). */
const CLIP_STOCK = JSON.parse(JSON.stringify(CLIP_COLORS));
let painted = [];
export function applySettings(s = readSettings(), draft = null) {
  const root = document.documentElement;
  const t = draft || findTheme(s.theme) || findTheme('strike');
  for (const v of painted) root.style.removeProperty(v);
  painted = [];
  if (t.css) {
    if (t.id === 'strike') delete root.dataset.theme; else root.dataset.theme = t.id;
  } else {
    root.dataset.theme = isLight(t) ? 'day' : 'made';
    const vars = themeVars(t);
    painted = Object.keys(vars);
    for (const v of painted) root.style.setProperty(v, vars[v]);
  }
  root.style.setProperty('--rk', String(t.radius));
  root.style.setProperty('--fs', String(t.size));
  root.classList.toggle('no-motion', t.motion === false);
  if (s.appIcon === false || t.id === 'strike' || t.id === 'black') root.style.removeProperty('--mark'); else root.style.setProperty('--mark', markUrl(t));
  // Clips on the timeline are painted on a canvas from these.
  for (const [k, c] of [['video', t.video], ['audio', t.audio], ['text', t.title]]) {
    const pair = t.css ? CLIP_STOCK[k] : [c, mix(c, '#ffffff', 0.28)];
    CLIP_COLORS[k][0] = pair[0]; CLIP_COLORS[k][1] = pair[1];
  }
  const a = (draft ? null : ACCENTS.find(x => x.id === s.accent)) || ACCENTS[0];
  const st = root.style;
  if (t.css) for (const v of ACC_VARS) st.removeProperty(v);
  if (a.c) {
    st.setProperty('--acc', a.c);
    st.setProperty('--acc-hi', a.hi);
    st.setProperty('--acc-lo', a.lo);
    st.setProperty('--acc-glow', rgba(a.c, 0.55));
    st.setProperty('--acc-soft', rgba(a.c, 0.15));
    st.setProperty('--acc-line', rgba(a.c, 0.55));
    st.setProperty('--tl-lane-active', rgba(a.c, 0.10));
    st.setProperty('--tl-ghost-fill', rgba(a.c, 0.26));
    st.setProperty('--tl-ghost-line', rgba(a.c, 0.95));
    st.setProperty('--acc-txt', a.hi); st.setProperty('--on-acc', ['amber', 'emerald', 'cyan'].includes(a.id) ? '#06080f' : '#fff');
    painted.push('--acc-txt', '--on-acc', ...ACC_VARS);
  }
  root.classList.toggle('is-compact', s.density === 'compact');
  root.dataset.gcAccent = a.id;
  loadTheme();
  if (!draft) dressApp(t, s.appIcon !== false);
  bus.emit('theme');
  bus.emit('layout');
}

function dialog(id, label) {
  const el = document.createElement('div');
  el.className = 'pal qold';
  el.id = id;
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', label);
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) el.hidden = true; });
  window.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); el.hidden = true; } }, true);
  return el;
}

const ago = (ms) => {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function initQol({ store, cmds, history, playback, comp, timeline }) {
  /* ── History ─────────────────────────────────────────────── */
  const hist = dialog('historyPanel', 'History');
  function openHistory() {
    const steps = history.steps();
    hist.innerHTML = `
      <div class="pal__box qold__box">
        <div class="vers__head"><b>History</b><span>Every change you made. Click one to go back to just after it — nothing is lost, the later steps stay here to redo.</span>
          <button class="btn btn--ghost btn--sm" data-close>Close</button></div>
        <div class="pal__list hist__list"></div>
      </div>`;
    const list = hist.querySelector('.hist__list');
    const start = document.createElement('button');
    start.className = 'hist__row' + (steps.every(s => !s.done) ? ' is-now' : '');
    start.dataset.n = String(-steps.filter(s => s.done).length);
    start.innerHTML = '<i>◦</i><b>Start</b><span>before any change</span>';
    list.appendChild(start);
    let nowIdx = -1;
    steps.forEach((s, i) => { if (s.done) nowIdx = i; });
    steps.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'hist__row' + (s.done ? '' : ' is-undone') + (i === nowIdx ? ' is-now' : '');
      b.dataset.n = String(s.n);
      b.innerHTML = `<i>${i === nowIdx ? '●' : s.done ? '•' : '○'}</i><b></b><span>${i === nowIdx ? 'you are here' : s.done ? ago(s.at) : 'undone — click to redo'}</span>`;
      b.querySelector('b').textContent = s.label;
      list.appendChild(b);
    });
    if (!steps.length) list.insertAdjacentHTML('beforeend', '<div class="pal__none">No changes yet.</div>');
    hist.hidden = false;
    list.querySelector('.is-now')?.scrollIntoView({ block: 'nearest' });
  }
  hist.addEventListener('click', (e) => {
    const row = e.target.closest('.hist__row');
    if (!row) return;
    const n = Number(row.dataset.n);
    if (n) {
      history.jump(n);
      bus.emit('toast', { msg: n < 0 ? `Went back ${-n} step${n === -1 ? '' : 's'}` : `Redid ${n} step${n === 1 ? '' : 's'}`, key: 'edit', ms: 2600 });
    }
    openHistory();
  });
  document.getElementById('btnHistory')?.addEventListener('click', openHistory);
  bus.on('history:open', openHistory);

  /* ── Jump: click the timecode, type a time ───────────────── */
  const tc = document.getElementById('tcCurrent');
  if (tc) {
    tc.title = 'Click to type a time to jump to — 1:23, 83s, or a timecode';
    tc.classList.add('tc--jump');
    tc.addEventListener('click', () => {
      if (tc.querySelector('input')) return;
      const input = document.createElement('input');
      input.className = 'tc__in';
      input.id = 'tcJump';
      input.value = fmtTime(store.rt.playhead);
      input.setAttribute('aria-label', 'Jump to time');
      tc.textContent = '';
      tc.appendChild(input);
      input.focus(); input.select();
      let done = false;
      const finish = (go) => {
        if (done) return; done = true;
        if (go) {
          const raw = input.value.trim();
          const fps = store.doc.fps || 30;
          const tcm = /^(\d+):(\d{2}):(\d{2})[:;](\d{2})$/.exec(raw);
          const t = tcm ? (+tcm[1] * 3600 + +tcm[2] * 60 + +tcm[3] + +tcm[4] / fps) : parseTime(raw);
          if (t != null) { playback.pause(); playback.seek(Math.min(store.rt.duration, Math.max(0, t))); bus.emit('timeline:reveal', { start: store.rt.playhead, duration: 0 }); }
          else bus.emit('toast', { msg: 'Type a time like 1:23, 83s or 0:01:23:15' });
        }
        input.remove();
        store.emit('playhead', store.rt.playhead);
      };
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') finish(true);
        if (ev.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(false));
    });
  }

  /* ── Snapshot: the frame under the playhead, as a PNG ────── */
  /** The frame at `t`, drawn the way the export draws it: full size, exact frame. */
  async function fullFrame(t, type = 'image/png') {
    const { Compositor } = await import('../engine/compositor.js');
    const W = store.doc.width, H = store.doc.height;
    const canvas = document.createElement('canvas');
    const c = new Compositor(store, canvas, { fixedSize: { w: W, h: H } });
    try {
      await c.pool.seekExact(c.clipsNeededAt(t), t);
      c.render(t, false);
      return await new Promise(r => canvas.toBlob(r, type, 0.95));
    } finally { c.dispose(); }
  }

  async function saveFrame({ sink = null } = {}) {
    const xs = sink || window.gamecut?.exportSink;
    const t = store.rt.playhead;
    const W = store.doc.width, H = store.doc.height;
    const blob = await fullFrame(t);
    if (!blob) { bus.emit('toast', { msg: 'Could not grab that frame.', kind: 'err' }); return null; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = `${(store.doc.name || 'Strike').replace(/[<>:"/\\|?*]/g, '')} ${fmtTime(t).replace(':', 'm')}s.png`;
    if (!xs) {
      // In a browser: hand it over as a download.
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { bytes: bytes.length };
    }
    const d = await xs.open({ suggestedName: name, title: 'Save this frame' });
    if (!d) return null;
    try {
      await xs.write(d.token, bytes, 0);
      const r = await xs.close(d.token);
      if (!r?.ok) throw new Error(r?.reason || 'could not save');
    } catch (e) {
      await xs.abort?.(d.token).catch(() => {});
      bus.emit('toast', { msg: `Could not save the frame: ${e.message}`, kind: 'err' });
      return null;
    }
    bus.emit('toast', { msg: `Saved the frame at ${fmtTime(t)} (${W}×${H}) — ready for a thumbnail`, kind: 'ok', ms: 4200 });
    return { path: d.path, bytes: bytes.length, width: W, height: H };
  }
  /*
   * Quick look (Q): the frame under the playhead at full export quality, as
   * big as the window. The preview runs at a lighter quality to keep playback
   * smooth; this is how to check a detail (a small kill feed, a caption's
   * edge) exactly as the video file will have it.
   */
  const ql = document.createElement('div');
  ql.className = 'qlook';
  ql.id = 'quickLook';
  ql.hidden = true;
  document.body.appendChild(ql);
  let qlUrl = null;
  const closeLook = () => { ql.hidden = true; if (qlUrl) { URL.revokeObjectURL(qlUrl); qlUrl = null; } ql.innerHTML = ''; };
  async function quickLook() {
    if (!ql.hidden) { closeLook(); return; }
    playback.pause?.();
    const t = store.rt.playhead;
    ql.hidden = false;
    ql.innerHTML = '<div class="qlook__wait">Drawing the full-quality frame…</div>';
    const blob = await fullFrame(t, 'image/jpeg');
    if (ql.hidden || !blob) return;
    qlUrl = URL.createObjectURL(blob);
    ql.innerHTML = `<img alt="" src="${qlUrl}"><div class="qlook__bar"><b>Quick look</b><span>${store.doc.width}×${store.doc.height} · ${fmtTime(t)} · exactly as it will export</span><kbd>Q</kbd><span>or Esc to close</span></div>`;
  }
  ql.addEventListener('click', closeLook);
  window.addEventListener('keydown', (e) => { if (!ql.hidden && (e.key === 'Escape' || e.key === 'q' || e.key === 'Q')) { e.stopPropagation(); e.preventDefault(); closeLook(); } }, true);
  bus.on('quicklook', quickLook);

  document.getElementById('btnSnapshot')?.addEventListener('click', () => saveFrame());
  bus.on('frame:save', () => saveFrame());

  /* ── Settings ────────────────────────────────────────────── */
  const sets = dialog('settingsPanel', 'Settings');
  function openSettings() {
    const s = readSettings();
    sets.innerHTML = `
      <div class="pal__box qold__box">
        <div class="vers__head"><b>Settings</b><span>Theme, colour and size. Saved on this computer.</span>
          <button class="btn btn--ghost btn--sm" data-close>Close</button></div>
        <div class="qold__body">
          <div class="capd__lbl">Theme</div>
          <div class="set__now"><span class="set__nowpic">${themePicture(findTheme(s.theme) || findTheme('strike'))}</span><div><b id="setThemeName"></b><span>15 to choose from, or make your own.</span></div><button class="btn btn--primary" data-open="themes">Change theme…</button></div>
          <div class="capd__lbl">Accent colour</div>
          <div class="set__accents">${ACCENTS.map(a => `<button class="set__acc${a.id === s.accent ? ' is-on' : ''}" data-accent="${a.id}" style="--c:${a.c || 'var(--acc)'}" title="${a.name}"><i></i><span>${a.name}</span></button>`).join('')}</div>
          <div class="capd__lbl">Layout size</div>
          <div class="set__seg">
            <button class="chip-btn${s.density !== 'compact' ? ' is-on' : ''}" data-density="comfy">Roomy</button>
            <button class="chip-btn${s.density === 'compact' ? ' is-on' : ''}" data-density="compact">Compact — more timeline, smaller controls</button>
          </div>
          <div class="capd__lbl">Help</div>
          <label class="set__row"><input type="checkbox" id="setTips" ${s.tips ? 'checked' : ''}> Show hover hints on buttons</label>
          <div class="set__links">
            <button class="btn btn--ghost btn--sm" data-open="tour">What's new in ${VERSION_TOUR}</button>
            <button class="btn btn--ghost btn--sm" data-open="keys">Keyboard shortcuts</button>
          </div>
        </div>
      </div>`;
    sets.querySelector('#setThemeName').textContent = (findTheme(s.theme) || findTheme('strike')).name;
    sets.hidden = false;
  }
  sets.addEventListener('click', (e) => {
    const a = e.target.closest('[data-accent]');
    if (a) { applySettings(writeSettings({ accent: a.dataset.accent })); openSettings(); return; }
    const d = e.target.closest('[data-density]');
    if (d) { applySettings(writeSettings({ density: d.dataset.density })); openSettings(); return; }
    const o = e.target.closest('[data-open]');
    if (o) { sets.hidden = true; if (o.dataset.open === 'themes') bus.emit('themes:open'); else if (o.dataset.open === 'tour') openTour(); else document.getElementById('btnHelp')?.click(); }
  });
  sets.addEventListener('change', (e) => {
    if (e.target.id === 'setTips') {
      writeSettings({ tips: e.target.checked });
      document.documentElement.classList.toggle('no-tips', !e.target.checked);
    }
  });
  document.getElementById('btnSettings')?.addEventListener('click', openSettings);
  bus.on('settings:open', openSettings);
  const s0 = readSettings();
  applySettings(s0);
  document.documentElement.classList.toggle('no-tips', !s0.tips);
  // A slider's coloured part follows its handle, wherever the slider is.
  const fillOf = (r) => { const a = +r.min || 0, b = r.max === '' ? 100 : +r.max; r.style.setProperty('--fill', `${b > a ? ((r.value - a) / (b - a)) * 100 : 0}%`); };
  document.addEventListener('input', (e) => { if (e.target.matches?.('.rng')) fillOf(e.target); }, true);
  document.querySelectorAll('.rng').forEach(fillOf);
  new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches('.rng')) fillOf(n); else if (n.firstElementChild) n.querySelectorAll('.rng').forEach(fillOf); } }).observe(document.body, { childList: true, subtree: true });
  const themes = initThemeStudio({
    current: () => readSettings().theme,
    use: (id) => applySettings(writeSettings({ theme: id, accent: 'auto' })),
    preview: (t) => applySettings(readSettings(), t),
    icon: (on) => { if (on === undefined) return readSettings().appIcon !== false; applySettings(writeSettings({ appIcon: !!on })); return !!on; },
  });

  /* ── What's new ──────────────────────────────────────────── */
  const tour = dialog('tourPanel', "What's new");
  const mode = (m) => () => window.gc?.animLib?.setMode(m);
  const NEWS = [
    { t: 'GameCut is now Strike', d: 'A new look from the logo down, four themes (Strike, Pitch black, Neon night, Daylight), and Edit · Library · Export along the top. Your projects are all still here.', show: openSettings },
    { t: '61 animations, each with its own sound', d: 'Kill counters that count by themselves, headshots, ACE, rank ups, scoreboards, polls, subscribe buttons… Click one to drop it in, or drag it onto a lane.', show: mode('library') },
    { t: 'History', d: 'Every change you made, in a list. Click any step to go back to it (Ctrl+H).', show: openHistory },
    { t: 'Customize, not keyframes', d: 'Select an animation and its Customize tab has its words, colours, speed and sound. Swap it for another one and it keeps its place.' },
    { t: 'Quick look', d: 'Press Q to see the frame under the playhead at full export quality, as big as your screen.' },
    { t: 'Closing never saves nothing', d: 'Opening Strike and closing it again no longer leaves an empty "edited video" behind. Old empty ones can be cleared from the home screen.' },
    { t: 'Cut flash', d: 'S flashes the cut on the timeline, so a split made by key is seen to happen.' },
    { t: 'Make it vertical', d: 'One click turns a gameplay recording into a 9:16 short: Game + cam, Cam on top, cam bubble, or the whole picture over a blurred fill.', show: () => bus.emit('layouts:open') },
    { t: 'Sound pads', d: 'Twelve sounds on twelve keys. Press Play and record, hit Q W E R… while it plays — the whole take is one undo.', show: () => bus.emit('drawer:show', 'pads') },
    { t: 'Captions 2.0', d: 'Highlight box and One word at a time looks; keywords coloured, "um" and "uh" left out, kept clear of the phone apps\' buttons.', show: () => bus.emit('captions:open') },
    { t: 'Clip Inbox', d: 'New recordings from OBS, Medal and NVIDIA show up on the home screen by themselves. Open one, or make a quick short from it.' },
    { t: 'Thumbnail maker', d: 'Your best frame, big words and an arrow — a 1280×720 PNG for YouTube in a minute.', show: () => bus.emit('thumbnail:open') },
  ];
  function openTour() {
    tour.innerHTML = `
      <div class="pal__box qold__box tour__box">
        <div class="vers__head"><b>What's new in Strike ${VERSION_TOUR}</b><span>The biggest update yet: a new name, a new look, and an animation library.</span>
          <button class="btn btn--ghost btn--sm" data-close>Got it</button></div>
        <div class="tour__list">${NEWS.map((n, i) => `<div class="tour__item"><b>${n.t}</b><span>${n.d}</span>${n.show ? `<button class="btn btn--ghost btn--sm" data-show="${i}">Show me</button>` : ''}</div>`).join('')}</div>
      </div>`;
    tour.hidden = false;
  }
  tour.addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]');
    if (b) { tour.hidden = true; NEWS[+b.dataset.show].show?.(); }
  });
  bus.on('tour:open', openTour);
  let seen = null;
  try { seen = localStorage.getItem('gamecut.tour'); localStorage.setItem('gamecut.tour', VERSION_TOUR); } catch { /* private */ }
  // Only for people who used an earlier version: a brand-new install has the
  // first-run help instead.
  let hadProjects = false;
  try { hadProjects = !!localStorage.getItem('gamecut.layout.v2') || !!localStorage.getItem('gamecut.drawer'); } catch { /* private */ }
  // A toast, not a box over your work: it never stands between you and the editor.
  if (seen !== VERSION_TOUR && hadProjects) {
    setTimeout(() => bus.emit('toast', { msg: `GameCut is now Strike ${VERSION_TOUR} — 61 animations and a new look`, ms: 9000, action: { label: "What's new", run: openTour } }), 1500);
  }

  bus.emit('palette:add', [
    { id: 'history', name: 'History: go back to any earlier step', sec: 'Edit', key: 'Ctrl+H', run: openHistory },
    { id: 'quicklook', name: 'Quick look: this frame at full quality', sec: 'View', key: 'Q', run: quickLook },
    { id: 'snapshot', name: 'Save this frame as a picture (PNG)', sec: 'Export', key: 'Ctrl+Shift+S', run: saveFrame },
    { id: 'settings', name: 'Settings: accent colour, layout size', sec: 'App', key: 'Ctrl+,', run: openSettings },
    { id: 'tour', name: `What's new in ${VERSION_TOUR}`, sec: 'App', run: openTour },
    { id: 'addlane', name: 'Add a lane (Video, Facecam, Text, Voice, Music, SFX)', sec: 'Timeline', run: () => document.getElementById('btnAddLane')?.click() },
    { id: 'rippledel', name: 'Delete the selection and close the gap', sec: 'Edit', key: 'Shift+Del', run: () => cmds.removeSelected({ ripple: true }) },
    { id: 'nextedit', name: 'Jump to the next cut', sec: 'Jump', key: '↓', run: () => { const t = cmds.nextEdit(store.rt.playhead, 1); if (t != null) playback.seek(t); } },
    { id: 'prevedit', name: 'Jump to the previous cut', sec: 'Jump', key: '↑', run: () => { const t = cmds.nextEdit(store.rt.playhead, -1); if (t != null) playback.seek(t); } },
  ]);
  void comp; void timeline;
  return { openHistory, openSettings, openTour, saveFrame, applySettings, quickLook, fullFrame, themes };
}
