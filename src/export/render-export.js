import { Muxer, ArrayBufferTarget } from '../../vendor/mp4-muxer.mjs';
import { Compositor } from '../engine/compositor.js';
import { renderTimelineAudio, audibleClips } from '../audio/graph.js';

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

/** H.264 profile/level candidates, best first. Level must cover the resolution. */
function codecCandidates(width, height, fps) {
  const mb = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbPerSec = mb * fps;
  // Level thresholds in macroblocks/sec, coarse but sufficient to pick sanely.
  const level =
    mbPerSec > 522240 ? '33' :      // 5.1 — 4K60
    mbPerSec > 245760 ? '32' :      // 5.0
    mbPerSec > 245760 / 2 ? '2a' :  // 4.2 — 1080p60
    '28';                           // 4.0 — 1080p30
  return [
    `avc1.6400${level}`,            // High
    `avc1.4d40${level}`,            // Main
    `avc1.42e0${level}`,            // Baseline — widest support
    'avc1.42001f',                  // last resort
  ];
}

async function pickVideoCodec(config) {
  for (const codec of codecCandidates(config.width, config.height, config.framerate)) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ ...config, codec });
      if (supported) return codec;
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * Which audio codec this machine can actually *encode*.
 *
 * Decoding and encoding are different capabilities: Chromium on Linux plays AAC
 * happily but cannot produce it, while Windows usually can via the OS encoder.
 * AAC is preferred because every player and platform takes it; Opus in MP4 is a
 * valid, well-supported fallback (YouTube accepts it) rather than losing sound
 * altogether. Asking at runtime is the only reliable way to know.
 */
async function pickAudioCodec() {
  const options = [
    { muxer: 'aac', encoder: 'mp4a.40.2', ideal: true },
    { muxer: 'opus', encoder: 'opus', ideal: false },
  ];
  for (const o of options) {
    try {
      const { supported } = await AudioEncoder.isConfigSupported({
        codec: o.encoder, sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000,
      });
      if (supported) return o;
    } catch { /* try the next */ }
  }
  return null;
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
 * Render the project to MP4 bytes.
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
 * @returns {Promise<Uint8Array|null>} null if cancelled
 */
export async function renderToMp4({
  store, width, height, fps, vBitrate, aBitrate, onProgress, shouldCancel,
  frameAccuracy = 'fast',
}) {
  const support = exportSupport();
  if (!support.ok) throw new Error(support.reason);

  // Encoders reject odd dimensions.
  width = Math.max(2, Math.round(width / 2) * 2);
  height = Math.max(2, Math.round(height / 2) * 2);

  const duration = Math.max(1 / fps, store.rt.duration);
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const report = (phase, done, total) =>
    onProgress?.({ phase, done, total, percent: total ? Math.min(100, (done / total) * 100) : 0 });

  /* ── Audio first: it is quick, and its absence changes the muxer config ── */
  report('audio', 0, 1);
  const wantAudio = support.audio && audibleClips(store).length > 0;
  let audioBuffer = null;
  let audioCodec = null;
  if (wantAudio) {
    audioCodec = await pickAudioCodec();
    if (!audioCodec) {
      console.warn('no audio encoder on this machine — exporting silent');
    } else {
      try {
        audioBuffer = await renderTimelineAudio(store, duration, 48000);
      } catch (err) {
        console.warn('audio bounce failed, exporting silent:', err);
        audioBuffer = null;
      }
    }
  }
  if (shouldCancel?.()) return null;
  report('audio', 1, 1);

  /* ── Muxer + encoders ──────────────────────────────────────────────── */
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',          // moov at the front, so it streams on upload
    video: { codec: 'avc', width, height },
    ...(audioBuffer && audioCodec
      ? { audio: { codec: audioCodec.muxer, numberOfChannels: 2,
                   sampleRate: audioBuffer.sampleRate } }
      : {}),
  });

  const vConfig = {
    width, height, framerate: fps,
    bitrate: Math.max(1_000_000, Math.round(vBitrate)),
    latencyMode: 'quality',
  };
  const codec = await pickVideoCodec(vConfig);
  if (!codec) throw new Error(`No H.264 encoder available for ${width}×${height} at ${fps}fps.`);

  let encodeError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  videoEncoder.configure({ ...vConfig, codec });

  /* ── Video: composite every frame at full resolution ───────────────── */
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

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (shouldCancel?.()) return null;
      if (encodeError) throw encodeError;

      const t = i / fps;

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
      const clips = comp.clipsNeededAt(t);
      if (i === 0 || frameAccuracy === 'exact') await comp.pool.seekExact(clips, t);
      else corrections += await comp.pool.streamTo(clips, t, { tolerance: tol });

      comp.render(t, false);

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * frameDur),
        duration: Math.round(frameDur),
      });
      videoEncoder.encode(frame, { keyFrame: i % GOP === 0 });
      frame.close();

      // Backpressure: without this the queue grows until memory runs out on a
      // long timeline.
      while (videoEncoder.encodeQueueSize > 8) {
        await new Promise(r => setTimeout(r, 4));
        if (encodeError) throw encodeError;
      }

      if (i % 5 === 0 || i === totalFrames - 1) {
        // Frames a second, so a slow render says why it is slow rather than
        // only how long is left.
        const rate = (i + 1) / ((performance.now() - startedAt) / 1000);
        onProgress?.({
          phase: 'video', done: i + 1, total: totalFrames,
          percent: Math.min(100, ((i + 1) / totalFrames) * 100),
          fps: rate, seeking: comp.pool.streamSuspend > 0,
        });
      }
    }

    await videoEncoder.flush();
    if (encodeError) throw encodeError;
    if (corrections) {
      // Not a failure — the backstop doing its job. Worth seeing, because a
      // high count means the machine could not follow the source and the
      // render fell back towards the old seek-everything speed.
      console.info(`[export] ${corrections}/${totalFrames} frames needed a corrective seek`);
    }

    /* ── Audio encode ────────────────────────────────────────────────── */
    if (audioBuffer && audioCodec) {
      report('encoding audio', 0, 1);
      await encodeAudio(audioBuffer, muxer, aBitrate, audioCodec.encoder,
                        () => shouldCancel?.());
      report('encoding audio', 1, 1);
    }

    if (shouldCancel?.()) return null;

    muxer.finalize();
    report('done', 1, 1);
    return new Uint8Array(muxer.target.buffer);
  } finally {
    try { if (videoEncoder.state !== 'closed') videoEncoder.close(); } catch { /* already closed */ }
    // Leave nothing playing: a cancelled export would otherwise keep decoding.
    comp.pool.endStream();
    comp.dispose();
  }
}

/** Slice the bounced buffer into AudioData chunks and encode as AAC. */
async function encodeAudio(buffer, muxer, bitrate, codec, cancelled) {
  let err = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { err = e; },
  });
  enc.configure({
    codec,
    sampleRate: buffer.sampleRate,
    numberOfChannels: 2,
    bitrate: Math.max(64_000, Math.round(bitrate)),
  });

  const CHUNK = 4096;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

  for (let off = 0; off < buffer.length; off += CHUNK) {
    if (cancelled?.()) break;
    if (err) throw err;
    const n = Math.min(CHUNK, buffer.length - off);
    // f32-planar wants every channel laid end to end in one array.
    const planar = new Float32Array(n * 2);
    planar.set(left.subarray(off, off + n), 0);
    planar.set(right.subarray(off, off + n), n);

    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: buffer.sampleRate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((off / buffer.sampleRate) * 1e6),
      data: planar,
    });
    enc.encode(data);
    data.close();

    while (enc.encodeQueueSize > 16) await new Promise(r => setTimeout(r, 2));
  }

  await enc.flush();
  if (err) throw err;
  enc.close();
}
