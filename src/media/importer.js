import { assets } from './asset-store.js';
import { extractPeaks } from '../audio/waveform.js';
import { registerFontFile } from './fonts.js';
import { bus } from '../core/events.js';

const FONT_RE = /\.(ttf|otf|woff2?)$/i;

/**
 * A URL for this file that will still work tomorrow.
 *
 * A blob: URL only exists while this window does, so a project saved with one
 * could never find its footage again. On the desktop every opened file also
 * gets a `gcmedia://` id, streamed by the main process from wherever the file
 * actually lives — which is what a saved project stores. The blob is kept as a
 * fallback for anything with no path behind it.
 */
async function sourceFor(file) {
  const api = window.gamecut;
  const path = api?.pathFor?.(file) || null;
  if (path && api?.registerMedia) {
    try {
      const map = await api.registerMedia([file]);
      const id = map?.[path];
      if (id) return { url: `gcmedia://${id}`, path };
    } catch { /* fall through to the blob */ }
  }
  return { url: URL.createObjectURL(file), path };
}

/** Import a FileList / array of Files. Resolves with created asset records. */
export async function importFiles(files) {
  const out = [];
  for (const file of [...files]) {
    try {
      if (FONT_RE.test(file.name)) { out.push(await importFont(file)); continue; }
      if (file.type.startsWith('video')) { out.push(await importVideo(file)); continue; }
      if (file.type.startsWith('audio')) { out.push(await importAudio(file)); continue; }
      if (file.type.startsWith('image')) { out.push(await importImage(file)); continue; }
      bus.emit('toast', { msg: `Unsupported file: ${file.name}`, kind: 'err' });
    } catch (err) {
      console.error('import failed:', file.name, err);
      // A video that throws here almost always means the container or codec
      // isn't one this build can decode — say that, rather than "failed".
      const codecish = file.type.startsWith('video') || file.type.startsWith('audio');
      bus.emit('toast', {
        msg: codecish
          ? `Can't decode ${file.name} — try re-encoding it as H.264 MP4`
          : `Failed to import ${file.name}`,
        kind: 'err',
      });
    }
  }
  return out.filter(Boolean);
}

/* ── Video ──────────────────────────────────────────────────── */
async function importVideo(file) {
  const { url, path } = await sourceFor(file);
  const el = document.createElement('video');
  el.preload = 'metadata';
  el.muted = true;
  el.src = url;
  await once(el, 'loadedmetadata');

  const asset = assets.add({
    kind: 'video',
    name: file.name,
    file, url, path,
    duration: el.duration || 0,
    width: el.videoWidth, height: el.videoHeight,
    thumb: null,
    peaks: null,
  });

  // Thumbnail from ~8% in — avoids the black frame most captures start on.
  seekThumb(el, Math.min(el.duration * 0.08, 2)).then(thumb => {
    assets.update(asset.id, { thumb });
    URL.revokeObjectURL(el.src === url ? '' : el.src);
  }).catch(() => {});

  // The video's own soundtrack — decoded so AudioGraph can play it and the
  // clip can draw a waveform. Best effort: the picture must never depend on it.
  decodeSound(file, asset, el.duration || 0);

  return asset;
}

/**
 * Whether a clip's audio can be pulled into memory.
 *
 * `decodeAudioData` has no streaming form: it wants the entire compressed file
 * in an ArrayBuffer and hands back every sample as 32-bit floats. Cost is
 * governed by DURATION, not file size — decoded audio is
 * `seconds × 48000 × 2 channels × 4 bytes` no matter how well the source was
 * compressed:
 *
 *     4 minutes  →  0.09 GB      a music track, fine
 *    20 minutes  →  0.43 GB
 *    76 minutes  →  1.63 GB      a long recording, not fine
 *     2 hours    →  2.57 GB
 *
 * An earlier version of this guard measured the file instead, which a long,
 * efficiently-compressed recording walks straight past — and 1.6 GB of audio
 * starves the video decoder, which is what a black preview actually looks like
 * from the inside. Anything longer than the cap keeps its picture, plays its
 * sound straight off the video element instead (see audio/graph.js), and simply
 * goes without a waveform.
 */
const MAX_DECODE_SECONDS = 10 * 60;
const MAX_DECODE_BYTES = 400 * 1024 * 1024;   // the compressed copy costs RAM too

export function canDecodeAudio(seconds, bytes) {
  if (seconds && seconds > MAX_DECODE_SECONDS) return false;
  if (bytes && bytes > MAX_DECODE_BYTES) return false;
  return true;
}

async function decodeSound(file, asset, seconds) {
  if (!canDecodeAudio(seconds, file.size)) {
    const mins = Math.round((seconds || 0) / 60);
    assets.update(asset.id, { streamAudio: true });
    bus.emit('toast', {
      msg: `${file.name} is ${mins} min — playing its audio directly, no waveform`,
    });
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const peaks = await extractPeaks(buf);
    if (peaks) assets.update(asset.id, { peaks });
    else assets.update(asset.id, { streamAudio: true });
  } catch (err) {
    // Out of memory, or a container whose audio the browser can't decode.
    console.warn('audio decode failed for', file.name, err);
    assets.update(asset.id, { streamAudio: true });
    bus.emit('toast', { msg: `Could not read the audio in ${file.name}`, kind: 'err' });
  }
}

function seekThumb(el, t) {
  return new Promise((resolve, reject) => {
    const done = () => {
      try {
        const scale = 240 / (el.videoWidth || 240);
        const c = document.createElement('canvas');
        c.width = 240;
        c.height = Math.max(1, Math.round((el.videoHeight || 135) * scale));
        c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.72));
      } catch (e) { reject(e); }
    };
    el.addEventListener('seeked', done, { once: true });
    el.addEventListener('error', reject, { once: true });
    el.currentTime = Math.max(0.05, t || 0.05);
    setTimeout(() => reject(new Error('thumb timeout')), 8000);
  });
}

/* ── Audio ──────────────────────────────────────────────────── */
async function importAudio(file) {
  const { url, path } = await sourceFor(file);

  // Read the length from metadata BEFORE deciding to decode — a two-hour
  // recording must never be pulled into memory just to learn how long it is.
  const probe = document.createElement('audio');
  probe.preload = 'metadata';
  probe.src = url;
  const seconds = await once(probe, 'loadedmetadata')
    .then(() => probe.duration || 0)
    .catch(() => 0);

  const asset = assets.add({
    kind: 'audio',
    name: file.name,
    file, url, path,
    duration: seconds,
    peaks: null,
  });

  if (!canDecodeAudio(seconds, file.size)) {
    assets.update(asset.id, { streamAudio: true });
    bus.emit('toast', {
      msg: `${file.name} is ${Math.round(seconds / 60)} min — playing it directly, no waveform`,
    });
    return asset;
  }

  const buf = await file.arrayBuffer();
  const peaks = await extractPeaks(buf);
  if (peaks) assets.update(asset.id, { peaks, duration: peaks.duration || seconds });
  else assets.update(asset.id, { streamAudio: true });
  return asset;
}

/* ── Image ──────────────────────────────────────────────────── */
async function importImage(file) {
  const { url, path } = await sourceFor(file);
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => once(img, 'load'));
  return assets.add({
    kind: 'image',
    name: file.name,
    file, url, path,
    duration: 5,                  // default still duration
    width: img.naturalWidth, height: img.naturalHeight,
    thumb: url,
  });
}

/* ── Font ───────────────────────────────────────────────────── */
async function importFont(file) {
  const family = await registerFontFile(file);
  bus.emit('toast', { msg: `Font "${family}" ready`, kind: 'ok' });
  return assets.add({
    kind: 'font',
    name: file.name,
    family,
    file,
    duration: 0,
    bin: 'fonts',
  });
}

function once(el, ev) {
  return new Promise((res, rej) => {
    el.addEventListener(ev, res, { once: true });
    el.addEventListener('error', rej, { once: true });
  });
}
