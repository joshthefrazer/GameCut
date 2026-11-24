/**
 * Transitions between two cuts.
 *
 * The honest way to do this is the one every NLE does: during the transition
 * the outgoing clip keeps playing *past* its cut. A clip almost always has more
 * footage behind it than it shows — that spare footage is what a transition
 * spends. Freezing the last frame instead would be far simpler and would look
 * wrong the moment anything in the shot is moving, which in gameplay is always.
 *
 * So a transition is stored on the INCOMING clip, and the compositor asks the
 * decoder for the outgoing clip at a time beyond its own end. `frameFor` maps
 * timeline time to source time arithmetically and does not care that the result
 * lies past the clip's out point, so this needs no special case in the pool.
 *
 * If the outgoing clip has no footage left, its decoder simply holds its last
 * frame — the transition still plays, it just stops moving underneath. That is
 * a graceful floor rather than a failure.
 */

import { KINDS, kindOf } from './transition-fx.js';

export const TRANSITIONS = [{ id: 'none', name: 'Cut', note: 'No transition — a hard cut' },
  ...KINDS.map(k => ({ id: k.id, name: k.name, note: k.blurb }))];

/** What you can pick, in the order it is shown. Dissolve leads: it is the one reached for most. */
export const TRANSITION_PICKS = KINDS.map(k => ({ key: k.id, kind: k.id, ...k }));
/** The short list for right-click menus. */
export const QUICK_PICKS = ['dissolve', 'dip', 'whip', 'slide', 'zoomin', 'punch', 'glitch', 'flash']
  .map(id => TRANSITION_PICKS.find(p => p.key === id));

/** A fresh transition of this kind, or the one it already is. */
export function freshTransition(kind, from = null) {
  const k = kindOf(kind);
  if (!k) return null;
  return from?.kind === kind ? { ...k.d, ...from, kind } : { kind, ...k.d };
}

/** Which catalogue entry a clip's transition corresponds to, or null. */
export function pickFor(clip) {
  const tr = clip?.transIn;
  if (!tr || !tr.kind || tr.kind === 'none') return null;
  return TRANSITION_PICKS.find(p => p.kind === tr.kind) || null;
}

/**
 * The three original transitions, saved before they had any settings, are drawn
 * the way they always were (and cheaply); everything else goes to transition-fx.js.
 */
export const isPlain = (tr) => tr.kind === 'dissolve' || (tr.kind === 'slide' && tr.amount == null) || (tr.kind === 'dip' && tr.color == null);

/**
 * Every cut on the timeline: two clips on one track, back to back.
 *
 * This is what the badges on the timeline are drawn from and what the picker
 * applies to, so both agree on what counts as a cut — including the tolerance,
 * because clip edges land on frame boundaries and two edges that look flush can
 * be a fraction of a frame apart after trimming.
 */
export function junctions(doc) {
  const out = [];
  for (const track of doc.tracks) out.push(...junctionsOn(track));
  return out;
}

/**
 * The longest a transition between these two clips may be.
 *
 * It spends footage from both sides, so neither clip may be shorter than the
 * transition itself — a 0.45s dissolve onto a 0.2s clip would be asking the
 * incoming shot to still be arriving after it has already ended.
 */
export function maxDurFor(prev, next) {
  const room = Math.min(prev?.duration ?? Infinity, next?.duration ?? Infinity);
  return Math.max(0.1, Math.min(4, room));
}

/** Default length, in seconds. Short: a long transition on gameplay drags. */
export const DEFAULT_TRANS_DUR = 0.45;

const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

/**
 * A transition straddles its cut: half before, half after.
 *
 * It used to start at the cut and run forwards into the incoming clip, which is
 * simpler and is wrong. Every editor centres a transition on the seam, and the
 * reason is not decoration — it is that the cut is the moment you chose, and a
 * transition that only ever begins there delays it by its whole length. Centred,
 * the shot changes when you said it should and the blend happens around that
 * point. It is also what the badge on the timeline says is happening: a marker
 * sitting *on* the seam, not next to it.
 *
 * Both sides spend their spare footage — the outgoing clip plays past its out
 * point, the incoming one plays before its in point. Either can run out, in
 * which case it holds a frame; that is a soft floor rather than a hole.
 */
export function transitionSpan(prev, next) {
  const tr = next?.transIn;
  if (!tr || !tr.kind || tr.kind === 'none') return null;
  const dur = Math.max(0.05, Math.min(
    tr.dur || DEFAULT_TRANS_DUR, maxDurFor(prev, next)));
  const cut = next.start;
  return { kind: tr.kind, dir: tr.dir || 'left', amount: tr.amount, ease: tr.ease, color: tr.color,
    dur, cut, from: cut - dur / 2, to: cut + dur / 2 };
}

/**
 * The transition running on `track` at time `t`, with everything the compositor
 * needs to paint it. Null when the track is not mid-transition.
 */
export function transitionAt(track, t) {
  for (const j of junctionsOn(track)) {
    const span = transitionSpan(j.prev, j.next);
    if (!span) continue;
    if (t <= span.from || t >= span.to) continue;
    const raw = (t - span.from) / span.dur;
    return { ...span, prev: j.prev, next: j.next, raw, p: easeInOut(raw) };
  }
  return null;
}

/** Adjacent pairs on one track. Shared by `junctions` and `transitionAt`. */
function junctionsOn(track) {
  const out = [];
  if (!track || track.kind === 'audio') return out;
  const list = [...track.clips]
    .filter(c => c.type === 'video' || c.type === 'image')
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], next = list[i];
    if (Math.abs(prev.start + prev.duration - next.start) > 1e-3) continue;
    out.push({ track, prev, next, t: next.start });
  }
  return out;
}

/**
 * The clip this one cuts away from: the nearest earlier clip on the same track.
 *
 * Adjacency is judged with a small tolerance rather than exact equality —
 * clip edges sit on frame boundaries and two cuts that look flush can be a
 * fraction of a frame apart after trimming.
 */
export function outgoingFor(track, clip) {
  if (!track) return null;
  let best = null;
  for (const c of track.clips) {
    if (c === clip || c.id === clip.id) continue;
    const end = c.start + c.duration;
    if (end <= clip.start + 1e-3 && end > clip.start - 0.35) {
      if (!best || end > best.start + best.duration) best = c;
    }
  }
  return best;
}

/**
 * How the two pictures combine, as plain numbers the compositor can apply.
 *
 * Kept separate from the drawing so the same description drives the preview and
 * the export — there is one definition of what "slide" means, not two that can
 * drift apart.
 */
export function transitionPlan(tr, W, H) {
  if (tr.kind === 'dissolve') {
    return { under: 1, over: tr.p, dx: 0, dy: 0, black: 0 };
  }
  if (tr.kind === 'dip') {
    // First half takes the outgoing shot to black, second half brings the new
    // one up out of it. The midpoint is fully black, which is the whole point.
    const half = tr.raw < 0.5;
    const k = half ? tr.raw * 2 : (tr.raw - 0.5) * 2;
    return {
      under: half ? 1 - easeInOut(k) : 0,
      over: half ? 0 : easeInOut(k),
      dx: 0, dy: 0,
      black: 1,
    };
  }
  if (tr.kind === 'slide') {
    // A push, not an overlay: the new shot comes in from one edge and shoves
    // the old one out of the opposite edge, so the two move together as if
    // they were on one strip. Sliding only the top one looks like a card being
    // dealt over a still frame, which is the cheaper-looking version of this.
    const d = 1 - tr.p;
    const sx = tr.dir === 'left' ? 1 : tr.dir === 'right' ? -1 : 0;
    const sy = tr.dir === 'up' ? 1 : tr.dir === 'down' ? -1 : 0;
    return {
      under: 1, over: 1, black: 0,
      dx: sx * d * W, dy: sy * d * H,
      udx: -sx * tr.p * W, udy: -sy * tr.p * H,
    };
  }
  return { under: 1, over: tr.p, dx: 0, dy: 0, black: 0 };
}
