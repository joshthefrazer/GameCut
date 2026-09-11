import { CLIP_COLORS } from '../../core/schema.js';
import { assets } from '../../media/asset-store.js';
import { keyTimes } from '../../engine/keyframes.js';
import { shortTime } from '../../core/time.js';
import { TH, alpha as hexA } from '../theme.js';

const imgCache = new Map();
function thumbFor(assetId) {
  const a = assets.get(assetId);
  if (!a?.thumb) return null;
  let img = imgCache.get(a.thumb);
  if (!img) { img = new Image(); img.src = a.thumb; imgCache.set(a.thumb, img); }
  return img.complete && img.naturalWidth ? img : null;
}

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * One clip. `rect` is already clipped to the viewport by the caller, but the
 * true (unclipped) geometry is passed as `full` so content that scrolls — the
 * waveform, the filmstrip — stays locked to the media rather than sliding.
 *
 * On the light theme clip bodies are near-opaque: a translucent block on a white
 * lane reads as washed-out and its white label stops being legible.
 */
export function drawClip(ctx, { clip, track, rect, full, selected, pps, L }) {
  const { x, y, w, h } = rect;
  if (w <= 0.5) return;
  const [c1, c2] = CLIP_COLORS[clip.type] || CLIP_COLORS.video;
  const r = 5;
  const dim = track.hidden || track.muted;

  ctx.save();
  rr(ctx, x, y, w, h, r);
  ctx.clip();

  // Body
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, hexA(c1, dim ? .34 : .97));
  g.addColorStop(1, hexA(c2, dim ? .26 : .88));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);

  // Content
  if (clip.type === 'video' || clip.type === 'image') drawFilmstrip(ctx, clip, rect, full, h);
  if (clip.type === 'audio' || (clip.type === 'video' && h > 44)) drawWaveform(ctx, clip, rect, full, pps);
  if (clip.type === 'text') drawTextPreview(ctx, clip, rect);
  if (clip.type === 'shape') {
    ctx.fillStyle = hexA(clip.shape?.fill || c1, .9);
    ctx.fillRect(x + 4, y + h - 7, Math.max(0, w - 8), 3);
  }

  // Fades
  drawFades(ctx, clip, rect, pps);

  // Header strip + label
  const hh = Math.min(15, h * .34);
  ctx.fillStyle = TH.clipHeader;
  ctx.fillRect(x, y, w, hh);
  if (w > 34) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x + 5, y, Math.max(0, w - 34), hh); ctx.clip();
    ctx.fillStyle = TH.clipLabel;
    ctx.font = '600 10px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    // Always the clip's name here. Text clips show their copy in the body band
    // below, so putting it in both places just prints the same string twice.
    ctx.fillText(clip.name || 'Clip', x + 6, y + hh / 2 + .5);
    ctx.restore();
  }
  if (w > 64) {
    ctx.fillStyle = TH.clipLabelDim;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(shortTime(clip.duration), x + w - 5, y + hh / 2 + .5);
    ctx.textAlign = 'left';
  }

  // Keyframe diamonds
  const kts = keyTimes(clip);
  if (kts.length && h > 30) {
    ctx.fillStyle = TH.key;
    ctx.strokeStyle = 'rgba(8,20,45,.45)';
    ctx.lineWidth = 1;
    for (const kt of kts) {
      const kx = L.t2x(kt);
      if (kx < x - 4 || kx > x + w + 4) continue;
      const ky = y + h - 7;
      ctx.beginPath();
      ctx.moveTo(kx, ky - 3.4); ctx.lineTo(kx + 3.4, ky);
      ctx.lineTo(kx, ky + 3.4); ctx.lineTo(kx - 3.4, ky);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }

  if (clip.locked) {
    ctx.fillStyle = 'rgba(255,255,255,.34)';
    ctx.fillRect(x, y, w, h);
  }

  ctx.restore();

  // Border / selection
  rr(ctx, x + .5, y + .5, w - 1, h - 1, r);
  if (selected) {
    ctx.strokeStyle = TH.selEdge;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.strokeStyle = TH.selRing;
    ctx.lineWidth = 2.5;
    rr(ctx, x - 1, y - 1, w + 2, h + 2, r + 1);
    ctx.stroke();
    // trim grips
    ctx.fillStyle = TH.selEdge;
    for (const gx of [x + 3, x + w - 5]) { rr(ctx, gx, y + h / 2 - 7, 2, 14, 1); ctx.fill(); }
  } else {
    ctx.strokeStyle = hexA(c1, .85);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/* ── content painters ─────────────────────────────────────────── */

function drawFilmstrip(ctx, clip, rect, full, h) {
  const img = thumbFor(clip.assetId);
  const top = Math.min(15, h * .34);
  const bandH = h - top;
  if (bandH < 8) return;
  if (!img) return;
  const tw = (img.naturalWidth / img.naturalHeight) * bandH;
  if (tw < 4) return;
  ctx.save();
  ctx.globalAlpha = .72;
  ctx.beginPath(); ctx.rect(rect.x, rect.y + top, rect.w, bandH); ctx.clip();
  for (let sx = full.x; sx < rect.x + rect.w; sx += tw) {
    if (sx + tw < rect.x) continue;
    ctx.drawImage(img, sx, rect.y + top, tw, bandH);
  }
  ctx.restore();
}

function drawWaveform(ctx, clip, rect, full, pps) {
  const a = assets.get(clip.assetId);
  const peaks = a?.peaks;
  if (!peaks) return;
  const top = Math.min(15, rect.h * .34);
  const bandY = rect.y + top + 1;
  const bandH = rect.h - top - 3;
  if (bandH < 6) return;

  const mid = bandY + bandH / 2;
  const amp = bandH / 2 - 1;
  const speed = clip.speed || 1;
  const x0 = Math.max(rect.x, 0);
  const x1 = rect.x + rect.w;

  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x, bandY, rect.w, bandH); ctx.clip();

  // RMS body — white over the saturated clip body reads cleanly at any zoom.
  ctx.fillStyle = 'rgba(255,255,255,.34)';
  for (let x = x0; x < x1; x++) {
    const st = clip.inPoint + ((x - full.x) / pps) * speed;
    const i = (st * peaks.rate) | 0;
    if (i < 0 || i >= peaks.rms.length) continue;
    const v = peaks.rms[i] * amp * 1.9;
    ctx.fillRect(x, mid - v, 1, v * 2);
  }
  // Min/max silhouette — this is the edge you cut against.
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  for (let x = x0; x < x1; x++) {
    const st = clip.inPoint + ((x - full.x) / pps) * speed;
    const i = (st * peaks.rate) | 0;
    if (i < 0 || i >= peaks.max.length) continue;
    const hi = peaks.max[i] * amp;
    const lo = peaks.min[i] * amp;
    ctx.fillRect(x, mid - hi, 1, Math.max(1, hi - lo));
  }
  ctx.strokeStyle = TH.waveMid;
  ctx.beginPath(); ctx.moveTo(rect.x, mid + .5); ctx.lineTo(x1, mid + .5); ctx.stroke();
  ctx.restore();
}

function drawTextPreview(ctx, clip, rect) {
  const top = Math.min(15, rect.h * .34);
  if (rect.h - top < 10 || rect.w < 26) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x + 5, rect.y + top, rect.w - 10, rect.h - top); ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,.78)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText((clip.text?.text || '').split('\n')[0], rect.x + 6, rect.y + top + (rect.h - top) / 2);
  ctx.restore();
}

/**
 * Fades as a ramp, the way every NLE draws them: a light wedge under a crisp
 * hypotenuse. The earlier full-height gradient wash bleached the clip's label
 * on a light theme — the ramp reads unambiguously and leaves the text alone.
 */
function drawFades(ctx, clip, rect, pps) {
  const top = Math.min(15, rect.h * .34);
  const y0 = rect.y + top;                       // ramp lives below the header
  const y1 = rect.y + rect.h;
  if (y1 - y0 < 4) return;

  /**
   * `x0` is where the level is zero, `x1` where it is full. The wedge above the
   * ramp line is the part being attenuated, so a fade-in cuts the top-left
   * corner and a fade-out cuts the top-right.
   */
  const ramp = (x0, x1) => {
    ctx.beginPath();
    ctx.moveTo(x0, y1);                          // zero level, at the floor
    ctx.lineTo(x1, y0);                          // full level, at the ceiling
    ctx.lineTo(x0, y0);                          // back along the ceiling to the zero end
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,.34)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x0, y1);
    ctx.lineTo(x1, y0);
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
  };

  if (clip.fadeIn > 0) {
    const w = Math.min(clip.fadeIn * pps, rect.w);
    if (w > 2) ramp(rect.x, rect.x + w);
  }
  if (clip.fadeOut > 0) {
    const w = Math.min(clip.fadeOut * pps, rect.w);
    if (w > 2) ramp(rect.x + rect.w, rect.x + rect.w - w);
  }
}
