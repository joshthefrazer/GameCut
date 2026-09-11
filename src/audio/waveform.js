/**
 * Peak extraction for waveform rendering.
 *
 * Produces min/max/RMS buckets at PEAK_RATE per second. Drawing min+max gives
 * the sharp, transient-accurate silhouette you need to land cuts on a kick or
 * an orchestral hit; the RMS band underneath reads the body of the track so
 * quiet passages still show shape.
 */
export const PEAK_RATE = 480;      // buckets per second

let _ctx = null;
export function audioCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  return _ctx;
}

const cache = new Map();           // arrayBuffer byteLength+hash -> peaks

export async function extractPeaks(arrayBuffer) {
  try {
    const ctx = audioCtx();
    // decodeAudioData detaches the buffer — always hand it a copy.
    const audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return peaksFromBuffer(audio);
  } catch {
    return null;
  }
}

export function peaksFromBuffer(audio) {
  const n = Math.max(1, Math.ceil(audio.duration * PEAK_RATE));
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const rms = new Float32Array(n);
  const chans = Math.min(2, audio.numberOfChannels);
  const step = audio.sampleRate / PEAK_RATE;

  for (let ch = 0; ch < chans; ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const s0 = (i * step) | 0;
      const s1 = Math.min(data.length, ((i + 1) * step) | 0);
      let lo = 0, hi = 0, sum = 0;
      for (let s = s0; s < s1; s++) {
        const v = data[s];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v * v;
      }
      const cnt = Math.max(1, s1 - s0);
      if (ch === 0) { min[i] = lo; max[i] = hi; rms[i] = Math.sqrt(sum / cnt); }
      else {
        min[i] = Math.min(min[i], lo);
        max[i] = Math.max(max[i], hi);
        rms[i] = Math.max(rms[i], Math.sqrt(sum / cnt));
      }
    }
  }

  // Normalize to the loudest peak so quiet Suno stems still read clearly.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, max[i], -min[i]);
  const g = peak > 0.001 ? 1 / peak : 1;
  if (g !== 1) for (let i = 0; i < n; i++) { min[i] *= g; max[i] *= g; rms[i] *= g; }

  return { rate: PEAK_RATE, duration: audio.duration, min, max, rms, buffer: audio };
}

export { cache as peakCache };
