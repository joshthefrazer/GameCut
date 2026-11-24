/**
 * Looking at the picture: small greyscale samples of a clip's frames.
 *
 * Smart crop (find what stays still, click-to-select, follow the crop) is built on these
 * samples. Auto-vertical and Stabilize used to live in this file too; they were
 * removed in 3.0 (the original is kept in _removed-for-3.0/).
 */

const SW = 160, SH = 90;

/**
 * Grey 160×90 samples of an asset at the given source times (seconds).
 *
 * Exact frames first: the export's frame reader (WebCodecs) decodes the very
 * frame at each time. The hidden <video> fallback can hand back the previous
 * frame right after a jump, which made Follow drift now and then.
 */
export async function sampleFrames(asset, times, onProgress = () => {}, width = SW) {
  const exact = await sampleExact(asset, times, onProgress, width).catch(() => null);
  if (exact) return exact;
  return sampleWithPlayer(asset, times, onProgress, width);
}

async function sampleExact(asset, times, onProgress, width) {
  const { Mp4FrameReader } = await import('../export/frame-reader.js');
  const r = await Mp4FrameReader.open(asset);
  if (!r) return null;
  try {
    let c = null, g = null, w = 0, h = 0;
    const out = [];
    for (let i = 0; i < times.length; i++) {
      const f = await r.frameAt(Math.max(0, times[i]));
      if (!f) return null;
      if (!c) {
        const ar = (f.displayWidth || 16) / (f.displayHeight || 9);
        w = width; h = Math.max(8, Math.round(width / ar));
        c = document.createElement('canvas'); c.width = w; c.height = h;
        g = c.getContext('2d', { willReadFrequently: true });
      }
      g.drawImage(f, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      const grey = new Float32Array(w * h);
      for (let p = 0, q = 0; p < d.length; p += 4, q++) grey[q] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      out.push({ t: times[i], grey, w, h, stale: false });
      onProgress((i + 1) / times.length);
    }
    return out;
  } finally {
    r.close();
  }
}

async function sampleWithPlayer(asset, times, onProgress = () => {}, width = SW) {
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
    // A busy computer can take seconds per jump. Each one used to get 1.5 s, and
    // when that ran out the picture drawn was whatever was showing (an older
    // frame), so Follow chased the wrong frame and lost the thing it was on.
    // Now: wait properly, retry once, and say when a frame could not be had.
    const ok = await seekTo(v, t, 4000) || await seekTo(v, t, 6000);
    g.drawImage(v, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const grey = new Float32Array(w * h);
    for (let p = 0, q = 0; p < d.length; p += 4, q++) grey[q] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    // `stale`: this picture may not be the frame at `t`; a tracker should hold still on it.
    out.push({ t: times[i], grey, w, h, stale: !ok });
    onProgress((i + 1) / times.length);
  }
  v.removeAttribute('src'); v.load();
  return out;
}

/**
 * Move a <video> to `t` and wait until that frame is really there.
 * True when it arrived within `ms`; false if it did not (the caller decides).
 */
function seekTo(v, t, ms) {
  return new Promise((res) => {
    let settled = false, timer = 0;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeEventListener('seeked', onSeeked);
      res(ok);
    };
    const onSeeked = () => {
      if (Math.abs(v.currentTime - t) > 0.06) return;       // an earlier jump finishing late
      // The frame has been decoded once the element says it has data for it.
      if (v.readyState >= 2) { finish(true); return; }
      const poll = () => { if (settled) return; if (v.readyState >= 2) finish(true); else setTimeout(poll, 30); };
      poll();
    };
    v.addEventListener('seeked', onSeeked);
    timer = setTimeout(() => finish(false), ms);
    if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2 && !v.seeking) { finish(true); return; }
    v.currentTime = t;
  });
}
