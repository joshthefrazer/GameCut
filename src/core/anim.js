/**
 * Small tweens for interface state.
 *
 * Not for anything the compositor draws — a clip's animation is keyframes and
 * lives in the document. This is for the editor itself: the timeline sliding to
 * keep up with the playhead, a zoom that arrives instead of teleporting. Those
 * movements are what makes an editor feel like an object rather than a form,
 * and the cost is a handful of rAF ticks.
 *
 * Everything here checks the machine's reduced-motion setting and, when it is
 * on, jumps straight to the end. That is not a token gesture: people who turn
 * it on are often people for whom sliding panels are genuinely unpleasant, and
 * an editor is a thing you sit in front of for hours.
 */

export const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};

export const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
export const easeInOutCubic = (p) =>
  (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/**
 * Run `onStep(value)` from `from` to `to` over `ms`.
 *
 * Returns a cancel function. Starting a new tween on the same handle should
 * cancel the old one — two tweens fighting over one number is the classic way
 * a smooth interface becomes a juddering one.
 */
export function tween({ from, to, ms = 200, ease = easeOutCubic, onStep, onDone }) {
  if (from === to || !(ms > 0) || prefersReducedMotion()) {
    onStep?.(to);
    onDone?.();
    return () => {};
  }
  let raf = 0;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    onStep?.(from + (to - from) * ease(p));
    if (p < 1) raf = requestAnimationFrame(step);
    else { raf = 0; onDone?.(); }
  };
  raf = requestAnimationFrame(step);
  return () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
}

/**
 * A tween holder that only ever has one animation in flight.
 *
 * `run(from, to, opts)` cancels whatever was running and starts again from
 * wherever it had got to, which is what makes repeated presses of a zoom button
 * feel continuous rather than like a series of competing lurches.
 */
export function makeTweener() {
  let cancel = () => {};
  return {
    run(opts) { cancel(); cancel = tween(opts); },
    stop() { cancel(); cancel = () => {}; },
  };
}
