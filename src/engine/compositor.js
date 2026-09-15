import { DecoderPool } from './decoder-pool.js';
import { drawVisualClip, drawShapeClip, sourceRect } from './layers/video-layer.js';
import { drawTextClip, measureText } from './layers/text-layer.js';
import { evalProp, fadeGain } from './keyframes.js';
import { transitionAt, transitionPlan } from './transitions.js';

/** Preview renders at most this wide; export re-runs the same code at full res. */
const PREVIEW_MAX_W = 1600;

export class Compositor {
  /**
   * `fixedSize` pins the backing store to an exact resolution instead of the
   * preview cap — that is how export renders at 1080p or 4K through the very
   * same painting code the preview uses. Every transform is normalised 0..1,
   * so changing the canvas size is all it takes.
   */
  constructor(store, canvas, { fixedSize = null } = {}) {
    this.store = store;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: !fixedSize });
    this.pool = new DecoderPool();
    this.scale = 1;
    this.fixedSize = fixedSize;

    /**
     * Set when a decoder hands over a genuinely new picture.
     *
     * The transport ticks at display rate, but a 1080p60 source may only decode
     * 30 or 40 frames a second. Redrawing on every tick regardless means half
     * the draws paint a picture identical to the one already on screen — pure
     * waste, and worse, it competes for the same GPU the decoder needs. Drawing
     * only when this is set paces the preview to the decoder exactly.
     */
    this.fresh = true;
    this.onFrame = null;
    this.pool.onFrame = () => { this.fresh = true; this.onFrame?.(); };

    /**
     * Clips the canvas must not paint, by id.
     *
     * Only ever used by the in-place text editor, which puts a real DOM field
     * over the picture so you get a caret and a selection. Deliberately a set
     * on the compositor rather than a flag on the clip: it is a fact about what
     * is on screen right now, not about the project, so it must never be saved,
     * undone, or exported.
     */
    this.hidden = new Set();

    this.resize();
    this._sweepTimer = setInterval(() => this.pool.sweep(), 10_000);
  }

  /**
   * Match the backing store to project resolution.
   *
   * `store.ui.previewScale` is the quality control: halving it quarters the
   * pixels the machine has to composite and scale every frame, which is what
   * makes long or high-resolution footage playable. It only affects what you
   * look at — export always renders at full size through `fixedSize`.
   */
  resize() {
    const { width: pw, height: ph } = this.store.doc;
    // rt.renderScale is the quality governor's temporary override during
    // playback; ui.previewScale is what the person actually chose.
    const quality = this.fixedSize ? 1
      : (this.store.rt.renderScale || this.store.ui.previewScale || 1);
    const cap = Math.min(1, PREVIEW_MAX_W / pw) * quality;
    const w = this.fixedSize ? this.fixedSize.w : Math.max(2, Math.round(pw * cap));
    const h = this.fixedSize ? this.fixedSize.h : Math.max(2, Math.round(ph * cap));
    this.scale = w / pw;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._painted = false;          // nothing worth holding onto at a new size
    }
  }

  /**
   * Is there anything new to draw?
   *
   * True when a decoder produced a frame since the last paint, or when the
   * moment contains something that animates on its own — text keyframes and
   * shapes have no decoder to wait for. Without a video source at all we must
   * keep painting normally.
   */
  needsPaint(t = this.store.rt.playhead) {
    if (this.fresh) return true;
    for (const { clip } of this.activeClips(t)) {
      if (clip.type !== 'video' && clip.type !== 'image') return true;
    }
    return false;
  }

  /**
   * Advance the decoders without painting.
   *
   * `frameFor` is transport control as well as a frame request — it is what
   * calls play() on the element in the first place. Skipping it on ticks where
   * there is nothing new to draw therefore deadlocks: the element never starts,
   * so no frame ever arrives, so there is never anything new to draw. The
   * decoders have to be driven every tick even when the canvas is left alone.
   */
  sync(t = this.store.rt.playhead, playing = this.store.rt.playing) {
    // clipsNeededAt, not activeClips: mid-transition the outgoing shot is still
    // being painted, so its decoder has to be driven on these ticks too or it
    // stalls exactly while it is on screen.
    for (const clip of this.clipsNeededAt(t)) this.pool.frameFor(clip, t, playing);
  }

  /** Release decoders and timers. Export compositors are short-lived. */
  dispose() {
    clearInterval(this._sweepTimer);
    this.pool.disposeAll();
  }

  /** Visible clips at time t, bottom track first (painter's order). */
  activeClips(t) {
    const out = [];
    const tracks = this.store.doc.tracks;
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (track.kind === 'audio' || track.hidden) continue;
      for (const clip of track.clips) {
        if (t >= clip.start && t < clip.start + clip.duration) out.push({ clip, track });
      }
    }
    return out;
  }

  /**
   * Every clip that has to have a decoded frame ready at time `t`.
   *
   * Not the same list as `activeClips`. Mid-transition the shot being cut away
   * from is drawn even though `t` is past its end, so anything that prepares
   * decoders ahead of a paint — export does, frame by frame — has to prepare
   * that one too. It did not, and the result was an exported transition whose
   * outgoing half was missing or a frame from somewhere else, while the preview
   * looked right because there a late frame just arrives a moment later.
   */
  clipsNeededAt(t) {
    const out = [];
    const add = (c) => {
      if (!c) return;
      if (c.type !== 'video' && c.type !== 'image') return;
      if (!out.includes(c)) out.push(c);
    };
    for (const { clip } of this.activeClips(t)) add(clip);
    // A centred transition needs both sides before either one is strictly
    // "active": for the first half the incoming clip has not started yet, and
    // for the second half the outgoing one has already ended.
    for (const track of this.store.doc.tracks) {
      if (track.kind === 'audio' || track.hidden) continue;
      const tr = transitionAt(track, t);
      if (!tr) continue;
      add(tr.prev);
      add(tr.next);
    }
    return out;
  }

  /**
   * Paint one frame.
   *
   * `playing` is not cosmetic — it decides whether the decoder pool runs its
   * video elements or parks and seeks them. Passing `false` while the transport
   * is running therefore stops playback dead, so leave both arguments off
   * unless you specifically mean "draw this exact time, stopped".
   */
  render(t = this.store.rt.playhead, playing = this.store.rt.playing) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;

    // Ask the decoders first, before clearing anything.
    //
    // A frame that isn't ready used to be painted as a dark rectangle, so a
    // decoder struggling with heavy footage showed as a black screen — the
    // worst possible way to say "still loading". Instead, if a clip that should
    // have a picture doesn't have one yet, abandon the whole frame and leave
    // the canvas showing what it showed last. A held picture reads as a brief
    // stutter; black reads as broken.
    const layers = [];
    let starved = false;
    const tracks = this.store.doc.tracks;

    /**
     * Opacity for a clip whose frame is being borrowed from outside its own
     * span. Read at the nearest moment that is actually inside the clip, or a
     * fade-out would take the outgoing shot to zero exactly when the transition
     * needs it, and the picture would go dark for no reason anyone asked for.
     */
    const alphaOf = (clip, at) => {
      const inside = Math.min(Math.max(at, clip.start + 1e-4),
                              clip.start + clip.duration - 1e-4);
      return Math.max(0, Math.min(1,
        evalProp(clip, 'transform.opacity', inside) * fadeGain(clip, inside)));
    };

    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (track.kind === 'audio' || track.hidden) continue;

      /**
       * A transition is one layer contributed by the track, not a property of
       * one of the clips in it.
       *
       * It has to be, now that it straddles the cut: for the first half the
       * incoming clip has not begun and for the second half the outgoing one
       * has ended, so neither of them is on screen for the whole of it. The
       * track is the thing that is continuously visible, so the track is what
       * paints it, and the two clips involved are skipped in the normal pass
       * below.
       */
      const tr = transitionAt(track, t);
      if (tr) {
        const a = this.pool.frameFor(tr.prev, t, playing);
        const b = this.pool.frameFor(tr.next, t, playing);
        if (!a || !b) starved = true;
        if (a && b) {
          layers.push({
            kind: 'transition', tr,
            out: { clip: tr.prev, src: a, alpha: alphaOf(tr.prev, t) },
            in: { clip: tr.next, src: b, alpha: alphaOf(tr.next, t) },
          });
        }
      }

      for (const clip of track.clips) {
        if (tr && (clip === tr.prev || clip === tr.next)) continue;
        if (!(t >= clip.start && t < clip.start + clip.duration)) continue;
        // Something on top is standing in for this clip — an in-place text
        // editor, drawn in the DOM so it can carry a real caret. Painting the
        // canvas copy underneath as well would double every letter.
        if (this.hidden.size && this.hidden.has(clip.id)) continue;

        const alpha = Math.max(0, Math.min(1,
          evalProp(clip, 'transform.opacity', t) * fadeGain(clip, t)));
        if (alpha <= 0.001) continue;

        if (clip.type === 'text' || clip.type === 'shape') {
          layers.push({ clip, alpha, src: null });
          continue;
        }
        const src = this.pool.frameFor(clip, t, playing);
        if (!src) { starved = true; continue; }
        layers.push({ clip, alpha, src });
      }
    }

    // Whatever happens next, any frame the decoder had waiting has now been
    // looked at. Clearing this before the early return matters: leaving it set
    // would make every following tick believe there was still something new,
    // which is precisely the wasted repainting this flag exists to stop.
    this.fresh = false;

    if (starved && this._painted) return false;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.store.doc.bg || '#000';
    ctx.fillRect(0, 0, W, H);

    for (const layer of layers) {
      if (layer.kind === 'transition') { this.#drawTransition(ctx, layer, W, H, t); continue; }
      const { clip, alpha, src } = layer;
      if (clip.type === 'text') { drawTextClip(ctx, clip, W, H, t, alpha); continue; }
      if (clip.type === 'shape') { drawShapeClip(ctx, clip, W, H, t, alpha); continue; }
      drawVisualClip(ctx, clip, src, W, H, t, alpha);
    }

    this._painted = true;
    return true;
  }

  /**
   * Paint one frame of a transition: the outgoing shot, then the incoming one
   * over it, following the plan the transition describes. The plan is shared
   * with export, so there is one definition of what each transition means.
   */
  #drawTransition(ctx, layer, W, H, t) {
    const { tr } = layer;
    const outgoing = layer.out, incoming = layer.in;
    const plan = transitionPlan(tr, W, H);

    /**
     * The opacity is handed to the painter rather than set here.
     *
     * `drawVisualClip` assigns `ctx.globalAlpha` from its own argument, so a
     * value set on the context before calling it is thrown away — which is how
     * a dissolve once painted both shots at full strength and came out pixel
     * for pixel identical to a hard cut. There is exactly one place that owns
     * the alpha, and it is the painter.
     */
    if (plan.under > 0.001) {
      ctx.save();
      if (plan.udx || plan.udy) ctx.translate(plan.udx, plan.udy);
      drawVisualClip(ctx, outgoing.clip, outgoing.src, W, H, t, outgoing.alpha * plan.under);
      ctx.restore();
    }
    // At the exact middle of a dip neither side is drawn, so the background
    // shows through — that is the black the transition is named for.

    if (plan.over <= 0.001) return;
    ctx.save();
    if (plan.dx || plan.dy) ctx.translate(plan.dx, plan.dy);
    drawVisualClip(ctx, incoming.clip, incoming.src, W, H, t, incoming.alpha * plan.over);
    ctx.restore();
  }

  /** Bounding box of a clip in normalized (0..1) frame space, for the gizmo. */
  bounds(clip, t) {
    const W = this.canvas.width, H = this.canvas.height;
    const cx = evalProp(clip, 'transform.x', t);
    const cy = evalProp(clip, 'transform.y', t);
    const scale = evalProp(clip, 'transform.scale', t);
    const rot = evalProp(clip, 'transform.rotation', t);

    let w, h;
    if (clip.type === 'text') {
      const m = measureText(this.ctx, clip, W, H, t);
      w = (m.width / W) * scale;
      h = (m.height / H) * scale;
    } else if (clip.type === 'shape') {
      w = clip.transform.w * scale;
      h = clip.transform.h * scale;
    } else {
      // peek(), not frameFor(): this is a measurement, and frameFor would
      // pause and seek a playing clip as a side effect.
      const src = this.pool.peek(clip);
      // Same rectangle the painter uses, so the selection box lands on the
      // picture rather than on the whole uncropped frame.
      const r = sourceRect(clip, src);
      const sw = r.sw || (clip.crop ? W * clip.crop.w : W);
      const sh = r.sh || (clip.crop ? H * clip.crop.h : H);
      const fit = (clip.fit || 'cover') === 'cover'
        ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
      w = (sw * fit * scale) / W;
      h = (sh * fit * scale) / H;
    }
    return { cx, cy, w: Math.max(w, 0.02), h: Math.max(h, 0.02), rot };
  }

  /** Topmost clip whose box contains the normalized point. */
  hitTest(nx, ny, t) {
    const list = this.activeClips(t);
    for (let i = list.length - 1; i >= 0; i--) {
      const { clip } = list[i];
      const b = this.bounds(clip, t);
      const dx = nx - b.cx, dy = ny - b.cy;
      const a = -b.rot * Math.PI / 180;
      const rx = dx * Math.cos(a) - dy * Math.sin(a);
      const ry = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(rx) <= b.w / 2 && Math.abs(ry) <= b.h / 2) return clip;
    }
    return null;
  }
}
