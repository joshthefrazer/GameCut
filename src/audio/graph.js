import { audioCtx } from './waveform.js';
import { assets } from '../media/asset-store.js';
import { fadeGain } from '../engine/keyframes.js';

/**
 * Sample-accurate audio playback.
 *
 * On play we schedule one AudioBufferSourceNode per audible clip against the
 * AudioContext clock, so music stays locked to the timeline regardless of what
 * the video decoder or the rAF loop are doing. Any transport change tears the
 * graph down and reschedules — cheap, and impossible to drift.
 */
/**
 * Which clips make sound, and how loud.
 *
 * Shared by live playback and the offline export bounce so the file you render
 * can't quietly disagree with the file you heard. Returns clips whose asset
 * decoded to an AudioBuffer, honouring track mute, solo and per-clip mute.
 */
export function audibleClips(store) {
  const soloed = store.doc.tracks.some(t => t.solo);
  const out = [];
  for (const track of store.doc.tracks) {
    if (track.muted) continue;
    if (soloed && !track.solo) continue;
    for (const clip of track.clips) {
      if (clip.muted) continue;
      // A cropped layer is a second copy of media that is already playing
      // underneath it. Scheduling it too would play everything twice, slightly
      // out of phase — which sounds like a broken file rather than a duplicate.
      if (clip.silent) continue;
      const asset = assets.get(clip.assetId);
      if (!asset) continue;
      const buf = asset.peaks?.buffer;
      // Long media has no decoded buffer on purpose (see media/importer.js);
      // its sound comes straight off the media element instead.
      if (buf) out.push({ clip, track, buf, stream: false });
      else if (asset.streamAudio) out.push({ clip, track, buf: null, stream: true });
    }
  }
  return out;
}

/** Clips whose audio cannot be included in an export (too long to decode). */
export function unmixableClips(store) {
  return audibleClips(store).filter(c => c.stream).map(c => c.clip);
}

/**
 * Bounce the whole timeline to a single AudioBuffer for export.
 *
 * OfflineAudioContext renders as fast as the CPU allows rather than in real
 * time, so a five-minute mix takes seconds. The graph built here mirrors the
 * live one: same clip selection, same gains, same fade ramps.
 */
export async function renderTimelineAudio(store, duration, sampleRate = 48000) {
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);

  for (const { clip, track, buf } of audibleClips(store)) {
    if (!buf) continue;                    // streamed clips have nothing to mix
    const when = Math.max(0, clip.start);
    const offset = Math.max(0, clip.inPoint);
    const dur = Math.min(clip.duration * (clip.speed || 1), buf.duration - offset);
    if (dur <= 0) continue;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clip.speed || 1;

    const g = ctx.createGain();
    const base = (clip.volume ?? 1) * (track.volume ?? 1);
    g.gain.setValueAtTime(clip.fadeIn > 0 ? 0.0001 : base, when);
    if (clip.fadeIn > 0) g.gain.linearRampToValueAtTime(base, when + clip.fadeIn);
    if (clip.fadeOut > 0) {
      const outAt = when + clip.duration - clip.fadeOut;
      g.gain.setValueAtTime(base, Math.max(when, outAt));
      g.gain.linearRampToValueAtTime(0.0001, when + clip.duration);
    }

    src.connect(g).connect(ctx.destination);
    src.start(when, offset, dur);
  }

  return ctx.startRendering();
}

export class AudioGraph {
  constructor(store) {
    this.store = store;
    this.nodes = [];
    this.master = null;
    this.startedAt = 0;
    this.startTime = 0;
    /** Set by main.js — lets long video clips be heard off their decoder. */
    this.pool = null;
    /** clipId -> <audio> for long audio-only files. */
    this.streamEls = new Map();
    this.streaming = [];
    /**
     * clipId -> the GainNode carrying that clip, while it is scheduled.
     *
     * Kept so a fader can be heard as it moves. Without it, changing a clip's
     * volume during playback does nothing until the transport is touched, and
     * mixing by ear — which is the only way anyone mixes — becomes impossible.
     */
    this.gains = new Map();
  }

  /**
   * Sound for clips with no decoded buffer.
   *
   * A long recording's audio is never pulled into memory, so it plays from the
   * element that is already decoding its picture — one decode, sound and image
   * inherently in step. Volume rides on the element rather than a gain node,
   * which costs sample-accuracy but is the only option that does not put a
   * gigabyte of floats in RAM.
   */
  #stream(from) {
    this.#silenceStreams();
    const master = this.store.rt.muted ? 0 : (this.store.rt.volume ?? 1);

    for (const { clip, track, stream } of audibleClips(this.store)) {
      if (!stream) continue;
      const end = clip.start + clip.duration;
      if (end <= from) continue;

      const el = this.#elFor(clip);
      if (!el) continue;

      el.muted = false;
      el.volume = Math.max(0, Math.min(1,
        (clip.volume ?? 1) * (track.volume ?? 1) * master));
      this.streaming.push({ clip, el });

      // A video clip's element is already driven by the decoder pool, so it is
      // in the right place. A standalone audio file needs steering.
      if (!this.pool?.peek(clip)) {
        const offset = clip.inPoint + Math.max(0, from - clip.start) * (clip.speed || 1);
        try { el.currentTime = Math.max(0, offset); } catch { /* not ready */ }
        el.playbackRate = Math.min(16, Math.max(0.0625, clip.speed || 1));
        if (from >= clip.start) el.play().catch(() => {});
      }
    }
  }

  #elFor(clip) {
    const asset = assets.get(clip.assetId);
    if (!asset) return null;
    if (asset.kind === 'video') return this.pool?.elementFor(clip) || null;

    let el = this.streamEls.get(clip.id);
    if (!el) {
      el = document.createElement('audio');
      el.src = asset.url;
      el.preload = 'auto';
      this.streamEls.set(clip.id, el);
    }
    return el;
  }

  #silenceStreams() {
    for (const { el } of this.streaming) {
      el.muted = true;
      if (this.streamEls.size && !el.paused && el.tagName === 'AUDIO') el.pause();
    }
    this.streaming.length = 0;
  }

  #ensure() {
    const ctx = audioCtx();
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
    }
    this.master.gain.value = this.store.rt.muted ? 0 : this.store.rt.volume;
    return ctx;
  }

  setVolume(v, muted) {
    if (this.master) this.master.gain.value = muted ? 0 : v;
    for (const { clip, el } of this.streaming) {
      const track = this.store.doc.tracks.find(t => t.clips.includes(clip));
      el.volume = Math.max(0, Math.min(1,
        (muted ? 0 : v) * (clip.volume ?? 1) * (track?.volume ?? 1)));
    }
  }

  /** Schedule everything audible from `from` seconds onward. */
  start(from) {
    const ctx = this.#ensure();
    if (ctx.state === 'suspended') ctx.resume();
    this.stop();
    this.startedAt = ctx.currentTime;
    this.startTime = from;
    this.#stream(from);

    // Solo applies across every track that can make sound, not just audio ones.
    const soloed = this.store.doc.tracks.some(t => t.solo);

    for (const track of this.store.doc.tracks) {
      if (track.muted) continue;
      if (soloed && !track.solo) continue;

      for (const clip of track.clips) {
        const end = clip.start + clip.duration;
        if (end <= from) continue;
        if (clip.muted) continue;

        // Any clip whose asset decoded to an AudioBuffer is audible — which
        // includes a video's own soundtrack. The <video> elements the decoder
        // pool drives are muted on purpose, so if this loop skipped video
        // tracks (as it used to) a clip's audio would be played by nobody.
        const asset = assets.get(clip.assetId);
        const buf = asset?.peaks?.buffer;
        if (!buf) continue;

        const when = this.startedAt + Math.max(0, clip.start - from);
        const skip = Math.max(0, from - clip.start);
        const offset = clip.inPoint + skip * (clip.speed || 1);
        const dur = (clip.duration - skip) * (clip.speed || 1);
        if (dur <= 0 || offset >= buf.duration) continue;

        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = clip.speed || 1;

        const g = ctx.createGain();
        g.gain.value = (clip.volume ?? 1) * (track.volume ?? 1);
        this.#applyFades(g, clip, when, skip, ctx);

        src.connect(g).connect(this.master);
        src.start(when, offset, Math.min(dur, buf.duration - offset));
        this.nodes.push(src, g);
        this.gains.set(clip.id, g);
      }
    }
  }

  #applyFades(gainNode, clip, when, skip, ctx) {
    if (!clip.fadeIn && !clip.fadeOut) return;
    const base = (clip.volume ?? 1);
    const t0 = Math.max(when, ctx.currentTime);
    gainNode.gain.cancelScheduledValues(t0);
    gainNode.gain.setValueAtTime(base * fadeGain(clip, clip.start + skip), t0);
    if (clip.fadeIn > skip)
      gainNode.gain.linearRampToValueAtTime(base, when + (clip.fadeIn - skip));
    if (clip.fadeOut > 0) {
      const outAt = when + (clip.duration - skip - clip.fadeOut);
      if (outAt > t0) {
        gainNode.gain.setValueAtTime(base, outAt);
        gainNode.gain.linearRampToValueAtTime(0.0001, outAt + clip.fadeOut);
      }
    }
  }

  /**
   * Make one clip's level match the document, right now.
   *
   * Called while a fader is moving. A clip with fades has ramps already booked
   * against the old level, and re-pointing those mid-ramp is not worth the
   * arithmetic — the caller reschedules the whole graph on release instead, so
   * the only thing that can be briefly wrong is a fade's end point during the
   * drag itself.
   */
  liveGain(clip) {
    const track = this.store.doc.tracks.find(t => t.clips.includes(clip));
    const level = (clip.muted ? 0 : (clip.volume ?? 1)) * (track?.volume ?? 1);

    const g = this.gains.get(clip.id);
    if (g) {
      if (clip.fadeIn || clip.fadeOut) {
        // Leave the booked ramps alone; they are relative to the old level and
        // will be rebuilt on release. Setting .value here would be ignored.
      } else {
        try { g.gain.value = level; } catch { /* node already finished */ }
      }
    }

    const s = this.streaming.find(x => x.clip === clip);
    if (s) {
      const master = this.store.rt.muted ? 0 : (this.store.rt.volume ?? 1);
      s.el.volume = Math.max(0, Math.min(1, level * master));
    }
  }

  stop() {
    for (const n of this.nodes) { try { n.stop?.(); n.disconnect(); } catch {} }
    this.nodes.length = 0;
    this.gains.clear();
    this.#silenceStreams();
  }
}
