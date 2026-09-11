import { junctions, transitionSpan } from '../../engine/transitions.js';
import { TH } from '../theme.js';

/**
 * The little button that sits on a cut.
 *
 * This is the piece that was missing. Transitions existed, but the only way to
 * reach one was to select the right clip and find a panel — so the feature was
 * invisible unless you already knew it was there. CapCut puts a small button in
 * the seam between two clips: you can see every cut that could take a
 * transition, see at a glance which ones already have one, and click straight
 * onto the thing you want to change. That is the whole idea, and it is worth
 * copying exactly.
 *
 * Drawn on the canvas with everything else rather than as DOM: there can be
 * hundreds of cuts on a long timeline, and hundreds of absolutely-positioned
 * elements being moved on every scroll is the kind of cost this editor has
 * already paid once and will not pay again. The boxes are kept in `L.junctions`
 * so the pointer code can hit-test them without recomputing anything.
 */

/** Badge size in px. Square, and never taller than the lane it sits in. */
const SIZE = 18;
const MIN_ROW_H = 26;

export function layoutJunctions(store, L) {
  const out = [];
  const pps = store.pxPerSec;
  for (const j of junctions(store.doc)) {
    const row = L.rowFor(j.track.id);
    if (!row) continue;
    if (row.h < MIN_ROW_H) continue;
    if (row.y + row.h < L.RH || row.y > L.H) continue;
    const x = L.t2x(j.t);
    if (x < -SIZE || x > L.W + SIZE) continue;

    /**
     * The badge never covers the clips it sits between.
     *
     * Zoomed out, two clips either side of a cut can each be narrower than the
     * button — and then the button is the only thing you can hit, so the clips
     * themselves become unclickable and right-clicking one gives you the menu
     * for empty space. Below this width the cut is still there and still takes
     * a transition; you just have to zoom in far enough to aim at it, which is
     * true of trimming it as well.
     */
    const room = Math.min(j.prev.duration, j.next.duration) * pps;
    if (room < SIZE * 2.2) continue;

    const s = Math.min(SIZE, row.h - 8);
    out.push({
      ...j,
      x: x - s / 2,
      y: row.y + (row.h - s) / 2,
      w: s, h: s,
      on: !!(j.next.transIn && j.next.transIn.kind && j.next.transIn.kind !== 'none'),
    });
  }
  L.junctions = out;
  return out;
}

/** The junction box under a point, if any. Badges win over the clips beneath. */
export function junctionAt(L, px, py) {
  for (const j of L.junctions || []) {
    if (px >= j.x - 2 && px <= j.x + j.w + 2 && py >= j.y - 2 && py <= j.y + j.h + 2) return j;
  }
  return null;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * The bowtie. Two triangles meeting in the middle — the symbol every editor
 * uses for a transition, and the one CapCut puts in this exact spot.
 */
function bowtie(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx - r, cy + r);
  ctx.closePath();
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx + r, cy + r);
  ctx.closePath();
  ctx.fill();
}

export function drawJunctions(ctx, store, L) {
  const list = L.junctions || [];
  if (!list.length) return;
  const sel = store.rt.junction;

  for (const j of list) {
    const active = sel === j.next.id;
    // Squared-off, not a circle: it is a button, and a round dot on a
    // timeline already means a keyframe or a marker everywhere else.
    const r = Math.min(4, j.w / 4);

    ctx.save();

    // A pale surround so the badge stays legible over busy footage. Shadow
    // rather than an outline: an outline on a 18px box eats a fifth of it.
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 1;

    roundRect(ctx, j.x, j.y, j.w, j.h, r);
    ctx.fillStyle = active ? TH.acc : j.on ? 'rgba(14,20,38,.92)' : 'rgba(14,20,38,.78)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    roundRect(ctx, j.x + .5, j.y + .5, j.w - 1, j.h - 1, r);
    ctx.strokeStyle = active ? '#ffffff' : j.on ? TH.acc2 : 'rgba(255,255,255,.55)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = active ? '#ffffff' : j.on ? TH.acc2 : 'rgba(255,255,255,.9)';
    bowtie(ctx, j.x + j.w / 2, j.y + j.h / 2, Math.max(3, j.w * 0.26));
    ctx.restore();
  }
}

/**
 * The stretch of timeline a transition occupies, shaded on both clips.
 *
 * A transition spends footage from each side of the cut, so it is drawn either
 * side of it rather than only on the incoming clip — which is what it looks
 * like in every editor, and what makes its length something you can judge by
 * eye rather than by reading a number.
 */
export function drawTransitionSpans(ctx, store, L) {
  const pps = store.pxPerSec;
  for (const j of L.junctions || []) {
    if (!j.on) continue;
    const span = transitionSpan(j.prev, j.next);
    if (!span) continue;
    const dur = span.dur;
    const row = L.rowFor(j.track.id);
    if (!row) continue;
    const half = (dur * pps) / 2;
    const x = L.t2x(j.t);
    const y = row.y + 2, h = row.h - 5;
    if (half < 2) continue;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x - half, y, half * 2, h);
    ctx.clip();
    ctx.fillStyle = 'rgba(8,20,45,.34)';
    ctx.fillRect(x - half, y, half * 2, h);
    ctx.strokeStyle = 'rgba(255,255,255,.72)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(x - half, y + h); ctx.lineTo(x + half, y);
    ctx.moveTo(x - half, y);     ctx.lineTo(x + half, y + h);
    ctx.stroke();
    ctx.restore();
  }
}
