import { assets } from '../../media/asset-store.js';
import { paintTransition, kindOf } from '../../engine/transition-fx.js';

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
 * `paintTransition` is the same function the compositor and the exporter use, so
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
      img.crossOrigin = 'anonymous';
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
 * Two made-up shots, for when no cut is picked: a warm one and a cool one, with
 * enough in them (ground, sun, shapes, a big letter) that movement reads.
 */
let demo = null;
export function demoFrames() {
  if (demo) return demo;
  const w = 480, h = 270;
  const shot = (sky, ground, sun, letter, seed) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const s = g.createLinearGradient(0, 0, 0, h * 0.75); s.addColorStop(0, sky[0]); s.addColorStop(1, sky[1]);
    g.fillStyle = s; g.fillRect(0, 0, w, h);
    g.fillStyle = sun; g.beginPath(); g.arc(w * (seed ? 0.26 : 0.74), h * 0.36, 34, 0, 7); g.fill();
    let r = 7 + seed * 91;
    const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
    for (let l = 0; l < 3; l++) {
      g.fillStyle = ground[l];
      for (let x = -20; x < w; ) { const bw = 18 + rnd() * 46, bh = 24 + rnd() * (90 - l * 18); g.fillRect(x, h * (0.66 + l * 0.11) - bh, bw, h); x += bw + (l ? 0 : 4); }
    }
    g.fillStyle = 'rgba(255,255,255,.92)'; g.font = '900 96px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(letter, w / 2, h * 0.52);
    return c;
  };
  demo = { a: shot(['#ff9a3d', '#ffd98a'], ['#8a3b12', '#5f2509', '#351205'], '#fff3d0', 'A', 0),
    b: shot(['#142a6b', '#3fa7c9'], ['#15406b', '#0d2a4a', '#071829'], '#dff6ff', 'B', 1), w, h, demo: true };
  return demo;
}

/** One moment of a transition, on a canvas of any size. */
export function drawMoment(canvas, frames, tr, raw, lite = true) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.filter = 'none'; g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#05070d'; g.fillRect(0, 0, W, H);
  const A = frames?.a, B = frames?.b;
  if (!A && !B) return;
  if (!tr || !A || !B) { g.drawImage(raw < 0.5 ? (A || B) : (B || A), 0, 0, W, H); return; }
  paintTransition(g, A, B, { ...tr, raw }, W, H, { lite });
}

/**
 * The looping player.
 *
 * One canvas, one rAF loop, and a `show()` that can be called as fast as a
 * pointer moves across a grid of tiles.
 */
export function createTransPreview(canvas) {
  let frames = null;                 // { a, b, w, h }
  let tr = null;                     // { kind, dir, amount, ease, color }
  let dur = 0.45;
  let raf = 0, t0 = 0;
  let running = false;

  const HOLD_IN = 0.35, HOLD_OUT = 0.55;   // seconds of still either side

  function setFrames(f) {
    frames = f && (f.a || f.b) ? f : null;
    const w = frames?.w || 480, h = frames?.h || 270;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (!running) drawMoment(canvas, frames, null, 0);
  }

  /** Start (or switch) the loop. `null` parks on the first frame. Same transition: keeps rolling. */
  function show(next, nextDur) {
    const same = tr && next && tr.kind === next.kind;
    tr = next;
    // A touch slower than life, so a quarter-second whip can be seen.
    dur = Math.max(0.35, (nextDur || kindOf(next?.kind)?.d?.dur || 0.45) * 1.25);
    if (!same) t0 = performance.now();
    if (!tr) { stop(); drawMoment(canvas, frames, null, 0); return; }
    if (!running) { running = true; raf = requestAnimationFrame(tick); }
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function tick(now) {
    if (!running) return;
    const at = ((now - t0) / 1000) % (HOLD_IN + dur + HOLD_OUT);
    drawMoment(canvas, frames, tr, at < HOLD_IN ? 0 : at > HOLD_IN + dur ? 1 : (at - HOLD_IN) / dur, false);
    raf = requestAnimationFrame(tick);
  }

  return {
    setFrames, show, stop,
    get hasFrames() { return !!frames; },
    get frames() { return frames; },
    /** What was actually captured. Exposed so a test can tell a real pair of
     *  frames from a preview that quietly fell back to one, or to none. */
    get captured() { return { a: !!frames?.a, b: !!frames?.b }; },
  };
}
