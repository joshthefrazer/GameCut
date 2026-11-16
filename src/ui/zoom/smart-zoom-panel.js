import { bus } from '../../core/events.js';
import { zoomMoments, addZooms, clearZooms, ZOOM_STYLES } from '../../edit/smart-zoom.js';

/**
 * The Smart Zoom window.
 *
 * Lists the moments worth punching in on, all ticked. Hover a row and the
 * preview jumps there; untick the ones you do not want; pick how it moves and
 * how far in; Add puts them on the Zoom lane in one step of undo.
 */

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const PREF_KEY = 'strike.smartZoom';
const readPrefs = () => { try { return { style: 'smooth', factor: 1.35, whoosh: true, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { style: 'smooth', factor: 1.35, whoosh: true }; } };

export function initSmartZoom({ store, cmds, playback, comp }) {
  const el = document.createElement('div');
  el.className = 'pal qold';
  el.id = 'smartZoom';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Smart Zoom');
  document.body.appendChild(el);
  const close = () => { el.hidden = true; if (back != null) { playback.seek(back); back = null; } };
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  window.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);

  let back = null;
  let prefs = readPrefs();
  const save = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private */ } };

  function open() {
    const moments = zoomMoments(store);
    const zoomed = store.doc.tracks.filter(t => t.zoomLane).reduce((n, t) => n + t.clips.length, 0);
    back = store.rt.playhead;
    el.innerHTML = `
      <div class="pal__box qold__box szoom">
        <div class="vers__head"><b>Smart Zoom</b>
          <span>${moments.length ? `Found ${moments.length} moment${moments.length === 1 ? '' : 's'} worth zooming on. Hover one to see it; untick any you do not want.`
            : 'No moments found yet. Smart Zoom listens to the game sound and looks for kill animations — add footage with sound, or a kill counter, first.'}</span>
          <button class="btn btn--ghost btn--sm" data-close>Close</button></div>
        <div class="szoom__list">${moments.map((m, i) => `
          <label class="szoom__row" data-i="${i}">
            <input type="checkbox" checked data-i="${i}">
            <span class="szoom__t">${fmt(m.t)}</span>
            <b>${m.why}</b>
            <i class="szoom__bar"><i style="width:${Math.round(20 + m.strength * 80)}%"></i></i>
          </label>`).join('')}</div>
        <div class="szoom__opts">
          <div class="szoom__lbl">How it moves</div>
          <div class="szoom__styles">${ZOOM_STYLES.map(s => `<button class="achip${s.id === prefs.style ? ' is-on' : ''}" data-style="${s.id}" title="${s.note}">${s.name}</button>`).join('')}</div>
          <div class="szoom__lbl">How far in <output id="szFactor">${prefs.factor.toFixed(2)}×</output></div>
          <input type="range" id="szRange" min="1.1" max="1.9" step="0.05" value="${prefs.factor}">
          <label class="szoom__chk"><input type="checkbox" id="szWhoosh" ${prefs.whoosh ? 'checked' : ''}> Add a whoosh on each zoom</label>
        </div>
        <div class="szoom__foot">
          ${zoomed ? `<button class="btn btn--ghost" id="szClear">Remove the ${zoomed} zoom${zoomed === 1 ? '' : 's'} already in</button>` : '<span></span>'}
          <button class="btn btn--primary" id="szAdd" ${moments.length ? '' : 'disabled'}>Add ${moments.length} zoom${moments.length === 1 ? '' : 's'}</button>
        </div>
      </div>`;
    const addBtn = el.querySelector('#szAdd');
    const picked = () => [...el.querySelectorAll('.szoom__row input:checked')].map(i => moments[+i.dataset.i]);
    const recount = () => { const n = picked().length; addBtn.textContent = `Add ${n} zoom${n === 1 ? '' : 's'}`; addBtn.disabled = !n; };
    el.querySelectorAll('.szoom__row input').forEach(i => i.addEventListener('change', recount));
    el.querySelectorAll('.szoom__row').forEach(r => r.addEventListener('pointerenter', () => {
      const m = moments[+r.dataset.i];
      playback.seek(Math.max(0, m.t - 0.05));
    }));
    el.querySelector('.szoom__styles').addEventListener('click', (e) => {
      const b = e.target.closest('[data-style]'); if (!b) return;
      prefs.style = b.dataset.style; save();
      el.querySelectorAll('[data-style]').forEach(x => x.classList.toggle('is-on', x === b));
    });
    el.querySelector('#szRange').addEventListener('input', (e) => {
      prefs.factor = +e.target.value; save();
      el.querySelector('#szFactor').textContent = `${prefs.factor.toFixed(2)}×`;
    });
    el.querySelector('#szWhoosh').addEventListener('change', (e) => { prefs.whoosh = e.target.checked; save(); });
    addBtn.addEventListener('click', () => {
      const list = picked();
      const n = addZooms({ store, cmds }, list, prefs);
      back = null;
      el.hidden = true;
      comp.render();
      if (n) bus.emit('toast', { msg: `Added ${n} zoom${n === 1 ? '' : 's'} on the Zoom lane — drag one to move it, or change how far it goes in the inspector`, kind: 'ok', ms: 5000, action: { label: 'Undo', run: () => cmds.undo() } });
    });
    el.querySelector('#szClear')?.addEventListener('click', () => {
      const n = clearZooms({ store, cmds });
      bus.emit('toast', { msg: `Removed ${n} zoom${n === 1 ? '' : 's'}`, action: { label: 'Undo', run: () => cmds.undo() } });
      open();
    });
    el.hidden = false;
  }

  bus.emit('palette:add', [{ id: 'smart-zoom', name: 'Smart Zoom: zoom in on the big moments', sec: 'Edit', run: open }]);
  bus.on('smartzoom:open', open);
  return { open, close };
}
