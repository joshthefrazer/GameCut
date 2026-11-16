import { animById, valuesFor, drawAnim } from '../../anim/defs.js';
import { evalProp } from '../keyframes.js';

/**
 * Animation clips (Strike's animation library, src/anim/defs.js).
 *
 * An animation draws into a box 1000 units wide. On the picture that box is
 * `def.size` × the short edge of the frame wide, times the clip's scale, and
 * centred on the clip's position — so a kill counter is the same size on a
 * 9:16 short and a 16:9 video, and resizing it on the preview is just scale.
 * A full-frame one (the spotlight) always covers the whole picture instead.
 */

/** The clip's own clock: seconds into the animation, and how long it runs. */
export function animClock(clip, t) {
  const inP = clip.inPoint || 0;
  return { lt: (t - clip.start) * (clip.speed || 1) + inP, dur: inP + clip.duration * (clip.speed || 1) };
}

/** Where the animation's box sits, in pixels. */
export function animBox(clip, W, H, t) {
  const def = animById(clip.anim?.id);
  if (!def) return null;
  if (def.full) {
    return { def, cx: W / 2, cy: H / 2, w: W, h: H, k: W / 1000, bh: 1000 * H / W, rot: 0 };
  }
  const scale = evalProp(clip, 'transform.scale', t);
  const w = def.size * Math.min(W, H) * scale;
  const k = w / 1000;
  return {
    def, k, bh: def.h,
    cx: evalProp(clip, 'transform.x', t) * W,
    cy: evalProp(clip, 'transform.y', t) * H,
    w, h: def.h * k,
    rot: evalProp(clip, 'transform.rotation', t),
  };
}

export function drawAnimClip(ctx, clip, W, H, t, alpha) {
  const b = animBox(clip, W, H, t);
  if (!b) return;
  const { lt, dur } = animClock(clip, t);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(b.cx, b.cy);
  if (b.rot) ctx.rotate(b.rot * Math.PI / 180);
  ctx.scale(b.k, b.k);
  ctx.translate(-500, -b.bh / 2);
  try {
    drawAnim(ctx, b.def, Math.max(0, lt), Math.max(0.1, dur), valuesFor(b.def, clip.anim.p), clip.anim.inDur, clip.anim.outDur, b.bh);
  } catch (e) {
    // One broken drawing must never take the whole frame (or an export) down.
    if (!drawAnimClip.warned) { drawAnimClip.warned = true; console.warn('animation draw failed', e); }
  }
  ctx.restore();
}
