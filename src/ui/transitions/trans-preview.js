import { assets } from '../../media/asset-store.js';
import { transitionPlan } from '../../engine/transitions.js';

/**
 * A moving preview of a transition, on your own two shots.
 *
 * Tiles that draw a diagram of a transition tell you what it is called. They do
 * not tell you whether a dip to black is too long for this cut, or whether a
 * slide fights the camera move that is already happening in the shot — and
 * those are the questions you actually have. So this grabs one frame from
 * either side of the seam and runs the real transition across them, on a loop.
 *
 * It is deliberately built on stills rather than on live decoders. Two extra
 * <video> elements looping in a side panel would compete with the preview for
 * decoders and for the machine, and the answer to "does this look right" is
 * visible in the shape of the move, not in whether the footage underneath is
 * playing.
 *
 * `transitionPlan` is the same function the compositor and the exporter use, so
 * what you see here cannot disagree with what gets rendered.
 */

/** How big the captured stills are. Small: this is a panel, not a monitor. */
const CAP_W = 480;

/**
 * Two frames either side of a cut, as canvases.
 *
 * Returns nulls rather than throwing when the footage is not decodable — a
 * preview is a nicety and must never be the reason an edit fails.
 */
export async function grabCutFrames(j, { store, comp }) {
  const ratio = store.doc.height / store.doc.width;
  const w = CAP_W, h = Math.round(CAP_W * ratio);

  const draw = async (clip, t) => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.fillStyle = store.doc.bg || '#000';
    c.fillRect(0, 0, w, h);

    let src = null;
    const asset = assets.get(clip.assetId);
    if (asset?.kind === 'video') {
      try {
        await comp.pool.seekExact([clip], t, 2500);
        src = comp.pool.peek(clip);
      } catch { src = comp.pool.peek(clip); }
    } else {
      src = comp.pool.peek(clip) || comp.pool.frameFor(clip, t, false);
    }

    // A thumbnail is a poor second — it is not this moment of the clip — but it
    // is still this clip, which beats a coloured rectangle.
    if (!src && asset?.thumb) {
      const img = new Image();
      img.src = asset.thumb;
      try { await img.decode(); src = img; } catch { src = null; }
    }
    if (!src) return null;

    const sw = src.videoWidth || src.naturalWidth || w;
    const sh = src.videoHeight || src.naturalHeight || h;
    // Cover, the same framing the compositor defaults to, so the preview is not
    // letterboxed differently from the thing it is previewing.
    const k = Math.max(w / sw, h / sh);
    try {
      c.drawImage(src, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
    } catch { return null; }
    return cv;
  };

  // Just inside each clip rather than exactly on the boundary: a frame sampled
  // precisely at the cut can land on either side of it depending on rounding.
  const eps = 1 / (store.doc.fps || 30);
  const a = await draw(j.prev, Math.max(j.prev.start, j.t - eps));
  const b = await draw(j.next, Math.min(j.next.start + j.next.duration - eps, j.t + eps));

  // Put the decoders back where the editor thinks they are. `playing` has to
  // be passed honestly: telling the compositor the transport is stopped while
  // it is running pauses every decoder, and the picture freezes while the sound
  // carries on.
  try { comp.sync?.(store.rt.playhead, store.rt.playing); comp.render(); } catch { /* fine */ }

  return { a, b, w, h };
}

/**
 * The looping player.
 *
 * One canvas, one rAF loop, and a `show()` that can be called as fast as a
 * pointer moves across a grid of tiles — switching what is being previewed must
 * not restart anything expensive, because hovering six tiles in two seconds is
 * the normal way to use this.
 */
export function createTransPreview(canvas) {
  const ctx = canvas.getContext('2d');
  let frames = null;                 // { a, b, w, h }
  let pick = null;                   // { kind, dir, name }
  let dur = 0.45;
  let raf = 0, t0 = 0;
  let running = false;

  const HOLD_IN = 0.35, HOLD_OUT = 0.55;   // seconds of still either side

  function setFrames(f) {
    frames = f && (f.a || f.b) ? f : null;
    resize();
    if (!frames) draw(0);
  }

  function resize() {
    const w = frames?.w || 480;
    const h = frames?.h || 270;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  /** Start (or switch) the loop. `null` parks on the first frame. */
  function show(nextPick, nextDur) {
    pick = nextPick;
    dur = Math.max(0.15, nextDur || 0.45);
    t0 = performance.now();
    if (!pick) { stop(); draw(0); return; }
    if (!running) { running = true; raf = requestAnimationFrame(tick); }
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function tick(now) {
    if (!running) return;
    const cycle = HOLD_IN + dur + HOLD_OUT;
    const at = ((now - t0) / 1000) % cycle;
    const raw = at < HOLD_IN ? 0
      : at > HOLD_IN + dur ? 1
        : (at - HOLD_IN) / dur;
    draw(raw);
    raf = requestAnimationFrame(tick);
  }

  const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

  function draw(raw) {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, W, H);
    if (!frames) return;

    const A = frames.a, B = frames.b;
    if (!pick) { if (A) ctx.drawImage(A, 0, 0, W, H); return; }

    const plan = transitionPlan(
      { kind: pick.kind, dir: pick.dir || 'left', p: easeInOut(raw), raw }, W, H);

    if (A && plan.under > 0.001) {
      ctx.save();
      ctx.globalAlpha = plan.under;
      if (plan.udx || plan.udy) ctx.translate(plan.udx, plan.udy);
      ctx.drawImage(A, 0, 0, W, H);
      ctx.restore();
    }
    if (B && plan.over > 0.001) {
      ctx.save();
      ctx.globalAlpha = plan.over;
      if (plan.dx || plan.dy) ctx.translate(plan.dx, plan.dy);
      ctx.drawImage(B, 0, 0, W, H);
      ctx.restore();
    }
  }

  return {
    setFrames, show, stop,
    get hasFrames() { return !!frames; },
    /** What was actually captured. Exposed so a test can tell a real pair of
     *  frames from a preview that quietly fell back to one, or to none. */
    get captured() { return { a: !!frames?.a, b: !!frames?.b }; },
  };
}
