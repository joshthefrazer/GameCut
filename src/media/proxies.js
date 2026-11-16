import { assets } from './asset-store.js';
import { bus } from '../core/events.js';
import { makeClip, makeTrack } from '../core/schema.js';

/**
 * Smooth 4K preview: light stand-in copies of heavy clips.
 *
 * Decoding a 1440p or 4K recording is what makes the preview stutter on a
 * weaker PC, and no preview-quality setting helps with that — the decoder
 * still has to unpack every full-size frame. So heavy clips get a 540p copy
 * (made with the same renderer as an export, into Strike's own cache
 * folder), and the PREVIEW plays that. Export always reads the original.
 *
 * A copy is found again by the original's path, size and date, so it is made
 * once and reused by every project that uses the file.
 */
const HEAVY_W = 2400;

export const isHeavy = (a) => a?.kind === 'video' && (a.width >= HEAVY_W || a.height >= HEAVY_W);

/** Attach an existing copy to the asset, if one was made before. */
export async function findProxy(asset) {
  const api = window.gamecut?.proxies;
  if (!api || !asset?.path || asset.kind !== 'video') return false;
  try {
    const r = await api.find(asset.path);
    if (r?.found && r.mediaId) {
      assets.update(asset.id, { proxyUrl: `gcmedia://${r.mediaId}` });
      return true;
    }
  } catch { /* no bridge: nothing to find */ }
  return false;
}

const running = new Map();

/** Make the 540p copy. Resolves true when it is in use. */
export function makeProxy(asset, { store, comp } = {}) {
  if (running.has(asset.id)) return running.get(asset.id);
  const job = (async () => {
    const api = window.gamecut?.proxies, xs = window.gamecut?.exportSink;
    if (!api?.open || !xs || !asset.path) throw new Error('This file cannot get a copy (it was not opened from a folder).');
    const { renderToMp4 } = await import('../export/render-export.js');
    const ar = (asset.width || 16) / (asset.height || 9);
    const h = 540, w = Math.round((h * ar) / 2) * 2;
    const dur = asset.duration;
    const clip = makeClip('video', {
      assetId: asset.id, start: 0, duration: dur, sourceDuration: dur, fit: 'contain', silent: true, muted: true,
    });
    const track = makeTrack('video', 'Video 1');
    track.clips.push(clip);
    clip.trackId = track.id;
    const doc = { id: 'proxy', name: 'proxy', fps: 30, width: w, height: h, aspect: '16:9', bg: '#000', bpm: 120, beatOffset: 0, tracks: [track], markers: [], assets: [] };
    const shadow = Object.create(store);
    shadow.doc = doc;
    shadow.rt = { ...store.rt, duration: dur, playing: false };
    const d = await api.open(asset.path);
    try {
      const r = await renderToMp4({
        store: shadow, width: w, height: h, fps: 30, vBitrate: 2_500_000, aBitrate: 96_000,
        sink: { write: (chunk, position) => xs.write(d.token, chunk, position) },
        shouldCancel: () => false,
        onProgress: (e) => { if (typeof e.percent === 'number') bus.emit('proxy:progress', { id: asset.id, percent: e.percent }); },
      });
      if (!r) throw new Error('cancelled');
      const c = await xs.close(d.token);
      if (!c?.ok) throw new Error(c?.reason || 'could not save the copy');
    } catch (e) {
      await xs.abort(d.token).catch(() => {});
      throw e;
    }
    await findProxy(asset);
    // Decoders opened on the original reopen on the copy.
    comp?.pool?.disposeAll?.();
    comp?.render?.();
    bus.emit('assets');
    return true;
  })().finally(() => running.delete(asset.id));
  running.set(asset.id, job);
  return job;
}

/**
 * Wire it up: look for copies whenever media arrives, and offer to make one
 * for heavy footage the first time it shows up.
 */
export function initProxies({ store, comp }) {
  comp.pool.useProxies = true;
  const offered = new Set();
  const look = async () => {
    for (const a of assets.all()) {
      if (a.kind !== 'video' || a.proxyUrl || a.missing || offered.has(a.id)) continue;
      offered.add(a.id);
      if (await findProxy(a)) { comp.pool.disposeAll?.(); comp.render(); continue; }
      if (isHeavy(a) && a.path) {
        bus.emit('toast', {
          msg: `${a.name} is ${a.height >= 2000 ? '4K' : '1440p'} — make a light copy so the preview plays smoothly? (Your export still uses the original.)`,
          ms: 12000,
          action: { label: 'Make it', run: () => startProxy(a) },
        });
      }
    }
  };
  function startProxy(a) {
    bus.emit('toast', { msg: `Making a smooth-editing copy of ${a.name}…`, key: 'proxy' + a.id, ms: 4000 });
    makeProxy(a, { store, comp })
      .then(() => bus.emit('toast', { msg: `${a.name} now previews from a light copy — playback should be smooth`, kind: 'ok', key: 'proxy' + a.id }))
      .catch((e) => bus.emit('toast', { msg: `Could not make the copy: ${e.message}`, kind: 'err', key: 'proxy' + a.id }));
  }
  bus.on('assets', () => { look(); });
  bus.emit('palette:add', [{
    id: 'proxies', name: 'Make smooth-editing copies of big (1440p / 4K) clips', sec: 'Media',
    run: () => {
      const list = assets.all().filter(a => isHeavy(a) && !a.proxyUrl && a.path);
      if (!list.length) { bus.emit('toast', { msg: 'No 1440p or 4K clips need a copy.' }); return; }
      for (const a of list) startProxy(a);
    },
  }]);
  return { makeProxy: (a) => makeProxy(a, { store, comp }), findProxy, startProxy };
}
