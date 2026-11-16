import { bus } from '../../core/events.js';
import { LAYOUTS, CORNERS, applyLayout, mainLane } from '../../edit/layouts.js';

/**
 * "Make it vertical": pick a layout, say where the facecam is, done.
 *
 * Each card is a little drawing of the tall frame (cam in Volt, game in
 * blue), so the choice is made by looking, not by reading.
 */

const PREF = 'strike.layout';
const readPref = () => { try { return { id: 'gameCam', cam: 'bl', size: 0.28, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { id: 'gameCam', cam: 'bl', size: 0.28 }; } };

function sketch(L) {
  const g = (y0, y1) => `<rect x="2" y="${2 + y0 * 76}" width="40" height="${(y1 - y0) * 76}" rx="3" fill="#3B5BFF"/>`;
  const c = (y0, y1) => `<rect x="2" y="${2 + y0 * 76}" width="40" height="${(y1 - y0) * 76}" rx="3" fill="#C6FF3D"/>`;
  let body = '';
  if (L.fill) body = `<rect x="2" y="2" width="40" height="76" rx="3" fill="#3B5BFF" opacity=".35"/><rect x="2" y="28" width="40" height="24" rx="2" fill="#3B5BFF"/>`;
  else {
    body += g(...L.game);
    if (L.cam) body += c(...L.cam);
    if (L.bubble) body += '<circle cx="13" cy="15" r="8" fill="#C6FF3D" stroke="#fff" stroke-width="1.5"/>';
  }
  return `<svg viewBox="0 0 44 80" class="lay__svg"><rect x="1" y="1" width="42" height="78" rx="4" fill="none" stroke="currentColor" stroke-opacity=".35"/>${body}</svg>`;
}

export function initLayouts({ store, cmds, comp }) {
  const el = document.createElement('div');
  el.className = 'pal qold';
  el.id = 'layouts';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Vertical layouts');
  document.body.appendChild(el);
  let pref = readPref();
  const save = () => { try { localStorage.setItem(PREF, JSON.stringify(pref)); } catch { /* private */ } };

  function open() {
    const lane = mainLane(store.doc);
    const n = lane ? lane.clips.filter(c => c.type === 'video' || c.type === 'image').length : 0;
    el.innerHTML = `
      <div class="pal__box qold__box lay">
        <div class="vers__head"><b>Make it vertical</b>
          <span>${n ? `Pick a layout for the ${n} clip${n === 1 ? '' : 's'} on your main lane. The project turns 9:16; Ctrl+Z puts it all back.` : 'Put a recording on the timeline first — the layout is built from it.'}</span>
          <button class="btn btn--ghost btn--sm" data-close>Close</button></div>
        <div class="lay__grid">${LAYOUTS.map(L => `
          <button class="lay__card${L.id === pref.id ? ' is-on' : ''}" data-layout="${L.id}">
            ${sketch(L)}<b>${L.name}</b><span>${L.recommended ? 'Recommended · ' : ''}${L.note}</span></button>`).join('')}</div>
        <div class="lay__cam">
          <div class="szoom__lbl">Where is your facecam in the recording?</div>
          <div class="szoom__styles">${CORNERS.map(c => `<button class="achip${c.id === pref.cam ? ' is-on' : ''}" data-cam="${c.id}">${c.name}</button>`).join('')}
            <button class="achip${pref.cam === 'none' ? ' is-on' : ''}" data-cam="none">No facecam</button></div>
          <div class="szoom__lbl">Facecam size <output id="layOut">${Math.round(pref.size * 100)}% of the width</output></div>
          <input type="range" id="laySize" min="0.15" max="0.45" step="0.01" value="${pref.size}">
        </div>
        <div class="szoom__foot"><span></span><button class="btn btn--primary" id="layGo" ${n ? '' : 'disabled'}>Use ${LAYOUTS.find(l => l.id === pref.id)?.name}</button></div>
      </div>`;
    el.hidden = false;
  }
  const go = () => {
    const made = applyLayout({ store, cmds }, pref.id, { cam: pref.cam === 'none' ? null : pref.cam, camSize: pref.size });
    el.hidden = true;
    comp.resize?.();
    bus.emit('preview:fit');
    comp.render();
    if (made) bus.emit('toast', { msg: `${LAYOUTS.find(l => l.id === pref.id).name} — drag the facecam or the game on the preview to adjust`, kind: 'ok', ms: 5000, action: { label: 'Undo', run: () => cmds.undo() } });
    return made;
  };

  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) { el.hidden = true; return; }
    const l = e.target.closest('[data-layout]');
    if (l) {
      pref.id = l.dataset.layout; save();
      el.querySelectorAll('[data-layout]').forEach(b => b.classList.toggle('is-on', b === l));
      el.querySelector('#layGo').textContent = `Use ${LAYOUTS.find(x => x.id === pref.id).name}`;
      return;
    }
    const c = e.target.closest('[data-cam]');
    if (c) { pref.cam = c.dataset.cam; save(); el.querySelectorAll('[data-cam]').forEach(b => b.classList.toggle('is-on', b === c)); return; }
    if (e.target.closest('#layGo')) go();
  });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'laySize') { pref.size = +e.target.value; save(); el.querySelector('#layOut').textContent = `${Math.round(pref.size * 100)}% of the width`; }
  });
  window.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); el.hidden = true; } }, true);
  document.getElementById('btnLayouts')?.addEventListener('click', open);
  bus.on('layouts:open', open);
  bus.emit('palette:add', [{ id: 'layouts', name: 'Make it vertical: facecam and game layouts for shorts', sec: 'Project', run: open }]);
  return { open, apply: (id, o) => applyLayout({ store, cmds }, id, o) };
}
