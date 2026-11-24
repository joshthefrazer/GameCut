import { assets } from '../media/asset-store.js';
import { sampleFrames } from './frame-analysis.js';

/**
 * Follow it as it moves: keep a crop's box on the thing inside it.
 *
 * The box drawn at the playhead becomes a small greyscale template. Frame by
 * frame, forwards to the end of the clip and backwards to its start, the
 * template is looked for near where it was last seen (coarse grid, then a
 * fine pass), and is refreshed a little each time so a turning player or a
 * changing light does not lose it. Brightness is taken out of the comparison,
 * so a muzzle flash or an explosion does not drag the box away.
 *
 * The result is a path of box positions keyed by SOURCE time (see cropAt),
 * smoothed so the cut-out glides rather than jitters.
 */
const SAMPLE_W = 320;

function patch(f, x, y, w, h, stride) {
  const out = [];
  let sum = 0;
  for (let j = 0; j < h; j += stride) {
    const row = Math.min(f.h - 1, Math.max(0, y + j)) * f.w;
    for (let i = 0; i < w; i += stride) {
      const v = f.grey[row + Math.min(f.w - 1, Math.max(0, x + i))];
      out.push(v); sum += v;
    }
  }
  const mean = sum / out.length;
  for (let k = 0; k < out.length; k++) out[k] -= mean;
  return Float32Array.from(out);
}

function cost(f, tmpl, x, y, w, h, stride, bail) {
  // Zero-mean absolute difference: brightness changes do not count.
  let sum = 0, n = 0;
  for (let j = 0; j < h; j += stride) {
    const row = Math.min(f.h - 1, Math.max(0, y + j)) * f.w;
    for (let i = 0; i < w; i += stride) { sum += f.grey[row + Math.min(f.w - 1, Math.max(0, x + i))]; n++; }
  }
  const mean = sum / n;
  let d = 0, k = 0;
  for (let j = 0; j < h; j += stride) {
    const row = Math.min(f.h - 1, Math.max(0, y + j)) * f.w;
    for (let i = 0; i < w; i += stride) {
      d += Math.abs(f.grey[row + Math.min(f.w - 1, Math.max(0, x + i))] - mean - tmpl[k++]);
    }
    if (d > bail) return d;
  }
  return d;
}

function follow(frames, box, R) {
  const f0 = frames[0];
  const w = Math.max(6, Math.round(box.w * f0.w)), h = Math.max(6, Math.round(box.h * f0.h));
  const stride = Math.max(1, Math.ceil(Math.max(w, h) / 40));
  let x = Math.round(box.x * f0.w), y = Math.round(box.y * f0.h);
  let tmpl = patch(f0, x, y, w, h, stride);
  const first = Float32Array.from(tmpl);
  const out = [{ t: f0.t, x, y }];
  let vx = 0, vy = 0;
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    // A frame the sampler could not get in time: hold still (and keep heading
    // the same way) rather than chase whatever picture was left on screen.
    if (f.stale) {
      x = Math.min(f.w - w, Math.max(0, x + Math.round(vx)));
      y = Math.min(f.h - h, Math.max(0, y + Math.round(vy)));
      out.push({ t: f.t, x, y });
      continue;
    }
    // Look where it was heading, not only where it was.
    const gx = x + Math.round(vx), gy = y + Math.round(vy);
    let best = Infinity, bx = gx, by = gy;
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
      const cx = Math.min(f.w - w, Math.max(0, gx + dx)), cy = Math.min(f.h - h, Math.max(0, gy + dy));
      const c = cost(f, tmpl, cx, cy, w, h, stride, best);
      if (c < best) { best = c; bx = cx; by = cy; }
    }
    const cx0 = bx, cy0 = by;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const cx = Math.min(f.w - w, Math.max(0, cx0 + dx)), cy = Math.min(f.h - h, Math.max(0, cy0 + dy));
      const c = cost(f, tmpl, cx, cy, w, h, stride, best);
      if (c < best) { best = c; bx = cx; by = cy; }
    }
    vx = 0.6 * vx + 0.4 * (bx - x); vy = 0.6 * vy + 0.4 * (by - y);
    x = bx; y = by;
    out.push({ t: f.t, x, y });
    // Refresh the template a little, anchored to the first look so it cannot drift away entirely.
    const now = patch(f, x, y, w, h, stride);
    for (let k = 0; k < tmpl.length; k++) tmpl[k] = 0.8 * tmpl[k] + 0.12 * now[k] + 0.08 * first[k];
  }
  return out.map(p => ({ t: p.t, x: p.x / f0.w, y: p.y / f0.h }));
}

function smooth(path, k = 2) {
  return path.map((p, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(path.length - 1, i + k); j++) { sx += path[j].x; sy += path[j].y; n++; }
    return { t: Math.round(p.t * 1000) / 1000, x: sx / n, y: sy / n };
  });
}

/**
 * Track what is inside `clip.crop` through the clip.
 * `at` is the timeline time the box was drawn at (the playhead).
 */
export async function trackCrop(clip, { at, onProgress = () => {}, alive = () => true } = {}) {
  const asset = assets.get(clip.assetId);
  if (!asset || asset.kind !== 'video') throw new Error('only video can be followed');
  const c = clip.crop;
  if (!c) throw new Error('this layer is not a crop');
  const sp = clip.speed || 1;
  const a = clip.inPoint || 0, b = a + clip.duration * sp;
  const t0 = Math.min(b, Math.max(a, a + ((at ?? clip.start) - clip.start) * sp));
  const step = Math.min(0.5, Math.max(1 / 15, (b - a) / 900));
  const fwd = [], back = [];
  for (let t = t0; t <= b + 1e-6; t += step) fwd.push(t);
  for (let t = t0 - step; t >= a - 1e-6; t -= step) back.push(t);
  const R = Math.max(6, Math.min(40, Math.round(SAMPLE_W * 0.7 * step)));
  const total = fwd.length + back.length;
  const box = { x: c.x, y: c.y, w: c.w, h: c.h };

  const F = await sampleFrames(asset, fwd, (p) => onProgress(0.5 * p * fwd.length / total), SAMPLE_W);
  if (!alive()) throw new Error('cancelled');
  const ahead = follow(F, box, R);
  let behind = [];
  if (back.length) {
    const B = await sampleFrames(asset, [t0, ...back], (p) => onProgress((fwd.length + p * back.length) / total * 0.98), SAMPLE_W);
    if (!alive()) throw new Error('cancelled');
    behind = follow(B, box, R).slice(1).reverse();
  }
  onProgress(1);
  const maxX = 1 - c.w, maxY = 1 - c.h;
  return smooth([...behind, ...ahead]).map(p => ({ t: p.t, x: Math.min(maxX, Math.max(0, p.x)), y: Math.min(maxY, Math.max(0, p.y)) }));
}
