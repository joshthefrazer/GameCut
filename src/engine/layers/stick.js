/**
 * Stick to it: a layer that moves with something you tracked.
 *
 *   clip.stick = { to: <id of a followed crop layer>, anchor: 'center' | 'above' | 'below',
 *                  fit: true (take the tracked box's size), pad: 1.25 (how much bigger than the box),
 *                  dx, dy (a nudge, in frame fractions) }
 *
 * "Follow it as it moves" leaves a crop layer with a path of box positions in
 * its recording. This turns that box into a place in the finished frame: where
 * the footage the crop came from is drawn, at this moment. So a ring, an arrow,
 * a name tag, a blur or a spotlight stays on the player even when the footage
 * itself is moved, zoomed or cropped onto another layer.
 */
import { cropAt } from './video-layer.js';

const findById = (doc, id) => {
  for (const t of doc.tracks) for (const c of t.clips) if (c.id === id) return c;
  return null;
};

/**
 * Where the tracked thing is at timeline time `t`, as fractions of the frame:
 * { x, y } centre and { w, h } size. Null if the target is gone or not tracked.
 * `place(footage, t)` returns the footage's drawn rectangle in pixels
 * ({ cx, cy, w, h }, see Compositor.boundsPx), or null.
 */
export function trackedBox(doc, targetId, t, W, H, place) {
  const target = findById(doc, targetId);
  if (!target?.crop) return null;
  const c = target.crop;
  const at = cropAt(target, t);
  const u = at.x + c.w / 2, v = at.y + c.h / 2;
  // The footage the crop was cut from, as it sits in the finished frame.
  const footage = target.linkTo ? findById(doc, target.linkTo) : null;
  const r = footage && !footage.crop ? place(footage, t) : null;
  if (r && r.w > 0 && r.h > 0) {
    return {
      x: (r.cx - r.w / 2 + u * r.w) / W, y: (r.cy - r.h / 2 + v * r.h) / H,
      w: (c.w * r.w) / W, h: (c.h * r.h) / H,
    };
  }
  // No footage underneath (it was deleted, or the crop stands alone): the recording fills the frame.
  return { x: u, y: v, w: c.w, h: c.h };
}

/** The clip as it should be drawn at `t`: moved (and sized) onto what it is stuck to. */
export function resolveStick(doc, clip, t, W, H, place) {
  const s = clip.stick;
  if (!s?.to) return clip;
  const b = trackedBox(doc, s.to, t, W, H, place);
  if (!b) return clip;
  const pad = s.pad ?? 1.25;
  let y = b.y;
  if (s.anchor === 'above') y = b.y - b.h * pad / 2 - (s.gap ?? 0.03);
  else if (s.anchor === 'below') y = b.y + b.h * pad / 2 + (s.gap ?? 0.03);
  const tr = { ...clip.transform, x: b.x + (s.dx || 0), y: y + (s.dy || 0) };
  if (s.fit) { tr.w = Math.max(0.005, b.w * pad); tr.h = Math.max(0.005, b.h * pad); tr.scale = 1; }
  // Keyframes on position would fight the tracking; the tracking wins.
  let keys = clip.keys;
  if (keys && (keys['transform.x'] || keys['transform.y'] || (s.fit && (keys['transform.w'] || keys['transform.h'])))) {
    keys = { ...keys };
    delete keys['transform.x']; delete keys['transform.y'];
    if (s.fit) { delete keys['transform.w']; delete keys['transform.h']; }
  }
  return { ...clip, transform: tr, keys };
}
