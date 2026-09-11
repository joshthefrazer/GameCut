/** Time / frame / timecode math. Single source of truth for the whole app. */

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export const lerp = (a, b, t) => a + (b - a) * t;

export const secToFrame = (sec, fps) => Math.round(sec * fps);
export const frameToSec = (f, fps) => f / fps;

/** Quantize a time to the nearest frame boundary. */
export const snapFrame = (sec, fps) => Math.round(sec * fps) / fps;

const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0');

/** HH:MM:SS:FF */
export function timecode(sec, fps = 60) {
  sec = Math.max(0, sec || 0);
  const total = Math.round(sec * fps);
  const f = total % Math.round(fps);
  const s = Math.floor(total / fps);
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

/** MM:SS — compact form for clip badges. */
export function shortTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${pad(s)}`;
}

/**
 * Adaptive ruler step: smallest "nice" interval whose on-screen width
 * clears `minPx`. Sub-second steps fall back to frame multiples.
 */
export function rulerStep(pxPerSec, fps, minPx = 78) {
  const frame = 1 / fps;
  const candidates = [
    frame, frame * 2, frame * 5, frame * 10, frame * 15, frame * 30,
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600
  ];
  for (const c of candidates) if (c * pxPerSec >= minPx) return c;
  return candidates.at(-1);
}

/** Label for a ruler tick, terse at high zoom, coarse when zoomed out. */
export function tickLabel(sec, step, fps) {
  if (step < 1) {
    const f = Math.round((sec % 1) * fps);
    return f === 0 ? `${Math.floor(sec)}s` : `+${f}f`;
  }
  if (step < 60) {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m ? `${m}:${pad(s)}` : `${s}s`;
  }
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}:${pad(m)}:00` : `${m}:00`;
}

/** Beat grid times across [t0,t1] for a given BPM + offset. */
export function beatTimes(bpm, t0, t1, offset = 0) {
  const step = 60 / Math.max(1, bpm);
  const out = [];
  let i = Math.floor((t0 - offset) / step);
  for (let t = offset + i * step; t <= t1; t += step, i++) {
    if (t >= t0) out.push({ t, beat: ((i % 4) + 4) % 4 });
  }
  return out;
}
