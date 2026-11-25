import { EFFECTS } from '../../engine/layers/effects.js';
import { bus } from '../../core/events.js';
import { starEl, isStarred } from '../stars.js';

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
    <p class="fx__lead">Click one to drop it at the playhead. It changes everything on the lanes under it, and leaves your titles alone.</p>
    <div class="fx__bar"><button class="is-on" data-fxshow="all">All</button><button data-fxshow="star">★ Starred</button></div>
    <div class="fx__grid" id="fxGrid"></div>
    <p class="fx__tip"><kbd>Z</kbd> drops a punch-in zoom right where you are.</p>`;
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
    b.appendChild(starEl('fx', e.id, e.name));
    grid.appendChild(b);
  }
  let only = 'all';
  const none = document.createElement('p'); none.className = 'fx__lead'; none.textContent = 'Nothing starred yet. Point at an effect and click its star.'; none.hidden = true; grid.after(none);
  const sift = () => { let n = 0; for (const b of grid.children) { b.hidden = only === 'star' && !isStarred('fx', b.dataset.fx); if (!b.hidden) n++; } none.hidden = n > 0; };
  root.querySelector('.fx__bar').addEventListener('click', (ev) => { const b = ev.target.closest('[data-fxshow]'); if (!b) return; only = b.dataset.fxshow; for (const x of b.parentElement.children) x.classList.toggle('is-on', x === b); sift(); });
  bus.on('stars', sift);
  return {};
}
