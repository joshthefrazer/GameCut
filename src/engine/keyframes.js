import { getDeep } from '../core/commands.js';
import { lerp } from '../core/time.js';

/** Easing curves available on a keyframe. */
export const EASINGS = {
  linear: t => t,
  ease:   t => t * t * (3 - 2 * t),
  in:     t => t * t,
  out:    t => 1 - (1 - t) * (1 - t),
  inout:  t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  hold:   () => 0,
  back:   t => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
};

/**
 * Value of `path` on `clip` at timeline time `t`.
 * Falls back to the static property when no key track exists — so the
 * compositor and the exporter never need to branch.
 */
export function evalProp(clip, path, t) {
  const list = clip.keys?.[path];
  if (!list || !list.length) return getDeep(clip, path);

  const local = t - clip.start;
  if (local <= list[0].t) return list[0].v;
  if (local >= list.at(-1).t) return list.at(-1).v;

  let i = 0;
  while (i < list.length - 1 && list[i + 1].t <= local) i++;
  const a = list[i], b = list[i + 1];
  const span = b.t - a.t || 1e-6;
  const u = (EASINGS[a.e] || EASINGS.ease)((local - a.t) / span);
  return typeof a.v === 'number' ? lerp(a.v, b.v, u) : (u < 1 ? a.v : b.v);
}

/** Resolved transform for a clip at time t. */
export function evalTransform(clip, t) {
  return {
    x:        evalProp(clip, 'transform.x', t),
    y:        evalProp(clip, 'transform.y', t),
    scale:    evalProp(clip, 'transform.scale', t),
    rotation: evalProp(clip, 'transform.rotation', t),
    opacity:  evalProp(clip, 'transform.opacity', t),
    w:        evalProp(clip, 'transform.w', t),
    h:        evalProp(clip, 'transform.h', t),
  };
}

/** Multiplier from fade in/out ramps, combined with keyed opacity. */
export function fadeGain(clip, t) {
  const local = t - clip.start;
  let g = 1;
  if (clip.fadeIn > 0)  g *= Math.min(1, local / clip.fadeIn);
  if (clip.fadeOut > 0) g *= Math.min(1, (clip.duration - local) / clip.fadeOut);
  return Math.max(0, Math.min(1, g));
}

/** Keyframe times (timeline space) for drawing diamonds on the timeline. */
export function keyTimes(clip) {
  const set = new Set();
  for (const list of Object.values(clip.keys || {}))
    for (const k of list) set.add(+(clip.start + k.t).toFixed(4));
  return [...set];
}
