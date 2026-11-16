import { assets } from '../media/asset-store.js';
import { audioCtx, peaksFromBuffer } from '../audio/waveform.js';
import { bus } from '../core/events.js';

/**
 * The sound that comes with an animation.
 *
 * An animation clip plays its sound the same way any clip does: its `assetId`
 * points at an audio asset, and the audio graph schedules that asset's buffer
 * from the clip's start. The asset is built here from the bundled WAVs in
 * assets/sfx/, laid out as a "plan" — which sound, at which second — so a
 * countdown beeps once per number and Big words pops once per word.
 *
 * Nothing about the sound is stored in the project but the plan itself
 * (`asset.bundled`); reopening a project rebuilds the buffer from it.
 */

const RATE = 44100;
const decoded = new Map();      // sound name -> Promise<AudioBuffer>

function load(name) {
  if (!decoded.has(name)) {
    decoded.set(name, (async () => {
      const r = await fetch(`./assets/sfx/${name}.wav`);
      if (!r.ok) throw new Error(`missing sound ${name}`);
      return audioCtx().decodeAudioData(await r.arrayBuffer());
    })().catch((e) => { decoded.delete(name); throw e; }));
  }
  return decoded.get(name);
}

/** Which sound plays when, for this animation with these values. */
export function soundPlan(def, values = {}, dur = def.dur) {
  if (!def?.sound) return [];
  if (typeof def.sounds === 'function') return def.sounds(values, dur).filter(s => s.at >= 0 && s.at < dur);
  const at = def.soundAt || 0;
  if (!def.soundEvery) return [{ sound: def.sound, at }];
  const out = [];
  for (let t = at; t < dur - 0.25; t += def.soundEvery) out.push({ sound: def.sound, at: +t.toFixed(3) });
  return out;
}

const keyOf = (plan) => plan.map(s => `${s.sound}@${s.at}`).join(',');

/** Mix a plan into one buffer. */
async function render(plan) {
  const parts = await Promise.all(plan.map(async (s) => ({ ...s, buf: await load(s.sound) })));
  const len = Math.max(0.05, ...parts.map(p => p.at + p.buf.duration));
  const out = new AudioBuffer({ length: Math.ceil(len * RATE), numberOfChannels: 2, sampleRate: RATE });
  for (const ch of [0, 1]) {
    const dst = out.getChannelData(ch);
    for (const p of parts) {
      const src = p.buf.getChannelData(Math.min(ch, p.buf.numberOfChannels - 1));
      const ratio = p.buf.sampleRate / RATE;
      const o = Math.round(p.at * RATE);
      const n = Math.min(dst.length - o, Math.floor(src.length / ratio));
      for (let i = 0; i < n; i++) dst[o + i] += src[Math.floor(i * ratio)] * 0.8;
    }
    for (let i = 0; i < dst.length; i++) dst[i] = Math.max(-1, Math.min(1, dst[i]));
  }
  return out;
}

/** Fill in a bundled asset's sound (a new one, or one from a reopened project). */
export async function buildBundled(asset) {
  if (!asset?.bundled) return;
  assets.update(asset.id, { audioState: 'pending', hasAudio: true, missing: false });
  try {
    const buf = await render(asset.bundled);
    const peaks = peaksFromBuffer(buf);
    assets.update(asset.id, { peaks, duration: buf.duration, audioState: 'ready' });
  } catch (e) {
    assets.update(asset.id, { audioState: 'unreadable', audioReason: String(e?.message || e) });
  }
  bus.emit('assets');
}

/**
 * The asset id for a sound plan — an existing one when the same plan is
 * already in the project, so ten kill counters share one sound.
 */
export function soundAssetFor(def, values, dur) {
  const plan = soundPlan(def, values, dur);
  if (!plan.length) return null;
  const key = keyOf(plan);
  const have = assets.all().find(a => a.bundled && keyOf(a.bundled) === key);
  if (have) return have.id;
  const a = assets.add({
    kind: 'audio', name: `${def.name} sound`, bundled: plan,
    url: null, file: null, duration: 0, hasAudio: true, audioState: 'pending',
  });
  buildBundled(a);
  return a.id;
}

/** Media you added yourself, without the sounds animations brought along. */
export const isBundled = (a) => !!a?.bundled;

/** Play one built-in sound now (a pad being hit). */
export async function playSound(name, gain = 0.8) {
  const buf = await load(name);
  const ctx = audioCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf; g.gain.value = gain;
  src.connect(g); g.connect(ctx.destination);
  src.start();
  return buf.duration;
}

/** The asset for one built-in sound on its own (pads, whooshes). */
export const singleSoundAsset = (name, label = name) => soundAssetFor({ name: label, sound: name }, {}, 30);
