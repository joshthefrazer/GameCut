import { beatTimes } from '../../core/time.js';

/**
 * Snap resolution in pixel space, so the magnet feels equally strong at every
 * zoom level. Candidates are ranked: an explicit marker or the playhead wins
 * over a neighbouring clip edge, which wins over the beat grid.
 */
const TOL_PX = 8;

export function snapCandidates(store, { excludeIds = [], includeBeats = null } = {}) {
  const out = [{ t: 0, kind: 'origin', w: 2 }];
  const rt = store.rt, doc = store.doc;

  out.push({ t: rt.playhead, kind: 'playhead', w: 3 });
  for (const m of doc.markers) out.push({ t: m.t, kind: 'marker', w: 3 });

  for (const track of doc.tracks) {
    for (const c of track.clips) {
      if (excludeIds.includes(c.id)) continue;
      out.push({ t: c.start, kind: 'clip', w: 2 });
      out.push({ t: c.start + c.duration, kind: 'clip', w: 2 });
    }
  }

  const beats = includeBeats ?? store.ui.beatGrid;
  if (beats) {
    const t0 = store.ui.scrollX;
    const t1 = t0 + 240;
    for (const b of beatTimes(doc.bpm, t0, t1, doc.beatOffset))
      out.push({ t: b.t, kind: 'beat', w: b.beat === 0 ? 1.6 : 1 });
  }
  return out;
}

/**
 * @returns {{t:number, snapped:boolean, kind:string|null}}
 */
export function resolveSnap(store, time, candidates, tolPx = TOL_PX) {
  if (!store.ui.snap) return { t: time, snapped: false, kind: null };
  const pps = store.pxPerSec;
  let best = null, bestScore = Infinity;
  for (const c of candidates) {
    const dpx = Math.abs(c.t - time) * pps;
    if (dpx > tolPx) continue;
    const score = dpx / c.w;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best ? { t: best.t, snapped: true, kind: best.kind } : { t: time, snapped: false, kind: null };
}

/** Snap a moving clip by whichever of its two edges is closest to a target. */
export function snapClipEdges(store, newStart, duration, candidates, tolPx = TOL_PX) {
  const a = resolveSnap(store, newStart, candidates, tolPx);
  const b = resolveSnap(store, newStart + duration, candidates, tolPx);
  const da = a.snapped ? Math.abs(a.t - newStart) : Infinity;
  const db = b.snapped ? Math.abs(b.t - (newStart + duration)) : Infinity;
  if (da <= db && a.snapped) return { start: a.t, line: a.t, kind: a.kind };
  if (b.snapped) return { start: b.t - duration, line: b.t, kind: b.kind };
  return { start: newStart, line: null, kind: null };
}
