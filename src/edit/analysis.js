import { assets } from '../media/asset-store.js';

/**
 * Listening to the timeline: where the loud moments are, and where the beat is.
 *
 * Both work from the waveform summary every imported file already has
 * (`asset.peaks`: loudness 480 times a second), so nothing is decoded again
 * and an hour of footage is analysed in well under a second.
 */

/** Loudness of a clip's sound around timeline time `t`, 0..1, or null if it has none. */
function clipLoudness(clip, t, win = 0.1) {
  const a = assets.get(clip.assetId);
  const p = a?.peaks;
  if (!p?.rms?.length) return null;
  const sp = clip.speed || 1;
  const s = clip.inPoint + (t - clip.start) * sp;
  const i0 = Math.max(0, Math.floor((s - win / 2) * p.rate));
  const i1 = Math.min(p.rms.length, Math.ceil((s + win / 2) * p.rate));
  let m = 0;
  for (let i = i0; i < i1; i++) m = Math.max(m, p.rms[i]);
  return m;
}

/**
 * The loud moments of the edit — gunfire, a shout, a big play.
 *
 * Builds one loudness line for the whole timeline from every clip that makes
 * sound (music lanes are skipped: a drop in the song is not a highlight),
 * then picks the peaks that stand well above the clip's usual level and are
 * at least `gap` seconds apart, loudest first.
 */
export function findHighlights(store, { max = 12, gap = 1.5, step = 0.1 } = {}) {
  const doc = store.doc;
  const sources = [];
  for (const t of doc.tracks) {
    if (t.muted || t.hidden) continue;
    if (t.kind === 'audio' && /music|song|beat/i.test(t.name)) continue;
    for (const c of t.clips) {
      if (c.muted || c.silent) continue;
      if (c.type !== 'video' && c.type !== 'audio') continue;
      if (assets.get(c.assetId)?.peaks?.rms) sources.push(c);
    }
  }
  const end = store.rt.duration;
  if (!sources.length || end <= 0) return [];
  const n = Math.floor(end / step);
  const line = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * step;
    let v = 0;
    for (const c of sources) {
      if (t < c.start || t >= c.start + c.duration) continue;
      const l = clipLoudness(c, t, step * 1.5);
      if (l != null) v = Math.max(v, l * (c.volume ?? 1));
    }
    line[i] = v;
  }
  const sorted = [...line].filter(v => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-4;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || median;
  const floor = Math.max(median * 1.8, p90 * 0.95, 0.04);
  // Local peaks over the floor.
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    const v = line[i];
    if (v < floor || v < line[i - 1] || v < line[i + 1]) continue;
    // Prefer a sudden jump: compare with the half second before.
    let before = 0;
    for (let k = Math.max(0, i - 8); k < i - 2; k++) before += line[k];
    before /= Math.max(1, Math.min(6, i - 2));
    const score = v / Math.max(median, 1e-4) + (v - before) / Math.max(median, 1e-4);
    peaks.push({ t: i * step, v, score });
  }
  peaks.sort((a, b) => b.score - a.score);
  const out = [];
  for (const p of peaks) {
    if (out.some(o => Math.abs(o.t - p.t) < gap)) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Tempo and the time of the first beat of a song, from its waveform.
 *
 * An onset line (how sharply the level rises) is autocorrelated over every
 * tempo from 70 to 180 BPM; the best match wins, with its half/double checked
 * so a 160 BPM drum-and-bass track is not reported at 80. The phase is the
 * offset whose beats land on the most onset energy. Returns source-time
 * values: `offset` is seconds into the file.
 */
export function detectBeat(asset, from = 0, len = Infinity) {
  const p = asset?.peaks;
  if (!p?.rms?.length) return null;
  const R = 100;                                    // analysis rate, per second
  const k = p.rate / R;
  const i0 = Math.floor(from * R);
  const n = Math.min(Math.floor(p.rms.length / k) - i0, Math.floor(Math.min(len, 90) * R));
  if (n < R * 4) return null;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = Math.floor((i0 + i) * k), b = Math.floor((i0 + i + 1) * k);
    for (let j = a; j < b; j++) m = Math.max(m, p.rms[j] || 0);
    env[i] = m;
  }
  const on = new Float32Array(n);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, env[i] - env[i - 1]);
  // Remove the slow trend so loud sections do not dominate.
  let mean = 0; for (let i = 0; i < n; i++) mean += on[i]; mean /= n;
  for (let i = 0; i < n; i++) on[i] = Math.max(0, on[i] - mean);

  const corr = (lag) => { let s = 0; for (let i = lag; i < n; i++) s += on[i] * on[i - lag]; return s / (n - lag); };
  let best = 0, bestLag = 0;
  const scores = new Map();
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * R;
    const l0 = Math.floor(lag), f = lag - l0;
    const c = corr(l0) * (1 - f) + corr(l0 + 1) * f;
    scores.set(bpm, c);
    if (c > best) { best = c; bestLag = bpm; }
  }
  if (!best) return null;
  let bpm = bestLag;
  // Half / double check.
  const dbl = bpm * 2 <= 180 ? scores.get(Math.round(bpm * 4) / 2) : 0;
  if (dbl && dbl > best * 0.9) bpm *= 2;
  const period = (60 / bpm) * R;
  let bestPh = 0, bestE = -1;
  for (let ph = 0; ph < period; ph += 1) {
    let e = 0;
    for (let x = ph; x < n; x += period) e += on[Math.round(x)] || 0;
    if (e > bestE) { bestE = e; bestPh = ph; }
  }
  return { bpm: Math.round(bpm * 2) / 2, offset: from + bestPh / R, confidence: best };
}

/** The loud moments inside one recording, in seconds into the file. */
export function assetHighlights(asset, { max = 6, gap = 2, step = 0.1 } = {}) {
  const p = asset?.peaks;
  if (!p?.rms?.length) return [];
  const dur = p.rms.length / p.rate;
  const n = Math.floor(dur / step);
  const line = new Float32Array(n);
  const k = p.rate * step;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.floor(i * k); j < Math.floor((i + 1) * k); j++) m = Math.max(m, p.rms[j] || 0);
    line[i] = m;
  }
  const sorted = [...line].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)] || 1e-4;
  const p90 = sorted[Math.floor(n * 0.9)] || median;
  const floor = Math.max(median * 1.8, p90 * 0.95, 0.04);
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    const v = line[i];
    if (v < floor || v < line[i - 1] || v < line[i + 1]) continue;
    let before = 0;
    for (let q = Math.max(0, i - 8); q < i - 2; q++) before += line[q];
    before /= Math.max(1, Math.min(6, i - 2));
    peaks.push({ t: i * step, v, score: v / median + (v - before) / median });
  }
  peaks.sort((a, b) => b.score - a.score);
  const out = [];
  for (const q of peaks) {
    if (out.some(o => Math.abs(o.t - q.t) < gap)) continue;
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}
