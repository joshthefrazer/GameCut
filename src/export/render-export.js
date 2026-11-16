import { Muxer, ArrayBufferTarget, StreamTarget } from '../../vendor/mp4-muxer.mjs';
import { Compositor } from '../engine/compositor.js';
import { assets } from '../media/asset-store.js';
import { dequeued } from './wait.js';
import { mixTimeline, audibleClips } from '../audio/graph.js';
import { junctions, transitionSpan } from '../engine/transitions.js';

/**
 * Offline renderer: timeline → MP4 (H.264 video; AAC audio where the machine
 * can encode it, Opus otherwise).
 *
 * Frames are rendered one at a time rather than screen-recorded. That is the
 * whole point — a capture of the preview would inherit every stutter and
 * dropped frame from playback, and could only ever run in real time. Every
 * output frame is composited at full project resolution and fed to the encoder
 * one at a time, so nothing is ever dropped.
 *
 * How the source is walked is a genuine trade, and `frameAccuracy` picks it:
 *
 *   'fast'   Play the footage forward and take the frame the decoder has
 *            reached. Measured ~3x quicker end to end, because a seek throws
 *            away the decode pipeline and rebuilds it from the last keyframe —
 *            187ms a frame against 0.14ms to encode one. The frame chosen can
 *            sit up to about one source frame from the requested moment
 *            (16ms on 60fps footage), so the file is not bit-identical to the
 *            exact path and can differ slightly between machines.
 *
 *   'exact'  Seek to every frame. Slower, and the only mode that guarantees
 *            the same bytes on every computer.
 *
 * Neither mode drops or duplicates frames, and both are unaffected by how busy
 * the machine is while rendering.
 */

/**
 * The H.264 levels, and what each one is allowed to do.
 *
 * A level is not just "how big a picture" — it also caps the BITRATE. That is
 * what the previous version of this function missed: it picked a level from the
 * resolution alone, so a 1080p30 export was handed level 4.0, whose ceiling is
 * 20 Mbps. Ask for 80 Mbps and the encoder is being asked for something its own
 * codec string forbids. What comes back is not an error — it is a file quietly
 * encoded at a fraction of what was asked for, which looks like Strike simply
 * ignoring the setting. Recordings from Medal and OBS routinely sit at 50-100
 * Mbps, so every export from that footage was being squeezed through a 20 Mbps
 * pipe and handed back looking worse than the source.
 *
 * MaxMBPS  macroblocks per second   — resolution × frame rate
 * MaxFS    macroblocks per frame    — resolution alone
 * MaxBR    kbit/s, for Baseline/Main/Extended. High profile gets 1.25× this,
 *          which is applied below rather than stored twice.
 *
 * Figures are from ITU-T H.264 Table A-1.
 */
const H264_LEVELS = [
  { name: '3.0', idc: '1e', maxMBPS: 40500, maxFS: 1620, maxBR: 10000 },
  { name: '3.1', idc: '1f', maxMBPS: 108000, maxFS: 3600, maxBR: 14000 },
  { name: '3.2', idc: '20', maxMBPS: 216000, maxFS: 5120, maxBR: 20000 },
  { name: '4.0', idc: '28', maxMBPS: 245760, maxFS: 8192, maxBR: 20000 },
  { name: '4.1', idc: '29', maxMBPS: 245760, maxFS: 8192, maxBR: 50000 },
  { name: '4.2', idc: '2a', maxMBPS: 522240, maxFS: 8704, maxBR: 50000 },
  { name: '5.0', idc: '32', maxMBPS: 589824, maxFS: 22080, maxBR: 135000 },
  { name: '5.1', idc: '33', maxMBPS: 983040, maxFS: 36864, maxBR: 240000 },
  { name: '5.2', idc: '34', maxMBPS: 2073600, maxFS: 36864, maxBR: 240000 },
  { name: '6.0', idc: '3c', maxMBPS: 4177920, maxFS: 139264, maxBR: 240000 },
  { name: '6.1', idc: '3d', maxMBPS: 8355840, maxFS: 139264, maxBR: 480000 },
  { name: '6.2', idc: '3e', maxMBPS: 16711680, maxFS: 139264, maxBR: 800000 },
];

/** The highest bitrate any H.264 level can carry, in bits/sec (6.2, High). */
export const MAX_H264_BITRATE = 800_000 * 1000 * 1.25;

/**
 * The lowest level that can carry this picture at this bitrate.
 *
 * Lowest rather than highest on purpose: a level is a promise to the player
 * about how much work decoding will be, and overstating it turns away hardware
 * decoders that could have handled the file perfectly well.
 *
 * `highProfile` is separate because High profile's 1.25× bitrate allowance is
 * the difference between 1080p at 62 Mbps needing level 4.2 and needing 5.0.
 */
export function levelFor(width, height, fps, bitrate, highProfile = true) {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = fs * fps;
  const kbit = (bitrate || 0) / 1000;
  const scale = highProfile ? 1.25 : 1;
  return H264_LEVELS.find(l =>
    l.maxFS >= fs && l.maxMBPS >= mbps && l.maxBR * scale >= kbit) || null;
}

/** H.264 profile/level candidates, best first. Level must cover the whole ask. */
function codecCandidates(width, height, fps, bitrate) {
  const high = levelFor(width, height, fps, bitrate, true);
  const main = levelFor(width, height, fps, bitrate, false);
  const out = [];
  // High first: it is both the better compressor and the more generous level.
  if (high) out.push(`avc1.6400${high.idc}`);
  if (main) out.push(`avc1.4d40${main.idc}`, `avc1.42e0${main.idc}`);
  // Only when NOTHING in the table can carry the ask: offer the ceiling, so an
  // absurd request still produces the best file the format allows. Appending
  // these unconditionally would be worse than useless — a 720p draft would be
  // labelled level 6.2 (turning away hardware decoders that could play it), and
  // a request the encoder refused at the right level would quietly succeed at
  // the wrong one, which is the very bug this file was rewritten to stop.
  if (!out.length) {
    const top = H264_LEVELS[H264_LEVELS.length - 1];
    out.push(`avc1.6400${top.idc}`, `avc1.4d40${top.idc}`);
  }
  return [...new Set(out)];
}

async function pickVideoCodec(config) {
  for (const codec of codecCandidates(
    config.width, config.height, config.framerate, config.bitrate)) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ ...config, codec });
      if (supported) return codec;
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * The two ways this machine can encode H.264, best first.
 *
 * Measured on the owner's PC (Windows, Intel GPU), through this same API:
 *
 *   · Electron 33: the hardware encoder refused every 60 fps config, so every
 *     export ran on OpenH264, the software fallback. OpenH264 ignores the
 *     bitrate it is given — asked for 16 or 80 Mbps it produced 243-270 Mbps
 *     on hard footage — and refuses anything above about 288.
 *   · Electron 44: the hardware encoder takes 1080p60, 1440p60, 4K60 and
 *     1080p120, and honours the bitrate ONLY in 'constant' mode (asked 80,
 *     produced 82.9). In 'variable' mode it drifts to whatever it likes
 *     (asked 16 or 80 → ~28 Mbps; asked 200 → 55).
 *
 * So hardware + constant is the path that does what the dialog says, and it is
 * tried first. Software is the fallback for when the hardware will not take
 * the job at all — and it is announced, because on that path nobody, Strike
 * included, can promise the file size. (Measured on Linux too, where OpenH264
 * is the only encoder: asked for 4 or 16 Mbps on noise, it wrote 67.)
 */
const PATHS = [
  { path: 'hardware', honours: true,
    options: [
      { hardwareAcceleration: 'prefer-hardware', bitrateMode: 'constant' },
      // Some graphics cards (several AMD and Intel ones) refuse constant mode
      // but encode happily in variable mode. Falling straight to the
      // processor for that made their exports several times slower than they
      // needed to be; the graphics card in variable mode is far better.
      { hardwareAcceleration: 'prefer-hardware', bitrateMode: 'variable' },
      { hardwareAcceleration: 'prefer-hardware' },
    ] },
  { path: 'software', honours: false,
    options: [
      { hardwareAcceleration: 'prefer-software', bitrateMode: 'constant' },
      { hardwareAcceleration: 'prefer-software' },
      { hardwareAcceleration: 'no-preference' },
    ] },
];

/** Codec string + options for this exact config on this path, or null. */
async function accepts(base, options, bitrate) {
  for (const o of options) {
    const codec = await pickVideoCodec({ ...base, ...o, bitrate });
    if (codec) return { codec, options: o };
  }
  return null;
}

/**
 * The most this path will take at this size and frame rate, up to `want`.
 *
 * Asked of the encoder rather than assumed: the ceiling depends on the GPU, the
 * driver and the resolution, and the encoder is the only reliable source. A
 * binary search over isConfigSupported — a dozen cheap questions — replaces the
 * old loop that halved the bitrate on any refusal and then reported the halving
 * as if it were the machine's limit.
 */
async function bestRate(base, options, want) {
  const ok = await accepts(base, options, want);
  if (ok) return { ...ok, bitrate: want, capped: false };
  const floor = await accepts(base, options, 1_000_000);
  if (!floor) return null;                 // this path refuses the size, not the rate
  let lo = 1_000_000, hi = want, best = floor;
  while (hi - lo > 1_000_000) {
    const mid = Math.round((lo + hi) / 2 / 500_000) * 500_000;
    const r = await accepts(base, options, mid);
    if (r) { lo = mid; best = r; } else hi = mid;
  }
  return { ...best, bitrate: lo, capped: true };
}

/**
 * Prove a config works by encoding one frame with it.
 *
 * isConfigSupported is a promise about the config, not about the device: a
 * hardware encoder can say yes and then fail to start (driver busy, another
 * app holding the session). Finding that out on frame one of a twenty-minute
 * render is the wrong time — so it is found out here, in a few milliseconds,
 * and the software path takes over.
 */
async function smokeTest(config) {
  let got = false, err = null;
  const enc = new VideoEncoder({ output: () => { got = true; }, error: (e) => { err = e; } });
  try {
    enc.configure(config);
    const c = new OffscreenCanvas(config.width, config.height);
    c.getContext('2d').fillRect(0, 0, 2, 2);
    const f = new VideoFrame(c, { timestamp: 0, duration: 1 });
    enc.encode(f, { keyFrame: true });
    f.close();
    await enc.flush();
  } catch (e) { err = err || e; }
  try { if (enc.state !== 'closed') enc.close(); } catch { /* closed */ }
  return got && !err;
}

/**
 * Decide how this export will be encoded, before anything is rendered.
 *
 * Returns { codec, config, path, honours, bitrate, requested, capped } — or
 * null when nothing on this machine can encode H.264 at this size at all.
 *
 * `bitrate` is never more than the chosen path accepts. Asking for more used to
 * be how "Best quality" produced a warning on every export: it tracks the
 * footage, 4K doubles it, and a 120 Mbps recording asked the encoder for 300.
 *
 * Exported so the export dialog can show the real figure before you press
 * Export, rather than a request the encoder will change. Cached per size, rate
 * and bitrate, because the answer does not change while the app is open.
 */
const planCache = new Map();
export async function planVideoEncoder({ width, height, fps, bitrate }) {
  const requested = Math.min(MAX_H264_BITRATE, Math.max(1_000_000, Math.round(bitrate || 0)));
  const key = `${width}x${height}@${fps}:${requested}`;
  if (!planCache.has(key)) planCache.set(key, makePlan(width, height, fps, requested));
  return planCache.get(key);
}

async function makePlan(width, height, fps, requested) {
  const base = { width, height, framerate: fps, latencyMode: 'quality' };
  for (const p of PATHS) {
    const r = await bestRate(base, p.options, requested);
    if (!r) continue;
    const config = { ...base, ...r.options, bitrate: r.bitrate };
    if (!(await smokeTest({ ...config, codec: r.codec }))) continue;
    return { codec: r.codec, config, path: p.path, honours: p.honours,
             bitrate: r.bitrate, requested, capped: r.capped };
  }
  return null;
}

/**
 * What the plan means for the file, in plain words — or '' when there is
 * nothing to say. Only things that actually happened produce a sentence.
 */
export function encoderNote(plan, { width, height, fps } = {}) {
  if (!plan) return '';
  if (plan.path === 'software') {
    return 'This computer\'s graphics chip can\'t encode this video, so Strike is using its '
      + 'slower built-in encoder. That encoder doesn\'t stick to the quality setting, so '
      + 'Strike can\'t control the file size: it may come out much bigger or smaller than '
      + 'the estimate.';
  }
  if (plan.capped) {
    return `This computer's encoder tops out at ${Math.round(plan.bitrate / 1e6)} Mbps for `
      + `${width}×${height}${fps ? ` at ${fps} fps` : ''}, so that's what this video uses `
      + `(${Math.round(plan.requested / 1e6)} Mbps was asked for).`;
  }
  return '';
}

/**
 * Which audio codec this machine can actually *encode*, and at what bitrates.
 *
 * Decoding and encoding are different capabilities: Chromium on Linux plays AAC
 * happily but cannot produce it, while Windows usually can via the OS encoder.
 * AAC is preferred because every player and platform takes it; Opus in MP4 is a
 * valid, well-supported fallback (YouTube accepts it) rather than losing sound
 * altogether. Asking at runtime is the only reliable way to know.
 *
 * Bitrates are asked one at a time, because Windows' own AAC encoder (Media
 * Foundation) is documented to take only 96, 128, 160 and 192 kbps — offering
 * 256 or 320 there is a choice the encoder refuses or quietly overrides.
 */
const AUDIO_RATES = [96_000, 128_000, 160_000, 192_000, 256_000, 320_000];
let audioCaps = null;
export function audioCapabilities() {
  if (!audioCaps) audioCaps = probeAudio();
  return audioCaps;
}

async function probeAudio() {
  const options = [
    { muxer: 'aac', encoder: 'mp4a.40.2', name: 'AAC' },
    { muxer: 'opus', encoder: 'opus', name: 'Opus' },
  ];
  if (typeof AudioEncoder === 'undefined') return { codec: null, bitrates: [] };
  for (const o of options) {
    const rates = [];
    for (const b of AUDIO_RATES) {
      try {
        const { supported } = await AudioEncoder.isConfigSupported({
          codec: o.encoder, sampleRate: 48000, numberOfChannels: 2, bitrate: b,
        });
        if (supported) rates.push(b);
      } catch { /* not this one */ }
    }
    if (rates.length) return { codec: o, bitrates: rates };
  }
  return { codec: null, bitrates: [] };
}

/** The bitrate this machine's audio encoder takes that is closest to, and not above, the ask. */
export function nearestAudioRate(caps, want) {
  const list = caps?.bitrates || [];
  if (!list.length) return 0;
  const under = list.filter(b => b <= want);
  return under.length ? under[under.length - 1] : list[0];
}

/** Feature check with a message a human can act on. */
export function exportSupport() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return { ok: false, reason: 'This build has no video encoder (WebCodecs missing).' };
  }
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return { ok: true, audio: false, reason: 'Audio encoder unavailable — video will export silent.' };
  }
  return { ok: true, audio: true };
}

/**
 * Render the project to an MP4.
 *
 * @param {object}   o
 * @param {object}   o.store        project store
 * @param {number}   o.width        output width  (even number)
 * @param {number}   o.height       output height (even number)
 * @param {number}   o.fps
 * @param {number}   o.vBitrate     bits/sec
 * @param {number}   o.aBitrate     bits/sec
 * @param {Function} o.onProgress   ({phase, done, total, percent}) => void
 * @param {Function} o.shouldCancel () => boolean, polled every frame
 * @param {'fast'|'exact'} o.frameAccuracy  how the source is walked — see below
 * @param {object}   [o.sink]       { write(chunk: Uint8Array, position) → Promise }
 *                                  — when given, the file is streamed to it as
 *                                  it is made and never held in memory
 * @returns {Promise<Uint8Array|{bytes:number}|null>}
 *   without a sink: the file's bytes; with one: how many bytes were written;
 *   null if cancelled.
 *
 * ── Why a sink ────────────────────────────────────────────────
 * The whole file used to live in memory three or four times over: the muxer's
 * in-memory "fast start" buffer, the ArrayBuffer it was copied into, and the
 * copy sent to the main process to save. A 20-minute "Recommended" export is
 * ~2.5 GB, so the renderer peaked near 8 GB and crashed at 99%, throwing the
 * whole render away. Now each piece is written to disk at its position as soon
 * as the muxer has it, and memory stays flat however long the video is.
 *
 * The streamed file puts its index (moov) at the END. YouTube, TikTok, Windows'
 * Media Player and Films & TV all read that without complaint — it only
 * matters to a web player starting a download before it has finished, which is
 * not what an export is for. "Fragmented" MP4 was the other option; it was not
 * chosen because several Windows tools still show a fragmented file's length
 * as zero or refuse to seek in it.
 */
export async function renderToMp4({
  store, width, height, fps, vBitrate, aBitrate, onProgress, shouldCancel,
  frameAccuracy = 'fast', sink = null, profile = null,
}) {
  const support = exportSupport();
  if (!support.ok) throw new Error(support.reason);

  // Encoders reject odd dimensions.
  width = Math.max(2, Math.round(width / 2) * 2);
  height = Math.max(2, Math.round(height / 2) * 2);

  // A NaN or Infinity length (media with no duration in its header) would
  // mean an export that never ends. The importer refuses such media now; this
  // is the backstop for a document that got one some other way.
  const timeline = Number.isFinite(store.rt.duration) ? store.rt.duration : 0;
  if (!(timeline > 0) && !Number.isFinite(store.rt.duration)) {
    throw new Error('The timeline has no definite length — a clip on it has an unknown duration.');
  }
  const duration = Math.max(1 / fps, timeline);
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const report = (phase, done, total) =>
    onProgress?.({ phase, done, total, percent: total ? Math.min(100, (done / total) * 100) : 0 });

  /* ── Video encoder: decided before anything is written ──────────── */
  report('encoder', 0, 1);
  const plan = await planVideoEncoder({ width, height, fps, bitrate: vBitrate });
  if (!plan) {
    const e = new Error(`This computer has no H.264 encoder that can make a ${width}×${height} `
      + `${fps} fps video.`);
    e.kind = 'encoder';
    throw e;
  }

  /* ── Audio: which codec, which bitrate, and is there anything to mix ── */
  const audible = support.audio ? audibleClips(store).filter(c => c.src) : [];
  const caps = audible.length ? await audioCapabilities() : null;
  const audioCodec = caps?.codec || null;
  const audioRate = audioCodec ? nearestAudioRate(caps, aBitrate || 192_000) : 0;
  const warnings = [];
  if (audible.length && !audioCodec) warnings.push('This computer has no audio encoder, so the video has no sound.');

  // Always announced, not only when something went wrong: this is the one
  // moment the abstract request ("80 Mbps") becomes a concrete decision (which
  // path, which profile and level, what the encoder was actually configured
  // at), and it is what the dialog and the export suite both read.
  onProgress?.({
    phase: 'encoder',
    codec: plan.codec,
    path: plan.path,
    honours: plan.honours,
    capped: plan.capped,
    hardwareAcceleration: plan.config.hardwareAcceleration,
    bitrateMode: plan.config.bitrateMode || null,
    requested: plan.requested,
    bitrate: plan.bitrate,
    audioCodec: audioCodec?.name || null,
    audioBitrate: audioRate,
    note: encoderNote(plan, { width, height, fps }),
    done: 0, total: 1, percent: 0,
  });

  if (shouldCancel?.()) return null;

  /* ── Where the bytes go ────────────────────────────────────────── */
  let writeErr = null;
  let inflight = 0;
  let written = 0;
  let writing = Promise.resolve();
  const target = sink
    ? new StreamTarget({
      chunked: true,
      chunkSize: 8 * 1024 * 1024,
      onData: (data, position) => {
        // Writes are chained, so the main process sees them in order and the
        // number in flight is known — that is the backpressure below.
        inflight += data.byteLength;
        written = Math.max(written, position + data.byteLength);
        writing = writing.then(async () => {
          if (!writeErr) await sink.write(data, position);
        }).catch((e) => { writeErr = writeErr || saveError(e); })
          .finally(() => { inflight -= data.byteLength; });
      },
    })
    : new ArrayBufferTarget();
  const failIfWriteFailed = () => { if (writeErr) throw writeErr; };
  const drain = async (limit) => {
    while (inflight > limit) {
      await new Promise(r => setTimeout(r, 2));
      failIfWriteFailed();
    }
  };

  const muxer = new Muxer({
    target,
    // In memory (tests, or no save bridge): index at the front. Streamed:
    // index at the end — see above.
    fastStart: sink ? false : 'in-memory',
    video: { codec: 'avc', width, height },
    ...(audioCodec ? { audio: { codec: audioCodec.muxer, numberOfChannels: 2, sampleRate: 48000 } } : {}),
  });

  /*
   * The video encoder, which can be started again.
   *
   * A hardware encoder can fail in the middle of a long export — the graphics
   * driver resets, the machine sleeps, another program takes the encoder — and
   * until now that threw the whole render away. The error is remembered here;
   * the loop below notices it, makes a new encoder with the same settings and
   * carries on from the first frame the old one never handed back. `lastOutTs`
   * is the newest picture the muxer already has, so nothing is written twice and
   * timestamps keep rising.
   */
  let encoderErr = null;          // set by the CURRENT encoder's error callback
  let lastOutTs = -1;             // µs timestamp of the newest chunk given to the muxer
  let restarts = 0;
  let needKey = false;            // the next picture must be a keyframe (a new encoder starts one)
  let videoEncoder = null;
  const makeEncoder = () => {
    const generation = restarts;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (enc !== videoEncoder) return;            // a retired encoder's late output
        lastOutTs = Math.max(lastOutTs, chunk.timestamp);
        // The file's codec description (the avcC box) is the FIRST encoder's, so
        // a restarted encoder's own copy is not offered to the muxer. Same settings,
        // same machine, so it matches; this just makes sure of it.
        muxer.addVideoChunk(chunk, generation > 0 && meta ? { ...meta, decoderConfig: undefined } : meta);
      },
      error: (e) => { if (enc === videoEncoder) encoderErr = encoderErr || e; },
    });
    enc.configure({ ...plan.config, codec: plan.codec });
    return enc;
  };
  videoEncoder = makeEncoder();

  /* ── Audio: mixed and encoded a stretch at a time, alongside the picture ─
     The whole mix used to be one OfflineAudioContext the length of the video
     — 23 MB a minute of output plus a float copy of every source — rendered
     before the first frame. Now it is ten seconds at a time, just ahead of
     the picture, so the file is interleaved and memory does not grow with
     length. */
  const audio = audioCodec
    ? audioStream({ store, duration, codec: audioCodec.encoder, bitrate: audioRate,
                    muxer, warnings })
    : null;

  /* ── Video: composite every frame at full resolution ───────────── */
  const canvas = document.createElement('canvas');
  const comp = new Compositor(store, canvas, { fixedSize: { w: width, h: height } });

  const GOP = Math.max(1, Math.round(fps * 2));     // keyframe every ~2s
  const frameDur = 1e6 / fps;                        // microseconds

  /**
   * How far the source may sit from the requested time before the frame is
   * re-fetched with a real seek.
   *
   * Half an output frame, and never more than 1/120s — tight enough that no
   * source running at a sane frame rate can slip a whole frame inside it.
   *
   * This was briefly loosened to 1/60 on the theory that fewer corrective seeks
   * would speed the render up, since a seek costs roughly thirty ordinary
   * frames. Measured across repeated runs the difference was lost in the noise
   * (2.5-2.9x either way), so the looser value bought nothing and gave up
   * accuracy for it. Left tight.
   */
  const tol = Math.min(1 / (fps * 2), 1 / 120);
  let corrections = 0;
  const startedAt = performance.now();
  let finished = false;

  /*
   * Exact frames from WebCodecs for every MP4 clip that allows it (see
   * frame-reader.js); anything else keeps the <video> element path.
   */
  const { Mp4FrameReader, forgetProbes, READER_STATS, resetReaderStats } = await import('./frame-reader.js');
  resetReaderStats();
  /*
   * One reader per CLIP, not per file: two clips of the same recording on
   * screen at once (a replay over the live moment, a facecam layer) would
   * otherwise drag one decoder back and forth every frame. A reader is closed
   * once its clip is over, so a recording cut into fifty pieces never has
   * fifty decoders open.
   */
  const readers = new Map();       // clipId -> reader | null
  const readerFor = async (clip) => {
    const a = assets.get(clip.assetId);
    if (!a || a.kind !== 'video') return null;
    if (!readers.has(clip.id)) readers.set(clip.id, await Mp4FrameReader.open(a));
    return readers.get(clip.id);
  };

  /*
   * One picture for a clip, from its reader — and a second chance when the reader fails.
   *
   * A decoder can stumble mid-recording (a damaged frame, the graphics card
   * resetting). A reader that failed used to be thrown away for the rest of the
   * export and its clip handed to the <video> player, which seeks on every frame
   * and is many times slower. Now the first failure starts a fresh reader at the
   * right keyframe, the second one asks for the processor's decoder instead, and
   * only a clip that fails three times goes to the player — with a note in the
   * result, so a slow or imperfect clip is never a surprise.
   */
  const failures = new Map();      // clipId -> times its reader failed
  let usedPlayer = false;
  const pictureFor = async (clip, st) => {
    let r = await readerFor(clip);
    while (r) {
      try {
        // Test hook (qa/speed-test.mjs): fail this many reads to exercise the retry. Never set by the app.
        if (globalThis.__strikeFailReader > 0) { globalThis.__strikeFailReader--; throw new Error('test: simulated decoder failure'); }
        return await r.canvasAt(st);
      } catch (e) {
        r.close();
        const n = (failures.get(clip.id) || 0) + 1;
        failures.set(clip.id, n);
        console.warn(`[export] frame reader failed (${n}) for ${clip.name || clip.id}`, e);
        if (n > 2) {
          readers.set(clip.id, null);
          if (!usedPlayer) {
            usedPlayer = true;
            warnings.push('Part of your footage could not be read the fast way, so Strike used a slower method for it. '
              + 'The picture is the same, but the render took longer.');
          }
          return null;
        }
        const a = assets.get(clip.assetId);
        r = await Mp4FrameReader.open(a, { software: n === 2 });
        readers.set(clip.id, r);
      }
    }
    return null;
  };
  /*
   * How long each clip's reader must stay open.
   *
   * A transition is centred on its cut, so the OUTGOING clip is still drawn for
   * half the transition after its own end (see engine/transitions.js). The reader
   * used to be closed 0.05 s after the clip's end and marked finished for good,
   * so for the rest of every transition that clip fell back to the <video>
   * player: a seek per frame, each one re-decoding from the last keyframe. That
   * is the "exports with transitions crawl" slowness, and when a seek never
   * settled the export sat on a five-second timeout for a single frame.
   */
  const holdUntil = new Map();
  for (const j of junctions(store.doc)) {
    const span = transitionSpan(j.prev, j.next);
    if (span) holdUntil.set(j.prev.id, Math.max(holdUntil.get(j.prev.id) ?? 0, span.to));
  }
  const allClips = new Map();
  for (const tr of store.doc.tracks) for (const c of tr.clips) allClips.set(c.id, c);
  const retire = (t) => {
    for (const [id, r] of readers) {
      if (!r) continue;
      const c = allClips.get(id);
      // (__strikeLegacyRetire is a test switch for qa/speed-test.mjs: the old rule, no transition hold.)
      const end = c ? (globalThis.__strikeLegacyRetire ? c.start + c.duration : Math.max(c.start + c.duration, holdUntil.get(id) ?? 0)) : -Infinity;
      if (!c || end < t - 0.05) { r.close(); readers.set(id, null); }
    }
  };
  const srcTime = (clip, t) => {
    const a = assets.get(clip.assetId);
    const raw = Math.max(0, (clip.inPoint || 0) + (t - clip.start) * (clip.speed || 1));
    return Math.min(raw, Math.max(0, (a?.duration || Infinity) - 1 / 60));
  };

  /*
   * Where the time goes. Filled in only when the caller passes `profile`
   * (the benchmark does; the dialog does not), so a normal export pays for one
   * `performance.now()` per stage and nothing else.
   */
  const stage = profile ? (profile.ms = { audio: 0, decode: 0, fallback: 0, render: 0, encode: 0, backpressure: 0, drain: 0 }) : null;
  let tick = 0;
  const lap = (name) => {
    if (!stage) return;
    const n = performance.now();
    stage[name] += n - tick;
    tick = n;
  };
  const wallStart = performance.now();

  /**
   * Replace a failed encoder and say which frame to carry on from.
   *
   * Gives up (and throws the encoder's own error) after three restarts, so a
   * machine that cannot encode at all still fails promptly with a real message
   * rather than looping.
   */
  const restartEncoder = () => {
    const why = encoderErr;
    if (restarts >= 3) throw why;
    restarts++;
    encoderErr = null;
    try { if (videoEncoder.state !== 'closed') videoEncoder.close(); } catch { /* already gone */ }
    videoEncoder = makeEncoder();
    needKey = true;
    console.warn('[export] video encoder failed; restarted it', why);
    if (restarts === 1) {
      warnings.push('The video encoder stopped part-way through. Strike restarted it and carried on, '
        + 'so the picture may change slightly at that point.');
    }
    // Pictures the old encoder never handed back are gone: make them again. The
    // readers have moved on past them, so each is reopened where it is next needed.
    for (const r of readers.values()) r?.close();
    readers.clear();
    return lastOutTs < 0 ? 0 : Math.min(totalFrames, Math.round(lastOutTs / frameDur) + 1);
  };

  try {
    let i = 0;
    for (;;) {
    while (i < totalFrames) {
      if (shouldCancel?.()) return null;
      // Test hook (qa/speed-test.mjs): pretend the encoder failed at this frame, once. Never set by the app.
      if (globalThis.__strikeFailEncoderAt === i && !encoderErr) {
        globalThis.__strikeFailEncoderAt = -1;
        encoderErr = new Error('test: simulated encoder failure');
      }
      if (encoderErr) i = restartEncoder();
      failIfWriteFailed();

      const t = i / fps;
      if (stage) tick = performance.now();
      if (audio) await audio.until(t + 2);
      lap('audio');

      /**
       * Walk the source to this frame.
       *
       * `streamTo` plays the footage forward and only falls back to a seek when
       * it overshoots — the same picture a seek would have produced, roughly
       * thirty times faster, because export moves through time in order and a
       * decoder is built for exactly that. `seekExact` is still what runs
       * underneath whenever the step is not a step: the first frame, a cut to a
       * different clip, or a correction.
       */
      // Includes the outgoing side of any transition running at this frame —
      // that clip is painted but is not "active", so asking activeClips alone
      // left its decoder unprepared.
      if (i % 30 === 0) retire(t);
      const needed = comp.clipsNeededAt(t);
      const clips = [];
      comp.pool.overrides.clear();
      /*
       * Layers that show the SAME moment of the SAME recording share one decode.
       * A vertical short with a facecam cut out of the gameplay, or a replay laid
       * over the live shot, is two clips of one file at one instant: decoding the
       * picture twice (and copying it twice) was pure waste. The key is the
       * source time to a tenth of a millisecond, so clips that merely overlap in
       * time but sit at different places in the file never share.
       */
      const shared = new Map();
      for (const c of needed) {
        const st = srcTime(c, t);
        const key = `${c.assetId}|${Math.round(st * 1e4)}`;
        let pic = globalThis.__strikeNoShare ? null : (shared.get(key) || null);   // (test switch: the old one-decode-per-layer)
        if (!pic) {
          pic = await pictureFor(c, st);
          if (pic) shared.set(key, pic);
        }
        if (pic) comp.pool.overrides.set(c.id, pic); else clips.push(c);
      }
      lap('decode');
      if (clips.length) {
        if (i === 0 || frameAccuracy === 'exact') await comp.pool.seekExact(clips, t);
        else corrections += await comp.pool.streamTo(clips, t, { tolerance: tol });
      }
      lap('fallback');

      comp.render(t, false);
      lap('render');

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * frameDur),
        duration: Math.round(frameDur),
      });
      let queued = true;
      try {
        videoEncoder.encode(frame, { keyFrame: needKey || i % GOP === 0 });
        needKey = false;
      } catch (e) {
        // The encoder closed itself between the check above and now.
        queued = false;
        encoderErr = encoderErr || e;
      }
      frame.close();
      lap('encode');
      // Not queued: the top of the loop restarts the encoder and winds `i` back.
      if (!queued) continue;

      // Backpressure: without this the queue grows until memory runs out on a
      // long timeline — the encoder's queue, and the disk's.
      while (videoEncoder.encodeQueueSize > 8 && !encoderErr) {
        await dequeued(videoEncoder);
      }
      lap('backpressure');
      if (sink) await drain(48 * 1024 * 1024);
      lap('drain');

      if (i % 5 === 0 || i === totalFrames - 1) {
        // Frames a second, so a slow render says why it is slow rather than
        // only how long is left.
        const rate = (i + 1) / ((performance.now() - startedAt) / 1000);
        onProgress?.({
          phase: 'video', done: i + 1, total: totalFrames,
          percent: Math.min(100, ((i + 1) / totalFrames) * 100),
          fps: rate, seeking: comp.pool.streamSuspend > 0,
          fastDecode: READER_STATS.used, gpuDecode: READER_STATS.hardware, gpuEncode: plan?.path === 'hardware',
        });
      }
      i++;
    }

    if (stage) tick = performance.now();
    try { await videoEncoder.flush(); } catch (e) { encoderErr = encoderErr || e; }
    // Failed while finishing: start again and redo whatever it had not handed back.
    if (!encoderErr) break;
    i = restartEncoder();
    }
    if (profile) {
      lap('backpressure');
      profile.frames = totalFrames;
      profile.loopMs = performance.now() - wallStart;
      profile.corrections = corrections;
      profile.path = plan.path;
      profile.readers = [...readers.values()].filter(Boolean).length;
      profile.readerStats = { ...READER_STATS };
    }
    if (corrections) {
      // Not a failure — the backstop doing its job. Worth seeing, because a
      // high count means the machine could not follow the source and the
      // render fell back towards the old seek-everything speed.
      console.info(`[export] ${corrections}/${totalFrames} frames needed a corrective seek`);
    }

    if (audio) {
      report('encoding audio', 0, 1);
      await audio.finish(() => shouldCancel?.());
      report('encoding audio', 1, 1);
    }

    if (shouldCancel?.()) return null;

    muxer.finalize();
    if (sink) {
      await writing;
      failIfWriteFailed();
    }
    finished = true;
    onProgress?.({ phase: 'done', done: 1, total: 1, percent: 100, warnings: warnings.slice() });
    return sink ? { bytes: written, warnings } : new Uint8Array(muxer.target.buffer);
  } finally {
    try { if (videoEncoder.state !== 'closed') videoEncoder.close(); } catch { /* already closed */ }
    audio?.close();
    // Leave nothing playing: a cancelled export would otherwise keep decoding.
    comp.pool.endStream();
    comp.pool.overrides.clear();
    for (const r of readers.values()) r?.close();
    forgetProbes();
    comp.dispose();
    // A render that stopped early still has writes in flight; let them land
    // (or fail) before the caller deletes the half-written file.
    if (!finished && sink) await writing.catch(() => {});
  }
}

/** A failed write, worded for a person and marked as a saving problem. */
function saveError(e) {
  const err = new Error(String(e?.message || e || 'The video could not be written to disk.')
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  err.kind = 'save';
  return err;
}

/**
 * The export's soundtrack, mixed and encoded on demand.
 *
 * `until(t)` makes sure everything up to `t` seconds has been handed to the
 * muxer; `finish()` does the rest. A mixing failure part-way is not allowed to
 * fail the video — it is recorded in `warnings`, which the dialog shows, so a
 * file with missing sound is never handed over without a word.
 */
function audioStream({ store, duration, codec, bitrate, muxer, warnings }) {
  const SR = 48000;
  let err = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { err = e; },
  });
  enc.configure({ codec, sampleRate: SR, numberOfChannels: 2, bitrate });

  let doneTo = 0;                 // seconds mixed and handed to the encoder
  let broken = false;
  const mixer = mixTimeline(store, duration, { sampleRate: SR, segment: 10 });

  const encodeBuffer = async (buf, frame0) => {
    const CHUNK = 4096;
    const left = buf.getChannelData(0);
    const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
    for (let off = 0; off < buf.length; off += CHUNK) {
      if (err) throw err;
      const n = Math.min(CHUNK, buf.length - off);
      // f32-planar wants every channel laid end to end in one array.
      const planar = new Float32Array(n * 2);
      planar.set(left.subarray(off, off + n), 0);
      planar.set(right.subarray(off, off + n), n);
      const data = new AudioData({
        format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2,
        timestamp: Math.round(((frame0 + off) / SR) * 1e6),
        data: planar,
      });
      enc.encode(data);
      data.close();
      while (enc.encodeQueueSize > 16) await dequeued(enc);
    }
  };

  const step = async () => {
    const r = await mixer.next();
    if (r.done) { doneTo = Infinity; return; }
    const { buffer, frame } = r.value;
    await encodeBuffer(buffer, frame);
    doneTo = (frame + buffer.length) / SR;
  };

  const guard = async (fn) => {
    if (broken) return;
    try { await fn(); } catch (e) {
      broken = true;
      console.warn('audio mix failed part-way:', e);
      warnings.push(`The sound stopped being mixed at ${Math.floor(doneTo / 60)}:`
        + `${String(Math.floor(doneTo % 60)).padStart(2, '0')} because of an error `
        + `(${e?.message || e}). The rest of the video has no sound.`);
    }
  };

  return {
    until: (t) => guard(async () => { while (doneTo < Math.min(t, duration)) await step(); }),
    finish: (cancelled) => guard(async () => {
      while (doneTo < duration && !cancelled()) await step();
      await enc.flush();
      if (err) throw err;
    }),
    close: () => { try { if (enc.state !== 'closed') enc.close(); } catch { /* closed */ } },
  };
}
