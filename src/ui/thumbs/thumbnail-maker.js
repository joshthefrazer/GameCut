import { bus } from '../../core/events.js';
import { text as bigText, rr, FONT_DISPLAY } from '../../anim/kit.js';
import { findHighlights } from '../../edit/analysis.js';

/**
 * Thumbnail maker: your best frame, big words, done.
 *
 * Frames to start from are picked for you — the loud moments, your markers,
 * then evenly through the video — drawn at full quality. On top go one or
 * two lines of huge words, an optional arrow or circle, and a "make it pop"
 * that lifts contrast and colour the way thumbnails do. "Check it small"
 * shows it at the size it will really be seen in a feed.
 */

const ARROW = (ctx, x, y, s, rot, col) => {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 12; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(-160, -40); ctx.lineTo(30, -40); ctx.lineTo(30, -100); ctx.lineTo(170, 0); ctx.lineTo(30, 100); ctx.lineTo(30, 40); ctx.lineTo(-160, 40); ctx.closePath();
  ctx.stroke(); ctx.fill(); ctx.restore();
};

export function initThumbnails({ store, qol }) {
  const el = document.createElement('div');
  el.className = 'pal qold';
  el.id = 'thumbMaker';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Thumbnail maker');
  document.body.appendChild(el);

  const o = { line1: '1v4', line2: 'CLUTCH', c1: '#FFFFFF', c2: '#C6FF3D', side: 'left', size: 1, pop: true, sticker: 'arrow', glow: true };
  let frames = [], pick = 0, bitmaps = new Map();

  const tall = () => store.doc.height > store.doc.width;
  const outSize = () => (tall() ? { w: 1080, h: 1920 } : { w: 1280, h: 720 });

  async function frameAt(t) {
    if (bitmaps.has(t)) return bitmaps.get(t);
    const blob = await qol.fullFrame(t, 'image/jpeg');
    const bmp = blob ? await createImageBitmap(blob) : null;
    bitmaps.set(t, bmp);
    return bmp;
  }

  function candidates() {
    const d = store.rt.duration || 0;
    const ts = [];
    try { for (const h of findHighlights(store, { max: 4 })) ts.push(h.t); } catch { /* no sound */ }
    for (const m of store.doc.markers || []) ts.push(m.t);
    ts.push(store.rt.playhead);
    for (let i = 1; i <= 4; i++) ts.push((d * i) / 5);
    const out = [];
    // Not the very start: recordings so often open on a black frame.
    for (const t of ts) if (t >= Math.min(0.5, d * 0.05) && t <= d && !out.some(x => Math.abs(x - t) < 0.8)) out.push(+t.toFixed(2));
    return out.slice(0, 8);
  }

  /** Draw the thumbnail into a W×H canvas context. */
  function draw(ctx, W, H, bmp) {
    ctx.save();
    ctx.fillStyle = '#06080F'; ctx.fillRect(0, 0, W, H);
    if (bmp) {
      const k = Math.max(W / bmp.width, H / bmp.height);
      if (o.pop) ctx.filter = 'contrast(1.18) saturate(1.4) brightness(1.04)';
      ctx.drawImage(bmp, (W - bmp.width * k) / 2, (H - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
      ctx.filter = 'none';
    }
    // Darken the words' side a touch so they read on anything.
    const g = ctx.createLinearGradient(o.side === 'left' ? 0 : W, 0, o.side === 'left' ? W * 0.7 : W * 0.3, 0);
    g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    const S = Math.min(W, H) / 720;
    const size = (tall() ? 190 : 170) * S * o.size;
    const x = o.side === 'left' ? W * 0.06 : W * 0.94;
    const align = o.side === 'left' ? 'left' : 'right';
    const y1 = tall() ? H * 0.2 : H * 0.36, y2 = y1 + size * 1.02;
    const opts = (col) => ({ size, font: FONT_DISPLAY, weight: 900, color: col, stroke: '#06080F', strokeW: size * 0.09, align, italic: true, maxW: W * 0.62, glow: o.glow ? col : null, glowR: o.glow ? size * 0.35 : 0 });
    if (o.line1) bigText(ctx, String(o.line1).toUpperCase(), x, y1, opts(o.c1));
    if (o.line2) bigText(ctx, String(o.line2).toUpperCase(), x, o.line1 ? y2 : y1, opts(o.c2));

    if (o.sticker === 'arrow') ARROW(ctx, o.side === 'left' ? W * 0.8 : W * 0.2, H * 0.74, S * 0.7, o.side === 'left' ? 2.6 : 0.55, o.c2);
    if (o.sticker === 'circle') {
      ctx.strokeStyle = '#FF3B30'; ctx.lineWidth = 16 * S; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.ellipse(o.side === 'left' ? W * 0.74 : W * 0.26, H * 0.55, 150 * S, 120 * S, -0.2, 0.2, Math.PI * 2.05); ctx.stroke();
    }
    ctx.restore();
  }

  async function paint() {
    const big = el.querySelector('#thumbBig'), small = el.querySelector('#thumbSmall');
    if (!big) return;
    const { w, h } = outSize();
    const bmp = frames.length ? await frameAt(frames[pick]) : null;
    big.width = w; big.height = h;
    draw(big.getContext('2d'), w, h, bmp);
    const sw = tall() ? 96 : 168;
    small.width = sw * 2; small.height = Math.round(sw * 2 * h / w);
    small.getContext('2d').drawImage(big, 0, 0, small.width, small.height);
  }

  async function open() {
    frames = candidates();
    pick = 0;
    bitmaps = new Map();
    const { w, h } = outSize();
    el.innerHTML = `
      <div class="pal__box qold__box thm">
        <div class="vers__head"><b>Thumbnail maker</b><span>Start from a good frame, add big words. ${w}×${h}, ready to upload.</span>
          <button class="btn btn--ghost btn--sm" data-close>Close</button></div>
        <div class="thm__body">
          <div class="thm__stage">
            <canvas id="thumbBig" class="thm__big${tall() ? ' is-tall' : ''}"></canvas>
            <div class="szoom__lbl">Best frames</div>
            <div class="thm__frames">${frames.map((t, i) => `<button class="thm__frame${i === 0 ? ' is-on' : ''}" data-frame="${i}"><canvas width="160" height="90"></canvas><span>${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}</span></button>`).join('')}</div>
          </div>
          <div class="thm__side">
            <div class="szoom__lbl">Big words</div>
            <label class="libf"><span>Top line</span><input data-o="line1" value="${o.line1}" spellcheck="false"></label>
            <label class="libf"><span>Bottom line</span><input data-o="line2" value="${o.line2}" spellcheck="false"></label>
            <div class="thm__row"><label class="libf libf--col"><span>Top colour</span><input type="color" data-o="c1" value="${o.c1}"></label>
              <label class="libf libf--col"><span>Bottom colour</span><input type="color" data-o="c2" value="${o.c2}"></label></div>
            <div class="szoom__styles"><button class="achip${o.side === 'left' ? ' is-on' : ''}" data-side="left">Words left</button><button class="achip${o.side === 'right' ? ' is-on' : ''}" data-side="right">Words right</button></div>
            <label class="libf"><span>Word size</span><input type="range" data-o="size" min="0.6" max="1.5" step="0.05" value="${o.size}"></label>
            <div class="szoom__lbl">Extras</div>
            <div class="szoom__styles">${[['arrow', 'Arrow'], ['circle', 'Red circle'], ['none', 'No sticker']].map(([k, n]) => `<button class="achip${o.sticker === k ? ' is-on' : ''}" data-sticker="${k}">${n}</button>`).join('')}</div>
            <label class="szoom__chk"><input type="checkbox" data-o="pop" ${o.pop ? 'checked' : ''}> Make it pop (contrast and colour)</label>
            <label class="szoom__chk"><input type="checkbox" data-o="glow" ${o.glow ? 'checked' : ''}> Glow behind the words</label>
            <div class="szoom__lbl">Check it small</div>
            <canvas id="thumbSmall" class="thm__small"></canvas>
            <button class="btn btn--primary" id="thumbSave">Save ${w}×${h} PNG</button>
          </div>
        </div>
      </div>`;
    el.hidden = false;
    paint();
    // The little frame pickers fill in one by one.
    el.querySelectorAll('.thm__frame').forEach(async (b, i) => {
      const bmp = await frameAt(frames[i]);
      if (!bmp) return;
      const c = b.querySelector('canvas'), x = c.getContext('2d');
      const k = Math.max(160 / bmp.width, 90 / bmp.height);
      x.drawImage(bmp, (160 - bmp.width * k) / 2, (90 - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    });
  }

  async function savePng() {
    const big = el.querySelector('#thumbBig');
    const blob = await new Promise(r => big.toBlob(r, 'image/png'));
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = `${(store.doc.name || 'Strike').replace(/[<>:"/\\|?*]/g, '')} thumbnail.png`;
    const xs = window.gamecut?.exportSink;
    if (!xs) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { bytes: bytes.length };
    }
    const d = await xs.open({ suggestedName: name, title: 'Save the thumbnail' });
    if (!d) return null;
    try {
      await xs.write(d.token, bytes, 0);
      const r = await xs.close(d.token);
      if (!r?.ok) throw new Error(r?.reason || 'could not save');
    } catch (e) {
      await xs.abort?.(d.token).catch(() => {});
      bus.emit('toast', { msg: `Could not save the thumbnail: ${e.message}`, kind: 'err' });
      return null;
    }
    bus.emit('toast', { msg: `Thumbnail saved (${big.width}×${big.height})`, kind: 'ok' });
    return { path: d.path, bytes: bytes.length };
  }

  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) { el.hidden = true; return; }
    const f = e.target.closest('[data-frame]');
    if (f) { pick = +f.dataset.frame; el.querySelectorAll('[data-frame]').forEach(b => b.classList.toggle('is-on', b === f)); paint(); return; }
    const s = e.target.closest('[data-side]');
    if (s) { o.side = s.dataset.side; el.querySelectorAll('[data-side]').forEach(b => b.classList.toggle('is-on', b === s)); paint(); return; }
    const st = e.target.closest('[data-sticker]');
    if (st) { o.sticker = st.dataset.sticker; el.querySelectorAll('[data-sticker]').forEach(b => b.classList.toggle('is-on', b === st)); paint(); return; }
    if (e.target.closest('#thumbSave')) savePng();
  });
  el.addEventListener('input', (e) => {
    const k = e.target.dataset.o; if (!k) return;
    o[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? +e.target.value : e.target.value;
    paint();
  });
  el.addEventListener('keydown', (e) => e.stopPropagation());
  window.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); el.hidden = true; } }, true);
  bus.on('thumbnail:open', open);
  document.getElementById('btnThumb')?.addEventListener('click', open);
  bus.emit('palette:add', [{ id: 'thumbnail', name: 'Thumbnail maker: best frame plus big words', sec: 'Export', run: open }]);
  void rr;
  return { open, save: savePng, draw, get options() { return o; } };
}
