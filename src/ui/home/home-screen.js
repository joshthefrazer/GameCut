import { bus } from '../../core/events.js';

/**
 * The screen you land on.
 *
 * Opening straight into an empty timeline made every session start the same
 * way — with no idea what you were working on last, and no way back to it. This
 * is the list of your projects, and the way to start another.
 *
 * It lives in the same window as the editor rather than a second one: the
 * editor's compositor, decoders and audio graph are all built at boot and
 * survive being hidden, so switching views is a class change rather than a
 * teardown.
 */
export function initHome({ library, onOpen, onNew }) {
  const root = document.getElementById('homeScreen');
  const grid = document.getElementById('homeGrid');
  const count = document.getElementById('homeCount');
  const app = document.getElementById('app');

  const fmtTime = (s) => {
    if (!s || !isFinite(s)) return '00:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    const h = Math.floor(m / 60);
    return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
             : `${m}:${String(sec).padStart(2, '0')}`;
  };

  const fmtWhen = (ms) => {
    if (!ms) return 'never saved';
    const d = new Date(ms);
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };

  const esc = (s) => String(s).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  async function refresh() {
    const list = await library.list();
    count.textContent = list.length
      ? `${list.length} project${list.length === 1 ? '' : 's'}` : '';
    grid.innerHTML = '';

    if (!list.length) {
      grid.innerHTML = `<div class="home__empty">
        <b>No projects yet</b>
        <span>Start one above. Everything you do is saved here automatically,
        and the footage stays where it already is on your drive.</span>
      </div>`;
      return;
    }

    for (const p of list) {
      const card = document.createElement('button');
      card.className = 'proj';
      card.dataset.id = p.id;
      card.innerHTML = `
        <span class="proj__shot">${p.thumb
          ? `<img src="${p.thumb}" alt="">`
          : `<i class="proj__blank"></i>`}</span>
        <span class="proj__meta">
          <b class="proj__name">${esc(p.name)}</b>
          <span class="proj__sub">${fmtTime(p.duration)} · ${p.clips} clip${p.clips === 1 ? '' : 's'} · ${fmtWhen(p.savedAt)}</span>
        </span>
        <i class="proj__del" role="button" tabindex="0" aria-label="Delete this project">✕</i>`;

      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('proj__del')) return;
        onOpen(p.id);
      });

      /**
       * Delete asks once, on the card itself.
       *
       * A native confirm() would do the job, but it freezes the whole window
       * until it is answered — including the decoders and the audio graph — and
       * it cannot be dismissed by clicking away. Turning the ✕ into a "Sure?"
       * that forgets itself after a few seconds asks the same question without
       * stopping the app, and a misclick costs nothing.
       */
      const del = card.querySelector('.proj__del');
      let armedAt = 0;
      let timer = null;
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!armedAt) {
          armedAt = Date.now();
          del.classList.add('is-armed');
          del.textContent = 'Delete?';
          timer = setTimeout(() => {
            armedAt = 0;
            del.classList.remove('is-armed');
            del.textContent = '✕';
          }, 4000);
          return;
        }
        clearTimeout(timer);
        await library.remove(p.id);
        bus.emit('toast', { msg: `Deleted "${p.name}" — your video files are untouched` });
        refresh();
      });
      grid.appendChild(card);
    }
  }

  document.getElementById('homeNew').addEventListener('click', () => onNew());

  const show = async () => {
    app.classList.add('is-home');
    await refresh();
  };
  const hide = () => app.classList.remove('is-home');
  const isOpen = () => app.classList.contains('is-home');

  document.getElementById('btnHome')?.addEventListener('click', () => {
    bus.emit('home:request');
  });

  return { show, hide, refresh, isOpen };
}
