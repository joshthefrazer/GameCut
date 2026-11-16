import { PcmStore } from '../audio/pcm.js';
import { mixInto, MAX_PCM_SECONDS } from './mp4-audio.js';

/**
 * Sound out of a Matroska (.mkv) recording — what OBS writes by default.
 *
 * MKV used to go through decodeAudioData, which needs the whole file in memory
 * and only ever decodes the first track, so anything over 400 MB or 10 minutes
 * (most OBS recordings) had "listen only" sound: played off the video element,
 * drifting and skipping, and missing from every export.
 *
 * This walks the file once, in 4 MB reads, picking out the packets of the
 * first audio track (OBS's full mix) and decoding them with WebCodecs as it
 * goes. Video packets are stepped over, never copied. The result is the same
 * PcmStore an MP4's sound becomes, so preview, waveform and export treat both
 * the same way.
 */

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
  Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
};
/** Elements walked into rather than over. */
const CONTAINERS = new Set([ID.Segment, ID.Cluster, ID.BlockGroup]);
const CHUNK = 4 * 1024 * 1024;

function readId(b, p) {
  const x = b[p];
  const len = x >= 0x80 ? 1 : x >= 0x40 ? 2 : x >= 0x20 ? 3 : x >= 0x10 ? 4 : 0;
  if (!len || p + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return { v, len };
}
function readSize(b, p) {
  const x = b[p];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(x & mask)) { len++; mask >>= 1; }
  if (len > 8 || p + len > b.length) return null;
  let v = x & (mask - 1), allOnes = v === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false; }
  return { v: allOnes ? -1 : v, len };
}
const uint = (b, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };
const float = (b, p, n) => { const dv = new DataView(b.buffer, b.byteOffset + p, n); return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };

/** The children of a small master element (Info, Tracks) already in memory. */
function* children(b, p, end) {
  while (p < end) {
    const id = readId(b, p); if (!id) return;
    const sz = readSize(b, p + id.len); if (!sz) return;
    const start = p + id.len + sz.len, size = sz.v < 0 ? end - start : sz.v;
    yield { id: id.v, start, size };
    p = start + size;
  }
}

function parseTracks(b, p, end) {
  const out = [];
  for (const e of children(b, p, end)) {
    if (e.id !== ID.TrackEntry) continue;
    const t = {};
    for (const f of children(b, e.start, e.start + e.size)) {
      if (f.id === ID.TrackNumber) t.number = uint(b, f.start, f.size);
      else if (f.id === ID.TrackType) t.type = uint(b, f.start, f.size);
      else if (f.id === ID.CodecID) t.codecId = new TextDecoder('latin1').decode(b.subarray(f.start, f.start + f.size)).replace(/\0+$/, '');
      else if (f.id === ID.CodecPrivate) t.priv = b.slice(f.start, f.start + f.size);
      else if (f.id === ID.Video) {
        for (const g of children(b, f.start, f.start + f.size)) {
          if (g.id === ID.PixelWidth) t.width = uint(b, g.start, g.size);
          else if (g.id === ID.PixelHeight) t.height = uint(b, g.start, g.size);
        }
      }
      else if (f.id === ID.Audio) {
        for (const g of children(b, f.start, f.start + f.size)) {
          if (g.id === ID.SamplingFrequency) t.sampleRate = float(b, g.start, g.size);
          else if (g.id === ID.Channels) t.channels = uint(b, g.start, g.size);
        }
      }
    }
    out.push(t);
  }
  return out;
}

/** WebCodecs settings for a Matroska audio track, or null for codecs we do not take. */
function settingsFor(t) {
  if (t.codecId === 'A_AAC' || t.codecId?.startsWith('A_AAC/')) {
    const aot = t.priv?.length ? t.priv[0] >> 3 : 2;
    return { codec: `mp4a.40.${aot || 2}`, sampleRate: Math.round(t.sampleRate || 48000), numberOfChannels: t.channels || 2, ...(t.priv ? { description: t.priv } : {}) };
  }
  if (t.codecId === 'A_OPUS') return { codec: 'opus', sampleRate: 48000, numberOfChannels: t.channels || 2, ...(t.priv ? { description: t.priv } : {}) };
  return null;
}

/**
 * Decode the first audio track of an MKV into a PcmStore.
 * Resolves null when the file has no track this machine can decode.
 */
export async function decodeMkvAudio(src, { onProgress, alive } = {}) {
  if (typeof AudioDecoder === 'undefined') return null;
  const size = src.size || 0;
  let buf = new Uint8Array(0), bufAt = 0;
  /** Make sure bytes [pos, pos+n) are in `buf`; false at the end of the file. */
  const ensure = async (pos, n) => {
    if (pos >= bufAt && pos + n <= bufAt + buf.length) return true;
    const want = Math.max(CHUNK, n);
    const end = size ? Math.min(size, pos + want) : pos + want;
    if (end <= pos) return false;
    buf = await src.read(pos, end);
    bufAt = pos;
    return pos + n <= bufAt + buf.length;
  };

  let scale = 1e6, duration = 0, track = null, dec = null, store = null, err = null, flow = { next: null };
  let clusterTime = 0, pos = 0, decoded = 0, steps = 0;

  const startDecoder = async (t) => {
    const cfg = settingsFor(t);
    if (!cfg) return false;
    try { if (!(await AudioDecoder.isConfigSupported(cfg)).supported) return false; } catch { return false; }
    dec = new AudioDecoder({
      output: (ad) => {
        try {
          if (!store) store = new PcmStore(ad.sampleRate);
          mixInto(store, ad, ad.timestamp / 1e6, flow);
        } catch (e) { err = err || e; }
        ad.close();
      },
      error: (e) => { err = err || e; },
    });
    dec.configure(cfg);
    return true;
  };

  while (true) {
    if (alive && !alive()) { try { dec?.close(); } catch { /* closed */ } return null; }
    if (err) throw err;
    if (!(await ensure(pos, 12))) break;
    const b = buf, p = pos - bufAt;
    const id = readId(b, p); const sz = id && readSize(b, p + id.len);
    if (!id || !sz) break;
    const head = id.len + sz.len, body = pos + head;

    if (CONTAINERS.has(id.v) || id.v === ID.EBML && false) { pos = body; continue; }

    if (id.v === ID.Info || id.v === ID.Tracks || id.v === ID.Timecode) {
      if (sz.v < 0 || !(await ensure(body, sz.v))) break;
      const q = body - bufAt;
      if (id.v === ID.Timecode) clusterTime = uint(buf, q, sz.v);
      else if (id.v === ID.Info) {
        for (const f of children(buf, q, q + sz.v)) {
          if (f.id === ID.TimecodeScale) scale = uint(buf, f.start, f.size);
          else if (f.id === ID.Duration) duration = float(buf, f.start, f.size);
        }
      } else if (!track) {
        const audio = parseTracks(buf, q, q + sz.v).filter(t => t.type === 2);
        for (const t of audio) { if (await startDecoder(t)) { track = t; break; } }
        if (!track) return null;
        if (duration * scale / 1e9 > MAX_PCM_SECONDS) { try { dec.close(); } catch { /* closed */ } return null; }
      }
      pos = body + sz.v;
      continue;
    }

    if ((id.v === ID.SimpleBlock || id.v === ID.Block) && track && sz.v > 4) {
      if (!(await ensure(body, Math.min(sz.v, 16)))) break;
      const q = body - bufAt;
      const tn = readSize(buf, q);
      if (tn && tn.v === track.number) {
        if (!(await ensure(body, sz.v))) break;
        const r = body - bufAt;
        const rel = (buf[r + tn.len] << 8 | buf[r + tn.len + 1]) << 16 >> 16;
        const flags = buf[r + tn.len + 2];
        const ts = Math.round((clusterTime + rel) * scale / 1000);       // µs
        const data = buf.slice(r + tn.len + 3, r + sz.v);
        if ((flags & 0x06) === 0) {
          dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data }));
          decoded++;
        }
        // Laced audio (rare from OBS/ffmpeg) is skipped rather than mis-split.
      }
      pos = body + sz.v;
    } else {
      if (sz.v < 0) break;                 // an unknown-size element we do not walk into
      pos = body + sz.v;
    }

    if (++steps % 2000 === 0) {
      while (dec && dec.decodeQueueSize > 64) await new Promise(r => setTimeout(r, 1));
      if (size) onProgress?.(Math.min(0.99, pos / size));
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (!dec) return null;
  await dec.flush();
  dec.close();
  if (err) throw err;
  onProgress?.(1);
  return decoded ? store : null;
}

/**
 * The video track's packets of an MKV, for export (see export/frame-reader.js):
 * where each one is, when it is shown, and which are keyframes, in the same
 * shape probeMp4 gives for an MP4 so one reader serves both. Only H.264 (what
 * OBS writes); anything else resolves null and export uses the player.
 */
export async function probeMkvVideo(src) {
  const size = src.size || 0;
  let buf = new Uint8Array(0), bufAt = 0;
  const ensure = async (pos, n) => {
    if (pos >= bufAt && pos + n <= bufAt + buf.length) return true;
    const end = size ? Math.min(size, pos + Math.max(CHUNK, n)) : pos + Math.max(CHUNK, n);
    if (end <= pos) return false;
    buf = await src.read(pos, end);
    bufAt = pos;
    return pos + n <= bufAt + buf.length;
  };
  let scale = 1e6, track = null, clusterTime = 0, pos = 0, steps = 0;
  const samples = [];
  while (true) {
    if (!(await ensure(pos, 12))) break;
    const b = buf, p = pos - bufAt;
    const id = readId(b, p); const sz = id && readSize(b, p + id.len);
    if (!id || !sz) break;
    const body = pos + id.len + sz.len;
    if (CONTAINERS.has(id.v)) { pos = body; continue; }
    if (id.v === ID.Info || id.v === ID.Tracks || id.v === ID.Timecode) {
      if (sz.v < 0 || !(await ensure(body, sz.v))) break;
      const q = body - bufAt;
      if (id.v === ID.Timecode) clusterTime = uint(buf, q, sz.v);
      else if (id.v === ID.Info) { for (const f of children(buf, q, q + sz.v)) if (f.id === ID.TimecodeScale) scale = uint(buf, f.start, f.size); }
      else if (!track) {
        const v = parseTracks(buf, q, q + sz.v).find(t => t.type === 1);
        if (!v || v.codecId !== 'V_MPEG4/ISO/AVC' || !v.priv || v.priv.length < 4) return null;
        const hex = (x) => x.toString(16).padStart(2, '0');
        track = { ...v, codec: `avc1.${hex(v.priv[1])}${hex(v.priv[2])}${hex(v.priv[3])}` };
      }
      pos = body + sz.v;
      continue;
    }
    if ((id.v === ID.SimpleBlock || id.v === ID.Block) && track && sz.v > 4) {
      if (!(await ensure(body, 16))) break;
      const q = body - bufAt;
      const tn = readSize(buf, q);
      if (tn && tn.v === track.number) {
        const rel = (buf[q + tn.len] << 8 | buf[q + tn.len + 1]) << 16 >> 16;
        const flags = buf[q + tn.len + 2];
        if ((flags & 0x06) === 0) {
          samples.push({
            offset: body + tn.len + 3, size: sz.v - tn.len - 3,
            cts: Math.round((clusterTime + rel) * scale / 1000), duration: 0,
            // SimpleBlock marks keyframes; a Block (inside a BlockGroup) does not, so treat it as one only if it is the first.
            sync: id.v === ID.SimpleBlock ? !!(flags & 0x80) : samples.length === 0,
          });
        }
      }
      pos = body + sz.v;
    } else {
      if (sz.v < 0) break;
      pos = body + sz.v;
    }
    if (++steps % 4000 === 0) await new Promise(r => setTimeout(r, 0));
  }
  if (!track || !samples.length) return null;
  const vw = track.width, vh = track.height;
  return { codec: track.codec, description: track.priv, timescale: 1e6, offset: 0, width: vw || 0, height: vh || 0, samples };
}
