import { bus } from '../core/events.js';
import { assets } from '../media/asset-store.js';

/**
 * Freeze frame — "pause the video here and keep it paused".
 *
 * Grabs the exact frame under the playhead from each video clip there, keeps it
 * as a real PNG file (so a saved project still has it tomorrow), and has the
 * timeline cut, insert the still and push the rest later (commands.insertFreeze)
 * as a single undo step. The still copies the clip's crop, fit, effects and
 * position, so the pause looks like the video simply stopped.
 */

const DEFAULT_HOLD = 2;

function once(el, ok, ms = 10000) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); el.removeEventListener(ok, done); el.removeEventListener('error', fail); resolve(); };
    const fail = () => { clearTimeout(timer); el.removeEventListener(ok, done); el.removeEventListener('error', fail); reject(new Error('That video could not be read')); };
    const timer = setTimeout(() => { el.removeEventListener(ok, done); el.removeEventListener('error', fail); reject(new Error('That video took too long to load')); }, ms);
    el.addEventListener(ok, done);
    el.addEventListener('error', fail);
  });
}

/** One frame of a video file at `sec`, full size, as PNG bytes. */
export async function grabFrame(url, sec) {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    if (v.readyState < 2) await once(v, 'loadeddata');
    const end = Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.02) : sec;
    const at = Math.min(Math.max(0, sec), end);
    if (Math.abs(v.currentTime - at) > 1e-3) {
      const seeked = once(v, 'seeked');
      v.currentTime = at;
      await seeked;
    }
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('That video has no picture to freeze');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    if (!blob) throw new Error('That frame could not be saved');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), blob, w, h };
  } finally {
    v.removeAttribute('src');
    try { v.load(); } catch { /* gone */ }
  }
}

const stamp = (s) => {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}m${r.toFixed(1).padStart(4, '0')}s`;
};

/**
 * Freeze every video clip under `t` for `hold` seconds.
 * Resolves with the ids of the stills it made (empty if nothing was frozen).
 */
export async function freezeFrame({ store, cmds, t = store.rt.playhead, hold = DEFAULT_HOLD }) {
  const targets = cmds.freezeTargets(t);
  if (!targets.length) {
    bus.emit('toast', { msg: 'Put the playhead over a video clip first — that is the frame that gets frozen.' });
    return [];
  }
  bus.emit('toast', { msg: 'Freezing the frame…', key: 'freeze', ms: 8000 });
  const api = window.gamecut;
  const stills = {};
  const made = new Map();         // "asset@frame" → image asset id, so copies share one picture
  try {
    for (const { clip, t: at } of targets) {
      const asset = assets.get(clip.assetId);
      if (!asset || asset.missing || !asset.url) continue;
      const sec = (clip.inPoint || 0) + Math.max(0, at - clip.start) * (clip.speed || 1);
      const key = `${asset.id}@${sec.toFixed(4)}`;
      if (!made.has(key)) {
        const { bytes, blob, w, h } = await grabFrame(asset.url, sec);
        let url = null, path = null;
        if (api?.saveStill) {
          const r = await api.saveStill(bytes);
          url = `gcmedia://${r.id}`; path = r.path;
        } else {
          url = URL.createObjectURL(blob);
        }
        const img = assets.add({
          kind: 'image',
          name: `${asset.name.replace(/\.[^.]+$/, '')} frame ${stamp(sec)}.png`,
          url, path, bytes: bytes.byteLength,
          duration: 5, width: w, height: h, thumb: url,
        });
        made.set(key, img.id);
      }
      stills[clip.id] = made.get(key);
    }
  } catch (err) {
    bus.emit('toast', { msg: `Could not freeze that frame: ${err.message}`, kind: 'err', key: 'freeze' });
    return [];
  }
  bus.emit('assets');
  const ids = cmds.insertFreeze(t, stills, hold);
  if (ids.length) {
    bus.emit('toast', {
      msg: `Paused for ${hold}s — drag the end of the still to make the pause longer or shorter.`,
      kind: 'ok', key: 'freeze', ms: 6000,
      action: { label: 'Undo', run: () => cmds.undo() },
    });
  } else {
    bus.emit('toast', { msg: 'Nothing was frozen — that clip is locked.', key: 'freeze' });
  }
  return ids;
}
