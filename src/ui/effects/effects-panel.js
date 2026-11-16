import { EFFECTS } from '../../engine/layers/effects.js';
import { bus } from '../../core/events.js';

/**
 * The Effects drawer: hit moments you drop at the playhead.
 *
 * Each tile shows its effect moving. Click one and it lands at the playhead as
 * its own clip on the timeline — drag it, stretch it, delete it like any clip.
 * Z drops a punch-in zoom without opening anything.
 */
export function initEffects({ store, cmds, comp }) {
  const root = document.getElementById('fxRoot');
  if (!root) return {};
  root.innerHTML = `
    <button class="szoom__cta" id="btnSmartZoom" title="Finds the loud hits and kills, and zooms in on each one">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path d="M11 8v6M8 11h6"/></svg>
      <span><b>Smart Zoom</b><i>Zoom in on every big moment, in one click</i></span></button>
    <p class="fx__lead">Click one to drop it at the playhead. It changes everything on the lanes under it, and leaves your titles alone.</p>
    <div class="fx__grid" id="fxGrid"></div>
    <p class="fx__tip"><kbd>Z</kbd> drops a punch-in zoom right where you are.</p>`;
  root.querySelector('#btnSmartZoom').addEventListener('click', () => bus.emit('smartzoom:open'));
  const grid = root.querySelector('#fxGrid');
  for (const e of EFFECTS) {
    const b = document.createElement('button');
    b.className = 'fxtile';
    b.dataset.fx = e.id;
    b.title = e.note;
    b.innerHTML = `<span class="fxtile__stage fxtile__stage--${e.id}"><i></i></span><b>${e.name}</b><span>${e.note}</span>`;
    b.addEventListener('click', () => {
      const clip = cmds.addEffect(e.id, store.rt.playhead);
      if (!clip) return;
      store.select([clip.id]);
      comp.render();
      bus.emit('toast', { msg: `${e.name} added — drag its ends on the timeline to make it longer or shorter`, ms: 3600 });
    });
    grid.appendChild(b);
  }
  return {};
}
