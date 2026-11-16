import { audioCtx } from './waveform.js';
import { assets } from '../media/asset-store.js';
import { fadeGain } from '../engine/keyframes.js';
import { readerOf, windowBuffer, PcmStore } from './pcm.js';

/**
 * Sample-accurate audio playback.
 *
 * On play we schedule source nodes per audible clip against the AudioContext
 * clock, so music stays locked to the timeline regardless of what the video
 * decoder or the rAF loop are doing. Any transport change tears the graph down
 * and reschedules — cheap, and impossible to drift.
 *
 * Sound arrives in one of two shapes (see audio/pcm.js): an AudioBuffer from
 * decodeAudioData (short mp3/wav/ogg files), or a PcmStore holding a whole
 * recording as 16-bit samples. A buffer is scheduled whole, as it always was.
 * A store is scheduled a couple of seconds at a time, just ahead of the
 * playhead — turning an hour of 16-bit sound into one float AudioBuffer would
 * undo the point of keeping it small.
 */

/**
 * Which clips make sound, and how loud.
 *
 * Shared by live playback and the offline export bounce so the file you render
 * can't quietly disagree with the file you heard. Honours track mute, solo and
 * per-clip mute. `src` is a reader (pcm.js) for clips with decoded sound;
 * `stream` marks clips whose sound can only come off a media element.
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
      if (!asset || asset.missing) continue;
      const buf = asset.peaks?.buffer;
      const src = readerOf(buf);
      if (src) out.push({ clip, track, buf, src, stream: false });
      // Only a long non-MP4 file still plays its sound off the media element.
      else if (asset.streamAudio) out.push({ clip, track, buf: null, src: null, stream: true });
    }
  }
  return out;
}

/** Clips whose audio cannot be included in an export (sound only on the element). */
export function unmixableClips(store) {
  return audibleClips(store).filter(c => c.stream).map(c => c.clip);
}

/**
 * Everything the export dialog needs to say about sound, before rendering.
 *
 * Each list holds { clip, asset }, one entry per file:
 *   pending     still being prepared — wait for it
 *   stream      plays here but can't be mixed (long .mkv/.webm/.mp3)
 *   unreadable  has sound this computer can't decode
 *   offline     the file was moved or deleted (picture AND sound)
 *
 * Clips with no sound track at all are not listed anywhere: a silent recording
 * exporting silent is not news.
 */
export function soundReport(store) {
  const soloed = store.doc.tracks.some(t => t.solo);
  const r = { pending: [], stream: [], unreadable: [], offline: [] };
  const seen = new Set();
  for (const track of store.doc.tracks) {
    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      if (!asset) continue;
      if (asset.missing) {
        // Listed whatever the mute state — the PICTURE is missing too.
        if (!seen.has('o' + asset.id)) { seen.add('o' + asset.id); r.offline.push({ clip, asset }); }
        continue;
      }
      if (asset.kind !== 'audio' && asset.kind !== 'video') continue;
      if (track.muted || (soloed && !track.solo) || clip.muted || clip.silent) continue;
      if (seen.has(asset.id)) continue;
      const state = asset.peaks?.buffer ? 'ready' : asset.audioState;
      const bucket = state === 'pending' ? 'pending'
        : state === 'ready' ? null
        : asset.streamAudio || state === 'stream' ? 'stream'
        : state === 'unreadable' ? 'unreadable'
        // An asset nobody has looked at yet (a project reopened by an older
        // library) is treated as still coming, not as silent.
        : state === undefined && asset.hasAudio !== false && !asset.url?.startsWith('data:') ? 'pending'
        : null;
      if (bucket) { seen.add(asset.id); r[bucket].push({ clip, asset }); }
    }
  }
  return r;
}

/* ── Level and fades, shared by preview and export ─────────── */

/** The clip's gain before fades: its own volume times its track's. */
const levelOf = (clip, track) => (clip.volume ?? 1) * (track?.volume ?? 1);

/**
 * The clip's gain over timeline time, as straight-line pieces.
 *
 * One description used by BOTH the preview and the export. They used to be
 * written twice and had drifted: the preview reset the gain to the clip's own
 * volume whenever the clip had a fade (dropping the track's volume), and
 * starting playback inside a fade-out booked no ramp at all.
 */
export function gainPoints(clip, level) {
  const s = clip.start, d = clip.duration, e = s + d;
  const fi = Math.max(0, Math.min(clip.fadeIn || 0, d));
  const fo = Math.max(0, Math.min(clip.fadeOut || 0, d));
  const ts = new Set([s, s + fi, e - fo, e]);
  // Overlapping fades multiply into a curve; a few points keep it close.
  if (fi + fo > d) for (let k = 1; k < 8; k++) ts.add((e - fo) + (s + fi - (e - fo)) * k / 8);
  return [...ts].filter(t => t >= s && t <= e).sort((a, b) => a - b)
    .map(t => ({ t, v: level * fadeGain(clip, t) }));
}

export function gainAt(points, t) {
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (t <= b.t) return b.t > a.t ? a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t) : b.v;
  }
  return points[points.length - 1].v;
}

/* ── Auto-duck and voice clean-up ──────────────────────────────
 * Both live here, in the code the preview AND the export share, so what you
 * hear while editing is what ends up in the file. */

/**
 * The music dipping by itself under voice and game sound.
 *
 * A lane with `duck.on` has its level multiplied by this envelope: it falls by
 * `duck.depth` (0..1) whenever any other sound in the edit is louder than a
 * whisper, quickly (attack) and comes back slowly (release), the way a radio
 * presenter's music does. Worked out from the waveform summaries every
 * imported file already has, so it costs nothing to compute.
 */
export function duckEnvelope(store, clip, track) {
  const d = track?.duck;
  if (!d?.on) return null;
  const depth = Math.max(0, Math.min(0.95, d.depth ?? 0.7));
  const others = [];
  for (const t of store.doc.tracks) {
    if (t === track || t.muted || t.duck?.on) continue;
    for (const c of t.clips) {
      if (c.muted || c.silent) continue;
      if (c.type !== 'video' && c.type !== 'audio') continue;
      if (c.start >= clip.start + clip.duration || c.start + c.duration <= clip.start) continue;
      const p = assets.get(c.assetId)?.peaks;
      if (p?.rms?.length) others.push({ c, p, lvl: (c.volume ?? 1) * (t.volume ?? 1) });
    }
  }
  if (!others.length) return null;
  const step = 0.05, attack = 0.08, release = 0.45, thresh = 0.06;
  const s = clip.start, e = s + clip.duration;
  const pts = [];
  let g = 1, last = null;
  for (let t = s; t <= e + 1e-9; t += step) {
    let loud = 0;
    for (const { c, p, lvl } of others) {
      if (t < c.start || t >= c.start + c.duration) continue;
      const i = Math.floor((c.inPoint + (t - c.start) * (c.speed || 1)) * p.rate);
      let m = 0;
      for (let k = Math.max(0, i - 12); k < Math.min(p.rms.length, i + 12); k++) m = Math.max(m, p.rms[k]);
      loud = Math.max(loud, m * lvl);
    }
    const target = loud > thresh ? 1 - depth : 1;
    const rate = target < g ? step / attack : step / release;
    g = g + (target - g) * Math.min(1, rate);
    const v = Math.round(g * 1000) / 1000;
    if (last == null || Math.abs(v - last) > 0.01) { pts.push({ t: Math.min(t, e), v }); last = v; }
  }
  if (!pts.length || pts.at(-1).t < e) pts.push({ t: e, v: g });
  return pts;
}

/** Multiply two step-wise envelopes onto one list of points. */
function combine(points, duck) {
  if (!duck?.length) return points;
  const ts = [...new Set([...points.map(p => p.t), ...duck.map(p => p.t)])].sort((a, b) => a - b);
  return ts.map(t => ({ t, v: gainAt(points, t) * gainAt(duck, t) }));
}

/** The gain a clip gets in the mix, fades and ducking included. */
export function clipEnvelope(store, clip, track) {
  return combine(gainPoints(clip, levelOf(clip, track)), duckEnvelope(store, clip, track));
}

/**
 * Voice clean-up: rumble and hiss out, a little mud out, presence up, the
 * level evened out. Plain Web Audio nodes, identical live and offline.
 */
/**
 * A soft limiter on the whole mix.
 *
 * Game sound, voice, music and sound effects summed together easily go past
 * full scale, and past full scale is hard clipping: the crackle you hear. This
 * is a fixed curve (no memory), so it behaves the same in the preview and in
 * every slice of the export bounce: untouched below -2 dB, then rounded off
 * so the peaks never hit the wall.
 */
let limiterCurve = null;
export function softLimiter(ctx) {
  if (!limiterCurve) {
    const n = 4096, knee = 0.8;
    limiterCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 4 - 2;            // the shaper's input runs -2..2
      const a = Math.abs(x);
      const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
      limiterCurve[i] = Math.sign(x) * y;
    }
  }
  const ws = ctx.createWaveShaper();
  ws.curve = limiterCurve;
  ws.oversample = '2x';
  return ws;
}

export function voiceChain(ctx) {
  const f = (type, freq, q, gain = 0) => {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = freq; b.Q.value = q; if (gain) b.gain.value = gain;
    return b;
  };
  const hp = f('highpass', 90, 0.7);
  const mud = f('peaking', 320, 1, -4);
  const pres = f('peaking', 3200, 0.9, 3.5);
  const lp = f('lowpass', 11500, 0.7);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -26; comp.knee.value = 10; comp.ratio.value = 3.5;
  comp.attack.value = 0.006; comp.release.value = 0.2;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.45;
  hp.connect(mud).connect(pres).connect(lp).connect(comp).connect(makeup);
  return { input: hp, output: makeup, nodes: [hp, mud, pres, lp, comp, makeup] };
}

/** Book the envelope on an AudioParam from timeline time `from` on. */
function automate(param, points, from, toCtx) {
  param.cancelScheduledValues(0);
  param.setValueAtTime(gainAt(points, from), toCtx(from));
  for (const p of points) if (p.t > from) param.linearRampToValueAtTime(p.v, toCtx(p.t));
}

/* ── Export mix ────────────────────────────────────────────── */

/**
 * Mix the timeline a stretch at a time, for export.
 *
 * An async generator of { buffer, frame }: `segment`-second AudioBuffers (the
 * last one shorter) and where each starts, in output frames. Each stretch is
 * its own OfflineAudioContext, fed only the few seconds of each source it
 * covers — so a two-hour export holds ten seconds of mix in memory, not two
 * hours of it plus a float copy of every source. Stretches join exactly: each
 * source resumes at the fractional position the previous stretch stopped at.
 */
export async function* mixTimeline(store, duration, { sampleRate = 48000, segment = 10, from = 0 } = {}) {
  const total = Math.max(1, Math.ceil(duration * sampleRate));
  const step = Math.max(1, Math.round(segment * sampleRate));
  const list = audibleClips(store).filter(c => c.src);
  for (let f0 = Math.max(0, Math.floor(from * sampleRate)); f0 < total; f0 += step) {
    const n = Math.min(step, total - f0);
    const t0 = f0 / sampleRate, t1 = (f0 + n) / sampleRate;
    const ctx = new OfflineAudioContext(2, n, sampleRate);
    const out = softLimiter(ctx);
    out.connect(ctx.destination);
    for (const { clip, track, src } of list) {
      const s = clip.start, e = clip.start + clip.duration;
      if (e <= t0 || s >= t1) continue;
      const speed = clip.speed || 1;
      const a = Math.max(t0, s), b = Math.min(t1, e);
      const srcA = Math.max(0, clip.inPoint || 0) + (a - s) * speed;
      const srcB = Math.max(0, clip.inPoint || 0) + (b - s) * speed;
      if (srcA >= src.duration) continue;
      const fa = Math.floor(srcA * src.sampleRate);
      const fb = Math.min(src.length, Math.ceil(srcB * src.sampleRate) + 2);
      if (fb <= fa) continue;
      const node = ctx.createBufferSource();
      node.buffer = windowBuffer(ctx, src, fa, fb - fa);
      node.playbackRate.value = speed;
      const g = ctx.createGain();
      automate(g.gain, clipEnvelope(store, clip, track), a, (t) => Math.max(0, t - t0));
      if (clip.clean || track.voice) { const ch = voiceChain(ctx); node.connect(ch.input); ch.output.connect(g); }
      else node.connect(g);
      g.connect(out);
      const offset = srcA - fa / src.sampleRate;
      const dur = Math.min((b - a) * speed, (fb - fa) / src.sampleRate - offset);
      if (dur > 0) node.start(a - t0, offset, dur);
    }
    yield { buffer: await ctx.startRendering(), frame: f0 };
  }
}

/**
 * Bounce the whole timeline to one AudioBuffer.
 *
 * Kept for small jobs and tests; exports use mixTimeline, which never holds
 * the whole mix at once.
 */
export async function renderTimelineAudio(store, duration, sampleRate = 48000) {
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const out = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  for await (const { buffer, frame } of mixTimeline(store, duration, { sampleRate })) {
    out.copyToChannel(buffer.getChannelData(0), 0, frame);
    out.copyToChannel(buffer.getChannelData(1), 1, frame);
  }
  return out;
}

/* ── Live playback ─────────────────────────────────────────── */

/** Seconds of a PcmStore turned into one AudioBuffer per scheduled piece. */
const PIECE_SECONDS = 2;
/** How far ahead of the playhead pieces are booked. */
const LOOKAHEAD = 4;

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
    /** PcmStore clips still being fed piece by piece. */
    this.feeds = [];
    this.timer = 0;
    /**
     * clipId -> the GainNode carrying that clip, while it is scheduled.
     *
     * Kept so a fader can be heard as it moves. Without it, changing a clip's
     * volume during playback does nothing until the transport is touched, and
     * mixing by ear — which is the only way anyone mixes — becomes impossible.
     */
    this.gains = new Map();
  }

  /** Timeline time the audio clock says it is now. */
  #now(ctx) { return this.startTime + (ctx.currentTime - this.startedAt); }

  /**
   * Sound for clips with no decoded buffer.
   *
   * Only long non-MP4 files get here now. A video clip plays from the element
   * that is already decoding its picture — one decode, sound and image in
   * step. An audio-only file gets its own element, which #tick cues, starts,
   * keeps in step and stops: it used to be started only if it was already
   * under the playhead when Play was pressed (so a clip further along never
   * sounded), was started late by the seek it had to make first, and was never
   * stopped at its end.
   */
  #stream(from) {
    this.#silenceStreams();
    const master = this.store.rt.muted ? 0 : (this.store.rt.volume ?? 1);

    for (const { clip, track, stream } of audibleClips(this.store)) {
      if (!stream) continue;
      const end = clip.start + clip.duration;
      if (end <= from) continue;
      const asset = assets.get(clip.assetId);
      const el = this.#elFor(clip);
      if (!el) continue;

      el.muted = false;
      el.volume = Math.max(0, Math.min(1, levelOf(clip, track) * master));
      const own = asset?.kind === 'audio';
      this.streaming.push({ clip, el, own, cued: false, go: 0 });
      if (own) {
        el.pause();
        el.playbackRate = Math.min(16, Math.max(0.0625, clip.speed || 1));
      }
    }
  }

  /** Where in its file an audio-only stream clip should be at timeline `t`. */
  #offsetAt(clip, t) {
    return Math.max(0, (clip.inPoint || 0) + Math.max(0, t - clip.start) * (clip.speed || 1));
  }

  #elFor(clip) {
    const asset = assets.get(clip.assetId);
    if (!asset) return null;
    if (asset.kind === 'video') return this.pool?.elementFor(clip) || null;

    let el = this.streamEls.get(clip.id);
    if (!el) {
      el = document.createElement('audio');
      el.crossOrigin = 'anonymous';
      el.src = asset.url;
      el.preload = 'auto';
      this.streamEls.set(clip.id, el);
    }
    return el;
  }

  #silenceStreams() {
    for (const s of this.streaming) {
      clearTimeout(s.go);
      s.el.muted = true;
      if (s.own && !s.el.paused) s.el.pause();
    }
    this.streaming.length = 0;
  }

  #ensure() {
    const ctx = audioCtx();
    if (!this.master) {
      this.master = ctx.createGain();
      this.limiter = softLimiter(ctx);
      this.master.connect(this.limiter);
      this.limiter.connect(ctx.destination);
    }
    this.master.gain.value = this.store.rt.muted ? 0 : this.store.rt.volume;
    return ctx;
  }

  setVolume(v, muted) {
    if (this.master) this.master.gain.value = muted ? 0 : v;
    for (const { clip, el } of this.streaming) {
      const track = this.store.doc.tracks.find(t => t.clips.includes(clip));
      el.volume = Math.max(0, Math.min(1, (muted ? 0 : v) * levelOf(clip, track)));
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
    const toCtx = (t) => this.startedAt + (t - from);

    for (const { clip, track, buf, src } of audibleClips(this.store)) {
      if (!src) continue;
      const end = clip.start + clip.duration;
      if (end <= from) continue;

      // Any clip whose asset decoded to sound is audible — which includes a
      // video's own soundtrack. The <video> elements the decoder pool drives
      // are muted on purpose, so this graph is the only thing playing it.
      const speed = clip.speed || 1;
      const skip = Math.max(0, from - clip.start);
      const offset = (clip.inPoint || 0) + skip * speed;
      const dur = (clip.duration - skip) * speed;
      if (dur <= 0 || offset >= src.duration) continue;

      const g = ctx.createGain();
      automate(g.gain, clipEnvelope(this.store, clip, track), Math.max(from, clip.start), toCtx);
      g.connect(this.master);
      this.nodes.push(g);
      this.gains.set(clip.id, g);
      // Clean-up sits between the source and the level, so the fader still
      // sets the loudness after it.
      let inlet = g;
      if (clip.clean || track.voice) { const ch = voiceChain(ctx); ch.output.connect(g); inlet = ch.input; this.nodes.push(...ch.nodes); }
      const when = toCtx(Math.max(from, clip.start));

      if (!(buf instanceof PcmStore)) {
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.playbackRate.value = speed;
        node.connect(inlet);
        node.start(when, offset, Math.min(dur, buf.duration - offset));
        this.nodes.push(node);
        continue;
      }
      this.feeds.push({
        clip, src, gain: g, inlet, speed, when,
        frame: Math.floor(offset * src.sampleRate),
        endFrame: Math.min(src.length, Math.ceil((offset + dur) * src.sampleRate)),
      });
    }

    this.#tick();
    if (this.feeds.length || this.streaming.some(s => s.own)) {
      this.timer = setInterval(() => this.#tick(), 200);
    }
  }

  /** Book the next pieces of every fed clip, and steer stream elements. */
  #tick() {
    const ctx = audioCtx();
    const horizon = ctx.currentTime + LOOKAHEAD;
    for (const f of this.feeds) {
      while (f.frame < f.endFrame && f.when < horizon) {
        const n = Math.min(Math.round(PIECE_SECONDS * f.src.sampleRate), f.endFrame - f.frame);
        const node = ctx.createBufferSource();
        node.buffer = windowBuffer(ctx, f.src, f.frame, n);
        node.playbackRate.value = f.speed;
        node.connect(f.inlet || f.gain);
        node.start(Math.max(f.when, ctx.currentTime));
        node.onended = () => {
          const i = this.nodes.indexOf(node);
          if (i >= 0) this.nodes.splice(i, 1);
          try { node.disconnect(); } catch { /* gone */ }
        };
        this.nodes.push(node);
        f.frame += n;
        f.when += n / f.src.sampleRate / f.speed;
      }
    }

    const t = this.#now(ctx);
    for (const s of this.streaming) {
      if (!s.own) continue;
      const { clip, el } = s;
      const end = clip.start + clip.duration;
      if (t >= end) { if (!el.paused) el.pause(); continue; }
      if (t < clip.start - 1) continue;
      if (t < clip.start) {
        // Cue a second early: seeking a long file takes a moment, and a seek
        // begun on the clip's first frame is a late start.
        if (!s.cued) {
          s.cued = true;
          try { el.currentTime = this.#offsetAt(clip, clip.start); } catch { /* not ready */ }
          clearTimeout(s.go);
          s.go = setTimeout(() => { if (this.streaming.includes(s)) el.play().catch(() => {}); },
            Math.max(0, (clip.start - t) * 1000));
        }
        continue;
      }
      const want = this.#offsetAt(clip, t);
      if (el.paused) {
        if (!s.cued || Math.abs(el.currentTime - want) > 0.25) {
          try { el.currentTime = want; } catch { /* not ready */ }
        }
        s.cued = true;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - want) > 0.3) {
        try { el.currentTime = want; } catch { /* not ready */ }
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
    const level = (clip.muted ? 0 : 1) * levelOf(clip, track);

    const g = this.gains.get(clip.id);
    if (g && !(clip.fadeIn || clip.fadeOut)) {
      // The gain carries a booked envelope, so .value would be ignored —
      // replace the booking with the new level from now on.
      try {
        g.gain.cancelScheduledValues(0);
        g.gain.setValueAtTime(level, audioCtx().currentTime);
      } catch { /* node already finished */ }
    }

    const s = this.streaming.find(x => x.clip === clip);
    if (s) {
      const master = this.store.rt.muted ? 0 : (this.store.rt.volume ?? 1);
      s.el.volume = Math.max(0, Math.min(1, level * master));
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    for (const n of this.nodes) { try { n.stop?.(); n.disconnect(); } catch {} }
    this.nodes.length = 0;
    this.feeds.length = 0;
    this.gains.clear();
    this.#silenceStreams();
  }
}
