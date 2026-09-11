import { clamp } from '../../core/time.js';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 24;

/** Slider position (0..1000) <-> zoom, log-mapped so both ends feel even. */
export const zoomToSlider = (z) =>
  Math.round(1000 * (Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)));
export const sliderToZoom = (v) =>
  MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v / 1000);

/** Zoom while keeping the time under `anchorPx` pinned to the cursor. */
export function zoomAt(store, factor, anchorPx) {
  const before = store.ui.scrollX + anchorPx / store.pxPerSec;
  store.ui.zoom = clamp(store.ui.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  store.ui.scrollX = Math.max(0, before - anchorPx / store.pxPerSec);
}

/** Fit the whole project (plus 6% headroom) into `viewW` pixels. */
export function zoomFit(store, viewW) {
  const dur = Math.max(store.rt.duration, 4);
  store.ui.zoom = clamp((viewW / (dur * 1.06)) / store.ui.basePxPerSec, MIN_ZOOM, MAX_ZOOM);
  store.ui.scrollX = 0;
}
