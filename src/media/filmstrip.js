/**
 * The real pictures along a clip.
 *
 * Small stills of a recording, made while nothing else is going on: never during
 * playback, an export or a drag. The timeline asks for the moment each tile shows;
 * it gets that picture, or the nearest one there is, and is repainted when more come.
 */
import { bus } from '../core/events.js';
import { assets } from './asset-store.js';

const W = 112, KEEP = 700;
const tiles = new Map();            // "asset@seconds" -> canvas (null: could not be read). Oldest first.
const want = new Map();             // same key -> { asset, t, at }
const readers = new Map();          // assetId -> { video, used }
const bad = new Set();              // assets that could not be read
let working = false, told = 0, quiet = () => true, on = true, paintedAt = 0;

export function initFilmstrip({ store }) {
  quiet = () => !store.rt.playing && !store.rt.exporting && !store.rt.dragging;
  setInterval(() => {
    const now = performance.now();
    for (const [id, r] of readers) if (now - r.used > 20000) { drop(r.video); readers.delete(id); }
    if (want.size) work();
  }, 1000);
}
export const setFilmstrips = (v) => { on = v; if (!v) { want.clear(); for (const r of readers.values()) drop(r.video); readers.clear(); } };
export const filmstripStats = () => ({ tiles: [...tiles.values()].filter(Boolean).length, waiting: want.size, readers: readers.size });

/** Seconds between tiles, as a power of two so zooming reuses what is there. */
export const stepFor = (tileSeconds) => Math.max(0.25, 2 ** Math.floor(Math.log2(Math.max(0.25, tileSeconds))));

/** The picture for source time `t`. Asks for it if it is not there yet. */
export function tileAt(asset, t, step) {
  if (!on || asset.missing || bad.has(asset.id) || !(asset.proxyUrl || asset.url)) return null;
  const at = Math.max(0, Math.min((asset.duration || 0) - 0.05, Math.floor(t / step) * step));
  const key = asset.id + '@' + at.toFixed(2);
  paintedAt = performance.now();
  if (tiles.has(key)) {
    const c = tiles.get(key);
    tiles.delete(key); tiles.set(key, c);      // used: newest
    if (c) return c;
  } else if (want.has(key)) want.get(key).at = paintedAt;
  else { want.set(key, { asset, t: at, at: paintedAt }); work(); }
  for (let s = step * 2; s <= 256; s *= 2) { const c = tiles.get(asset.id + '@' + (Math.floor(t / s) * s).toFixed(2)); if (c) return c; }
  return null;
}

function drop(v) { try { v.removeAttribute('src'); v.load(); } catch { /* gone */ } }
export function openVideo(asset) {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'auto'; v.playsInline = true;
  v.src = asset.proxyUrl || asset.url;
  return v;
}
/** Seek and wait for the picture. Rejects after `ms`. */
export function seekTo(v, t, ms = 4000) {
  return new Promise((resolve, reject) => {
    const end = (fn) => { clearTimeout(timer); v.removeEventListener('seeked', ok); v.removeEventListener('error', no); v.removeEventListener('loadeddata', go); fn(); };
    const ok = () => end(resolve), no = () => end(() => reject(new Error('cannot read')));
    const go = () => { if (Math.abs(v.currentTime - t) < 0.001 && !v.seeking) ok(); else v.currentTime = t; };
    const timer = setTimeout(no, ms);
    v.addEventListener('seeked', ok); v.addEventListener('error', no);
    if (v.readyState >= 2) go(); else v.addEventListener('loadeddata', go);
  });
}

async function work() {
  if (working) return;
  working = true;
  try {
    while (want.size && on) {
      if (!quiet()) break;
      let key = null, w = null;
      for (const [k, x] of want) {
        if (paintedAt - x.at > 3000 || bad.has(x.asset.id) || assets.get(x.asset.id) !== x.asset) { want.delete(k); continue; }       // scrolled away
        if (!w) { key = k; w = x; }                                      // left to right, as asked
      }
      if (!w) break;
      want.delete(key);
      let r = readers.get(w.asset.id);
      if (!r) {
        while (readers.size >= 2) { const [id, old] = [...readers].sort((a, b) => a[1].used - b[1].used)[0]; drop(old.video); readers.delete(id); }
        r = { video: openVideo(w.asset), used: 0 };
        readers.set(w.asset.id, r);
      }
      r.used = performance.now();
      let c = null;
      try {
        await seekTo(r.video, Math.max(0.02, w.t));
        r.ok = true;
        c = document.createElement('canvas');
        c.width = W; c.height = Math.max(8, Math.round(W * (r.video.videoHeight || 9) / (r.video.videoWidth || 16)));
        c.getContext('2d').drawImage(r.video, 0, 0, c.width, c.height);
      } catch { c = null; drop(r.video); readers.delete(w.asset.id); if (!r.ok) bad.add(w.asset.id); }
      tiles.set(key, c);
      while (tiles.size > KEEP) tiles.delete(tiles.keys().next().value);
      const now = performance.now();
      if (now - told > 160 || !want.size) { told = now; bus.emit('filmstrip'); }
      await new Promise(r2 => setTimeout(r2, 12));                        // room for the editor
    }
  } finally { working = false; }
}
// A closed project's files are let go of at once.
assets.on('change', () => { for (const [id, r] of readers) if (!assets.get(id)) { drop(r.video); readers.delete(id); } });
bus.on('home:request', () => { tiles.clear(); want.clear(); for (const r of readers.values()) drop(r.video); readers.clear(); });
