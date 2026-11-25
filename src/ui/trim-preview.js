import { bus } from '../core/events.js';
import { assets } from '../media/asset-store.js';
import { openVideo, seekTo } from '../media/filmstrip.js';

/**
 * While you drag a cut: the last picture before it and the first one after, side by
 * side, so you cut on what you see rather than on where the line is.
 */
export function initTrimPreview({ store }) {
  const el = document.createElement('div');
  el.className = 'trimv'; el.id = 'trimPreview'; el.hidden = true;
  el.innerHTML = '<figure data-side="a"><canvas width="240" height="135"></canvas><figcaption>Last frame</figcaption></figure><figure data-side="b"><canvas width="240" height="135"></canvas><figcaption>First frame</figcaption></figure>';
  document.body.appendChild(el);
  const side = (k) => ({ fig: el.querySelector(`[data-side="${k}"]`), cv: el.querySelector(`[data-side="${k}"] canvas`), video: null, asset: null, want: null, busy: false });
  const S = { a: side('a'), b: side('b') };
  let shownFor = 0;

  async function feed(s) {
    if (s.busy) return;
    s.busy = true;
    const id = shownFor;
    try {
      while (s.want && shownFor === id) {
        const { asset, t } = s.want; s.want = null;
        if (s.asset !== asset.id) { if (s.video) { s.video.removeAttribute('src'); s.video.load(); } s.video = openVideo(asset); s.asset = asset.id; }
        try { await seekTo(s.video, t, 2500); } catch { continue; }
        if (shownFor !== id || !s.video.videoWidth) break;
        const h = Math.min(240, Math.round(240 * s.video.videoHeight / s.video.videoWidth));
        if (s.cv.height !== h) s.cv.height = h;
        s.cv.getContext('2d').drawImage(s.video, 0, 0, 240, h);
        s.fig.classList.remove('is-wait');
      }
    } finally { s.busy = false; if (s.want && shownFor) feed(s); }
  }
  function put(s, clip, last) {
    const asset = clip && assets.get(clip.assetId);
    s.fig.hidden = !clip || (clip.type !== 'video' && clip.type !== 'image') || !asset;
    if (s.fig.hidden) return;
    if (clip.type === 'image') {
      const img = new Image(); img.onload = () => { const h = Math.min(240, Math.round(240 * img.height / img.width)); s.cv.height = h; s.cv.getContext('2d').drawImage(img, 0, 0, 240, h); s.fig.classList.remove('is-wait'); };
      img.src = asset.thumb || asset.url; return;
    }
    const t = last ? clip.inPoint + clip.duration * (clip.speed || 1) - 1 / (store.doc.fps || 30) : clip.inPoint;
    s.want = { asset, t: Math.max(0.001, Math.min((asset.duration || t + 1) - 0.01, t)) };
    feed(s);
  }
  bus.on('trim:show', ({ clipId, edge, x, y }) => {
    const track = store.doc.tracks.find(k => k.clips.some(c => c.id === clipId));
    const clip = track?.clips.find(c => c.id === clipId);
    if (!clip || (clip.type !== 'video' && clip.type !== 'image')) return;
    if (!shownFor) { shownFor = performance.now(); for (const s of Object.values(S)) s.fig.classList.add('is-wait'); }
    const at = edge === 'in' ? clip.start : clip.start + clip.duration;
    const gap = 1.5 / (store.doc.fps || 30);
    const before = edge === 'in' ? track.clips.find(c => c.id !== clip.id && Math.abs(c.start + c.duration - at) < gap) : clip;
    const after = edge === 'in' ? clip : track.clips.find(c => c.id !== clip.id && Math.abs(c.start - at) < gap);
    put(S.a, before, true); put(S.b, after, false);
    el.hidden = S.a.fig.hidden && S.b.fig.hidden;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
    el.style.top = Math.max(8, y - h - 28) + 'px';
  });
  bus.on('trim:hide', () => {
    el.hidden = true; shownFor = 0;
    for (const s of Object.values(S)) { s.want = null; if (s.video) { s.video.removeAttribute('src'); s.video.load(); s.video = null; s.asset = null; } }
  });
}
