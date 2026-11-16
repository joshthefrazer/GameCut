import { makeTrack, trackAccepts } from './schema.js';

/**
 * Linked clips and the one-clip-per-moment rule.
 *
 * Two things made the timeline "mess up the video":
 *
 * 1. A cropped HUD layer, a clip's extracted sound and a speed badge are all
 *    copies of a clip's TIMING. Nothing kept them in step, so a ripple delete,
 *    a trim or closing a gap moved the footage and left the copies behind —
 *    the zoomed-in minimap then showed a different moment from the gameplay
 *    under it, and the sound drifted off the picture.
 *
 *    Such a copy now carries `linkTo: <parent id>` and simply mirrors the
 *    parent's start, length, in-point and speed after every edit. Touching the
 *    copy's own timing (dragging it, trimming it) cuts the link, so you can
 *    still put a crop somewhere else on purpose.
 *
 * 2. Nothing stopped two clips sharing one lane at one moment. A clip dropped
 *    onto another hid it, which looks exactly like footage vanishing. Places
 *    that can create that now move the newcomer to a free lane above instead.
 */

const EPS = 1e-6;

/** Every clip that mirrors a parent's timing, by parent id. */
export function childrenOf(doc, parentId) {
  const out = [];
  for (const t of doc.tracks) for (const c of t.clips) {
    if (c.linkTo === parentId || c.badgeFor === parentId) out.push({ clip: c, track: t });
  }
  return out;
}

function index(doc) {
  const byId = new Map();
  for (const t of doc.tracks) for (const c of t.clips) byId.set(c.id, { clip: c, track: t });
  return byId;
}

/**
 * Make every linked clip match its parent again. Runs inside the same undo
 * step as the edit that moved the parent (see History.onBeforeCommit), so one
 * Ctrl+Z puts both back. A link whose parent is gone is dropped, not obeyed.
 * Returns the clips that moved.
 */
export function syncLinks(doc) {
  const byId = index(doc);
  const moved = [];
  for (const t of doc.tracks) {
    if (t.locked) continue;
    for (const c of t.clips) {
      const pid = c.linkTo || c.badgeFor;
      if (!pid || c.locked) continue;
      const p = byId.get(pid)?.clip;
      if (!p) { if (c.linkTo) delete c.linkTo; continue; }
      let changed = false;
      const set = (k, v) => { if (v !== undefined && Math.abs((c[k] ?? 0) - v) > EPS) { c[k] = v; changed = true; } };
      set('start', p.start);
      set('duration', p.duration);
      if (c.linkTo && c.assetId && c.assetId === p.assetId) {
        set('inPoint', p.inPoint);
        set('speed', p.speed || 1);
        if (Number.isFinite(p.sourceDuration)) set('sourceDuration', p.sourceDuration);
      }
      if (changed) moved.push({ clip: c, track: t });
    }
  }
  for (const t of doc.tracks) t.clips.sort((a, b) => a.start - b.start);
  return moved;
}

/** Does [start, end) on `track` hit any clip other than the ones in `skip`? */
export function clashes(track, start, end, skip = null) {
  for (const c of track.clips) {
    if (skip && (skip === c || skip.has?.(c.id))) continue;
    if (c.start < end - EPS && c.start + c.duration > start + EPS) return c;
  }
  return null;
}

/**
 * A lane with room for [start, end) for a clip of `type`, near `track`.
 *
 * Pictures and text look upwards (a new layer sits in front, which is what a
 * clip dropped onto another one was meant to do); sound looks downwards. If
 * nothing is free, a new lane of the same kind is made right next to `track`.
 */
export function freeLane(doc, track, start, end, type, skip = null) {
  const at = doc.tracks.indexOf(track);
  const ok = (t) => t && !t.locked && trackAccepts(t.kind, type) && !clashes(t, start, end, skip);
  if (track.kind === 'audio') {
    for (let i = at + 1; i < doc.tracks.length; i++) if (ok(doc.tracks[i])) return doc.tracks[i];
  } else {
    for (let i = at - 1; i >= 0; i--) {
      const t = doc.tracks[i];
      if (t.kind !== track.kind) continue;
      if (ok(t)) return t;
    }
  }
  const taken = new Set(doc.tracks.map(t => t.name));
  const stem = track.kind[0].toUpperCase() + track.kind.slice(1);
  let n = doc.tracks.filter(t => t.kind === track.kind).length + 1;
  while (taken.has(`${stem} ${n}`)) n++;
  const made = makeTrack(track.kind, `${stem} ${n}`, { height: track.height });
  doc.tracks.splice(track.kind === 'audio' ? at + 1 : at, 0, made);
  return made;
}

/**
 * Move each of `ids` that now overlaps another clip on its lane to a lane
 * where it fits. Clips are settled earliest first, so a group keeps its shape
 * as far as it can. Returns how many had to move.
 */
export function settle(doc, ids) {
  const want = new Set(ids);
  const list = [];
  for (const t of doc.tracks) for (const c of t.clips) if (want.has(c.id)) list.push({ clip: c, track: t });
  list.sort((a, b) => a.clip.start - b.clip.start);
  let moved = 0;
  for (const { clip, track } of list) {
    if (track.locked || clip.locked) continue;
    if (!clashes(track, clip.start, clip.start + clip.duration, clip)) continue;
    const to = freeLane(doc, track, clip.start, clip.start + clip.duration, clip.type, clip);
    track.clips.splice(track.clips.indexOf(clip), 1);
    clip.trackId = to.id;
    to.clips.push(clip);
    to.clips.sort((a, b) => a.start - b.start);
    moved++;
  }
  return moved;
}

/**
 * The room a clip has on its lane: from the end of the clip before it to the
 * start of the clip after it. Trims clamp to this when Ripple is off, so an
 * edge dragged into a neighbour stops at it instead of sliding underneath.
 */
export function roomAround(track, clip) {
  let lo = 0, hi = Infinity;
  for (const c of track.clips) {
    if (c === clip) continue;
    const end = c.start + c.duration;
    if (end <= clip.start + EPS) lo = Math.max(lo, end);
    else if (c.start >= clip.start + clip.duration - EPS) hi = Math.min(hi, c.start);
  }
  return { lo, hi };
}

/**
 * Pull `keep` back over the time `removed` used to cover on one lane — the
 * same closing-up a ripple delete does, for a clip that was lifted out to be
 * put back somewhere else on the same lane.
 */
export function closeHoles(keep, removed, q = (t) => t) {
  const iv = removed.map(c => [c.start, c.start + c.duration]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of iv) {
    const last = merged.at(-1);
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  // Only time no remaining clip also covers is really empty.
  const cover = keep.map(c => [c.start, c.start + c.duration]);
  const freed = [];
  for (const [a, b] of merged) {
    let pieces = [[a, b]];
    for (const [ka, kb] of cover) {
      const next = [];
      for (const [pa, pb] of pieces) {
        if (kb <= pa || ka >= pb) { next.push([pa, pb]); continue; }
        if (ka > pa) next.push([pa, ka]);
        if (kb < pb) next.push([kb, pb]);
      }
      pieces = next;
    }
    freed.push(...pieces.filter(([pa, pb]) => pb - pa > EPS));
  }
  for (const c of keep) {
    if (c.locked) continue;
    let back = 0;
    for (const [a, b] of freed) if (a < c.start - EPS) back += Math.min(b, c.start) - a;
    if (back > EPS) c.start = q(c.start - back);
  }
}
