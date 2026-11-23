import { probeMp4, byteSourceFor, looksLikeMp4, looksLikeMatroska } from '../media/mp4-audio.js';
import { dequeued, yieldNow } from './wait.js';

/**
 * Exact frames for export, decoded with WebCodecs straight from the MP4.
 *
 * Export used to get each frame by playing a <video> element forward and
 * seeking back whenever it overshot. Every seek re-decodes from the last
 * keyframe, and OBS puts keyframes seconds apart, so a 1080p60 recording spent
 * nearly all of its export time seeking, and frames that took too long came
 * out as a copy of a neighbour (stutter, frozen moments).
 *
 * This reads the file's own sample table and feeds the decoder in order:
 * every frame is decoded once, and the frame for each moment is the exact one
 * that should be on screen. A jump backwards or far ahead (a cut to another
 * part of the recording) restarts from the right keyframe.
 *
 * Anything it cannot do (not an MP4, a codec this machine cannot decode, a
 * broken index) returns null from `open`, and that clip uses the old way.
 */

const AHEAD = 3;            // seconds: a jump further than this restarts at a keyframe
const PROBES = new Map();   // assetId -> probe, for the length of an export (cleared by forgetProbes)
export const forgetProbes = () => PROBES.clear();
/** What the export's progress line reports: was this used, and on the graphics card? */
export const READER_STATS = { used: false, hardware: false };
export const resetReaderStats = () => { READER_STATS.used = false; READER_STATS.hardware = false; };

export class Mp4FrameReader {
  /**
   * `software`: skip the graphics card's decoder and ask for the processor's.
   * Used for the second retry after a reader failed, since a decoder that keeps
   * falling over on the graphics card is often fine on the processor (H.264;
   * Electron has no software HEVC decoder, and then this returns null as before).
   */
  static async open(asset, { software = false } = {}) {
    try {
      if (typeof VideoDecoder === 'undefined' || !asset?.url || asset.missing) return null;
      const src = byteSourceFor({ url: asset.url, bytes: asset.bytes || 0 });
      const head = await src.read(0, 64 * 1024);
      const mkv = looksLikeMatroska(head);
      if (!mkv && !looksLikeMp4(head)) return null;
      // Several clips of one recording share its (possibly large) index.
      let probe = PROBES.get(asset.id);
      if (probe === undefined) {
        if (mkv) {
          const { probeMkvVideo } = await import('../media/mkv-audio.js');
          const v = await probeMkvVideo(src);
          probe = v ? { videoTracks: [v] } : null;
        } else probe = await probeMp4(src, { video: true });
        PROBES.set(asset.id, probe);
      }
      const tr = probe?.videoTracks?.[0];
      if (!tr || !tr.samples.length) return null;
      const config = {
        codec: tr.codec, ...(tr.width && tr.height ? { codedWidth: tr.width, codedHeight: tr.height } : {}),
        ...(tr.description ? { description: tr.description } : {}),
        optimizeForLatency: false,
      };
      // The graphics card's decoder when there is one; otherwise whatever works.
      let hw = false;
      if (!software) {
        try { hw = (await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-hardware' })).supported; } catch { hw = false; }
      }
      if (hw) config.hardwareAcceleration = 'prefer-hardware';
      else if (software) {
        let sw = false;
        try { sw = (await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' })).supported; } catch { sw = false; }
        if (sw) config.hardwareAcceleration = 'prefer-software';
        else if (!(await VideoDecoder.isConfigSupported(config)).supported) return null;
      } else if (!(await VideoDecoder.isConfigSupported(config)).supported) return null;
      READER_STATS.hardware = READER_STATS.hardware || hw;
      READER_STATS.used = true;
      return new Mp4FrameReader(src, tr, config);
    } catch (e) {
      console.warn('export frame reader unavailable', e);
      return null;
    }
  }

  constructor(src, track, config) {
    this.src = src;
    this.config = config;
    this.ts = track.timescale;
    this.offset = track.offset || 0;
    // Decode order is file order; each knows when it is shown (µs).
    //
    // Worked out once per recording, not once per reader. A reader is made for
    // every CLIP, and a montage of fifty cuts from one two-hour recording has
    // fifty clips: copying a million-entry index for each of them cost seconds
    // and hundreds of MB apiece. The list is only ever read, so they share it.
    this.samples = track.mapped
      || (track.mapped = track.samples.map(s => ({ ...s, t: Math.round((s.cts / this.ts + this.offset) * 1e6) })));
    this.queue = [];        // decoded frames, in presentation order
    this.next = 0;          // next sample index to feed
    this.err = null;
    this.current = null;    // the frame last handed out (kept until replaced)
    this.canvas = null;
    this.#makeDecoder();
  }

  #makeDecoder() {
    this.dec?.close?.();
    this.dec = new VideoDecoder({
      output: (f) => {
        // Keep presentation order; B-frames arrive out of it.
        const q = this.queue;
        let i = q.length;
        while (i > 0 && q[i - 1].timestamp > f.timestamp) i--;
        q.splice(i, 0, f);
        const w = this.wake; this.wake = null; w?.();
      },
      error: (e) => { this.err = this.err || e; },
    });
    this.dec.configure(this.config);
    this.flushed = false;
    this.flushDone = false;
  }

  /** Restart from the last keyframe at or before `us`. */
  #seek(us) {
    for (const f of this.queue) f.close();
    this.queue = [];
    this.#makeDecoder();
    let k = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (s.sync && s.t <= us) k = i;
      if (s.t > us + 5e6 && s.sync) break;
    }
    this.next = k;
  }

  /** Feed the next run of samples (one read of up to ~4 MB). */
  async #feed() {
    const S = this.samples;
    if (this.next >= S.length) {
      /*
       * End of the file: ask the decoder for its last frames, but do NOT wait
       * for that here. A hardware decoder has only a few frames to lend, and
       * the queue may be holding them (frames after the one asked for); a
       * flush awaited at this point waited for frames that could only come
       * once we let go of the ones we hold — forever. That hang is why a
       * 1440p/4K "smooth preview copy" stopped at ~80% and never finished.
       * `frameAt` keeps handing frames back while the flush completes.
       */
      if (!this.flushed) {
        this.flushed = true;
        this.flushDone = false;
        const dec = this.dec;
        dec.flush().then(
          () => { if (dec === this.dec) this.flushDone = true; },
          (e) => { if (dec === this.dec) { this.flushDone = true; if (dec.state !== 'closed') this.err = this.err || e; } },
        ).finally(() => { const w = this.wake; this.wake = null; w?.(); });
      }
      return false;
    }
    const first = this.next;
    let last = first;
    while (last + 1 < S.length && S[last + 1].offset >= S[last].offset
      && S[last + 1].offset + S[last + 1].size - S[first].offset <= 4 * 1024 * 1024
      && S[last + 1].offset - (S[last].offset + S[last].size) <= 256 * 1024) last++;
    const start = S[first].offset, end = S[last].offset + S[last].size;
    const bytes = await this.src.read(start, end);
    for (let i = first; i <= last; i++) {
      const s = S[i];
      const from = s.offset - start;
      if (from < 0 || from + s.size > bytes.length) continue;
      this.dec.decode(new EncodedVideoChunk({
        type: s.sync ? 'key' : 'delta', timestamp: s.t,
        duration: Math.round((s.duration || 0) / this.ts * 1e6),
        data: bytes.subarray(from, from + s.size),
      }));
    }
    this.next = last + 1;
    return true;
  }

  /**
   * The frame on screen at `sec` (source time). The reader owns it: do not
   * close it, and do not keep it past the next call.
   */
  async frameAt(sec) {
    const us = Math.round(sec * 1e6);
    const q = this.queue;
    const have = q.length ? q[0].timestamp : (this.current ? this.current.timestamp : -Infinity);
    // A jump back, or far ahead, starts again from a keyframe.
    if (us < have - 1000 || (this.next < this.samples.length && us > this.#fedUpTo() + AHEAD * 1e6)) this.#seek(us);

    // Decode until a frame AFTER `us` exists (so the one at `us` is final), or the file ends.
    for (let guard = 0; guard < 100000; guard++) {
      if (this.err) throw this.err;
      // Frames already passed go back to the decoder at once: it has only a
      // handful to lend, and holding them stalls it.
      while (this.queue.length >= 2 && this.queue[1].timestamp <= us + 500) this.queue.shift().close();
      const after = this.queue.some(f => f.timestamp > us);
      if (after) break;
      if (this.dec.decodeQueueSize > 12) { await this.#nextFrame(); continue; }
      const more = await this.#feed();
      if (!more) {
        // Fed and flushed: whatever is in the queue is all there is.
        if (this.flushDone) { await yieldNow(); break; }
        // Still flushing: let frames come back (the top of the loop returns used ones).
        await this.#nextFrame();
        continue;
      }
      // Let the decoder hand frames back.
      if (!this.queue.some(f => f.timestamp > us)) await this.#nextFrame();
    }
    if (this.err) throw this.err;

    // The last frame at or before `us` is the picture; older ones are done with.
    let pick = null;
    while (this.queue.length && this.queue[0].timestamp <= us + 500) {
      const f = this.queue.shift();
      if (pick) pick.close();
      pick = f;
    }
    if (pick) { if (this.current) this.current.close(); this.current = pick; }
    // Before the first frame's own time (an MKV whose video starts a few ms
    // after its sound): show the first frame, as a player does.
    if (!this.current && this.queue.length) this.current = this.queue.shift();
    return this.current;
  }

  /** Until the decoder hands back a frame (or has room), never a fixed sleep. */
  #nextFrame() {
    return Promise.race([
      new Promise((r) => { this.wake = r; }),
      dequeued(this.dec, 100),
    ]);
  }

  #fedUpTo() {
    const s = this.samples[Math.max(0, this.next - 1)];
    return s ? s.t : 0;
  }

  /**
   * The frame drawn into a canvas the compositor can use like a <video>
   * (it reads videoWidth / videoHeight).
   */
  /*
   * Drawn into a canvas first, not handed over as the VideoFrame itself:
   * measured, the compositor drawing VideoFrames directly (cropped and scaled)
   * made a 1080p export three times SLOWER, while one plain full-size copy
   * costs next to nothing.
   */
  async canvasAt(sec) {
    const f = await this.frameAt(sec);
    if (!f) return null;
    const w = f.displayWidth, h = f.displayHeight;
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.canvas.videoWidth = w;
      this.canvas.videoHeight = h;
      this.ctx = this.canvas.getContext('2d');
    }
    this.ctx.drawImage(f, 0, 0, w, h);
    return this.canvas;
  }

  close() {
    for (const f of this.queue) f.close();
    this.queue = [];
    this.current?.close();
    this.current = null;
    try { this.dec?.close(); } catch { /* closed */ }
  }
}
