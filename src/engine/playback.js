import { audioCtx } from '../audio/waveform.js';
import { snapFrame, clamp } from '../core/time.js';

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
  }

  play() {
    if (this.store.rt.playing) return;
    const rt = this.store.rt;
    if (rt.playhead >= this.store.rt.duration - 1e-3) rt.playhead = 0;

    const ctx = audioCtx();
    if (ctx.state === 'suspended') ctx.resume();

    this.anchorCtx = ctx.currentTime;
    this.anchorTime = rt.playhead;
    this.audio.start(rt.playhead);
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
    const t = this.anchorTime + (ctx.currentTime - this.anchorCtx);
    const end = this.store.rt.duration;

    if (t >= end) {
      if (this.store.rt.loop) { this.seek(0); this.audio.start(0); this.anchorCtx = ctx.currentTime; this.anchorTime = 0; }
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
