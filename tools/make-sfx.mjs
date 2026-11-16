/**
 * Strike's built-in sound effects, synthesised from scratch.
 *
 * Every animation in the library comes with its own sound (a pop for a
 * pop-up, a bass hit for a slam). They are generated here rather than taken
 * from a sample pack, so there is no licence to worry about and the files are
 * tiny. Run once; the WAVs are committed under assets/sfx/.
 *   node tools/make-sfx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const RATE = 44100;
const OUT = path.resolve(import.meta.dirname, '..', 'assets', 'sfx');
fs.mkdirSync(OUT, { recursive: true });

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;

function wav(samples) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * g)) * 32767), 44 + i * 2);
  return buf;
}
const make = (secs, fn) => { const n = Math.round(secs * RATE), out = new Float32Array(n); fn(out, n); return out; };

/** One-pole low-pass, cutoff per sample. */
function lowpass(x, cutoff) {
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const fc = typeof cutoff === 'function' ? cutoff(i / RATE) : cutoff;
    const a = 1 - Math.exp(-2 * Math.PI * fc / RATE);
    y += a * (x[i] - y); x[i] = y;
  }
  return x;
}
function highpass(x, fc) {
  const a = Math.exp(-2 * Math.PI * fc / RATE); let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) { const y = a * (py + x[i] - px); px = x[i]; py = y; x[i] = y; }
  return x;
}
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));

const SOUNDS = {
  whoosh: make(0.7, (o, n) => {
    for (let i = 0; i < n; i++) { const t = i / RATE; o[i] = noise() * Math.sin(Math.PI * Math.min(1, t / 0.7)) ** 2; }
    lowpass(o, t => 300 + 5200 * Math.sin(Math.PI * Math.min(1, t / 0.7)));
  }),
  hit: make(0.9, (o, n) => {
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / RATE, f = 38 + 110 * Math.exp(-t / 0.06);
      ph += 2 * Math.PI * f / RATE;
      o[i] = Math.sin(ph) * env(t, 0.002, 0.28) + noise() * 0.5 * env(t, 0.0005, 0.012);
    }
  }),
  boom: make(1.6, (o, n) => {
    const nz = new Float32Array(n); for (let i = 0; i < n; i++) nz[i] = noise();
    lowpass(nz, t => 120 + 900 * Math.exp(-t / 0.15));
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / RATE; ph += 2 * Math.PI * (32 + 60 * Math.exp(-t / 0.1)) / RATE;
      o[i] = nz[i] * 2.5 * env(t, 0.004, 0.5) + Math.sin(ph) * env(t, 0.003, 0.45);
    }
  }),
  pop: make(0.18, (o, n) => {
    let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / RATE; ph += 2 * Math.PI * (380 + 900 * Math.exp(-t / 0.02)) / RATE; o[i] = Math.sin(ph) * env(t, 0.001, 0.04); }
  }),
  ding: make(1.4, (o, n) => {
    const parts = [[1320, 1], [2640, 0.4], [3960, 0.2], [1980, 0.25]];
    for (let i = 0; i < n; i++) { const t = i / RATE; let s = 0; for (const [f, a] of parts) s += a * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / (0.5 / (f / 1320))); o[i] = s * env(t, 0.002, 10); }
  }),
  ping: make(0.5, (o, n) => {
    for (let i = 0; i < n; i++) { const t = i / RATE; const f = t < 0.08 ? 880 : 1175; o[i] = Math.sin(2 * Math.PI * f * t) * env(t < 0.08 ? t : t - 0.08, 0.003, t < 0.08 ? 0.05 : 0.16); }
  }),
  tick: make(0.08, (o, n) => {
    for (let i = 0; i < n; i++) { const t = i / RATE; o[i] = (Math.sin(2 * Math.PI * 2200 * t) * 0.6 + noise() * 0.4) * env(t, 0.0005, 0.01); }
  }),
  riser: make(1.6, (o, n) => {
    let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / RATE, k = t / 1.6; ph += 2 * Math.PI * (180 + 1400 * k * k) / RATE; o[i] = (Math.sin(ph) * 0.5 + noise() * 0.35 * k) * k * (t > 1.5 ? (1.6 - t) / 0.1 : 1); }
    highpass(o, 120);
  }),
  glitch: make(0.45, (o, n) => {
    for (let i = 0; i < n; i++) {
      const t = i / RATE, seg = Math.floor(t / 0.035);
      const f = [180, 2400, 600, 90, 3100, 420, 1500, 250, 2000, 700, 120, 2800, 500][seg % 13];
      const sq = Math.sign(Math.sin(2 * Math.PI * f * t));
      o[i] = (seg % 3 === 1 ? noise() : sq) * 0.6 * (t > 0.4 ? (0.45 - t) / 0.05 : 1);
    }
  }),
  click: make(0.12, (o, n) => {
    for (let i = 0; i < n; i++) { const t = i / RATE; o[i] = noise() * env(t, 0.0003, 0.004) + noise() * 0.5 * env(Math.max(0, t - 0.045), 0.0003, 0.006) * (t > 0.045 ? 1 : 0); }
    highpass(o, 1500);
  }),
  scratch: make(0.55, (o, n) => {
    const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = noise();
    lowpass(x, t => 600 + 2600 * Math.abs(Math.sin(2 * Math.PI * 4 * t)));
    for (let i = 0; i < n; i++) { const t = i / RATE; o[i] = x[i] * Math.abs(Math.sin(2 * Math.PI * 4 * t)) * (t > 0.5 ? (0.55 - t) / 0.05 : 1); }
  }),
  levelup: make(0.9, (o, n) => {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < n; i++) {
      const t = i / RATE, k = Math.min(3, Math.floor(t / 0.11)), tl = t - k * 0.11;
      const f = notes[k];
      o[i] = (Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.3 + Math.sin(2 * Math.PI * f * t) * 0.7) * env(tl, 0.003, k === 3 ? 0.35 : 0.08);
    }
  }),
  beep: make(0.16, (o, n) => {
    for (let i = 0; i < n; i++) { const t = i / RATE; o[i] = Math.sin(2 * Math.PI * 990 * t) * (t < 0.14 ? 1 : (0.16 - t) / 0.02) * Math.min(1, t / 0.004); }
  }),
  go: make(0.6, (o, n) => {
    for (let i = 0; i < n; i++) { const t = i / RATE; o[i] = (Math.sin(2 * Math.PI * 1480 * t) + 0.3 * Math.sin(2 * Math.PI * 2960 * t)) * env(t, 0.003, 0.25); }
  }),
  // A crowd roaring: lots of voices (noise through moving vowel formants), swelling and fading.
  cheer: make(2.2, (o, n) => {
    for (let v = 0; v < 26; v++) {
      const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = noise();
      const f1 = 450 + rnd() * 500, f2 = 1100 + rnd() * 900, wob = 2 + rnd() * 4, ph = rnd() * 6, start = rnd() * 0.25;
      // two resonant band-passes (biquad) per voice
      const bp = (sig, f, q) => {
        const w = 2 * Math.PI * f / RATE, al = Math.sin(w) / (2 * q), a0 = 1 + al;
        const b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0;
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < sig.length; i++) { const y = b0 * sig[i] + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = sig[i]; y2 = y1; y1 = y; sig[i] = y; }
        return sig;
      };
      const a = bp(Float32Array.from(x), f1, 6), b = bp(x, f2, 8);
      for (let i = 0; i < n; i++) {
        const t = i / RATE; if (t < start) continue;
        const e = Math.min(1, (t - start) / 0.35) * (t > 1.5 ? Math.max(0, (2.2 - t) / 0.7) : 1);
        o[i] += (a[i] + b[i] * 0.6) * e * (0.75 + 0.25 * Math.sin(2 * Math.PI * wob * t + ph));
      }
    }
  }),
  // An air horn: three detuned saws, a little tremolo.
  airhorn: make(1.3, (o, n) => {
    const fs = [233, 293.7, 349.2];
    for (let i = 0; i < n; i++) {
      const t = i / RATE; let v = 0;
      for (const f of fs) for (const d of [-1.5, 0, 1.5]) v += (((t * (f + d)) % 1) * 2 - 1);
      const e = Math.min(1, t / 0.03) * (t > 1.1 ? (1.3 - t) / 0.2 : 1);
      o[i] = v * e * (0.85 + 0.15 * Math.sin(2 * Math.PI * 9 * t));
    }
    lowpass(o, 3500);
  }),
  // Tape rewind: a fast chirp that sweeps up and wobbles, then stops.
  rewind: make(1.1, (o, n) => {
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / RATE, k = t / 1.1, f = 300 + 2600 * k * k + 120 * Math.sin(2 * Math.PI * 14 * t);
      ph += 2 * Math.PI * f / RATE;
      o[i] = (Math.sign(Math.sin(ph)) * 0.35 + noise() * 0.25) * Math.min(1, t / 0.05) * (t > 1.0 ? (1.1 - t) / 0.1 : 1);
    }
    lowpass(o, 4200);
  }),
  // A camera shutter: two clacks.
  shutter: make(0.22, (o, n) => {
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      o[i] = noise() * (env(t, 0.0004, 0.008) + 0.8 * (t > 0.09 ? env(t - 0.09, 0.0004, 0.012) : 0));
    }
    highpass(o, 900);
  }),
};

for (const [name, s] of Object.entries(SOUNDS)) {
  fs.writeFileSync(path.join(OUT, `${name}.wav`), wav(s));
}
const list = Object.fromEntries(Object.entries(SOUNDS).map(([k, s]) => [k, +(s.length / RATE).toFixed(3)]));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(list, null, 1));
console.log('wrote', Object.keys(SOUNDS).length, 'sounds to', OUT);
