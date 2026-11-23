import { audioCtx } from '../audio/waveform.js';
import { snapFrame, clamp } from '../core/time.js';
import { assets } from '../media/asset-store.js';
import { audibleClips } from '../audio/graph.js';

/**
 * Transport clock.
 *
 * Time is read from the AudioContext clock rather than rAF deltas: it is
 * monotonic, unaffected by dropped frames, and it is the same clock the audio
 * graph schedules against — so a beat-synced cut stays synced even if the
 * compositor misses frames on a heavy 4K timeline.
 */
export class Playback {
  constructor(store, compositor, audioGraph) {
    this.store = store;
    this.comp = compositor;
    this.audio = audioGraph;
    this.anchorCtx = 0;
    this.anchorTime = 0;
    this._raf = null;
    this.onTick = null;
    /*
     * A long recording's sound takes a while to prepare. Pressing Play before
     * it was ready used to mean silence until Play was pressed again; now,
     * the moment more sound is ready than is playing, it is brought in.
     */
    this._heard = 0;
    assets.on('change', () => {
      if (!this.store.rt.playing) return;
      const n = this.#playable();
      if (n > this._heard) this.#restartSound();
    });
  }

  #playable() {
    try { return audibleClips(this.store).filter(c => c.src).length; } catch { return 0; }
  }

  #restartSound() {
    const ctx = audioCtx();
    this.anchorCtx = ctx.currentTime;
    this.anchorTime = this.store.rt.playhead;
    this.audio.start(this.store.rt.playhead);
    this._heard = this.#playable();
  }

  play() {
    if (this.store.rt.playing) return;
    const rt = this.store.rt;
    if (rt.playhead >= this.store.rt.duration - 1e-3) rt.playhead = 0;
    // Looping In to Out and outside it: start at In.
    const r = this.loopRange();
    if (r && (rt.playhead < r.in - 1e-3 || rt.playhead >= r.out - 1e-3)) rt.playhead = r.in;

    const ctx = audioCtx();
    if (ctx.state === 'suspended') ctx.resume();

    this.anchorCtx = ctx.currentTime;
    this.anchorTime = rt.playhead;
    this.audio.start(rt.playhead);
    this._heard = this.#playable();
    this.store.setRT({ playing: true });
    this.#loop();
  }

  pause() {
    if (!this.store.rt.playing) return;
    this.audio.stop();
    this.comp.pool.pauseAll();
    cancelAnimationFrame(this._raf);
    this._raf = null;
    this.store.setRT({ playing: false });
    this.render();
  }

  toggle() { this.store.rt.playing ? this.pause() : this.play(); }

  /** In to Out, when looping and both marks are set; otherwise null. */
  loopRange() {
    if (!this.store.rt.loop) return null;
    const r = this.store.doc.range;
    if (!r || r.in == null || r.out == null || !(r.out - r.in > 1 / (this.store.doc.fps || 30))) return null;
    return { in: r.in, out: Math.min(r.out, this.store.rt.duration) };
  }

  /** Move the playhead; quantized to the frame grid. */
  seek(t, { fromUser = true } = {}) {
    const dur = Math.max(this.store.rt.duration, 1 / this.store.doc.fps);
    const nt = clamp(snapFrame(t, this.store.doc.fps), 0, dur);
    this.store.rt.playhead = nt;
    if (this.store.rt.playing && fromUser) {
      const ctx = audioCtx();
      this.anchorCtx = ctx.currentTime;
      this.anchorTime = nt;
      this.audio.start(nt);
    }
    this.store.emit('playhead', nt);
    this.render();
  }

  step(frames) {
    this.pause();
    this.seek(this.store.rt.playhead + frames / this.store.doc.fps);
  }

  render() {
    const t0 = performance.now();
    // False means the frame was abandoned because a decoder had nothing ready,
    // so the canvas still shows the previous picture. The fps readout counts
    // pictures, not attempts — otherwise it reports 60 while the preview is
    // visibly stuttering, which is the opposite of a useful meter.
    const painted = this.comp.render(this.store.rt.playhead, this.store.rt.playing) !== false;
    // How long the paint took is what the quality governor steers on.
    this.lastPaintMs = performance.now() - t0;
    this.lastPainted = painted;
    this.onTick?.(this.store.rt.playhead, this.lastPaintMs, painted);
  }

  #loop = () => {
    if (!this.store.rt.playing) return;
    const ctx = audioCtx();
    // The sound scheduled for a moment reaches your ears outputLatency later
    // (tens of ms on most outputs, far more on Bluetooth), so the picture is
    // held back by the same amount to stay with what you hear.
    const lat = Math.min(0.5, Math.max(0, ctx.outputLatency || ctx.baseLatency || 0));
    const t = Math.max(this.anchorTime, this.anchorTime + (ctx.currentTime - this.anchorCtx) - lat);
    // Loop with In and Out both set (I / O) plays just that part, over and over.
    const r = this.loopRange();
    const end = r && this.anchorTime < r.out ? r.out : this.store.rt.duration;
    const from = r ? r.in : 0;

    if (t >= end) {
      if (this.store.rt.loop) { this.seek(from); this.audio.start(from); this.anchorCtx = ctx.currentTime; this.anchorTime = from; }
      else { this.seek(end); this.pause(); return; }
    } else {
      this.store.rt.playhead = t;
      this.store.emit('playhead', t);
    }

    // Paint only when the decoder has actually produced a new picture.
    // Redrawing an identical frame costs the same as a real one and steals
    // time from the decode that playback is waiting on.
    if (this.comp.needsPaint(this.store.rt.playhead)) {
      this.render();
    } else {
      // Nothing new to show, but the decoders still need driving — see the
      // note on Compositor.sync().
      this.comp.sync(this.store.rt.playhead, true);
      this.onTick?.(this.store.rt.playhead, 0, false);
    }

    this._raf = requestAnimationFrame(this.#loop);
  };
}
