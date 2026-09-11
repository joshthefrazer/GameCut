import { assets } from '../media/asset-store.js';

/**
 * Frame source pool.
 *
 * One <video> per active clip, kept warm and nudged toward the clip's local
 * time. Four things here are load-bearing and easy to get wrong:
 *
 * 1. `play()` returns a promise that REJECTS if the element is seeked before it
 *    resolves. Seeking on the following frame therefore aborts the start, the
 *    element stays paused, and the only frames reaching the canvas are the ones
 *    each seek happens to land on — a couple a second, looking exactly like a
 *    broken decoder. So while a start is in flight we leave the element alone.
 *
 * 2. The elements live in the document, inside a hidden host. A detached media
 *    element still decodes, but Chromium deprioritises it and the frame handed
 *    to drawImage can go stale for long stretches.
 *
 * 3. Seeking tears down the decode pipeline. Correcting small drift by seeking
 *    causes the stall it was meant to fix: the element re-buffers, falls further
 *    behind, gets seeked again. Small drift is absorbed by bending playbackRate;
 *    a hard seek is a last resort behind a cooldown.
 *
 * 4. `playbackRate` above 16 throws NotSupportedError. Timelapses run well past
 *    that, so anything faster is stepped frame by frame instead of played.
 *
 * WebCodecs upgrade path: swap `#el()` for a VideoDecoder + frame ring buffer
 * behind the same `frameFor()` signature; nothing above this file changes.
 */
const DRIFT_SEEK = 2.5;      // beyond this it's a discontinuity, not drift
const DRIFT_TRIM = 0.12;     // below this, leave the rate completely alone
const TRIM_SETTLE = 0.04;    // and once inside this, stop trimming again
const TRIM_MAX = 0.06;       // never bend rate by more than 6%
const SEEK_COOLDOWN_MS = 6000;
const START_SNAP = 0.35;     // only pre-seek a paused element if it's this far off
const SCRUB_SNAP = 0.008;    // exactness demanded when parked
const IDLE_EVICT_MS = 20_000;

/* Export streaming (see DecoderPool.streamTo). */
const STREAM_JUMP = 2;          // seconds ahead beyond which a seek is cheaper
const STREAM_RATE_MIN = 2;
const STREAM_RATE_MAX = 16;     // the element refuses anything faster
const STREAM_RATE_START = 8;
const STREAM_WARMUP = 40;       // frames before any of this counts as evidence
const STREAM_WINDOW = 80;       // judged on the most recent this many
const STREAM_GIVE_UP = 0.34;    // corrected more often than this: not worth it
const STREAM_RETRY = 600;       // frames to seek through before trying again

/** Chromium refuses playbackRate above this; a timelapse is stepped instead. */
export const MAX_RATE = 16;

/**
 * Live decoders are the single biggest memory cost with long footage — each
 * holds decoded frames of a 1080p or 4K source. A timeline that walks through
 * many clips would otherwise accumulate one per clip until the idle sweep.
 */
export const MAX_DECODERS = 4;
/*
 * Four, not three. A transition needs the incoming and the outgoing shot
 * decoding at the same moment, and a cropped layer over either of them makes a
 * third live clip. At three, an ordinary "dissolve between two clips while a
 * magnified counter sits on top" was one decoder short and something on screen
 * went stale. A decoder is the biggest single memory cost here, so this stays
 * as low as the work honestly allows rather than being raised for comfort.
 */

/** Hidden host so decoders are in the document without being visible. */
function videoHost() {
  let host = document.getElementById('gc-decoder-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'gc-decoder-host';
    host.setAttribute('aria-hidden', 'true');
    // Not display:none — that stops frame production. Visually nothing, but
    // still a rendered box. No `contain`, for the same reason: paint
    // containment is exactly the sort of hint that gets decode deprioritised.
    //
    // 160x90 rather than 1x1: measured on 1080p60, a one-pixel host decoded
    // 8.5fps and a 160px one 10fps. Chromium gives a video that occupies
    // essentially no area less of the decode budget. Big enough to be taken
    // seriously, small enough that compositing a handful is free.
    // Wide enough for every decoder to sit side by side: MAX_DECODERS x 160.
    // Stacking them on one spot occludes all but the top one, and an occluded
    // video gets its decode budget cut exactly like a clipped one does.
    host.style.cssText =
      `position:fixed;left:0;top:0;width:${MAX_DECODERS * 160}px;height:90px;overflow:hidden;` +
      'display:flex;opacity:0;pointer-events:none;z-index:-1';
    document.body.appendChild(host);
  }
  return host;
}

export class DecoderPool {
  #els = new Map();      // transport key -> { el, lastUsed, starting, rvfc, lastSeek }
  #imgs = new Map();     // assetId -> HTMLImageElement

  /**
   * Which decoder a clip needs — not which clip it is.
   *
   * A cropped layer is the same footage, at the same offset, running at the
   * same speed, at the same moment as the clip it was lifted from. Giving it
   * its own <video> would decode every frame twice and, with the pool capped,
   * evict the original to make room: the preview freezes the instant you
   * crop anything. Clips that want an identical transport share one element, so
   * a crop costs no decoding at all. Move or retime either one and the keys
   * diverge, and they get a decoder each again, which is then correct.
   */
  #key(clip) {
    const n = (v) => (Number(v) || 0).toFixed(4);
    return `${clip.assetId}|${n(clip.inPoint)}|${n(clip.start)}|${n(clip.speed || 1)}`;
  }

  /** Fires whenever a decoded video frame lands, so the preview can repaint. */
  onFrame = null;

  /** Running count of frames the decoders have delivered — a rate, once sampled. */
  decodedFrames = 0;

  /** How fast export plays the source while walking it forward. Self-tuning. */
  streamRate = STREAM_RATE_START;
  /** Frames left to seek through before trying to stream again. */
  streamSuspend = 0;
  _clean = 0;
  _seen = 0;
  _winN = 0;
  _winBad = 0;

  #el(clip, asset) {
    const key = this.#key(clip);
    let rec = this.#els.get(key);
    if (!rec) {
      const el = document.createElement('video');
      el.src = asset.url;
      el.preload = 'auto';
      // Long clips have no decoded AudioBuffer, so their sound comes straight
      // off this element; AudioGraph unmutes and mixes it. Short clips are
      // scheduled sample-accurately from a buffer and this stays muted.
      el.muted = true;
      el.defaultMuted = true;
      el.volume = 1;
      el.playsInline = true;
      el.disablePictureInPicture = true;
      // Pitch preservation makes every playbackRate change re-run a resampler.
      // The rate is nudged to hold sync and these elements can be unmuted for
      // long clips, so that cost lands on the decode path — refuse it.
      el.preservesPitch = false;
      el.mozPreservesPitch = false;
      el.webkitPreservesPitch = false;
      el.style.cssText = 'flex:0 0 auto;width:160px;height:90px';
      videoHost().appendChild(el);

      /**
       * Stamped as used the moment it is made, not left at zero.
       *
       * The eviction pass sorts by `lastUsed` and throws away the oldest. A
       * brand-new record with `lastUsed: 0` is the oldest thing in the pool, so
       * once three decoders were warm the pool spent its whole life killing the
       * decoder it had just created: the new clip's element was stripped of its
       * source and removed a microsecond after being built, the next request
       * built another and killed that one too, and the clip never showed a
       * frame. It looked exactly like footage that would not decode — readyState
       * stuck at 0, no error, an empty currentSrc — which is why it took a
       * diagnostic rather than a guess to find.
       */
      rec = { el, lastUsed: performance.now(), starting: false, rvfc: null,
              lastSeek: 0, trimming: false, mediaTime: 0 };

      // Present every decoded frame rather than whatever happens to be current
      // when the transport's rAF fires.
      if (el.requestVideoFrameCallback) {
        const pump = (now, meta) => {
          this.decodedFrames++;
          // Presentation time of the frame now on screen. NOT the same thing as
          // el.currentTime, which is the playback clock and runs ahead of the
          // picture — mistaking one for the other is how a "frame-exact" export
          // can silently pick the wrong frame.
          if (meta) rec.mediaTime = meta.mediaTime;
          this.onFrame?.();
          rec.rvfc = el.requestVideoFrameCallback(pump);
        };
        rec.rvfc = el.requestVideoFrameCallback(pump);
      }

      this.#els.set(key, rec);
      this.#trim(key);
    }
    rec.lastUsed = performance.now();
    return rec;
  }

  /**
   * Keep only the most recently used decoders alive.
   *
   * `keep` is the decoder the caller is asking for right now and is never a
   * candidate, whatever the clock says. Belt and braces alongside the timestamp
   * above: evicting the thing you were just asked for can only ever be wrong.
   */
  #trim(keep = null) {
    if (this.#els.size <= MAX_DECODERS) return;
    const byAge = [...this.#els.entries()]
      .filter(([id]) => id !== keep)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.#els.size > MAX_DECODERS && byAge.length) {
      const [id, rec] = byAge.shift();
      if (!rec) break;
      this.#dispose(rec);
      this.#els.delete(id);
    }
  }

  /** playbackRate, guarded — above 16 the setter throws. */
  #setRate(el, want) {
    const rate = Math.min(MAX_RATE, Math.max(0.0625, want));
    if (Math.abs(el.playbackRate - rate) < 0.005) return;
    try { el.playbackRate = rate; } catch { /* refused; keep whatever it had */ }
  }

  /** Returns a drawable source for `clip` at timeline time `t`, or null. */
  frameFor(clip, t, playing) {
    const asset = assets.get(clip.assetId);
    if (!asset) return null;

    if (asset.kind === 'image') {
      let img = this.#imgs.get(asset.id);
      if (!img) {
        img = new Image();
        img.src = asset.url;
        this.#imgs.set(asset.id, img);
      }
      return img.complete && img.naturalWidth ? img : null;
    }

    if (asset.kind !== 'video') return null;

    const rec = this.#el(clip, asset);
    const el = rec.el;
    const speed = clip.speed || 1;
    const target = Math.max(0, clip.inPoint + (t - clip.start) * speed);

    // Past 16x the element cannot play at all, and consecutive output frames
    // are far enough apart in the source that playing would be pointless
    // anyway. Step it like a scrub instead.
    const stepped = speed > MAX_RATE;

    if (playing && !stepped) {
      if (rec.starting) {
        // A play() is pending. Touching currentTime now would abort it.
      } else if (el.paused) {
        if (Math.abs(el.currentTime - target) > START_SNAP) el.currentTime = target;
        this.#setRate(el, speed);
        rec.starting = true;
        const p = el.play();
        if (p && typeof p.then === 'function') {
          p.then(() => { rec.starting = false; })
           .catch(() => { rec.starting = false; });
        } else {
          rec.starting = false;
        }
      } else {
        /**
         * Drift handling, and the guiding rule is: touch the element as rarely
         * as possible.
         *
         * Both available corrections cost decode. A seek flushes the pipeline
         * outright. A playbackRate change reconfigures the media pipeline —
         * and these elements carry the audio for long clips, so it is not free
         * there either. Correcting little and often produced exactly what it
         * sounds like: smooth playback punctuated by a stall every couple of
         * seconds. So there is a wide dead zone, hysteresis so a correction
         * runs until it has properly settled rather than switching on and off
         * at the threshold, and a long cooldown on the seek of last resort.
         */
        const err = el.currentTime - target;      // + = ahead of the transport
        const now = performance.now();
        const mag = Math.abs(err);

        if (mag > DRIFT_SEEK && now - rec.lastSeek > SEEK_COOLDOWN_MS) {
          rec.lastSeek = now;
          rec.trimming = false;
          el.currentTime = target;
          this.#setRate(el, speed);
        } else if (mag > DRIFT_TRIM) {
          rec.trimming = true;
        } else if (mag < TRIM_SETTLE) {
          rec.trimming = false;
        }

        if (rec.trimming && mag <= DRIFT_SEEK) {
          const trim = Math.max(-TRIM_MAX, Math.min(TRIM_MAX, -err));
          this.#setRate(el, speed * (1 + trim));
        } else if (!rec.trimming) {
          this.#setRate(el, speed);
        }
      }
    } else {
      if (!el.paused && !rec.starting) el.pause();
      if (!rec.starting && Math.abs(el.currentTime - target) > SCRUB_SNAP) {
        try { el.currentTime = target; } catch { /* not seekable yet */ }
      }
    }

    return el.readyState >= 2 ? el : null;
  }

  /**
   * Intrinsic source for `clip` WITHOUT touching its transport.
   *
   * `frameFor` doubles as transport control — it plays, pauses and seeks the
   * element to match the timeline. That makes it the wrong thing to call from a
   * read-only query: measuring a clip's on-screen box every frame (the gizmo
   * does exactly that) was pausing and re-seeking the video three times a
   * second, which looked like a decoder running at 3fps.
   */
  peek(clip) {
    const asset = assets.get(clip.assetId);
    if (!asset) return null;
    if (asset.kind === 'image') {
      const img = this.#imgs.get(asset.id);
      return img?.complete && img.naturalWidth ? img : null;
    }
    if (asset.kind !== 'video') return null;
    const rec = this.#els.get(this.#key(clip));
    return rec && rec.el.readyState >= 1 ? rec.el : null;
  }

  /**
   * The element backing `clip`, created if needed.
   *
   * AudioGraph uses this to play a long clip's sound directly off the decoder
   * rather than from a decoded buffer — see the note in audio/graph.js about
   * why long media never gets a buffer.
   */
  elementFor(clip) {
    const asset = assets.get(clip.assetId);
    if (asset?.kind !== 'video') return null;
    return this.#el(clip, asset).el;
  }

  /**
   * Walk the decoders forward to timeline time `t` by PLAYING rather than
   * seeking, and return how many frames had to be corrected.
   *
   * This is the whole of export performance. Rendering used to park the source
   * on every output frame with a seek, and a seek is the most expensive thing
   * you can ask a video element to do: it throws away the decode pipeline, goes
   * back to the nearest keyframe and decodes forward again — up to two seconds
   * of footage to produce one frame. Measured on 1080p60, that was 187ms per
   * frame against 0.14ms to encode it. Ninety-nine percent of an export was
   * spent seeking.
   *
   * Export always walks time forward in equal steps, which is exactly what a
   * decoder is built for. Playing at speed and waiting for the clock to reach
   * each frame measured 6ms instead of 187ms.
   *
   * The catch is that a playing element does not stop where it is told: by the
   * time the loop notices the target has passed, it may have run on by a frame
   * or several, and how far depends on how busy the machine is. That would make
   * the exported file depend on the computer that made it, which is precisely
   * the property this renderer exists to guarantee. So every frame is checked,
   * and any that overshot is corrected with a real seek — the slow path, used
   * as a backstop rather than as the method. The playback rate then drops so it
   * stops happening, and climbs again while it is not.
   *
   * The output is the same either way. Only the time taken changes.
   */
  async streamTo(clips, t, { tolerance = 1 / 120 } = {}) {
    // Give up and just seek if playing forward is not actually paying off.
    //
    // Whether it does depends on the footage. Long recordings with sparse
    // keyframes are exactly where seeking hurts most and playing wins big; a
    // short clip whose frame rate is close to the output's is the opposite,
    // because the decoder keeps landing between output frames and every landing
    // has to be corrected — which is a seek PLUS the playing that preceded it,
    // strictly worse than seeking alone. Rather than guess from the file, watch
    // what actually happens and stop when it is not working.
    if (this.streamSuspend > 0) { this.streamSuspend--; await this.seekExact(clips, t); return 0; }

    let corrections = 0;

    for (const clip of clips) {
      const asset = assets.get(clip.assetId);
      if (asset?.kind !== 'video') continue;

      const rec = this.#el(clip, asset);
      const el = rec.el;
      const speed = clip.speed || 1;
      const target = Math.max(0, clip.inPoint + (t - clip.start) * speed);
      const here = el.currentTime;

      // Backwards, or so far ahead that playing through would cost more than a
      // seek. Either way this is a discontinuity, not a step.
      if (target < here - 1e-4 || target > here + STREAM_JUMP) {
        if (!el.paused) el.pause();
        await this.seekExact([clip], t);
        continue;
      }

      if (target > here) {
        el.muted = true;                  // export never wants sound out loud
        this.#setRate(el, this.streamRate);
        if (el.paused && !rec.starting) {
          rec.starting = true;
          try { await el.play(); } catch { /* fall through to the seek below */ }
          rec.starting = false;
        }
        const deadline = performance.now() + 5000;
        while (el.currentTime < target && performance.now() < deadline) {
          await new Promise(r => setTimeout(r, 1));
        }
      }

      // Did it stop somewhere that would show a different picture than an exact
      // seek would? Then take the slow path for this one frame.
      if (Math.abs(el.currentTime - target) > tolerance) {
        if (!el.paused) el.pause();
        await this.seekExact([clip], t);
        corrections++;
      }
    }

    this.#adaptRate(corrections, clips.length);
    return corrections;
  }

  /**
   * Chase the fastest rate this machine can follow.
   *
   * A correction costs roughly thirty ordinary frames, so overshooting is worth
   * backing away from hard and creeping back towards slowly.
   */
  #adaptRate(corrections, n) {
    if (!n) return;

    if (corrections > 0) {
      this.streamRate = Math.max(STREAM_RATE_MIN, this.streamRate * 0.7);
      this._clean = 0;
    } else if (++this._clean >= 30) {
      this.streamRate = Math.min(STREAM_RATE_MAX, this.streamRate * 1.4);
      this._clean = 0;
    }

    /**
     * Judge it on a rolling window, and never permanently.
     *
     * The first version of this decided once, on the first two dozen frames,
     * and that verdict stood for the whole render. Those are the worst frames
     * to judge on — the decoder is cold, the first play() is still settling —
     * and a 45,000-frame export could be condemned to the slow path by one bad
     * second at the start. It was, on a real export, which is how this was
     * found.
     *
     * So: ignore the warm-up entirely, then look at the most recent window. A
     * bad window suspends streaming for a while rather than forever, and the
     * next window gets to change its mind. Footage that genuinely does not
     * suit streaming costs one short retry every few hundred frames; footage
     * that was only briefly struggling recovers.
     */
    if (++this._seen <= STREAM_WARMUP) return;

    this._winN++;
    if (corrections > 0) this._winBad++;
    if (this._winN < STREAM_WINDOW) return;

    const rate = this._winBad / this._winN;
    this._winN = 0;
    this._winBad = 0;
    if (rate > STREAM_GIVE_UP) {
      this.streamSuspend = STREAM_RETRY;
      this.streamRate = STREAM_RATE_START;
    }
  }

  /** Stop every decoder this pool is streaming and leave it parked. */
  endStream() {
    this.streamRate = STREAM_RATE_START;
    this.streamSuspend = 0;
    this._seen = 0; this._winN = 0; this._winBad = 0; this._clean = 0;
    for (const rec of this.#els.values()) {
      if (!rec.el.paused) rec.el.pause();
      rec.starting = false;
      try { rec.el.playbackRate = 1; } catch { /* refused */ }
    }
  }

  /**
   * Park every video clip in `clips` at exactly time `t` and wait for the
   * decoded frame to arrive. Playback tolerates being a frame off; an exported
   * file must not be.
   */
  async seekExact(clips, t, timeoutMs = 5000) {
    const waits = [];
    for (const clip of clips) {
      const asset = assets.get(clip.assetId);
      if (asset?.kind !== 'video') continue;

      const rec = this.#el(clip, asset);
      const el = rec.el;
      const target = Math.max(0, clip.inPoint + (t - clip.start) * (clip.speed || 1));
      if (!el.paused) el.pause();
      rec.starting = false;

      if (el.readyState >= 2 && Math.abs(el.currentTime - target) < 1e-4) continue;

      waits.push(new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          el.removeEventListener('seeked', finish);
          el.removeEventListener('error', finish);
          resolve();
        };
        // A timeout resolves rather than rejects: one stubborn frame should
        // cost a duplicate picture, not abort the whole export.
        const timer = setTimeout(finish, timeoutMs);
        el.addEventListener('seeked', finish, { once: true });
        el.addEventListener('error', finish, { once: true });
        try { el.currentTime = target; } catch { finish(); }
      }));
    }
    if (waits.length) await Promise.all(waits);
  }

  /** Pause everything (transport stop / seek away). */
  pauseAll() {
    for (const rec of this.#els.values()) {
      if (!rec.el.paused) rec.el.pause();
      rec.starting = false;
    }
  }

  /** Preroll elements for clips about to become visible. */
  warm(clips) {
    for (const c of clips) {
      const a = assets.get(c.assetId);
      if (a?.kind === 'video') this.#el(c, a);
    }
  }

  #dispose(rec) {
    if (rec.rvfc && rec.el.cancelVideoFrameCallback) {
      try { rec.el.cancelVideoFrameCallback(rec.rvfc); } catch { /* already gone */ }
    }
    rec.el.pause();
    rec.el.removeAttribute('src');
    rec.el.load();
    rec.el.remove();
  }

  /** Drop elements untouched for a while, freeing decoders. */
  sweep() {
    const now = performance.now();
    for (const [id, rec] of this.#els) {
      if (now - rec.lastUsed > IDLE_EVICT_MS) {
        this.#dispose(rec);
        this.#els.delete(id);
      }
    }
  }

  /** Tear down every decoder this pool owns. */
  disposeAll() {
    for (const [id, rec] of this.#els) { this.#dispose(rec); this.#els.delete(id); }
    this.#imgs.clear();
  }

  /** Drop the decoder a clip is using. Anything sharing it loses it too. */
  release(clip) {
    const key = this.#key(clip);
    const rec = this.#els.get(key);
    if (rec) { this.#dispose(rec); this.#els.delete(key); }
  }
}
