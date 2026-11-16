/**
 * Motion: the named moves a clip can arrive with, leave with, and keep doing.
 *
 * Shared by text (which moves letter by letter) and by every other kind of
 * clip (which moves as one). A move is a small pure function of how far
 * through it is — nothing is keyframed, so changing or removing one is one
 * click and a saved project stays tiny.
 */
export const clamp01 = (n) => Math.max(0, Math.min(1, n));
export const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeBack = (p) => {
  const c = 1.70158 + 1;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};
const easeBounce = (p) => {
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) { p -= 1.5 / d; return n * p * p + 0.75; }
  if (p < 2.5 / d) { p -= 2.25 / d; return n * p * p + 0.9375; }
  p -= 2.625 / d; return n * p * p + 0.984375;
};
/** A repeatable "random" number in 0..1 — never Math.random, so a frame looks the same every time it is drawn. */
export const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
export const rad = (d) => d * Math.PI / 180;

/* ── One piece of motion ─────────────────────────────────────────
   `p` runs 0 → 1 as the piece arrives; leaving plays the same move
   backwards, so every arrival is also a departure for free. Returns what to
   do to the piece: opacity, scale, shift, turn, and how much a wipe has
   uncovered. `lh` is the line height, the unit shifts are measured in so they
   scale with the type. */
export const REST = Object.freeze({ a: 1, s: 1, sx: 1, dx: 0, dy: 0, rot: 0, wipe: 1, hue: null });

export function move(kind, p, lh, w, seed) {
  const o = { ...REST };
  const e = easeOut(p);
  switch (kind) {
    case 'fade':   o.a = e; break;
    case 'pop':    o.s = 0.6 + 0.4 * easeBack(p); o.a = Math.min(1, p * 3); break;
    case 'rise':   o.dy = (1 - e) * lh * 1.1; o.a = e; break;
    case 'fall':   o.dy = -(1 - e) * lh * 1.1; o.a = e; break;
    case 'drop':   o.dy = -(1 - easeBounce(p)) * lh * 2.6; o.a = Math.min(1, p * 6); break;
    case 'slam':   o.s = 1 + (1 - e) * 1.6; o.a = Math.min(1, p * 4); break;
    case 'grow':   o.s = Math.max(0.001, e); o.a = Math.min(1, p * 3); break;
    case 'slideL': o.dx = -(1 - e) * (w + lh * 2); o.a = Math.min(1, p * 4); break;
    case 'slideR': o.dx = (1 - e) * (w + lh * 2); o.a = Math.min(1, p * 4); break;
    case 'spin':   o.rot = -(1 - e) * 360; o.s = Math.max(0.001, e); o.a = Math.min(1, p * 3); break;
    case 'flip':   o.sx = Math.max(0.001, Math.abs(Math.cos((1 - e) * Math.PI / 2))); o.a = Math.min(1, p * 3); break;
    case 'wipe':   o.wipe = e; break;
    case 'glitch': {
      const f = Math.floor(p * 18);
      o.dx = (hash(f * 7 + seed) - 0.5) * lh * 0.55 * (1 - p);
      o.dy = (hash(f * 3 + seed + 9) - 0.5) * lh * 0.12 * (1 - p);
      o.a = hash(f + seed * 5) > 0.35 + 0.5 * (1 - p) ? 0.15 : 1;
      break;
    }
    default: break;
  }
  return o;
}

/* What a looping move is doing `tt` seconds in; `phase` is this piece's place in the line. */
export function loopMove(kind, tt, phase, lh) {
  const o = { ...REST };
  switch (kind) {
    case 'pulse':  o.s = 1 + 0.06 * Math.sin(tt * Math.PI * 2 * 1.2); break;
    case 'float':  o.dy = Math.sin(tt * Math.PI * 2 * 0.6) * lh * 0.12; break;
    case 'wave':   o.dy = Math.sin(tt * Math.PI * 2 * 0.9 - phase * 0.7) * lh * 0.16; break;
    case 'wobble': o.rot = Math.sin(tt * Math.PI * 2 * 0.9 - phase * 0.4) * 4; break;
    case 'shake': {
      const f = Math.floor(tt * 30);
      o.dx = (hash(f * 2 + phase) - 0.5) * lh * 0.07;
      o.dy = (hash(f * 2 + 1 + phase) - 0.5) * lh * 0.07;
      break;
    }
    case 'flicker': o.a = hash(Math.floor(tt * 18) + phase * 3) < 0.1 ? 0.25 : 1; break;
    case 'rainbow': o.hue = (tt * 120 + phase * 22) % 360; break;
    default: break;
  }
  return o;
}

/** Two moves at once — arriving and leaving, or either and the loop. */
export const combine = (a, b) => ({
  a: a.a * b.a, s: a.s * b.s, sx: a.sx * b.sx, dx: a.dx + b.dx, dy: a.dy + b.dy,
  rot: a.rot + b.rot, wipe: Math.min(a.wipe, b.wipe), hue: b.hue ?? a.hue,
});


/**
 * What a clip that is not text is doing at time `t`, or null when it is at rest.
 *
 * Reads `clip.motion` — the same five fields text keeps on `clip.text`, so one
 * panel edits both. `lh` is the unit shifts are measured in (a fraction of the
 * frame's short edge); `w` is how wide the clip is on screen, so a slide
 * always travels far enough to clear the frame.
 */
export function visualMotion(clip, t, lh, w) {
  const m = clip.motion;
  if (!m) return null;
  const inKind = m.anim || 'none', outKind = m.animOut || 'none', loopKind = m.animLoop || 'none';
  if (inKind === 'none' && outKind === 'none' && loopKind === 'none') return null;
  const inDur = Math.max(0.05, m.animDur || 0.5), outDur = Math.max(0.05, m.animOutDur || 0.5);
  const end = clip.start + clip.duration;
  let mv = { ...REST };
  if (inKind !== 'none') {
    const p = clamp01((t - clip.start) / inDur);
    if (p < 1) mv = combine(mv, move(inKind, p, lh, w, 1));
  }
  if (outKind !== 'none') {
    const p = clamp01((end - t) / outDur);
    if (p < 1) mv = combine(mv, move(outKind, p, lh, w, 6));
  }
  if (loopKind !== 'none') mv = combine(mv, loopMove(loopKind, Math.max(0, t - clip.start), 0, lh));
  return mv;
}

/** The default motion on a clip that is not text: none of it. */
export const defaultMotion = () => ({
  anim: 'none', animDur: 0.5, animOut: 'none', animOutDur: 0.5, animLoop: 'none',
});
