import { rulerStep, tickLabel, beatTimes } from '../../core/time.js';
import { TH } from '../theme.js';

/** Time ruler, beat grid and markers. `L` is the shared layout object. */
export function drawRuler(ctx, store, L) {
  const { W, RH } = L;
  const pps = store.pxPerSec;
  const t0 = store.ui.scrollX;
  const t1 = t0 + W / pps;
  const fps = store.doc.fps;

  ctx.save();
  ctx.fillStyle = TH.rulerBg;
  ctx.fillRect(0, 0, W, RH);

  // Beat grid sits behind the ticks and extends down the tracks.
  if (store.ui.beatGrid) {
    for (const b of beatTimes(store.doc.bpm, t0, t1, store.doc.beatOffset)) {
      const x = L.t2x(b.t);
      const bar = b.beat === 0;
      ctx.fillStyle = bar ? TH.beatBar : TH.beat;
      ctx.fillRect(Math.round(x), bar ? 0 : RH * 0.55, bar ? 1.5 : 1, L.H);
    }
  }

  const step = rulerStep(pps, fps);
  const sub = step / (step >= 1 ? 5 : 2);

  ctx.strokeStyle = TH.rulerLine;
  ctx.lineWidth = 1;
  /*
   * Ticks are placed by index (i × step), never by adding `step` to a running
   * total: the running total drifts, and a tick that should sit exactly on a
   * whole second came out a hair short of it and was labelled "+30f".
   */
  ctx.beginPath();
  for (let i = Math.floor(t0 / sub); i * sub <= t1; i++) {
    const x = Math.round(L.t2x(i * sub)) + .5;
    ctx.moveTo(x, RH - 6); ctx.lineTo(x, RH);
  }
  ctx.stroke();

  ctx.strokeStyle = TH.rulerTick;
  ctx.fillStyle = TH.rulerText;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.beginPath();
  // What was written is kept on the layout so a test can read the ruler the
  // way a person does, without OCR on a canvas.
  const labels = [];
  for (let i = Math.floor(t0 / step); i * step <= t1; i++) {
    const t = i * step;
    const x = Math.round(L.t2x(t)) + .5;
    ctx.moveTo(x, RH - 11); ctx.lineTo(x, RH);
    const label = tickLabel(t, step, fps);
    labels.push(label);
    ctx.fillText(label, x + 4, 13);
  }
  L.rulerLabels = labels;
  ctx.stroke();

  // Track-area vertical grid — subtle, helps eyeball alignment.
  ctx.strokeStyle = TH.grid;
  ctx.beginPath();
  for (let i = Math.floor(t0 / step); i * step <= t1; i++) {
    const x = Math.round(L.t2x(i * step)) + .5;
    ctx.moveTo(x, RH); ctx.lineTo(x, L.H);
  }
  ctx.stroke();

  // Markers
  for (const m of store.doc.markers) {
    const x = Math.round(L.t2x(m.t));
    if (x < -20 || x > W + 20) continue;
    ctx.fillStyle = m.color || TH.marker;
    ctx.beginPath();
    ctx.moveTo(x, RH - 12); ctx.lineTo(x + 9, RH - 12);
    ctx.lineTo(x + 6, RH - 7); ctx.lineTo(x + 9, RH - 2);
    ctx.lineTo(x, RH - 2); ctx.closePath(); ctx.fill();
    ctx.fillRect(x - .5, RH - 12, 1, L.H - RH + 12);
  }

  ctx.fillStyle = TH.edge;
  ctx.fillRect(0, RH - 1, W, 1);
  ctx.restore();
}

/** Playhead — drawn last so it sits above every clip. */
export function drawPlayhead(ctx, store, L) {
  const x = Math.round(L.t2x(store.rt.playhead)) + .5;
  if (x < -8 || x > L.W + 8) return;

  ctx.save();
  ctx.strokeStyle = TH.playhead;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, L.RH - 4); ctx.lineTo(x, L.H);
  ctx.stroke();

  ctx.fillStyle = TH.playhead;
  ctx.beginPath();
  ctx.moveTo(x - 6, L.RH - 14);
  ctx.lineTo(x + 6, L.RH - 14);
  ctx.lineTo(x + 6, L.RH - 6);
  ctx.lineTo(x, L.RH - 1);
  ctx.lineTo(x - 6, L.RH - 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const SNAP_NAMES = {
  playhead: 'Playhead', clip: 'Clip edge', marker: 'Marker', beat: 'Beat', origin: 'Start',
};

/**
 * Live snap indicator while dragging — and what it snapped to.
 *
 * A dashed line alone says "something grabbed this"; the label says what, so
 * a clip that jumped to a marker you forgot about is not a mystery.
 */
export function drawSnapLine(ctx, store, L) {
  const t = store.rt.snapLine;
  if (t == null) return;
  const x = Math.round(L.t2x(t)) + .5;
  ctx.save();
  ctx.strokeStyle = TH.snap;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, L.RH); ctx.lineTo(x, L.H);
  ctx.stroke();
  ctx.setLineDash([]);
  const name = SNAP_NAMES[store.rt.snapKind];
  if (name) {
    ctx.font = '600 10px system-ui, -apple-system, sans-serif';
    const w = ctx.measureText(name).width + 12;
    const lx = Math.min(L.W - w - 2, Math.max(2, x + 4));
    ctx.fillStyle = TH.snap;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(lx, L.RH + 3, w, 16, 8) : ctx.rect(lx, L.RH + 3, w, 16);
    ctx.fill();
    ctx.fillStyle = '#04121c';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, lx + 6, L.RH + 11.5);
  }
  ctx.restore();
}

/** Razor tool: where a click would cut. */
export function drawRazorLine(ctx, store, L) {
  const r = store.rt.razorAt;
  if (!r || store.ui.tool !== 'razor') return;
  const x = Math.round(L.t2x(r.t)) + .5;
  ctx.save();
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (r.all) { ctx.moveTo(x, L.RH); ctx.lineTo(x, L.H); }
  else { ctx.moveTo(x, r.y0); ctx.lineTo(x, r.y1); }
  ctx.stroke();
  ctx.restore();
}
