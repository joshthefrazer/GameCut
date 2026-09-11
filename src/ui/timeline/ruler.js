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
  ctx.beginPath();
  for (let t = Math.floor(t0 / sub) * sub; t <= t1; t += sub) {
    const x = Math.round(L.t2x(t)) + .5;
    ctx.moveTo(x, RH - 6); ctx.lineTo(x, RH);
  }
  ctx.stroke();

  ctx.strokeStyle = TH.rulerTick;
  ctx.fillStyle = TH.rulerText;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.beginPath();
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(L.t2x(t)) + .5;
    ctx.moveTo(x, RH - 11); ctx.lineTo(x, RH);
    ctx.fillText(tickLabel(t, step, fps), x + 4, 13);
  }
  ctx.stroke();

  // Track-area vertical grid — subtle, helps eyeball alignment.
  ctx.strokeStyle = TH.grid;
  ctx.beginPath();
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(L.t2x(t)) + .5;
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

/** Live snap indicator while dragging. */
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
  ctx.restore();
}
