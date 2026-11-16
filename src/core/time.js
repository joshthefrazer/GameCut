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
 * A time as a person reads it: `m:ss.f` — "0:07.5", "1:02.0", "1:00:05.0".
 *
 * For display only. Everything that edits still works in exact frames; this is
 * what goes on a label, where "00:00:07:30" makes you do arithmetic and "+15f"
 * means nothing at all to someone who has never used an editor before.
 * `digits` is how many decimals of a second to show (0 drops the point).
 */
export function humanTime(sec, digits = 1) {
  sec = Math.max(0, sec || 0);
  const scale = 10 ** digits;
  // Round once, on the whole value, so 59.96 becomes 1:00.0 rather than 0:60.0.
  const total = Math.round(sec * scale) / scale;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const ss = digits ? s.toFixed(digits).padStart(digits + 3, '0') : pad(Math.round(s));
  return h ? `${h}:${pad(m)}:${ss}` : `${m}:${ss}`;
}

/**
 * Adaptive ruler step: smallest "nice" interval whose on-screen width
 * clears `minPx`.
 *
 * Sub-second steps are tenths, fifths and halves of a second, which label
 * cleanly as 0:01.5. Single frames only appear once you have zoomed in far
 * enough that a tenth of a second is wider than a label — the one place a
 * frame count is what you are actually looking at.
 */
export function rulerStep(pxPerSec, fps, minPx = 78) {
  const frame = 1 / fps;
  const frames = [frame, frame * 2, frame * 5].filter(f => f < 0.1 - 1e-9);
  const candidates = [
    ...frames, 0.1, 0.2, 0.5,
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600
  ];
  for (const c of candidates) if (c * pxPerSec >= minPx) return c;
  return candidates.at(-1);
}

/**
 * Label for a ruler tick at `sec`, given the ruler's `step`.
 *
 * The frame count is worked out from ONE rounding of `sec × fps`. The old
 * version took `sec % 1` of a value that had been built by adding `step` over
 * and over, so floating error crept in and a tick sitting exactly on a whole
 * second could come out as "+30f" (at 30 fps) — the rounding of 0.9999… of a
 * second — instead of the second itself.
 */
export function tickLabel(sec, step, fps) {
  const rate = Math.round(fps) || 30;
  if (step < 0.1 - 1e-9) {
    // Frame-level zoom: whole seconds by name, frames in between by count.
    const total = Math.round(sec * fps);
    const f = total % rate;
    return f === 0 ? humanTime(total / fps, 0) : `+${f}f`;
  }
  if (step < 1 - 1e-9) {
    // Tenths are enough to name every tick at these steps (0.1 / 0.2 / 0.5).
    const t = Math.round(sec * 10) / 10;
    return Math.abs(t - Math.round(t)) < 1e-6 ? humanTime(t, 0) : humanTime(t, 1);
  }
  if (step < 3600) return humanTime(Math.round(sec), 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${h}:${pad(m)}:00`;
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
