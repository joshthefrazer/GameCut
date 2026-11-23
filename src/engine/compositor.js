import { DecoderPool } from './decoder-pool.js';
import { drawVisualClip, drawShapeClip, sourceRect } from './layers/video-layer.js';
import { drawTextClip, measureText } from './layers/text-layer.js';
import { evalProp, fadeGain } from './keyframes.js';
import { transitionAt, transitionPlan } from './transitions.js';
import { visualMotion, rad } from './motion.js';
import { applyEffect } from './layers/effects.js';
import { drawAnimClip, animBox } from './layers/anim-layer.js';
import { blendOp, colorFilter } from './layers/color.js';

/** Preview renders at most this wide; export re-runs the same code at full res. */
const PREVIEW_MAX_W = 2560;

/** How long a paused preview keeps retrying a frame it could not finish. */
const RETRY_MS = 4000;

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
  /**
   * The quality the person picked, as a step (1, 0.5 or 0.25).
   *
   * "Auto" (0, the default) picks the smallest step that is still at least as
   * sharp as the preview is on screen — panel width times the display's pixel
   * ratio — so a laptop at 150% scaling never gets a canvas stretched soft,
   * and a small panel never pays for pixels it cannot show.
   */
  chosenQuality() {
    const q = this.store.ui.previewScale;
    if (q) return q;
    const pw = this.store.doc.width;
    const shown = this.displayPx || 0;            // set by the preview panel's fit()
    if (!shown) return 1;
    const need = shown / Math.min(pw, PREVIEW_MAX_W);
    return need > 0.52 ? 1 : need > 0.26 ? 0.5 : 0.25;   // a little slack so 960px of panel gets Half, not Full
  }

  resize() {
    const { width: pw, height: ph } = this.store.doc;
    // rt.renderScale is the quality governor's temporary override during
    // playback; ui.previewScale is what the person actually chose.
    const quality = this.fixedSize ? 1
      : (this.store.rt.renderScale || this.chosenQuality());
    const cap = Math.min(1, PREVIEW_MAX_W / pw) * quality;
    const w = this.fixedSize ? this.fixedSize.w : Math.max(2, Math.round(pw * cap));
    const h = this.fixedSize ? this.fixedSize.h : Math.max(2, Math.round(ph * cap));
    this.scale = w / pw;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._painted = false;          // nothing worth holding onto at a new size
      // Resizing wipes the canvas. During playback the transport only paints
      // when something is new, so say that something is: the wiped canvas.
      this.fresh = true;
    }
  }

  /**
   * Is there anything new to draw?
   *
   * True when a decoder produced a frame since the last paint, or when the
   * moment contains something that changes on its own — text and shapes have
   * no decoder to wait for, and neither does a still that is moving.
   *
   * Stills used to be lumped in with footage here, and that was wrong in a way
   * that only shows on a timeline with no footage at all: nothing ever set
   * `fresh`, so once play was pressed the canvas was never painted again. A
   * graphic's keyframes, fades and motion presets, and a dissolve between two
   * stills, all sat frozen on their first frame for as long as it played. A
   * still that is NOT moving is still exempt — repainting a static logo over
   * playing footage at display rate is exactly the waste this method exists to
   * stop — but one that is moving is no different from a title.
   *
   * The set of layers changing counts as new as well: a cut from footage to a
   * still has no decoder frame to announce it, and the still would otherwise
   * wait for whatever happened to paint next.
   */
  needsPaint(t = this.store.rt.playhead) {
    if (this.fresh) return true;
    const active = this.activeClips(t);
    if (this.#sceneKey(active) !== this._scene) return true;
    for (const { clip } of active) {
      if (this.motionPreview?.clipId === clip.id) return true;
      if (clip.type === 'video') { if (motionLive(clip, t)) return true; continue; }
      if (clip.type !== 'image') return true;
      if (stillMoves(clip, t)) return true;
    }
    // A transition is a blend that changes every tick, whatever its two sides
    // are made of.
    for (const track of this.store.doc.tracks) {
      if (track.kind === 'audio' || track.hidden) continue;
      if (transitionAt(track, t)) return true;
    }
    return false;
  }

  /** Which layers are on screen, as one comparable string. */
  #sceneKey(active) {
    let k = '';
    for (const { clip } of active) k += clip.id + ',';
    return k;
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

  /**
   * Paint again on the next display frame, for a few seconds at most.
   *
   * Bounded because a source that will never arrive (a file that failed to
   * open) must not keep a loop running forever; anything that arrives later
   * than this is announced by the decoder pool's own events.
   */
  #retryPaint() {
    if (this._retry) return;
    const now = performance.now();
    if (!this._retryUntil) this._retryUntil = now + RETRY_MS;
    if (now > this._retryUntil) return;
    this._retry = requestAnimationFrame(() => {
      this._retry = 0;
      if (this.store.rt.playing) { this._retryUntil = 0; return; }
      this.render(this.store.rt.playhead, false);
    });
  }

  /** Release decoders and timers. Export compositors are short-lived. */
  dispose() {
    if (this._retry) cancelAnimationFrame(this._retry);
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

        if (clip.type === 'text' || clip.type === 'shape' || clip.type === 'effect' || clip.type === 'anim') {
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

    /*
     * A frame that could not be finished must be asked for again.
     *
     * Every edit repaints once, at once — and when the decoder is mid-seek, or
     * the element was only just created, that one paint finds nothing and is
     * abandoned. Playback asks again on its next tick, but while paused nothing
     * did: the frame arrived, sat in the decoder, and the preview stayed black
     * or kept showing a picture from before the edit. The decoder pool now
     * announces seeks and first loads as well as presented frames (see
     * `onFrame`), and this is the backstop for anything that announces nothing:
     * keep trying on the next display frame until the picture is whole.
     */
    if (starved && !playing && !this.fixedSize) this.#retryPaint();
    else this._retryUntil = 0;

    if (starved && this._painted) return false;

    /*
     * Compare view: the left of the divider is the picture without effects,
     * looks or motion; the right is the finished picture. Preview only — an
     * export never has `compare` set.
     *
     * The finished picture is painted straight into its own canvas. It used to
     * be painted on the preview and then copied off it, but the preview canvas
     * is `desynchronized`, and reading it back in the same task can return the
     * frame from before, so the "finished" half showed the picture without
     * effects (qa/features.mjs "Compare", failing since 2.0.5).
     */
    const cmp = this.compare;
    if (cmp?.on && !this.fixedSize) {
      if (!this._cmp || this._cmp.width !== W || this._cmp.height !== H) {
        this._cmp = document.createElement('canvas'); this._cmp.width = W; this._cmp.height = H;
      }
      this.#paintLayers(this._cmp.getContext('2d'), layers, W, H, t);
      this.bypass = true;
      try { this.#paintLayers(ctx, layers, W, H, t); } finally { this.bypass = false; }
      const x = Math.round(Math.max(0, Math.min(1, cmp.x ?? 0.5)) * W);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this._cmp, x, 0, W - x, H, x, 0, W - x, H);
    } else {
      this.#paintLayers(ctx, layers, W, H, t);
    }

    this._painted = true;
    this._scene = this.#sceneKey(this.activeClips(t));
    return true;
  }

  #paintLayers(ctx, layers, W, H, t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.store.doc.bg || '#000';
    ctx.fillRect(0, 0, W, H);

    const mp = this.bypass ? null : this.motionPreview;
    for (const layer of layers) {
      if (layer.kind === 'transition') { this.#drawTransition(ctx, layer, W, H, t); continue; }
      let { clip } = layer;
      const { alpha, src } = layer;
      // A move being tried out in the Motion panel: drawn on this clip, at the
      // panel's own clock, without touching the project.
      let mt = t;
      if (mp && mp.clipId === clip.id) {
        clip = clip.type === 'text'
          ? { ...clip, text: { ...clip.text, ...mp.patch } }
          : { ...clip, motion: { ...(clip.motion || {}), ...mp.patch } };
        mt = mp.t;
      }
      if (clip.type === 'effect') { if (!this.bypass) applyEffect(ctx, ctx.canvas, clip, t, W, H); continue; }
      if (clip.type === 'text') {
        if (this.bypass) clip = { ...clip, text: { ...clip.text, anim: 'none', animOut: 'none', animLoop: 'none' } };
        const c = clip;
        this.#styled(ctx, c, () => drawTextClip(ctx, c, W, H, mt, alpha));
        continue;
      }
      if (this.bypass && clip.fx) clip = { ...clip, fx: null };
      const c = clip;
      this.#styled(ctx, c, () => this.#drawMoving(ctx, c, src, W, H, t, mt, alpha));
    }
  }

  /**
   * A layer's colour and blend mode (src/engine/layers/color.js), around
   * whatever paints it. Compare's "before" side (`bypass`) shows neither.
   */
  #styled(ctx, clip, paint) {
    if (this.bypass) { paint(); return; }
    const op = blendOp(clip);
    const f = (clip.type === 'video' || clip.type === 'image') ? colorFilter(clip.color) : '';
    if (!op && !f) { paint(); return; }
    ctx.save();
    if (op) ctx.globalCompositeOperation = op;
    if (f) ctx.filter = f;
    try { paint(); } finally { ctx.restore(); }
  }

  /**
   * A picture, still or shape, with its named motion (arrives / leaves /
   * keeps doing) applied around its own centre. Text does the same inside its
   * own painter, piece by piece.
   */
  #drawMoving(ctx, clip, src, W, H, t, mt, alpha) {
    const paint = (a) => {
      if (clip.type === 'shape') drawShapeClip(ctx, clip, W, H, t, a);
      else if (clip.type === 'anim') drawAnimClip(ctx, clip, W, H, t, a);
      else drawVisualClip(ctx, clip, src, W, H, t, a);
    };
    if (!clip.motion || this.bypass) { paint(alpha); return; }
    const b = this.boundsPx(clip, t, src, W, H);
    const mv = visualMotion(clip, mt, Math.min(W, H) * 0.12, b.w);
    if (!mv) { paint(alpha); return; }
    const a = alpha * mv.a;
    if (a <= 0.001) return;
    ctx.save();
    ctx.translate(b.cx + mv.dx, b.cy + mv.dy);
    if (mv.rot) ctx.rotate(rad(mv.rot));
    if (mv.s !== 1 || mv.sx !== 1) ctx.scale(Math.max(0.001, mv.s * mv.sx), Math.max(0.001, mv.s));
    ctx.translate(-b.cx, -b.cy);
    if (mv.wipe < 1) {
      ctx.beginPath();
      ctx.rect(b.cx - b.w / 2 - 2, -H, (b.w + 4) * Math.max(0, mv.wipe), H * 3);
      ctx.clip();
    }
    // Keep the layer's own colour filter, if it has one, after the motion's hue turn.
    if (mv.hue != null) ctx.filter = `hue-rotate(${Math.round(mv.hue)}deg)` + (ctx.filter && ctx.filter !== 'none' ? ' ' + ctx.filter : '');
    paint(a);
    ctx.restore();
  }

  /** Where a clip sits on this canvas, in pixels: centre and size. */
  boundsPx(clip, t, src = null, W = this.canvas.width, H = this.canvas.height) {
    const cx = evalProp(clip, 'transform.x', t) * W;
    const cy = evalProp(clip, 'transform.y', t) * H;
    const scale = evalProp(clip, 'transform.scale', t);
    if (clip.type === 'shape') {
      return { cx, cy, w: evalProp(clip, 'transform.w', t) * W * scale, h: evalProp(clip, 'transform.h', t) * H * scale };
    }
    if (clip.type === 'anim') {
      const b = animBox(clip, W, H, t);
      return b ? { cx: b.cx, cy: b.cy, w: b.w, h: b.h } : { cx, cy, w: W * 0.2, h: H * 0.1 };
    }
    const r = sourceRect(clip, src || this.pool.peek(clip));
    const sw = r.sw || W, sh = r.sh || H;
    const fit = (clip.fit || 'cover') === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    return { cx, cy, w: sw * fit * scale, h: sh * fit * scale };
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
      this.#styled(ctx, outgoing.clip, () => drawVisualClip(ctx, outgoing.clip, outgoing.src, W, H, t, outgoing.alpha * plan.under));
      ctx.restore();
    }
    // At the exact middle of a dip neither side is drawn, so the background
    // shows through — that is the black the transition is named for.

    if (plan.over <= 0.001) return;
    ctx.save();
    if (plan.dx || plan.dy) ctx.translate(plan.dx, plan.dy);
    this.#styled(ctx, incoming.clip, () => drawVisualClip(ctx, incoming.clip, incoming.src, W, H, t, incoming.alpha * plan.over));
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
    } else if (clip.type === 'anim') {
      const b = animBox(clip, W, H, t);
      w = b ? b.w / W : 0.2; h = b ? b.h / H : 0.1;
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
      if (clip.type === 'effect') continue;      // an effect is not a thing you grab on the picture
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

/**
 * Does a still change over time at `t`?
 *
 * Keyframes only move a value between their first and last key — outside that
 * span it holds — and a fade only changes the picture while it is ramping.
 */
function stillMoves(clip, t) {
  if (motionLive(clip, t)) return true;
  const local = t - clip.start;
  if (clip.fadeIn > 0 && local < clip.fadeIn) return true;
  if (clip.fadeOut > 0 && clip.duration - local < clip.fadeOut) return true;
  const keys = clip.keys;
  if (keys) {
    for (const path in keys) {
      const list = keys[path];
      if (list && list.length > 1 && local >= list[0].t && local <= list.at(-1).t) return true;
    }
  }
  return false;
}

/** Is a clip's named motion changing the picture at `t`? */
function motionLive(clip, t) {
  const m = clip.motion;
  if (!m) return false;
  if (m.animLoop && m.animLoop !== 'none') return true;
  const local = t - clip.start;
  if (m.anim && m.anim !== 'none' && local < (m.animDur || 0.5)) return true;
  if (m.animOut && m.animOut !== 'none' && clip.duration - local < (m.animOutDur || 0.5)) return true;
  return false;
}
