/**
 * How good the exported file should be.
 *
 * ── Why this file exists ──────────────────────────────────────
 * GameCut used to offer three fixed quality tiers, and the best of them was
 * 16 Mbps at 1080p. That is a perfectly sensible number for footage from a
 * phone. It is nowhere near enough for footage from Medal or OBS, which record
 * gameplay at 50-100 Mbps: every export re-encoded a 70 Mbps source down to 16,
 * so the finished clip came out visibly softer than the raw recording — mush in
 * exactly the places gaming footage is hardest to compress, which is smoke,
 * foliage, muzzle flash and fast camera turns.
 *
 * The fix has two halves, and both live here:
 *
 *   1. The top tier is no longer a fixed number. It looks at the footage on the
 *      timeline and refuses to go below it, so "Best quality" means best
 *      relative to what you actually recorded.
 *   2. Anything can be typed in by hand. There is no list of allowed bitrates
 *      to fall off the end of — any number the H.264 format can carry is a
 *      number GameCut will encode at.
 *
 * ── Measuring the source ──────────────────────────────────────
 * Bytes divided by seconds is the file's average bitrate, which is the honest
 * figure: it already accounts for however the recorder was configured, whether
 * it was constant or variable rate, and whatever the audio track costs. There
 * is no need to parse the container to get it, and nothing to go stale.
 */

/** Bits per second a file of this size and length was recorded at. */
export function bitrateOf(bytes, seconds) {
  if (!bytes || !seconds || seconds <= 0) return 0;
  return (bytes * 8) / seconds;
}

/**
 * The highest bitrate among the video actually used on the timeline.
 *
 * The timeline rather than the whole media pool: a project is judged by what is
 * in it, and a stray 4K clip sitting unused in the pool should not quietly
 * treble the size of every export.
 *
 * Returns 0 when nothing can be measured — a project reopened from disk before
 * this version existed has no sizes recorded, and guessing would be worse than
 * falling back to the fixed tiers.
 */
export function sourceBitrate(store, assets) {
  let best = 0;
  for (const track of store?.doc?.tracks || []) {
    for (const clip of track.clips || []) {
      if (clip.type !== 'video') continue;
      const a = assets?.get?.(clip.assetId);
      if (!a) continue;
      const bytes = a.bytes || a.file?.size || 0;
      const rate = bitrateOf(bytes, a.duration);
      // A still or a one-frame asset can produce a nonsense figure; ignore
      // anything implausible rather than letting it set the export.
      if (rate > best && rate < 2_000_000_000) best = rate;
    }
  }
  return best;
}

/**
 * The bitrate a preset should actually use, given the footage.
 *
 * Only the top tier tracks the source, and only upward. "Recommended" staying
 * where it is matters: it is the one that keeps a clip small enough to upload,
 * and quietly turning it into a 90 Mbps monster because the source happened to
 * be 90 Mbps would be the opposite of what it says on it.
 *
 * `HEADROOM` exists because re-encoding always costs something — the second
 * encoder never sees the original pixels, only the first encoder's guess at
 * them, so matching the source bitrate exactly still loses a little. A quarter
 * more buys that back and is small enough not to be silly.
 */
export const HEADROOM = 1.25;

export function bitrateForPreset(preset, srcBitrate) {
  if (!preset) return 0;
  if (!preset.tracksSource || !srcBitrate) return preset.vBitrate;
  // Scaled by resolution: a 4K export of 1080p footage needs more than the
  // source, a 720p draft of it needs less.
  const scale = preset.scale > 1 ? preset.scale : 1;
  // Clamped, because the renderer clamps too. A near-lossless capture can be
  // 500 Mbps, and 500 x 1.25 x 2 is past what H.264 can carry — left unclamped
  // the tile would advertise a bitrate and a file size four times what would
  // actually be produced.
  return clampBitrate(Math.max(preset.vBitrate, Math.round(srcBitrate * HEADROOM * scale)));
}

/**
 * What "Match my footage" sets.
 *
 * Deliberately NOT bitrateForPreset: that treats the preset's own number as a
 * floor, so matching 8 Mbps phone footage against the custom tier's 30 Mbps
 * placeholder would set 30 and contradict the sentence next to the button.
 * Matching means matching.
 */
export function matchSource(srcBitrate, scale = 1) {
  if (!srcBitrate) return 0;
  return clampBitrate(srcBitrate * HEADROOM * Math.max(1, scale || 1));
}

/** Bounds for the hand-typed figure, in bits/sec. */
export const MIN_CUSTOM_BITRATE = 1_000_000;
export const MAX_CUSTOM_BITRATE = 1_000_000_000;      // H.264 level 6.2, High

export const clampBitrate = (v) =>
  Math.min(MAX_CUSTOM_BITRATE, Math.max(MIN_CUSTOM_BITRATE, Math.round(v || 0)));

/** "72 Mbps", or "8.5 Mbps" when the number needs a decimal to mean anything. */
export function fmtMbps(bits) {
  const m = (bits || 0) / 1e6;
  return `${m >= 10 ? Math.round(m) : m.toFixed(1)} Mbps`;
}
