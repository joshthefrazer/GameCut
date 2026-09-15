import { assets } from '../../media/asset-store.js';
import { bus, raf } from '../../core/events.js';
import { placeAsset } from '../timeline/place-asset.js';
import { GFX_LOOKS } from './looks.js';

/**
 * The Graphics tab.
 *
 * Media is where footage lives; this is where the things you put *on top* of
 * footage live — logos, cut-outs, stickers, webcam frames, emotes. Mechanically
 * they are the same image assets, and the tab does not pretend otherwise: it is
 * a filtered view of the pool with one important addition, which is that
 * dropping one in gives it a look rather than leaving it as a bare rectangle
 * sitting on the picture.
 *
 * That is the whole idea behind the looks row at the top. Almost nobody wants a
 * screenshot pasted flat onto their video; they want it with a shadow under it,
 * or a white sticker edge around it, or tilted a few degrees. Choosing that
 * before you place it means the first thing you see is already the thing you
 * meant, which is a very different experience from placing something ugly and
 * then going looking for the controls that fix it.
 */
export function initGraphics({ store, cmds, comp }) {
  const root = document.getElementById('gfxRoot');
  if (!root) return { refresh() {} };

  const picker = document.getElementById('filePicker');
  const rerender = raf(build);

  /** The look a newly placed graphic gets. Remembered for the session. */
  let lookId = 'shadow';
  try {
    const saved = localStorage.getItem('gamecut.gfx.look');
    if (saved && GFX_LOOKS.some(l => l.id === saved)) lookId = saved;
  } catch { /* no storage */ }

  /**
   * Put a graphic on the picture, configured, in ONE step.
   *
   * Everything about how it lands is folded into the clip before it is added,
   * so a single Ctrl+Z removes it. Setting the look, the size and the fit as
   * three commands afterwards is the obvious way to write this, and it means
   * undoing a graphic walks you backwards through a full-frame version of it
   * with no shadow — three states nobody asked to see.
   */
  function place(asset) {
    const look = GFX_LOOKS.find(l => l.id === lookId);
    const clip = placeAsset(store, cmds, asset.id, {
      allowShift: true,
      label: 'Add graphic',
      patch: {
        fx: look?.fx ? { ...look.fx } : null,
        // Graphics sit on top of footage, so they arrive at a size that reads
        // as an overlay rather than as a background.
        fit: 'contain',
        transform: { scale: 0.42 },
      },
    });
    if (!clip) return;
    store.select([clip.id]);
    comp.render();
    bus.emit('inspector:refresh');
  }

  function build() {
    const list = assets.all().filter(a => a.kind === 'image');
    root.innerHTML = '';

    /* ── Add ──────────────────────────────────────────────── */
    const add = document.createElement('button');
    add.className = 'gfx__add';
    add.id = 'gfxAdd';
    add.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
      <span><b>Add a graphic</b><i>PNG, JPG, WebP or GIF — cut-outs with transparency work best</i></span>`;
    const ALL = 'video/*,audio/*,image/*,.ttf,.otf,.woff,.woff2';
    add.addEventListener('click', () => {
      picker.setAttribute('accept', 'image/*');
      // Put it back when the dialog actually closes, rather than after a guessed
      // delay — otherwise the Import button in the top bar can be left offering
      // images only, or this one can be reset before the dialog has opened.
      const restore = () => {
        picker.setAttribute('accept', ALL);
        picker.removeEventListener('change', restore);
        picker.removeEventListener('cancel', restore);
        window.removeEventListener('focus', restore);
      };
      picker.addEventListener('change', restore);
      picker.addEventListener('cancel', restore);
      // `cancel` is not fired by every build; regaining window focus is the
      // backstop for someone who closes the dialog with Escape.
      setTimeout(() => window.addEventListener('focus', restore, { once: false }), 300);
      picker.click();
    });
    root.appendChild(add);

    /* ── Look ─────────────────────────────────────────────── */
    const lookWrap = document.createElement('div');
    lookWrap.className = 'gfx__looks';
    lookWrap.innerHTML = `<div class="gfx__label">How it lands</div>`;
    const looks = document.createElement('div');
    looks.className = 'gfx__lookrow';
    for (const l of GFX_LOOKS) {
      const b = document.createElement('button');
      b.className = 'gfxlook' + (l.id === lookId ? ' is-on' : '');
      b.dataset.look = l.id;
      b.title = l.note;
      b.innerHTML = `<span class="gfxlook__art">${l.art}</span>
        <span class="gfxlook__name"></span>`;
      b.querySelector('.gfxlook__name').textContent = l.name;
      b.addEventListener('click', () => {
        lookId = l.id;
        try { localStorage.setItem('gamecut.gfx.look', lookId); } catch { /* no storage */ }
        for (const x of looks.querySelectorAll('.gfxlook'))
          x.classList.toggle('is-on', x.dataset.look === lookId);
      });
      looks.appendChild(b);
    }
    lookWrap.appendChild(looks);
    root.appendChild(lookWrap);

    /* ── Your graphics ────────────────────────────────────── */
    const head = document.createElement('div');
    head.className = 'gfx__label gfx__label--head';
    head.textContent = list.length ? `Your graphics (${list.length})` : 'Your graphics';
    root.appendChild(head);

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = `<b>Nothing here yet</b><span>Add a PNG of your logo, a cut-out,
        an emote or a webcam frame. It lands on the picture with the look you picked above,
        and everything about it stays adjustable afterwards.</span>`;
      root.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'gfx__grid';
    for (const a of list) {
      const b = document.createElement('button');
      b.className = 'gfxtile';
      b.dataset.asset = a.id;
      b.title = `${a.name} — click to put it on the picture`;
      b.innerHTML = `<span class="gfxtile__art"></span><span class="gfxtile__name"></span>`;
      const art = b.querySelector('.gfxtile__art');
      if (a.thumb || a.url) {
        const img = document.createElement('img');
        img.src = a.thumb || a.url;
        img.alt = '';
        art.appendChild(img);
      }
      b.querySelector('.gfxtile__name').textContent = a.name;
      b.addEventListener('click', () => place(a));
      grid.appendChild(b);
    }
    root.appendChild(grid);
  }

  assets.on('change', rerender);
  bus.on('assets', rerender);

  build();
  return { refresh: rerender, get look() { return lookId; } };
}
