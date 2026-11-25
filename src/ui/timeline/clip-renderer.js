import { CLIP_COLORS } from '../../core/schema.js';
import { assets } from '../../media/asset-store.js';
import { keyTimes } from '../../engine/keyframes.js';
import { shortTime } from '../../core/time.js';
import { TH, alpha as hexA } from '../theme.js';
import { envelope } from '../../engine/layers/effects.js';
import { tileAt, stepFor } from '../../media/filmstrip.js';

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
export function drawClip(ctx, { clip, track, rect, full, selected, pps, L, hover = false, conflict = false }) {
  const { x, y, w, h } = rect;
  if (w <= 0.5) return;
  // A colour label wins over the clip's type colour.
  const [c1, c2] = clip.label ? [clip.label, mix(clip.label, '#ffffff', 0.3)] : (CLIP_COLORS[clip.type] || CLIP_COLORS.video);
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
  if (clip.type === 'video' || clip.type === 'image') drawFilmstrip(ctx, clip, rect, full, h, pps);
  if (clip.type === 'audio' || (clip.type === 'video' && !clip.silent && h >= 30)) drawWaveform(ctx, clip, rect, full, pps);
  if (clip.type === 'text') drawTextPreview(ctx, clip, rect);
  if (clip.type === 'anim') drawAnimPreview(ctx, clip, rect);
  if (clip.type === 'effect') drawEnvelope(ctx, clip, rect, full);
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
  if (clip.label) {
    // A colour label shows even over the picture strip: the header takes the colour.
    ctx.fillStyle = hexA(clip.label, .82);
    ctx.fillRect(x, y, w, hh);
    ctx.fillRect(x, y + h - 3, w, 3);
  }
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
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    const wasBase = ctx.textBaseline;
    ctx.textBaseline = 'middle';      // without it the top half was cut off
    ctx.fillText(shortTime(clip.duration), x + w - 5, y + hh / 2 + .5);
    ctx.textBaseline = wasBase;
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

  // Dropped here it would cover another clip, so it goes on a lane of its own.
  if (conflict) {
    ctx.fillStyle = 'rgba(251,191,36,.30)';
    ctx.fillRect(x, y, w, h);
    if (w > 70) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = '700 10px system-ui, -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('↑ new layer', x + 6, y + h - 8);
    }
  }

  // A chain: this clip follows another (a crop of it, its sound).
  if ((clip.linkTo || clip.badgeFor) && w > 46) {
    const hh2 = Math.min(15, h * .34);
    drawChain(ctx, x + w - (w > 64 ? 46 : 14), y + hh2 / 2);
  }

  ctx.restore();

  // Hover: the trim handles, wide enough to see and to grab.
  if ((hover || selected) && !clip.locked && !track.locked && full.w > 6) {
    const hw = Math.min(8, Math.max(3, full.w / 4));
    ctx.save();
    ctx.fillStyle = selected ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.6)';
    for (const hx of [full.x, full.x + full.w - hw]) {
      if (hx + hw < x - 1 || hx > x + w + 1) continue;
      rr(ctx, hx, y + 2, hw, h - 4, 3); ctx.fill();
      ctx.fillStyle = 'rgba(8,16,32,.55)';
      ctx.fillRect(hx + hw / 2 - .5, y + h / 2 - 6, 1, 12);
      ctx.fillStyle = selected ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.6)';
    }
    ctx.restore();
  }

  // Fade dots on the top corners — drag them in to fade.
  if ((hover || selected) && !clip.locked && !track.locked && clip.type !== 'effect' && full.w >= 46 && h >= 26) {
    const hy = y + Math.min(15, h * .34);
    const fi = Math.min(full.w / 2 - 4, Math.max(12, (clip.fadeIn || 0) * pps));
    const fo = Math.min(full.w / 2 - 4, Math.max(12, (clip.fadeOut || 0) * pps));
    ctx.save();
    for (const [hx, on] of [[full.x + fi, clip.fadeIn > 0], [full.x + full.w - fo, clip.fadeOut > 0]]) {
      if (hx < x - 4 || hx > x + w + 4) continue;
      ctx.beginPath();
      ctx.arc(hx, hy, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#ffffff' : 'rgba(255,255,255,.75)';
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(8,16,32,.8)';
      ctx.stroke();
    }
    ctx.restore();
  }

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
  } else {
    ctx.strokeStyle = hexA(c1, .85);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/* ── content painters ─────────────────────────────────────────── */

function drawFilmstrip(ctx, clip, rect, full, h, pps) {
  const img = thumbFor(clip.assetId);
  const asset = clip.type === 'video' ? assets.get(clip.assetId) : null;
  const top = Math.min(15, h * .34);
  const bandH = h - top;
  if (bandH < 8) return;
  if (!img) return;
  const tw = (img.naturalWidth / img.naturalHeight) * bandH;
  if (tw < 4) return;
  ctx.save();
  ctx.globalAlpha = .92;
  ctx.beginPath(); ctx.rect(rect.x, rect.y + top, rect.w, bandH); ctx.clip();
  for (let sx = full.x; sx < rect.x + rect.w; sx += tw) {
    if (sx + tw < rect.x) continue;
    // Each tile is the moment in the middle of it.
    const speed = clip.speed || 1;
    const t = clip.inPoint + ((sx + tw / 2 - full.x) / pps) * speed;
    const pic = asset && tileAt(asset, t, stepFor((tw / pps) * speed));
    ctx.drawImage(pic || img, sx, rect.y + top, tw + 0.5, bandH);
    if (asset && tw > 26) { ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(sx + tw - 0.5, rect.y + top, 1, bandH); }
  }
  ctx.restore();
}

function drawWaveform(ctx, clip, rect, full, pps) {
  const a = assets.get(clip.assetId);
  const peaks = a?.peaks;
  if (!peaks) return;
  const top = Math.min(15, rect.h * .34);
  const video = clip.type === 'video';
  const all = rect.h - top - 3;
  // Under the pictures on a video, the whole height on a sound.
  const bandH = video ? Math.max(8, Math.round(all * 0.38)) : all;
  const bandY = rect.y + rect.h - 2 - bandH;
  if (bandH < 6) return;

  const mid = bandY + bandH / 2;
  const amp = bandH / 2 - 1;
  const speed = clip.speed || 1;
  const x0 = Math.max(rect.x, 0);
  const x1 = rect.x + rect.w;

  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x, bandY, rect.w, bandH); ctx.clip();
  if (video) { ctx.fillStyle = 'rgba(4,7,14,.62)'; ctx.fillRect(rect.x, bandY, rect.w, bandH); }
  // What you hear: quieter when turned down, faint when muted.
  const vol = Math.min(1.4, clip.volume ?? 1);
  ctx.globalAlpha = clip.muted ? 0.3 : 1;
  const per = Math.max(1, Math.min(48, Math.ceil(speed * peaks.rate / pps)));   // summaries under one pixel
  const peakAt = (arr, i, pick) => { let v = arr[i]; for (let k = 1; k < per && i + k < arr.length; k++) if (pick ? arr[i + k] > v : arr[i + k] < v) v = arr[i + k]; return v; };

  // RMS body — white over the saturated clip body reads cleanly at any zoom.
  ctx.fillStyle = 'rgba(255,255,255,.34)';
  for (let x = x0; x < x1; x++) {
    const st = clip.inPoint + ((x - full.x) / pps) * speed;
    const i = (st * peaks.rate) | 0;
    if (i < 0 || i >= peaks.rms.length) continue;
    const v = Math.min(amp, peakAt(peaks.rms, i, true) * amp * 1.9 * vol);
    ctx.fillRect(x, mid - v, 1, v * 2);
  }
  // Min/max silhouette — this is the edge you cut against.
  ctx.fillStyle = video ? 'rgba(255,255,255,.8)' : 'rgba(255,255,255,.92)';
  for (let x = x0; x < x1; x++) {
    const st = clip.inPoint + ((x - full.x) / pps) * speed;
    const i = (st * peaks.rate) | 0;
    if (i < 0 || i >= peaks.max.length) continue;
    const hi = Math.min(amp, peakAt(peaks.max, i, true) * amp * vol);
    const lo = Math.max(-amp, peakAt(peaks.min, i, false) * amp * vol);
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

/** An animation: a bolt, then the words it shows (or its name). */
function drawAnimPreview(ctx, clip, rect) {
  const top = Math.min(15, rect.h * .34);
  if (rect.h - top < 10 || rect.w < 22) return;
  const p = clip.anim?.p || {};
  const words = p.label || p.title || p.name || p.msg || '';
  const cy = rect.y + top + (rect.h - top) / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x + 3, rect.y + top, rect.w - 6, rect.h - top); ctx.clip();
  ctx.fillStyle = 'rgba(6,8,15,.82)';
  const bx = rect.x + 7, s = Math.min(9, (rect.h - top) * 0.32);
  ctx.beginPath();
  ctx.moveTo(bx + s * 0.6, cy - s); ctx.lineTo(bx, cy + s * 0.15); ctx.lineTo(bx + s * 0.45, cy + s * 0.15);
  ctx.lineTo(bx + s * 0.3, cy + s); ctx.lineTo(bx + s * 0.95, cy - s * 0.2); ctx.lineTo(bx + s * 0.5, cy - s * 0.2);
  ctx.closePath(); ctx.fill();
  if (words && rect.w > 40) {
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(words), bx + s + 6, cy);
  }
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

function drawChain(ctx, cx, cy) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 1.3;
  for (const dx of [-2.6, 2.6]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx, cy, 3.2, 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** An effect clip draws its own strength over time: the shape of the hit. */
function drawEnvelope(ctx, clip, rect, full) {
  const top = Math.min(15, rect.h * .34);
  const y0 = rect.y + top + 2, y1 = rect.y + rect.h - 3;
  if (y1 - y0 < 5 || full.w < 4) return;
  const kind = clip.effect?.kind || 'zoom';
  const amt = clip.effect?.amount ?? 0.6;
  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x, y0, rect.w, y1 - y0); ctx.clip();
  ctx.beginPath();
  ctx.moveTo(full.x, y1);
  const n = Math.max(8, Math.min(120, Math.round(full.w / 3)));
  for (let i = 0; i <= n; i++) {
    const lx = full.x + (full.w * i) / n;
    const v = envelope(kind, (clip.duration * i) / n, clip.duration, clip.effect?.style) * (0.35 + 0.65 * amt);
    ctx.lineTo(lx, y1 - v * (y1 - y0));
  }
  ctx.lineTo(full.x + full.w, y1);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,.28)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

/** Blend two #rrggbb colours (t = share of b). */
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
