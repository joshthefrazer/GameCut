import { valuesFor, drawAnim } from '../../anim/defs.js';

/**
 * Living thumbnails for the animation library.
 *
 * One animation frame loop drives every card on screen. A card only moves
 * while it can be seen (and, in the drawer, while the pointer is on it), so a
 * library of twenty moving cards costs nothing once it is scrolled away or
 * hidden. Off, a card holds the animation's best moment: fully arrived.
 */

const cards = new Set();
let raf = 0, last = 0;
const seen = new WeakSet();
const io = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((list) => {
    for (const e of list) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); }
    kick();
  })
  : null;

/** The picture behind a card: a stand-in game scene so pop-ups have something to sit on. */
function backdrop(ctx, w, h, hue) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 32% 20%)`);
  g.addColorStop(1, `hsl(${(hue + 50) % 360} 30% 9%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.04)';
  for (let i = 0; i < 6; i++) ctx.fillRect(0, h * (0.55 + i * 0.08), w, 1);
}

function paint(card, t) {
  const { canvas, def } = card;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth || 200, ch = canvas.clientHeight || 120;
  const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  backdrop(ctx, W, H, card.hue);
  const full = !!def.full;
  const bh = full ? 1000 * H / W : def.h;
  const k = full ? W / 1000 : Math.min((W * 0.86) / 1000, (H * 0.8) / def.h);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(k, k);
  ctx.translate(-500, -bh / 2);
  try { drawAnim(ctx, def, t, def.dur, valuesFor(def, card.p || {}), undefined, undefined, bh); } catch { /* a card never throws */ }
  ctx.restore();
}

/** A moment that shows the animation at its best, for a card at rest. */
const restT = (def) => Math.min(def.dur * 0.55, (def.inDur ?? 0.4) + 0.5);

function loop(now) {
  raf = 0;
  let moving = false;
  if (now - last > 30) {
    last = now;
    for (const c of cards) {
      if (!c.canvas.isConnected) { cards.delete(c); continue; }
      const live = seen.has(c.canvas) && (c.always || c.hover);
      if (!live) { if (c.resting !== true) { paint(c, restT(c.def)); c.resting = true; } continue; }
      c.resting = false;
      moving = true;
      const period = c.def.dur + 0.6;
      const t = ((now - c.t0) / 1000) % period;
      paint(c, Math.min(t, c.def.dur - 0.001));
    }
  } else moving = true;
  if (moving) raf = requestAnimationFrame(loop);
}
function kick() { if (!raf) raf = requestAnimationFrame(loop); }

/**
 * Make `canvas` a living thumbnail of `def`. `always` plays whenever it is on
 * screen; otherwise it plays while hovered. Returns a handle to change the
 * values it shows (the Customize panel's preview) or restart it.
 */
export function liveThumb(canvas, def, { always = false, p = null, hoverEl = null } = {}) {
  const card = { canvas, def, always, p, hover: false, t0: performance.now(), resting: null,
    hue: (def.id.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) * 37) % 360 };
  cards.add(card);
  const el = hoverEl || canvas;
  el.addEventListener('pointerenter', () => { card.hover = true; card.t0 = performance.now(); kick(); });
  el.addEventListener('pointerleave', () => { card.hover = false; card.resting = null; kick(); });
  if (io) io.observe(canvas); else seen.add(canvas);
  requestAnimationFrame(() => { paint(card, restT(def)); card.resting = true; });
  kick();
  return {
    set(p2) { card.p = p2; card.resting = null; kick(); },
    restart() { card.t0 = performance.now(); kick(); },
    setDef(d) { card.def = d; card.resting = null; kick(); },
    drop() { cards.delete(card); io?.unobserve(canvas); },
  };
}

/** Repaint every resting card — fonts arriving late change how text measures. */
export function refreshThumbs() { for (const c of cards) c.resting = null; kick(); }
if (document.fonts?.ready) document.fonts.ready.then(refreshThumbs);
