/**
 * Decoded sound, kept small enough to hold a whole recording.
 *
 * ── Why this exists ──────────────────────────────────────────
 * The editor used to keep a clip's sound as an AudioBuffer: every sample of
 * every channel as a 32-bit float, 23 MB a minute at 48 kHz stereo. That is
 * fine for a song and hopeless for a gaming recording, so anything past a size
 * cap was simply not decoded — and a 60 fps Medal or OBS capture passes a
 * 400 MB cap in under a minute. Those clips played in the preview (straight off
 * the video element) and then exported with NO SOUND, which is the single most
 * common thing anyone exports.
 *
 * A PcmStore holds the same sound as 16-bit integers in fixed blocks:
 *
 *   · half the memory of floats (11.5 MB a minute, stereo, 48 kHz), and
 *     16 bits is what the recorder captured in the first place;
 *   · memory grows with the length of the SOUND, never with the size of the
 *     file — a 4 GB, 100 Mbps recording costs the same as a 40 MB one;
 *   · blocks are allocated only where sound was written, so a gap in a
 *     fragmented recording costs nothing, and nothing is ever one giant
 *     allocation that has to find a contiguous gigabyte.
 *
 * It looks enough like an AudioBuffer (`sampleRate`, `length`, `duration`,
 * `numberOfChannels`) that code which only asks "is there sound, how long is
 * it" keeps working. It has NO getChannelData — reading goes through `read()`,
 * a window at a time, which is the whole point.
 */

/** Frames per block. 65536 frames = 1.4 s at 48 kHz, 256 KB stereo. */
export const BLOCK = 1 << 16;

const S16 = 32767;

export class PcmStore {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.numberOfChannels = 2;
    /** Frames covered, i.e. one past the last frame anything was written to. */
    this.length = 0;
    /** Interleaved L/R Int16 blocks; `undefined` where nothing was written. */
    this.blocks = [];
  }

  get duration() { return this.length / this.sampleRate; }

  /** Bytes actually allocated — what this costs in memory. */
  get bytes() {
    let n = 0;
    for (const b of this.blocks) if (b) n += b.byteLength;
    return n;
  }

  #block(i) {
    let b = this.blocks[i];
    if (!b) { b = new Int16Array(BLOCK * 2); this.blocks[i] = b; }
    return b;
  }

  /**
   * MIX `n` frames of float sound in at `frame`.
   *
   * Added to what is already there rather than overwriting it: that is how a
   * recording with several audio tracks (game, microphone, Discord) becomes
   * one sound, track by track, without ever holding two copies. Clamped, so a
   * loud moment on two tracks saturates instead of wrapping round into a
   * full-scale crack.
   */
  mix(frame, L, R, n) {
    if (frame < 0) {                 // the encoder's priming: before time zero
      const skip = Math.min(n, -frame);
      L = L.subarray(skip); R = R.subarray(skip); n -= skip; frame = 0;
    }
    let i = 0;
    while (i < n) {
      const f = frame + i;
      const bi = Math.floor(f / BLOCK);
      const off = f - bi * BLOCK;
      const take = Math.min(n - i, BLOCK - off);
      const b = this.#block(bi);
      for (let k = 0; k < take; k++) {
        const o = (off + k) * 2;
        let l = b[o] + Math.round(L[i + k] * S16);
        let r = b[o + 1] + Math.round(R[i + k] * S16);
        b[o] = l > S16 ? S16 : l < -S16 ? -S16 : l;
        b[o + 1] = r > S16 ? S16 : r < -S16 ? -S16 : r;
      }
      i += take;
    }
    if (frame + n > this.length) this.length = frame + n;
  }

  /**
   * Copy `n` frames starting at `frame` into two float arrays.
   * Anything outside what was recorded reads as silence.
   */
  read(frame, n, outL, outR) {
    let i = 0;
    while (i < n) {
      const f = frame + i;
      if (f < 0 || f >= this.length) {
        // Silence up to the next frame that could hold sound (or the end).
        const stop = f < 0 ? Math.min(n, i - f) : n;
        outL.fill(0, i, stop); outR.fill(0, i, stop);
        i = stop;
        continue;
      }
      const bi = Math.floor(f / BLOCK);
      const off = f - bi * BLOCK;
      const take = Math.min(n - i, BLOCK - off, this.length - f);
      const b = this.blocks[bi];
      if (!b) {
        outL.fill(0, i, i + take); outR.fill(0, i, i + take);
      } else {
        for (let k = 0; k < take; k++) {
          const o = (off + k) * 2;
          outL[i + k] = b[o] / S16;
          outR[i + k] = b[o + 1] / S16;
        }
      }
      i += take;
    }
  }
}

/**
 * The same read() for an ordinary AudioBuffer.
 *
 * Short files (an mp3, a wav, a webm with sound) are still decoded the old way
 * by decodeAudioData, and arrive as AudioBuffers. Wrapping them means the mixer
 * and the preview have exactly one way of reading sound, whichever decoder
 * produced it.
 */
class BufferReader {
  constructor(buf) {
    this.buf = buf;
    this.sampleRate = buf.sampleRate;
    this.length = buf.length;
    this.numberOfChannels = buf.numberOfChannels;
  }
  get duration() { return this.buf.duration; }
  read(frame, n, outL, outR) {
    const l = this.buf.getChannelData(0);
    const r = this.buf.numberOfChannels > 1 ? this.buf.getChannelData(1) : l;
    for (let i = 0; i < n; i++) {
      const f = frame + i;
      const ok = f >= 0 && f < this.length;
      outL[i] = ok ? l[f] : 0;
      outR[i] = ok ? r[f] : 0;
    }
  }
}

const readers = new WeakMap();

/** Anything that holds sound → something with read(). Null for nothing. */
export function readerOf(buf) {
  if (!buf) return null;
  if (buf instanceof PcmStore) return buf;
  if (typeof buf.getChannelData !== 'function') return null;
  let r = readers.get(buf);
  if (!r) { r = new BufferReader(buf); readers.set(buf, r); }
  return r;
}

/**
 * A short window of a source as a real AudioBuffer, for a source node.
 *
 * Created at the SOURCE's own rate; Web Audio resamples to the context on
 * playback, exactly as it would for a buffer from decodeAudioData.
 */
export function windowBuffer(ctx, src, frame, n) {
  const len = Math.max(1, Math.floor(n));
  const out = ctx.createBuffer(2, len, src.sampleRate);
  src.read(Math.floor(frame), len, out.getChannelData(0), out.getChannelData(1));
  return out;
}

/** Buckets per second of the waveform drawn on clips. Matches waveform.js. */
const PEAK_RATE = 480;

/**
 * Waveform peaks from any source, a block at a time.
 *
 * Async and yielding, because a long recording is a hundred million samples
 * and the editor has to stay usable while they are walked.
 */
export async function peaksOf(src, { yieldEvery = 8 } = {}) {
  const frames = src.length;
  const n = Math.max(1, Math.ceil((frames / src.sampleRate) * PEAK_RATE));
  const min = new Float32Array(n), max = new Float32Array(n), rms = new Float32Array(n);
  const step = src.sampleRate / PEAK_RATE;
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);

  let bucket = 0, lo = 0, hi = 0, sum = 0, cnt = 0;
  let bucketEnd = Math.floor(step);
  let blocks = 0;
  for (let f0 = 0; f0 < frames; f0 += BLOCK) {
    const len = Math.min(BLOCK, frames - f0);
    src.read(f0, len, L, R);
    for (let k = 0; k < len; k++) {
      const f = f0 + k;
      while (f >= bucketEnd && bucket < n - 1) {
        min[bucket] = lo; max[bucket] = hi; rms[bucket] = Math.sqrt(sum / Math.max(1, cnt));
        bucket++; lo = 0; hi = 0; sum = 0; cnt = 0;
        bucketEnd = Math.floor((bucket + 1) * step);
      }
      const a = L[k], b = R[k];
      const vlo = a < b ? a : b, vhi = a > b ? a : b;
      if (vlo < lo) lo = vlo;
      if (vhi > hi) hi = vhi;
      // Louder channel's energy, as peaksFromBuffer takes the max of the two.
      sum += Math.max(a * a, b * b);
      cnt++;
    }
    if (++blocks % yieldEvery === 0) await new Promise(r => setTimeout(r, 0));
  }
  min[bucket] = lo; max[bucket] = hi; rms[bucket] = Math.sqrt(sum / Math.max(1, cnt));

  // Normalised to the loudest peak, the same as waveform.js, so a quiet
  // recording still draws a shape you can cut against.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, max[i], -min[i]);
  const g = peak > 0.001 ? 1 / peak : 1;
  if (g !== 1) for (let i = 0; i < n; i++) { min[i] *= g; max[i] *= g; rms[i] *= g; }

  return { rate: PEAK_RATE, duration: frames / src.sampleRate, min, max, rms, buffer: src };
}
