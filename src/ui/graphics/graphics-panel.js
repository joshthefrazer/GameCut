import { assets } from '../../media/asset-store.js';
import { bus, raf } from '../../core/events.js';
import { placeAsset } from '../timeline/place-asset.js';
import { GFX_LOOKS } from './looks.js';
import { TEXT_PRESETS, savedTexts, deleteTextEntry } from '../../project/text-presets.js';
import { previewStyle } from '../inspector/text-panel.js';
import { defaultTextStyle } from '../../core/schema.js';
import { getBrand, setBrand, logoFromFile, logoFile } from '../../project/brand.js';
import { fontList } from '../../media/fonts.js';

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

  /**
   * Text you can put on the picture without having selected anything first:
   * the built-in looks, then the words you saved. One click adds it at the
   * playhead, as one step of undo, and selects it so it can be typed into.
   */
  function textSection() {
    const wrap = document.createElement('div');
    wrap.className = 'gfx__looks gfx__text';
    wrap.innerHTML = `<div class="gfx__label">Add text</div>`;

    const add = (entry) => {
      const clip = cmds.addTextClip(store.rt.playhead, null, entry);
      if (!clip) return;
      store.select([clip.id]);
      comp.render();
      bus.emit('inspector:refresh');
    };
    const tile = (entry, own) => {
      const b = document.createElement('button');
      b.className = 'look';
      b.dataset.textId = entry.id;
      b.title = entry.text ? `“${entry.text.slice(0, 80)}” — click to add` : `${entry.note || entry.name} — click to add`;
      const chip = document.createElement('span');
      chip.className = 'look__chip';
      chip.textContent = entry.text ? entry.text.split('\n')[0].slice(0, 9) : 'Aa';
      Object.assign(chip.style, previewStyle({ ...defaultTextStyle(), ...entry.style }));
      b.appendChild(chip);
      const cap = document.createElement('span');
      cap.className = 'look__name';
      cap.textContent = entry.name;
      b.appendChild(cap);
      b.addEventListener('click', () => add(entry.text ? entry : { ...entry, text: 'Your text' }));
      if (own) {
        const x = document.createElement('i');
        x.className = 'look__x';
        x.textContent = '×';
        x.title = 'Delete this saved text';
        x.addEventListener('click', (e) => { e.stopPropagation(); deleteTextEntry(entry.id); rerender(); });
        b.appendChild(x);
      }
      return b;
    };

    const mine = savedTexts();
    if (mine.length) {
      const h = document.createElement('div');
      h.className = 'gfx__sub';
      h.textContent = 'Your saved texts';
      wrap.appendChild(h);
      const g = document.createElement('div');
      g.className = 'looks';
      for (const e of mine) g.appendChild(tile(e, true));
      wrap.appendChild(g);
    }
    const h = document.createElement('div');
    h.className = 'gfx__sub';
    h.textContent = 'Looks';
    wrap.appendChild(h);
    const g = document.createElement('div');
    g.className = 'looks';
    for (const p of TEXT_PRESETS) g.appendChild(tile(p, false));
    wrap.appendChild(g);
    return wrap;
  }

  /**
   * Brand kit: logo, colours and font, once, for every project. New text uses
   * them; "Add my logo" drops the logo in the corner for the whole video.
   */
  function brandSection() {
    const b = getBrand();
    const wrap = document.createElement('div');
    wrap.className = 'brand';
    wrap.id = 'brandKit';
    wrap.innerHTML = `<div class="gfx__label">Brand kit</div>
      <p class="brand__lead">Set these once. Every new text starts in your font and colour.</p>
      <div class="brand__row"><span>Logo</span>
        <span class="brand__logo">${b.logo ? `<img src="${b.logo}" alt="">` : '<i>none</i>'}</span>
        <button class="btn btn--ghost btn--sm" id="brandPickLogo">${b.logo ? 'Change' : 'Choose…'}</button></div>
      <div class="brand__row"><span>Colours</span><span class="brand__cols"></span></div>
      <div class="brand__row"><span>Font</span><select class="sel" id="brandFont"></select></div>
      <button class="gfx__add" id="brandAddLogo" ${b.logo ? '' : 'disabled'}><b>Add my logo to the video</b><span>In the corner, for the whole edit</span></button>`;
    const cols = wrap.querySelector('.brand__cols');
    b.colors.forEach((c, i) => {
      const inp = document.createElement('input');
      inp.type = 'color'; inp.className = 'swatch'; inp.value = c;
      inp.dataset.i = i;
      inp.addEventListener('change', () => { const next = [...getBrand().colors]; next[i] = inp.value; setBrand({ colors: next }); });
      cols.appendChild(inp);
    });
    const fsel = wrap.querySelector('#brandFont');
    fsel.innerHTML = `<option value="">Default (Inter)</option>` + fontList().map(f => `<option ${f === b.font ? 'selected' : ''}>${f}</option>`).join('');
    fsel.addEventListener('change', () => setBrand({ font: fsel.value }));
    const pick = document.createElement('input');
    pick.type = 'file'; pick.accept = 'image/*'; pick.hidden = true; pick.id = 'brandLogoInput';
    wrap.appendChild(pick);
    wrap.querySelector('#brandPickLogo').addEventListener('click', () => pick.click());
    pick.addEventListener('change', async () => {
      const f = pick.files?.[0];
      if (!f) return;
      try {
        setBrand({ logo: await logoFromFile(f), logoName: f.name.replace(/\.[^.]+$/, '') + '.png' });
        bus.emit('toast', { msg: 'Logo saved to your brand kit', kind: 'ok' });
      } catch { bus.emit('toast', { msg: 'That picture could not be read.', kind: 'err' }); }
      rerender();
    });
    wrap.querySelector('#brandAddLogo').addEventListener('click', addLogo);
    return wrap;
  }

  async function addLogo() {
    const file = await logoFile();
    if (!file) { bus.emit('toast', { msg: 'Choose a logo in the brand kit first.' }); return null; }
    const { importFiles } = await import('../../media/importer.js');
    const [asset] = await importFiles([file]);
    if (!asset) return null;
    bus.emit('assets');
    const len = Math.max(5, store.rt.duration || 0);
    const clip = placeAsset(store, cmds, asset.id, {
      start: 0, label: 'Add logo',
      patch: { fit: 'contain', duration: len, name: 'Logo', transform: { x: 0.9, y: 0.1, scale: 0.16, opacity: 0.92 } },
    });
    if (clip) { store.select([clip.id]); comp.render(); }
    return clip;
  }
  bus.emit('palette:add', [{ id: 'logo', name: 'Add my logo to the video (brand kit)', sec: 'Add', run: addLogo }]);

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

    /* ── Text ─────────────────────────────────────────────── */
    // Text has its own drawer now; the Graphics drawer keeps to pictures.
    const textRoot = document.getElementById('textRoot');
    if (textRoot) {
      textRoot.innerHTML = '';
      const add = document.createElement('button');
      add.className = 'gfx__add gfx__add--text';
      add.id = 'btnTextAdd';
      add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span><b>Add text at the playhead</b><i>Press T any time. Pick a look below to start styled.</i></span>';
      add.addEventListener('click', () => {
        const clip = cmds.addTextClip(store.rt.playhead);
        if (clip) { store.select([clip.id]); comp.render(); }
      });
      const cap = document.createElement('button');
      cap.className = 'gfx__add gfx__add--cap';
      cap.id = 'btnCaptions';
      cap.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3"/></svg><span><b>Auto-captions</b><i>Writes what you say on screen, word by word, timed to your voice.</i></span>';
      cap.addEventListener('click', () => bus.emit('captions:open'));
      textRoot.append(add, cap, textSection(), brandSection());
    } else {
      root.appendChild(textSection());
    }

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
  bus.on('textlib', rerender);

  build();
  return { refresh: rerender, get look() { return lookId; } };
}
