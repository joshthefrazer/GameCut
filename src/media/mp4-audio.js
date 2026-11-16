import { createFile, MP4BoxBuffer, DataStream, Endianness } from '../../vendor/mp4box.mjs';
import { PcmStore } from '../audio/pcm.js';

/**
 * The sound out of an MP4 or MOV, without reading the picture.
 *
 * ── Why ──────────────────────────────────────────────────────
 * A Medal or OBS recording is 50-100 Mbps of picture and a few hundred kbps of
 * sound. decodeAudioData only takes a whole file in memory, so getting at the
 * sound meant loading every byte of the picture first — which is why anything
 * over 400 MB was not decoded at all and exported silent. That is about a
 * minute of 60 fps gameplay: most of what anyone exports.
 *
 * So the container is read the way a player reads it:
 *
 *   1. Walk the top-level boxes, a small read at a time, skipping straight
 *      over `mdat` (the picture) to find `moov` — the index, wherever the
 *      recorder put it (OBS writes it at the end). For a fragmented file each
 *      `moof` is read the same way.
 *   2. The index says exactly where every audio sample sits in the file and how
 *      big it is. Only those bytes are read — a few MB from a multi-GB file —
 *      through Range requests on the gcmedia:// URL, which the main process
 *      serves straight from disk.
 *   3. WebCodecs' AudioDecoder decodes them, and the result is mixed into a
 *      16-bit PcmStore. EVERY audio track is mixed in, because OBS is often set
 *      to record game, microphone and Discord on separate tracks, and keeping
 *      only the first one silently drops your own voice.
 *
 * Memory is the decoded sound and nothing else: about 11.5 MB a minute,
 * however big the file is.
 *
 * mp4box.js is vendored (vendor/mp4box.mjs, BSD-3-Clause) for step 1. It is
 * only ever used as an index reader here — its own sample extraction would want
 * the file fed through it front to back.
 */

/** Longest sound decoded into memory, in seconds. 2 h ≈ 1.4 GB of 16-bit stereo. */
export const MAX_PCM_SECONDS = 2 * 60 * 60;

/* ── Reading bytes ─────────────────────────────────────────── */

/**
 * Random access to a media file.
 *
 * gcmedia:// is preferred whenever there is one, at import as well as on
 * reopen: it is the only way in once the File object is gone (a project
 * reopened tomorrow), so using it every time means the path that reopens a
 * project is the path every import has already exercised. A File is the
 * fallback for media with no path behind it.
 */
export function byteSourceFor({ url, file, bytes }) {
  if (url && /^gcmedia:/i.test(url)) return new UrlBytes(url, bytes);
  if (file) return new FileBytes(file);
  if (url) return new UrlBytes(url, bytes);
  return null;
}

class FileBytes {
  constructor(file) { this.file = file; this.size = file.size; }
  async read(start, end) {
    const e = Math.min(end, this.size);
    if (e <= start) return new Uint8Array(0);
    return new Uint8Array(await this.file.slice(start, e).arrayBuffer());
  }
}

class UrlBytes {
  constructor(url, size) { this.url = url; this.size = size || 0; }
  async read(start, end) {
    if (this.size && end > this.size) end = this.size;
    if (end <= start) return new Uint8Array(0);
    const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (res.status === 410) throw mediaError('offline', 'The file was moved or deleted.');
    if (res.status === 206) {
      // "bytes 0-65535/4294967296" — the total is how we learn the size of a
      // file we never had a File object for.
      const m = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') || '');
      if (m) this.size = Number(m[1]);
      return new Uint8Array(await res.arrayBuffer());
    }
    if (res.ok && start === 0) {
      // A server that ignores Range sends the whole file. Fine for the first
      // few bytes of a small file, a disaster for a 4 GB one — stop reading.
      const len = Number(res.headers.get('Content-Length') || 0);
      if (len && len <= end) { this.size = len; return new Uint8Array(await res.arrayBuffer()); }
      try { await res.body?.cancel(); } catch { /* already done */ }
    }
    throw mediaError('read', `Could not read the file (${res.status}).`);
  }
}

function mediaError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ── Recognising the container ─────────────────────────────── */

const MP4_TOP = new Set(['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid']);

/** First bytes of an ISO-BMFF file (MP4, MOV, M4A)? */
export function looksLikeMp4(head) {
  if (!head || head.length < 8) return false;
  const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
  return MP4_TOP.has(type);
}

/** First bytes of a Matroska / WebM file? (The EBML magic number.) */
export function looksLikeMatroska(head) {
  return !!head && head.length >= 4
    && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

/**
 * Does a Matroska/WebM file have a sound track, and which codec?
 *
 * Read from the CodecID strings in the track list ("A_AAC", "A_OPUS",
 * "V_MPEG4/ISO/AVC"…), which every muxer writes near the start of the file.
 * This is a scan, not a parser — but CodecID is a printable string with a
 * fixed prefix, so it is reliable for telling "no sound" from "sound we could
 * not decode", which is all it is used for.
 */
export function matroskaTracks(head) {
  const text = new TextDecoder('latin1').decode(head);
  const audio = [...text.matchAll(/A_[A-Z0-9_/]{2,24}/g)].map(m => m[0]);
  const video = [...text.matchAll(/V_[A-Z0-9_/]{2,24}/g)].map(m => m[0]);
  return { audio, video };
}

/* ── The index ─────────────────────────────────────────────── */

/**
 * Read the MP4's index and describe its tracks.
 *
 * Returns { duration, fragmented, video: [{codec,width,height}],
 *           audio: [{id, codec, sampleRate, channels, description, samples, start}] }
 * where `samples` is mp4box's sample table (offset, size, cts, timescale) and
 * `start` is where the track's first sample plays, in seconds, from its edit
 * list (AAC's encoder priming and any initial delay).
 */
export async function probeMp4(src, { video = false } = {}) {
  const file = createFile();
  let info = null;
  let failed = null;
  file.onReady = (i) => { info = i; };
  file.onError = (e) => { failed = e; };

  let pos = 0, want = 64 * 1024, reads = 0;
  for (;;) {
    if (src.size && pos >= src.size) break;
    const bytes = await src.read(pos, pos + want);
    if (!bytes.length) break;
    reads++;
    const buf = MP4BoxBuffer.fromArrayBuffer(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), pos);
    const atEnd = src.size ? pos + bytes.length >= src.size : bytes.length < want;
    const next = file.appendBuffer(buf, atEnd);
    if (failed) throw mediaError('parse', String(failed));
    // An ordinary file is done the moment the index is in. A fragmented one
    // keeps its sample tables in every `moof`, so it is walked to the end.
    if (info && !info.isFragmented) break;
    if (atEnd || next === undefined) break;
    if (next <= pos) {
      // The box at `pos` did not fit in what was read (a long recording's
      // index is several MB). Read more of it rather than the same again.
      want *= 2;
      if (want > 512 * 1024 * 1024) break;
      continue;
    }
    pos = next;
    want = 64 * 1024;
    if (reads > 200_000) break;            // a file of nothing but tiny boxes
  }
  file.flush();
  if (!info) info = file.moov ? file.getInfo() : null;
  if (!info) throw mediaError('parse', 'No MP4 index (moov) was found.');

  const out = {
    duration: info.timescale ? info.duration / info.timescale : 0,
    fragmented: !!info.isFragmented,
    video: (info.videoTracks || []).map(t => ({
      codec: t.codec, width: t.video?.width || t.track_width || 0,
      height: t.video?.height || t.track_height || 0,
    })),
    audio: [],
  };

  for (const t of info.audioTracks || []) {
    const trak = file.getTrackById(t.id);
    const samples = (file.getTrackSamplesInfo(t.id) || [])
      .map(s => ({ offset: s.offset, size: s.size, cts: s.cts, duration: s.duration }))
      .filter(s => s.size > 0);
    if (!samples.length) continue;
    const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    const timescale = trak?.mdia?.mdhd?.timescale || t.timescale;
    out.audio.push({
      id: t.id,
      codec: webCodecsName(t.codec),
      fourcc: entry?.type || '',
      sampleRate: t.audio?.sample_rate || entry?.samplerate || 48000,
      channels: t.audio?.channel_count || entry?.channel_count || 2,
      description: decoderConfig(entry),
      timescale,
      start: editStart(trak, info.timescale, timescale),
      samples,
    });
    const last = samples[samples.length - 1];
    const end = (last.cts + (last.duration || 0)) / timescale;
    if (end > out.duration) out.duration = end;   // fragmented: mvhd says 0
  }
  // For export: the video track's own sample table, so frames can be decoded
  // in order with WebCodecs instead of seeking a <video> element.
  if (video) {
    out.videoTracks = [];
    for (const t of info.videoTracks || []) {
      const trak = file.getTrackById(t.id);
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
      const box = entry?.avcC || entry?.hvcC || entry?.vpcC || entry?.av1C;
      let description;
      if (box) {
        const ds = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
        box.write(ds);
        description = new Uint8Array(ds.buffer, 8);       // without the box header
      }
      const timescale = trak?.mdia?.mdhd?.timescale || t.timescale;
      // When the first frame is shown: an edit list may skip the first
      // media_time ticks (B-frame reordering) or start after an empty edit.
      let shift = 0, delay = 0;
      for (const e of trak?.edts?.elst?.entries || []) {
        if (e.media_time === -1 || e.media_time === 0xffffffff) { delay += (e.segment_duration || 0) / (info.timescale || 1000); continue; }
        shift = e.media_time / timescale; break;
      }
      out.videoTracks.push({
        id: t.id, codec: t.codec, description, timescale,
        width: t.video?.width || t.track_width || 0, height: t.video?.height || t.track_height || 0,
        offset: delay - shift,
        samples: (file.getTrackSamplesInfo(t.id) || []).filter(x => x.size > 0)
          .map(x => ({ offset: x.offset, size: x.size, cts: x.cts, duration: x.duration, sync: !!x.is_sync })),
      });
    }
  }
  for (const t of info.videoTracks || []) {
    const s = file.getTrackSamplesInfo(t.id) || [];
    const last = s[s.length - 1];
    if (last) {
      const end = (last.cts + (last.duration || 0)) / (last.timescale || t.timescale);
      if (end > out.duration) out.duration = end;
    }
  }
  return out;
}

/** mp4box's codec string → the name WebCodecs wants. */
function webCodecsName(codec) {
  const c = String(codec || '');
  // MP3 inside MP4 is signalled as an MPEG-4 object type, not as "mp3".
  if (/^mp4a\.(6b|69)$/i.test(c)) return 'mp3';
  if (/^opus$/i.test(c)) return 'opus';
  if (/^flac$/i.test(c) || /^fLaC$/.test(c)) return 'flac';
  return c;
}

/**
 * The AAC "AudioSpecificConfig" — the two-ish bytes that tell a decoder the
 * profile, rate and channel layout. WebCodecs needs it as `description`.
 */
function decoderConfig(entry) {
  const descs = entry?.esds?.esd?.descs || [];
  for (const d of descs) {
    if (d.tag !== 4) continue;                       // DecoderConfigDescriptor
    for (const s of d.descs || []) {
      if (s.tag === 5 && s.data?.length) return new Uint8Array(s.data);   // DecSpecificInfo
    }
  }
  return undefined;
}

/**
 * When the first sample of a track is heard, in seconds — from its edit list.
 *
 * AAC encoders put about 1024 samples of "priming" at the front, and the MP4's
 * edit list says to skip them; ignoring it leaves the sound ~21 ms late against
 * the picture. An initial empty edit means the track starts after a delay.
 */
function editStart(trak, movieScale, mediaScale) {
  const entries = trak?.edts?.elst?.entries;
  if (!entries?.length) return 0;
  let delay = 0;
  for (const e of entries) {
    if (e.media_time === -1 || e.media_time === 0xffffffff) {
      delay += (e.segment_duration || 0) / (movieScale || 1000);
      continue;
    }
    return delay - (e.media_time || 0) / (mediaScale || 1);
  }
  return delay;
}

/* ── Decoding ──────────────────────────────────────────────── */

/** Can this machine decode every audio track the probe found? */
export async function canDecodeTracks(tracks) {
  if (typeof AudioDecoder === 'undefined') return false;
  for (const t of tracks) {
    try {
      const { supported } = await AudioDecoder.isConfigSupported(decoderSettings(t));
      if (!supported) return false;
    } catch { return false; }
  }
  return tracks.length > 0;
}

function decoderSettings(t) {
  return {
    codec: t.codec,
    sampleRate: t.sampleRate,
    numberOfChannels: t.channels,
    ...(t.description ? { description: t.description } : {}),
  };
}

/** Samples grouped into reads: neighbours merged, nothing over ~2 MB. */
function readPlan(samples) {
  const GAP = 64 * 1024, MAX = 2 * 1024 * 1024;
  const plan = [];
  let cur = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (cur && s.offset >= cur.end && s.offset - cur.end <= GAP
        && s.offset + s.size - cur.start <= MAX) {
      cur.end = Math.max(cur.end, s.offset + s.size);
      cur.last = i;
    } else {
      cur = { start: s.offset, end: s.offset + s.size, first: i, last: i };
      plan.push(cur);
    }
  }
  return plan;
}

/**
 * Decode every audio track into one PcmStore.
 *
 * @param src       byte source (see byteSourceFor)
 * @param probe     result of probeMp4
 * @param o.onProgress  (0..1) => void
 * @param o.alive       () => boolean — false stops the work (asset removed,
 *                      another project opened)
 */
export async function decodeMp4Audio(src, probe, { onProgress, alive } = {}) {
  const tracks = probe.audio;
  if (!tracks.length) return null;
  if (probe.duration > MAX_PCM_SECONDS) throw mediaError('too-long', 'Recording too long to hold its sound in memory.');

  const total = tracks.reduce((n, t) => n + t.samples.length, 0);
  let done = 0;
  let store = null;

  for (const t of tracks) {
    let err = null;
    const at = new Map();          // chunk timestamp (µs) → seconds on the clip
    const flow = { next: null };   // where this track's next packet should land
    const dec = new AudioDecoder({
      output: (ad) => {
        try {
          if (!store) store = new PcmStore(ad.sampleRate);
          // The decoder re-derives output timestamps and rounds them its own
          // way (42666 for an input of 42667 µs). An exact lookup missed two
          // packets in three, which then landed without the track's start
          // offset — 1024 samples off — and the sound stuttered ~15 times a
          // second, in the preview and in every export.
          let key = ad.timestamp;
          if (!at.has(key)) key = at.has(key + 1) ? key + 1 : at.has(key - 1) ? key - 1 : null;
          const sec = key !== null ? at.get(key) : ad.timestamp / 1e6 + t.start;
          if (key !== null) at.delete(key);
          mixInto(store, ad, sec, flow);
        } catch (e) { err = err || e; }
        ad.close();
      },
      error: (e) => { err = err || e; },
    });
    dec.configure(decoderSettings(t));

    const plan = readPlan(t.samples);
    // Two reads in flight while one is decoded: disk and decoder both busy.
    const fetchRun = (r) => src.read(r.start, r.end);
    let pending = plan.length ? fetchRun(plan[0]) : null;
    for (let k = 0; k < plan.length; k++) {
      if (alive && !alive()) { try { dec.close(); } catch { /* closed */ } return null; }
      if (err) throw err;
      const run = plan[k];
      const bytes = await pending;
      pending = k + 1 < plan.length ? fetchRun(plan[k + 1]) : null;

      for (let i = run.first; i <= run.last; i++) {
        const s = t.samples[i];
        const from = s.offset - run.start;
        if (from < 0 || from + s.size > bytes.length) continue;   // truncated file
        const sec = s.cts / t.timescale + t.start;
        // Unique, integral timestamps, so the output can be put back exactly
        // where its input came from — a decoder may emit in its own time.
        const ts = Math.round(s.cts / t.timescale * 1e6);
        at.set(ts, sec);
        dec.decode(new EncodedAudioChunk({
          type: 'key', timestamp: ts,
          duration: Math.round((s.duration || 0) / t.timescale * 1e6),
          data: bytes.subarray(from, from + s.size),
        }));
      }
      done += run.last - run.first + 1;
      while (dec.decodeQueueSize > 48) {
        await new Promise(r => setTimeout(r, 1));
        if (err) throw err;
      }
      if (k % 16 === 0) {
        onProgress?.(Math.min(0.99, done / total));
        // Let the editor breathe: this can be a few thousand iterations.
        await new Promise(r => setTimeout(r, 0));
      }
    }
    await dec.flush();
    dec.close();
    if (err) throw err;
  }
  onProgress?.(1);
  return store;
}

/**
 * Put one decoded packet into the store, as stereo, at the right moment.
 *
 * `flow.next` is where the previous packet ended. A packet whose own timestamp
 * rounds to within a couple of samples of that is placed exactly there instead:
 * timestamps in a coarse timescale round differently packet to packet, and a
 * one-sample gap or overlap at every packet boundary is an audible buzz.
 */
export function mixInto(store, ad, sec, flow) {
  const n = ad.numberOfFrames;
  const ch = ad.numberOfChannels;
  const plane = (i) => {
    const p = new Float32Array(n);
    ad.copyTo(p, { planeIndex: i, format: 'f32-planar' });
    return p;
  };
  let L, R;
  if (ch <= 1) { L = plane(0); R = L; }
  else if (ch === 2) { L = plane(0); R = plane(1); }
  else {
    // 5.1 and friends (L R C LFE Ls Rs): a plain fold-down, scaled so a full
    // centre channel cannot clip on its own.
    const p = [];
    for (let i = 0; i < Math.min(ch, 6); i++) p.push(plane(i));
    L = new Float32Array(n); R = new Float32Array(n);
    const c = p[2], sl = p[4], sr = p[5] || p[4];
    for (let i = 0; i < n; i++) {
      L[i] = 0.5 * (p[0][i] + 0.707 * (c ? c[i] : 0) + 0.707 * (sl ? sl[i] : 0));
      R[i] = 0.5 * (p[1][i] + 0.707 * (c ? c[i] : 0) + 0.707 * (sr ? sr[i] : 0));
    }
  }
  if (ad.sampleRate !== store.sampleRate) {
    // A second track at a different rate (rare: 44.1 kHz mic, 48 kHz game).
    // Linear resampling — good enough for speech, and only this track pays.
    const ratio = store.sampleRate / ad.sampleRate;
    const m = Math.max(1, Math.round(n * ratio));
    const l2 = new Float32Array(m), r2 = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const x = i / ratio, i0 = Math.floor(x), f = x - i0, i1 = Math.min(n - 1, i0 + 1);
      l2[i] = L[i0] * (1 - f) + L[i1] * f;
      r2[i] = R[i0] * (1 - f) + R[i1] * f;
    }
    L = l2; R = r2;
  }
  const frames = L.length;
  let at = Math.round(sec * store.sampleRate);
  if (flow.next !== null && Math.abs(at - flow.next) <= 2) at = flow.next;
  store.mix(at, L, R, frames);
  flow.next = at + frames;
}
