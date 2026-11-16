import { assets } from '../media/asset-store.js';
import { bus } from '../core/events.js';

/**
 * Looking at the picture: small greyscale samples of a clip's frames, and
 * the two jobs built on them — auto-vertical (a 9:16 frame that follows the
 * action across a 16:9 recording) and stabilize (taking the shake out of a
 * handheld clip). Both write ordinary position keyframes, so the result is
 * visible on the keyframe strip and can be nudged by hand.
 */

const SW = 160, SH = 90;

/** Grey 160×90 samples of an asset at the given source times (seconds). */
export async function sampleFrames(asset, times, onProgress = () => {}, width = SW) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true;
  v.crossOrigin = 'anonymous';           // or the pixels cannot be read back
  v.src = asset.url;
  await new Promise((res, rej) => {
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', () => rej(new Error('could not open the video')), { once: true });
  });
  const ar = (v.videoWidth || 16) / (v.videoHeight || 9);
  const w = width, h = Math.max(8, Math.round(width / ar));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const t = Math.max(0, Math.min((v.duration || times[i]) - 0.02, times[i]));
    await new Promise((res) => {
      const done = () => { v.removeEventListener('seeked', done); res(); };
      v.addEventListener('seeked', done);
      v.currentTime = t;
      setTimeout(done, 1500);
    });
    g.drawImage(v, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const grey = new Float32Array(w * h);
    for (let p = 0, q = 0; p < d.length; p += 4, q++) grey[q] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    out.push({ t: times[i], grey, w, h });
    onProgress((i + 1) / times.length);
  }
  v.removeAttribute('src'); v.load();
  return out;
}

/** Times spread over a clip's footage, at most `max`, `step` apart. */
function timesFor(clip, step, max) {
  const sp = clip.speed || 1;
  const a = clip.inPoint, b = clip.inPoint + clip.duration * sp;
  const n = Math.max(2, Math.min(max, Math.floor((b - a) / step) + 1));
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/** How far across the picture a clip in `fit: cover` can slide, as fractions of the frame width/height. */
function coverGeometry(asset, doc, scale = 1) {
  const sw = asset.width || 1920, sh = asset.height || 1080;
  const W = doc.width, H = doc.height;
  const k = Math.max(W / sw, H / sh) * scale;
  return { dw: (sw * k) / W, dh: (sh * k) / H };       // displayed size as multiples of the frame
}

const smooth = (xs, r) => xs.map((_, i) => {
  let s = 0, n = 0;
  for (let j = Math.max(0, i - r); j <= Math.min(xs.length - 1, i + r); j++) { s += xs[j]; n++; }
  return s / n;
});

/**
 * Auto-vertical: where the action is, column by column, over time.
 *
 * Action = what changes between samples (movement), plus a little of where
 * the detail is (edges), so a still scoreboard does not win over a moving
 * player. The centre of that, smoothed and speed-limited, is where the
 * narrow frame looks.
 */
export async function autoReframe({ store, cmds, clipId }) {
  const found = store.doc.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
  const asset = found && assets.get(found.assetId);
  if (!found || !asset?.url) return { ok: false, reason: 'Select a video clip first.' };
  const geo = coverGeometry(asset, store.doc);
  if (geo.dw < 1.05) return { ok: false, reason: 'The clip already fits the frame side to side — switch the project to 9:16 first.' };
  bus.emit('toast', { msg: 'Finding the action…', key: 'analyse', ms: 60000 });
  const times = timesFor(found, 0.33, 180);
  const frames = await sampleFrames(asset, times, (p) => bus.emit('toast', { msg: `Finding the action… ${Math.round(p * 100)}%`, key: 'analyse', ms: 60000 }));
  const centres = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], prev = frames[Math.max(0, i - 1)], next = frames[Math.min(frames.length - 1, i + 1)];
    const { w, h } = f;
    const col = new Float32Array(w);
    for (let y = 2; y < h - 2; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const motion = Math.abs(f.grey[p] - prev.grey[p]) + Math.abs(next.grey[p] - f.grey[p]);
        const edge = Math.abs(f.grey[p + 1] - f.grey[p - 1]);
        col[x] += motion + 0.15 * edge;
      }
    }
    // The strongest stretch of columns as wide as the narrow frame.
    const win = Math.max(3, Math.round(w / geo.dw));
    let best = 0, bestX = w / 2, run = 0;
    for (let x = 0; x < w; x++) {
      run += col[x] - (x >= win ? col[x - win] : 0);
      if (x >= win - 1 && run > best) { best = run; bestX = x - win / 2 + 0.5; }
    }
    centres.push(bestX / w);
  }
  // Smooth, then limit how fast the frame may pan (a third of the picture a second).
  let path = smooth(smooth(centres, 2), 2);
  const dt = times.length > 1 ? (times[1] - times[0]) / (found.speed || 1) : 1;
  const maxStep = 0.33 * dt;
  for (let i = 1; i < path.length; i++) path[i] = path[i - 1] + Math.max(-maxStep, Math.min(maxStep, path[i] - path[i - 1]));
  const lim = (geo.dw - 1) / 2;
  const keys = path.map((u, i) => ({
    t: +((times[i] - found.inPoint) / (found.speed || 1)).toFixed(4),
    v: +Math.max(0.5 - lim, Math.min(0.5 + lim, 0.5 - (u - 0.5) * geo.dw)).toFixed(4),
    e: 'ease',
  }));
  cmds.batch('Auto-vertical', () => {
    cmds.setClipProp(found.id, 'fit', 'cover', { merge: false, label: 'Auto-vertical' });
    cmds.setClipProp(found.id, 'transform', { ...found.transform, scale: 1, y: 0.5 }, { merge: false, label: 'Auto-vertical' });
    cmds.setKeyTracks(found.id, { 'transform.x': keys }, { clear: ['transform.x', 'transform.scale', 'transform.y'], label: 'Auto-vertical' });
  });
  bus.emit('toast', { msg: 'The frame now follows the action — nudge any diamond on the keyframe strip to adjust', kind: 'ok', key: 'analyse', ms: 4200 });
  return { ok: true, keys: keys.length };
}

/** Best (dx, dy) in sample pixels that lines frame b up with frame a. */
function shiftBetween(a, b, R = 6) {
  const { w, h } = a;
  let best = Infinity, bx = 0, by = 0;
  const x0 = R + 4, x1 = w - R - 4, y0 = R + 3, y1 = h - R - 3;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      let s = 0;
      for (let y = y0; y < y1; y += 2) {
        const ra = y * w, rb = (y + dy) * w + dx;
        for (let x = x0; x < x1; x += 2) s += Math.abs(a.grey[ra + x] - b.grey[rb + x]);
      }
      if (s < best) { best = s; bx = dx; by = dy; }
    }
  }
  return { dx: bx, dy: by };
}

/**
 * Stabilize: follow the shake, keep only the smooth part of the camera's
 * path, and move the picture the other way by the difference — zoomed in a
 * touch so no edge ever shows.
 */
export async function stabilizeClip({ store, cmds, clipId, zoom = 1.1 }) {
  const found = store.doc.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
  const asset = found && assets.get(found.assetId);
  if (!found || !asset?.url) return { ok: false, reason: 'Select a video clip first.' };
  const times = timesFor(found, 1 / 12, 480);
  bus.emit('toast', { msg: 'Measuring the shake…', key: 'analyse', ms: 60000 });
  const frames = await sampleFrames(asset, times, (p) => bus.emit('toast', { msg: `Measuring the shake… ${Math.round(p * 100)}%`, key: 'analyse', ms: 60000 }));
  const px = [0], py = [0];
  for (let i = 1; i < frames.length; i++) {
    const s = shiftBetween(frames[i - 1], frames[i]);
    px.push(px[i - 1] + s.dx); py.push(py[i - 1] + s.dy);
  }
  const r = Math.max(2, Math.round(frames.length / Math.max(1, times.at(-1) - times[0]) * 0.6));
  const sx = smooth(smooth(px, r), r), sy = smooth(smooth(py, r), r);
  const geo = coverGeometry(asset, store.doc, zoom);
  const { w, h } = frames[0];
  const keysX = [], keysY = [];
  const base = { x: found.transform.x ?? 0.5, y: found.transform.y ?? 0.5 };
  const maxX = (geo.dw - 1) / 2, maxY = (geo.dh - 1) / 2;
  for (let i = 0; i < frames.length; i++) {
    // Content moved by +d sample px means the camera moved by −d: shift it back.
    const cx = ((sx[i] - px[i]) / w) * geo.dw * -1;
    const cy = ((sy[i] - py[i]) / h) * geo.dh * -1;
    const t = +((times[i] - found.inPoint) / (found.speed || 1)).toFixed(4);
    keysX.push({ t, v: +(base.x + Math.max(-maxX, Math.min(maxX, -cx))).toFixed(5), e: 'linear' });
    keysY.push({ t, v: +(base.y + Math.max(-maxY, Math.min(maxY, -cy))).toFixed(5), e: 'linear' });
  }
  cmds.batch('Stabilize', () => {
    cmds.setClipProp(found.id, 'transform', { ...found.transform, scale: (found.transform.scale || 1) * zoom }, { merge: false, label: 'Stabilize' });
    cmds.setKeyTracks(found.id, { 'transform.x': keysX, 'transform.y': keysY }, { clear: ['transform.x', 'transform.y'], label: 'Stabilize' });
  });
  const shake = Math.max(...px.map((v, i) => Math.abs(v - sx[i]))) / w;
  bus.emit('toast', { msg: shake < 0.004 ? 'That clip was already steady — only a small correction was needed' : 'Stabilized — the picture is zoomed in 10% so no edges show', kind: 'ok', key: 'analyse', ms: 4200 });
  return { ok: true, shake };
}
