import { assets } from './asset-store.js';
import { audioCtx, peaksFromBuffer } from '../audio/waveform.js';
import { peaksOf } from '../audio/pcm.js';
import { registerFontFile } from './fonts.js';
import { queueAudio } from './audio-jobs.js';
import {
  byteSourceFor, looksLikeMp4, looksLikeMatroska, matroskaTracks,
  probeMp4, canDecodeTracks, decodeMp4Audio, MAX_PCM_SECONDS,
} from './mp4-audio.js';
import { bus } from '../core/events.js';

export { pendingAudio, whenAudioReady, onAudioJobs } from './audio-jobs.js';

const FONT_RE = /\.(ttf|otf|woff2?)$/i;

/**
 * What kind of file this is.
 *
 * The browser's MIME type first, the extension second. Windows only knows a
 * type for extensions something has registered, so an OBS .mkv on a machine
 * without VLC arrives with `type === ''` — and was turned away as
 * "Unsupported file" before anything looked at it.
 */
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|ts|mts|m2ts|flv|wmv)$/i;
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|wma|ac3|weba)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

function kindOf(file) {
  const t = file.type || '';
  if (FONT_RE.test(file.name)) return 'font';
  if (t.startsWith('video')) return 'video';
  if (t.startsWith('audio')) return 'audio';
  if (t.startsWith('image')) return 'image';
  if (VIDEO_EXT.test(file.name)) return 'video';
  if (AUDIO_EXT.test(file.name)) return 'audio';
  if (IMAGE_EXT.test(file.name)) return 'image';
  return null;
}

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

/**
 * An import that cannot go ahead, with a sentence a person can act on.
 * `importFiles` shows `userMessage` as it is instead of a generic failure.
 */
function refuse(userMessage) {
  const e = new Error(userMessage);
  e.userMessage = userMessage;
  return e;
}

/** Import a FileList / array of Files. Resolves with created asset records. */
export async function importFiles(files) {
  const out = [];
  for (const file of [...files]) {
    try {
      const kind = kindOf(file);
      if (kind === 'font') { out.push(await importFont(file)); continue; }
      if (kind === 'video') { out.push(await importVideo(file)); continue; }
      if (kind === 'audio') { out.push(await importAudio(file)); continue; }
      if (kind === 'image') { out.push(await importImage(file)); continue; }
      bus.emit('toast', { msg: `Unsupported file: ${file.name}`, kind: 'err' });
    } catch (err) {
      console.warn('import failed:', file.name, err);
      if (err?.userMessage) {
        bus.emit('toast', { msg: err.userMessage, kind: 'err', ms: 16000 });
        continue;
      }
      // A video that throws here almost always means the container or codec
      // isn't one this build can decode — say that, rather than "failed".
      const k = kindOf(file);
      bus.emit('toast', {
        msg: k === 'video' || k === 'audio'
          ? `Can't open ${file.name} — this computer can't play that format. Re-save it as an H.264 MP4.`
          : `Failed to import ${file.name}`,
        kind: 'err',
        ms: 9000,
      });
    }
  }
  return out.filter(Boolean);
}

/**
 * Import a recording the main process already knows (the Clip Inbox): it has
 * a path and a gcmedia:// id, but no File object. Everything that reads it
 * goes through the id, exactly as a reopened project's media does.
 */
export async function importRegistered({ path, id, name, bytes = 0 }) {
  const file = { name: name || String(path).split(/[\\/]/).pop(), size: bytes, type: '' };
  try {
    return await importVideo(file, { url: `gcmedia://${id}`, path });
  } catch (err) {
    bus.emit('toast', { msg: err?.userMessage || `Can't open ${file.name} — re-save it as an H.264 MP4.`, kind: 'err', ms: 12000 });
    return null;
  }
}

/* ── Looking inside the file ──────────────────────────────────── */

/**
 * The container, read from the file's first bytes rather than its name — and
 * for an MP4, its index.
 *
 * Cheap: a few small reads, never the picture. What it learns decides how the
 * sound is decoded, whether there is any sound at all, and — when the browser
 * cannot show the picture — what to tell the person to change.
 */
async function inspect({ file, url, bytes }) {
  const src = byteSourceFor({ url, file, bytes });
  const head = src ? await src.read(0, 256 * 1024).catch(() => null) : null;
  const ctx = { src, head, container: 'other', probe: null, mkv: null };
  if (!head) return ctx;
  if (looksLikeMp4(head)) {
    ctx.container = 'mp4';
    try { ctx.probe = await probeMp4(src); } catch (err) { console.warn('mp4 index unreadable', err); }
  } else if (looksLikeMatroska(head)) {
    ctx.container = 'mkv';
    ctx.mkv = matroskaTracks(head);
  }
  return ctx;
}

/** Is there a sound track? true / false / null (cannot tell from the outside). */
function hasAudioFrom(ctx) {
  if (ctx.probe) return ctx.probe.audio.length > 0;
  if (ctx.mkv && (ctx.mkv.audio.length || ctx.mkv.video.length)) return ctx.mkv.audio.length > 0;
  return null;
}

/* ── Plain-words reasons a video will not open ─────────────── */

const FIX_ENCODER = 'Change the recorder to H.264: in Medal, Settings → Recording → '
  + 'Encoder → H.264 (AVC); in OBS, Settings → Output → Recording → Video Encoder → '
  + 'any "H.264" option (x264, NVENC H.264, QuickSync H.264, AMF H.264).';

const FIX_MKV = 'In OBS: File → Remux Recordings, pick this file, press Remux, then '
  + 'import the .mp4 it makes. To record MP4 from now on: Settings → Output → '
  + 'Recording → Recording Format → MP4 (or Fragmented MP4).';

function cannotShowPicture(file, ctx) {
  const codec = ctx.probe?.video?.[0]?.codec
    || (/HEVC/.test(ctx.mkv?.video?.[0] || '') ? 'hev1' : /AV1/.test(ctx.mkv?.video?.[0] || '') ? 'av01' : '');
  if (/^(hvc1|hev1)/i.test(codec)) {
    return refuse(`${file.name} was recorded in HEVC (H.265), which this computer can't `
      + `play — it would import as a black picture. ${FIX_ENCODER}`);
  }
  if (/^av01/i.test(codec)) {
    return refuse(`${file.name} was recorded in AV1, which this computer can't play — it `
      + `would import as a black picture. ${FIX_ENCODER}`);
  }
  if (ctx.container === 'mkv' || /\.mkv$/i.test(file.name)) {
    return refuse(`${file.name} is an MKV recording this computer can't open. ${FIX_MKV}`);
  }
  return refuse(`${file.name} uses a video format this computer can't play — it would `
    + `import as a black picture. ${FIX_ENCODER}`);
}

/* ── Video ──────────────────────────────────────────────────── */
async function importVideo(file, pre = null) {
  const { url, path } = pre || await sourceFor(file);
  const ctx = await inspect({ file, url, bytes: file.size });

  // An .mp4 with sound and no picture (a recorder's audio-only output, or a
  // renamed .m4a) is audio. As a "video" it was a 0×0 black clip.
  if (ctx.probe && !ctx.probe.video.length && ctx.probe.audio.length) {
    return importAudio(file, { url, path, ctx });
  }

  const el = document.createElement('video');
  // Electron 44 treats gcmedia:// as a foreign origin for canvas purposes:
  // without asking for CORS, one frame drawn from it taints the canvas, and
  // export (VideoFrame from that canvas) and every pixel read-back throw.
  // The protocol answers with Access-Control-Allow-Origin: *, so asking is enough.
  el.crossOrigin = 'anonymous';
  el.preload = 'metadata';
  el.muted = true;
  el.src = url;
  try {
    await once(el, 'loadedmetadata');
  } catch {
    throw cannotShowPicture(file, ctx);
  }

  /**
   * A picture of no size means the browser read the container but cannot
   * decode the video inside it — HEVC on a machine without the HEVC
   * extension is the everyday case. It used to import anyway, as a black
   * 0×0 clip, with no word of why.
   */
  if (!el.videoWidth || !el.videoHeight) throw cannotShowPicture(file, ctx);

  const duration = await resolveDuration(el, ctx.probe?.duration);
  if (!duration) {
    throw refuse(`Couldn't work out how long ${file.name} is, so it can't go on the timeline. `
      + 'Re-save it as an MP4 (in OBS: File → Remux Recordings).');
  }

  const hasAudio = hasAudioFrom(ctx);
  const asset = assets.add({
    kind: 'video',
    name: file.name,
    file, url, path,
    duration,
    // Kept so the export dialog can work out what the footage was recorded at
    // and offer to match it. `file` itself is gone once a project is reopened
    // from disk, so the size has to be remembered rather than measured again.
    bytes: file.size || 0,
    width: el.videoWidth, height: el.videoHeight,
    thumb: null,
    peaks: null,
    hasAudio,
    audioState: hasAudio === false ? 'none' : 'pending',
  });

  // Thumbnail from ~8% in — avoids the black frame most captures start on.
  seekThumb(el, Math.min(duration * 0.08, 2)).then(thumb => {
    assets.update(asset.id, { thumb });
    URL.revokeObjectURL(el.src === url ? '' : el.src);
  }).catch(() => {});

  // The video's own soundtrack — decoded so AudioGraph can play it, the clip
  // can draw a waveform and the export can mix it. Queued, never awaited: the
  // picture must never wait on, or depend on, the sound.
  if (hasAudio !== false) queueAudio(asset, (job) => prepareSound(asset, ctx, job));

  return asset;
}

/**
 * The length of a piece of media, in seconds, or 0 if it truly has none.
 *
 * A WebM written live — OBS's replay buffer, a browser's MediaRecorder — has
 * no duration in its header, and the element reports Infinity. That number
 * used to go straight into the document: "Infinity min" toasts, "Infinity:NaN"
 * timecodes, and an export with infinitely many frames that never finished.
 *
 * The standard remedy: seek far past the end. The element has to find the
 * real end to land there, and reports the duration it found.
 */
export async function resolveDuration(el, fallback = 0) {
  const ok = (d) => Number.isFinite(d) && d > 0;
  if (ok(el.duration)) return el.duration;
  await new Promise((resolve) => {
    const done = () => {
      el.removeEventListener('durationchange', check);
      el.removeEventListener('seeked', done);
      clearTimeout(timer);
      resolve();
    };
    const check = () => { if (ok(el.duration)) done(); };
    const timer = setTimeout(done, 15000);
    el.addEventListener('durationchange', check);
    el.addEventListener('seeked', done);
    try { el.currentTime = 1e101; } catch { done(); }
  });
  const d = el.duration;
  try { el.currentTime = 0; } catch { /* the thumbnail seek sets it anyway */ }
  if (ok(d)) return d;
  return ok(fallback) ? fallback : 0;
}

/**
 * Whether a clip's audio can be pulled into memory the OLD way —
 * decodeAudioData, which wants the whole compressed file in an ArrayBuffer and
 * hands back every sample as 32-bit floats.
 *
 * Still the route for formats without a demuxer here (mp3, wav, ogg, webm,
 * mkv). MP4 and MOV no longer go through it: their sound is read straight out
 * of the file (see media/mp4-audio.js), however big the file is.
 *
 *     10 minutes  →  0.2 GB of floats, plus the compressed file
 */
const MAX_DECODE_SECONDS = 10 * 60;
const MAX_DECODE_BYTES = 400 * 1024 * 1024;   // the compressed copy costs RAM too

export function canDecodeAudio(seconds, bytes) {
  if (seconds && seconds > MAX_DECODE_SECONDS) return false;
  if (bytes && bytes > MAX_DECODE_BYTES) return false;
  return true;
}

/**
 * Work out an asset's sound and leave it in one of these states:
 *
 *   ready       peaks + decoded sound; plays in the preview, mixes into exports
 *   none        the file has no sound track (hasAudio === false)
 *   unreadable  it has sound, but this computer cannot decode that format
 *   stream      too long to hold in memory and not an MP4; plays in the
 *               preview straight off the media element, but cannot be mixed
 *               into an export
 *
 * Those used to be one state — "streamAudio" — which is how a video with no
 * sound at all came to be offered "Extract audio", and why the export dialog
 * blamed every silent clip on its length.
 */
/**
 * Which of a recording's sound tracks make up its sound.
 *
 * Recorders disagree. OBS usually puts the full mix on track 1 and parts of it
 * (the mic alone) after it — add them together and the mic is doubled and the
 * mix clips. Medal and others put the game and the mic on separate tracks —
 * take only track 1 and the mic (or the game) is gone, or there is no sound at
 * all when track 1 is the empty one.
 *
 * So a few short stretches of every track are decoded and compared: silent
 * tracks are left out, and a track that is clearly already inside track 1
 * (strongly correlated with it) is left out; everything else is mixed.
 */
async function chooseTracks(src, probe) {
  const tracks = probe.audio;
  const dur = probe.duration || 60, wins = 8, len = 1.5;
  const starts = Array.from({ length: wins }, (_, i) => (dur * (i + 0.5)) / wins - len / 2).filter(x => x >= 0);
  const sig = [];
  for (const t of tracks) {
    try {
      const sub = { ...t, samples: t.samples.filter(x => { const at = x.cts / t.timescale; return starts.some(a => at >= a && at < a + len); }) };
      const st = await decodeMp4Audio(src, { ...probe, audio: [sub] });
      if (!st) { sig.push(null); continue; }
      const parts = [];
      for (const a of starts) {
        const f = Math.round((a + 0.2) * st.sampleRate), n = Math.round((len - 0.4) * st.sampleRate);
        const L = new Float32Array(n), R = new Float32Array(n);
        st.read(f, n, L, R);
        for (let i = 0; i < n; i += 2) parts.push((L[i] + R[i]) / 2);
      }
      sig.push({ rate: st.sampleRate, x: Float32Array.from(parts) });
    } catch { sig.push(null); }
  }
  const rms = (x) => { let e = 0; for (const v of x) e += v * v; return Math.sqrt(e / Math.max(1, x.length)); };
  const corr = (a, b) => {
    const n = Math.min(a.length, b.length); let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
  };
  const live = tracks.map((t, i) => sig[i] && rms(sig[i].x) > 0.003);
  if (!live.some(Boolean)) return tracks.slice(0, 1);
  if (!live[0]) return tracks.filter((_, i) => live[i]);
  const out = [tracks[0]];
  for (let k = 1; k < tracks.length; k++) {
    if (!live[k]) continue;
    const inside = sig[k].rate === sig[0].rate && corr(sig[0].x, sig[k].x) > 0.25;
    if (!inside) out.push(tracks[k]);
  }
  return out;
}

async function prepareSound(asset, ctx, job) {
  const id = asset.id;
  const set = (patch) => { if (job.alive()) assets.update(id, patch); };
  const name = asset.name;
  const seconds = asset.duration || ctx.probe?.duration || 0;

  if (ctx.probe) {
    const tracks = ctx.probe.audio;
    if (!tracks.length) { set({ audioState: 'none', hasAudio: false, streamAudio: false }); return; }
    if (await canDecodeTracks(tracks)) {
      if (ctx.probe.duration > MAX_PCM_SECONDS) {
        set({ audioState: 'stream', hasAudio: true, streamAudio: true,
              audioReason: 'longer than 2 hours' });
        bus.emit('toast', { msg: `${name} is over 2 hours long. Its sound plays here, but `
          + 'exports will be silent for it — cut the recording into shorter parts first.', ms: 12000 });
        return;
      }
      // Which tracks to use: see chooseTracks.
      const use = tracks.length > 1 ? await chooseTracks(ctx.src, ctx.probe) : tracks;
      if (!job.alive()) return;
      const store = await decodeMp4Audio(ctx.src, { ...ctx.probe, audio: use },
        { onProgress: job.progress, alive: job.alive });
      if (!job.alive()) return;
      if (!store || !store.length) {
        set({ audioState: 'unreadable', hasAudio: true, audioReason: 'no sound came out of the decoder' });
        return;
      }
      const peaks = await peaksOf(store);
      set({ peaks, audioState: 'ready', hasAudio: true, streamAudio: false,
            audioTracks: tracks.length });
      if (tracks.length > 1) {
        bus.emit('toast', { msg: use.length === tracks.length ? `${name}: mixed its ${tracks.length} sound tracks together`
          : `${name}: using ${use.length} of its ${tracks.length} sound tracks (the others are already in that mix, or silent)`, ms: 4000 });
      }
      return;
    }
    // A codec WebCodecs will not take (FLAC or AC-3 in MP4, say). Small
    // files still get a try through decodeAudioData below.
  }

  // MKV (OBS's default): read its first audio track straight out of the file,
  // however long it is, so it plays in step and goes into exports.
  if (ctx.container === 'mkv' && ctx.mkv?.audio.length && ctx.src) {
    try {
      const { decodeMkvAudio } = await import('./mkv-audio.js');
      const store = await decodeMkvAudio(ctx.src, { onProgress: job.progress, alive: job.alive });
      if (!job.alive()) return;
      if (store && store.length) {
        const peaks = await peaksOf(store);
        set({ peaks, audioState: 'ready', hasAudio: true, streamAudio: false, audioTracks: ctx.mkv.audio.length });
        return;
      }
    } catch (err) {
      console.warn('mkv sound could not be read directly', err);
    }
  }

  if (ctx.mkv && ctx.mkv.video.length && !ctx.mkv.audio.length) {
    set({ audioState: 'none', hasAudio: false, streamAudio: false });
    return;
  }

  const bytes = asset.bytes || ctx.src?.size || 0;
  if (!canDecodeAudio(seconds, bytes)) {
    // Not an MP4, and too big to decode whole. The preview can still play it
    // straight off the media element; an export cannot include it.
    set({ audioState: 'stream', streamAudio: true, hasAudio: ctx.mkv ? true : asset.hasAudio ?? null,
          audioReason: ctx.container === 'mkv' ? 'mkv' : 'too long' });
    const mins = Math.round(seconds / 60);
    bus.emit('toast', {
      msg: ctx.container === 'mkv'
        ? `${name}: Strike can't put the sound of a long .mkv into an export. ${FIX_MKV}`
        : `${name} is ${mins} min — its sound plays here, but exports will be silent for it. `
          + 'Convert it to MP4 or M4A to export its sound.',
      ms: 14000,
    });
    return;
  }

  let audio = null;
  try {
    const raw = ctx.src ? await ctx.src.read(0, bytes || 1e12) : null;
    if (!job.alive() || !raw) return;
    // decodeAudioData detaches what it is given, so hand it its own copy.
    audio = await audioCtx().decodeAudioData(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  } catch (err) {
    audio = null;
    if (asset.hasAudio === false || hasAudioFrom(ctx) === false) {
      set({ audioState: 'none', hasAudio: false, streamAudio: false });
      return;
    }
    // A video file that is not MP4/MKV and failed to decode is most often
    // simply silent; a file that is NOTHING but sound failing is a real
    // format problem, and is worth a sentence.
    if (asset.kind === 'audio' || hasAudioFrom(ctx) === true) {
      set({ audioState: 'unreadable', hasAudio: true, streamAudio: false,
            audioReason: String(err?.message || err) });
      bus.emit('toast', { msg: `Can't read the sound in ${name} — this computer can't decode `
        + 'that format. Convert it to MP3, WAV or M4A.', kind: 'err', ms: 9000 });
    } else {
      set({ audioState: 'none', hasAudio: false, streamAudio: false });
    }
    return;
  }
  if (!job.alive()) return;
  const peaks = peaksFromBuffer(audio);
  set({ peaks, audioState: 'ready', hasAudio: true, streamAudio: false,
        ...(!(asset.duration > 0) ? { duration: peaks.duration } : {}) });
}

/**
 * Rebuild an asset's sound — for a project reopened from disk.
 *
 * The project file stores where the media lives, never its decoded sound, so
 * every audio and video asset needs this once it has a gcmedia:// url again.
 * Queued like an import (one file at a time, visible to the export dialog's
 * "Preparing sound…" wait), sized by the AUDIO, not the file: a 4 GB
 * recording is read for its few MB of sound, never loaded whole.
 *
 * Marks the asset pending synchronously, so call it as the asset is added and
 * an export started a moment later waits for it. Returns a promise for when
 * it is done; nothing needs to await it.
 */
export function restoreAssetAudio(asset) {
  if (!asset || asset.missing || !asset.url) return Promise.resolve();
  if (asset.kind !== 'audio' && asset.kind !== 'video') return Promise.resolve();
  // Whatever an old project file said about the sound is re-derived here.
  assets.update(asset.id, { peaks: null, streamAudio: false });
  return queueAudio(asset, async (job) => {
    const ctx = await inspect({ url: asset.url, bytes: asset.bytes || 0 });
    if (!job.alive()) return;
    const hasAudio = hasAudioFrom(ctx);
    if (hasAudio !== null) assets.update(asset.id, { hasAudio });
    await prepareSound(asset, ctx, job);
  });
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
async function importAudio(file, pre = null) {
  const { url, path } = pre || await sourceFor(file);
  const ctx = pre?.ctx || await inspect({ file, url, bytes: file.size });

  // Read the length from metadata BEFORE deciding to decode — a two-hour
  // recording must never be pulled into memory just to learn how long it is.
  const probe = document.createElement('audio');
  probe.crossOrigin = 'anonymous';
  probe.preload = 'metadata';
  probe.src = url;
  const seconds = await once(probe, 'loadedmetadata')
    .then(() => resolveDuration(probe, ctx.probe?.duration))
    .catch(() => (ctx.probe?.duration > 0 ? ctx.probe.duration : 0));
  probe.removeAttribute('src');

  if (!seconds && !ctx.probe) {
    // No length and no index to read one from: the browser cannot play this
    // at all (WMA, AC-3…). Saying so beats a 0-second clip that never sounds.
    throw refuse(`Can't open ${file.name} — this computer can't play that sound format. `
      + 'Convert it to MP3, WAV or M4A.');
  }

  const hasAudio = ctx.probe ? ctx.probe.audio.length > 0 : true;
  const asset = assets.add({
    kind: 'audio',
    name: file.name,
    file, url, path,
    duration: seconds || 0,
    bytes: file.size || 0,
    peaks: null,
    hasAudio,
    audioState: hasAudio ? 'pending' : 'none',
  });
  if (hasAudio) queueAudio(asset, (job) => prepareSound(asset, ctx, job));
  return asset;
}

/* ── Image ──────────────────────────────────────────────────── */
async function importImage(file) {
  const { url, path } = await sourceFor(file);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode().catch(() => once(img, 'load'));
  return assets.add({
    kind: 'image',
    name: file.name,
    file, url, path,
    bytes: file.size || 0,
    duration: 5,                  // default still duration
    width: img.naturalWidth, height: img.naturalHeight,
    thumb: url,
  });
}

/* ── Font ───────────────────────────────────────────────────── */
/**
 * A font is media like any other: it gets a path and a gcmedia:// url, so a
 * saved project can find it again. It used to get neither — reopening a
 * project lost every custom font and announced the font file as "missing",
 * when it was sitting exactly where it had always been.
 */
async function importFont(file) {
  const family = await registerFontFile(file);
  const { url, path } = await sourceFor(file);
  bus.emit('toast', { msg: `Font "${family}" ready`, kind: 'ok' });
  return assets.add({
    kind: 'font',
    name: file.name,
    family,
    file, url, path,
    bytes: file.size || 0,
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
