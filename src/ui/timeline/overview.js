import { TH, alpha as hexA } from '../theme.js';
import { CLIP_COLORS } from '../../core/schema.js';

/**
 * The overview strip: the whole project in one line.
 *
 * Zoomed in on a long edit you lose your place — which shot is this, how much
 * is left. The strip always shows everything, with a frame around what the
 * timeline below is showing. Drag the frame to travel; click anywhere to jump
 * there; the playhead and markers are on it too.
 */
export function initOverview({ store, L, repaint, deferFollow, playback }) {
  const canvas = document.getElementById('tlOverview');
  if (!canvas) return { paint() {} };
  const ctx = canvas.getContext('2d');
  const BANDS = { text: 0, video: 1, audio: 2 };

  const span = () => Math.max(store.rt.duration * 1.04, (L.W || 1) / store.pxPerSec, 4);

  function geom() {
    const r = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const total = span();
    return { W, H, total, k: W / total };
  }

  function paint() {
    if (!canvas.isConnected || canvas.offsetParent === null) return;
    const { W, H, total, k } = geom();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = TH.lane;
    ctx.fillRect(0, 0, W, H);

    const bandH = Math.max(3, Math.floor((H - 8) / 3));
    for (const track of store.doc.tracks) {
      const band = BANDS[track.kind] ?? 1;
      const y = 4 + band * bandH;
      for (const c of track.clips) {
        const [c1] = CLIP_COLORS[c.type] || CLIP_COLORS.video;
        ctx.fillStyle = c1;
        ctx.globalAlpha = track.hidden || track.muted ? 0.35 : 0.9;
        const x = c.start * k, w = Math.max(1.5, c.duration * k);
        ctx.fillRect(x, y + 1, w, bandH - 2);
      }
    }
    ctx.globalAlpha = 1;

    for (const m of store.doc.markers) {
      ctx.fillStyle = m.color || TH.marker;
      ctx.fillRect(Math.round(m.t * k), 0, 1.5, H);
    }

    // What the timeline is showing.
    const v0 = store.ui.scrollX * k;
    const vw = Math.max(8, ((L.W || 1) / store.pxPerSec) * k);
    ctx.fillStyle = hexA(TH.acc, 0.16);
    ctx.fillRect(v0, 1, vw, H - 2);
    ctx.strokeStyle = TH.acc;
    ctx.lineWidth = 2;
    roundRect(ctx, v0 + 1, 1, Math.max(4, vw - 2), H - 2, 5);
    ctx.stroke();

    ctx.fillStyle = TH.playhead;
    ctx.fillRect(Math.round(store.rt.playhead * k) - 1, 0, 2, H);
    canvas._g = { k, v0, vw, total };
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    deferFollow(2400);
    const r = canvas.getBoundingClientRect();
    const g = canvas._g || geom();
    const x = e.clientX - r.left;
    const visible = (L.W || 1) / store.pxPerSec;
    // Grabbed inside the frame: keep the grab point under the pointer.
    // Outside: centre the view there and carry on dragging from the middle.
    let grab = x >= g.v0 && x <= g.v0 + g.vw ? (x - g.v0) / g.k : visible / 2;
    const at = (cx) => {
      const t = (cx - r.left) / g.k - grab;
      store.ui.scrollX = Math.max(0, Math.min(Math.max(0, g.total - visible * 0.5), t));
      repaint();
    };
    at(e.clientX);
    canvas.setPointerCapture?.(e.pointerId);
    const move = (ev) => at(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // Double-click: put the playhead there as well.
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const g = canvas._g || geom();
    const t = Math.max(0, (e.clientX - r.left) / g.k);
    playback?.seek?.(Math.min(t, store.rt.duration));
  });

  return { paint };
}
