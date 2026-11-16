/**
 * Looking at the picture: small greyscale samples of a clip's frames.
 *
 * Smart crop (find what stays still, click-to-select, follow the crop) is built on these
 * samples. Auto-vertical and Stabilize used to live in this file too; they were
 * removed in 3.0 (the original is kept in _removed-for-3.0/).
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
