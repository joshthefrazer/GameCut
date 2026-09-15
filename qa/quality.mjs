/**
 * Export quality: the arithmetic behind "whatever bitrate you asked for".
 *
 * Plain node, no browser — this is all pure functions, and a suite that runs in
 * a second is a suite that gets run. The end-to-end proof that a high bitrate
 * survives all the way into the file lives in qa/export.mjs; this catches the
 * table being wrong long before anything is encoded.
 */
import { levelFor, MAX_H264_BITRATE } from '../src/export/render-export.js';
import {
  bitrateOf, sourceBitrate, bitrateForPreset, matchSource,
  clampBitrate, fmtMbps, MIN_CUSTOM_BITRATE, MAX_CUSTOM_BITRATE,
} from '../src/export/quality.js';
import { EXPORT_PRESETS } from '../src/project/presets.js';

const problems = [];
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { problems.push(m); console.log('  FAIL ' + m); };
const is = (got, want, what) =>
  got === want ? ok(`${what} — ${got}`) : bad(`${what}: got ${got}, expected ${want}`);

console.log('\n── export quality ───────────────────────');

/* ── The level table ─────────────────────────────────────────── */
// The bug this file exists for: resolution alone chose the level, so 1080p30
// got level 4.0, whose ceiling is 25 Mbps on High profile. Anything above that
// was quietly thrown away.
is(levelFor(1920, 1080, 30, 16e6)?.name, '4.0', '1080p30 at 16 Mbps fits level 4.0');
// 4.1 on High carries 62.5 Mbps, so 60 still fits there; 80 is the first rate
// that genuinely needs 5.0. Worth stating both, because getting this boundary
// wrong in the other direction would overstate the level and turn away
// hardware decoders that could have played the file.
is(levelFor(1920, 1080, 30, 60e6)?.name, '4.1', '1080p30 at 60 Mbps still fits level 4.1');
is(levelFor(1920, 1080, 30, 80e6)?.name, '5.0', '1080p30 at 80 Mbps needs level 5.0');
is(levelFor(1920, 1080, 30, 200e6)?.name, '5.1', '1080p30 at 200 Mbps needs level 5.1');
is(levelFor(1920, 1080, 60, 16e6)?.name, '4.2', '1080p60 needs 4.2 for the frame rate alone');
is(levelFor(3840, 2160, 60, 45e6)?.name, '5.2', '4K60 needs 5.2 for the frame rate');
is(levelFor(640, 360, 30, 80e6)?.name, '5.0', 'even a small picture needs 5.0 to carry 80 Mbps');

// High profile's 1.25x bitrate allowance is the difference between one level
// and the next for exactly the rates gaming captures land on.
is(levelFor(1920, 1080, 30, 60e6, false)?.name, '5.0', '60 Mbps on Main needs 5.0');
is(levelFor(1920, 1080, 30, 24e6, true)?.name, '4.0', '24 Mbps fits 4.0 on High');
is(levelFor(1920, 1080, 30, 24e6, false)?.name, '4.1', '24 Mbps needs 4.1 on Main');

{
  const top = levelFor(7680, 4320, 60, MAX_H264_BITRATE);
  if (top) ok(`the ceiling (${fmtMbps(MAX_H264_BITRATE)} at 8K60) is still level ${top.name}`);
  else bad('nothing in the level table can carry MAX_H264_BITRATE — the constant and the table disagree');
}

/* ── Measuring the source ────────────────────────────────────── */
// 700 MB over 60s is about 93 Mbps, which is an ordinary OBS recording.
is(Math.round(bitrateOf(700 * 1024 * 1024, 60) / 1e6), 98, 'bytes and seconds give a bitrate');
is(bitrateOf(0, 60), 0, 'no size means no answer rather than a guess');
is(bitrateOf(1000, 0), 0, 'no duration means no answer');

{
  // A fake project: one clip from a 90 Mbps recording, one from a 12 Mbps one,
  // and a third asset sitting unused in the pool that must be ignored.
  const store = { doc: { tracks: [
    { clips: [{ type: 'video', assetId: 'a' }, { type: 'video', assetId: 'b' }] },
    { clips: [{ type: 'audio', assetId: 'c' }] },
  ] } };
  const pool = new Map([
    ['a', { duration: 10, bytes: 12e6 / 8 * 10 }],
    ['b', { duration: 10, bytes: 90e6 / 8 * 10 }],
    ['unused', { duration: 10, bytes: 400e6 / 8 * 10 }],
    ['c', { duration: 10, bytes: 1e6 }],
  ]);
  const assets = { get: (id) => pool.get(id) };
  is(Math.round(sourceBitrate(store, assets) / 1e6), 90,
     'the timeline is measured by its busiest clip');

  const empty = { doc: { tracks: [] } };
  is(sourceBitrate(empty, assets), 0, 'an empty timeline measures nothing');
  is(sourceBitrate(store, { get: () => null }), 0, 'assets with no size measure nothing');
}

/* ── What a preset actually renders at ───────────────────────── */
{
  const best = EXPORT_PRESETS.find(p => p.id === 'yt4k');
  const mid = EXPORT_PRESETS.find(p => p.id === 'yt1080');

  if (!best?.tracksSource) bad('the top tier does not follow the footage');
  else ok('the top tier follows the footage');

  is(bitrateForPreset(best, 0), best.vBitrate, 'with nothing to measure, the fixed number stands');
  is(bitrateForPreset(mid, 200e6), mid.vBitrate, 'the middle tier stays uploadable whatever the source');

  const raised = bitrateForPreset(best, 90e6);
  if (raised > 90e6) ok(`90 Mbps footage raises Best quality to ${fmtMbps(raised)}`);
  else bad(`90 Mbps footage should raise Best quality above the source, got ${fmtMbps(raised)}`);

  const low = bitrateForPreset(best, 3e6);
  is(low, best.vBitrate, 'low-bitrate footage never drags the top tier down');
}

/* ── Matching the footage means matching it ──────────────────── */
// Not bitrateForPreset: that treats a preset's own number as a floor, so
// "Match my footage" on 8 Mbps phone footage would set 30 while the sentence
// beside the button said 8.
{
  const m = matchSource(8e6);
  if (m > 8e6 && m < 12e6) ok(`8 Mbps footage matches at ${fmtMbps(m)}`);
  else bad(`8 Mbps footage should match near 10 Mbps, got ${fmtMbps(m)}`);

  const scaled = matchSource(8e6, 2);
  if (scaled > m) ok(`matching at 2x size asks for more (${fmtMbps(scaled)})`);
  else bad('a bigger output should need more than the source');

  is(matchSource(0), 0, 'nothing to measure means nothing to match');
  is(matchSource(900e6), MAX_CUSTOM_BITRATE, 'an enormous source still lands inside H.264');
}

/* ── Nothing advertised that cannot be encoded ───────────────── */
// The tile shows a bitrate and a file size; the renderer clamps to what H.264
// can carry. If only one of them clamps, the dialog promises a file four times
// the size of the one it produces.
{
  const best = EXPORT_PRESETS.find(p => p.id === 'yt4k');
  const huge = bitrateForPreset(best, 1_500_000_000);
  if (huge <= MAX_CUSTOM_BITRATE) ok(`a near-lossless source still advertises ${fmtMbps(huge)}`);
  else bad(`the tile would advertise ${fmtMbps(huge)}, past what the renderer will encode`);
}

/* ── The hand-typed figure ───────────────────────────────────── */
is(clampBitrate(0), MIN_CUSTOM_BITRATE, 'zero becomes the floor');
is(clampBitrate(-5), MIN_CUSTOM_BITRATE, 'a negative becomes the floor');
is(clampBitrate(1e12), MAX_CUSTOM_BITRATE, 'an absurd number becomes the ceiling');
is(clampBitrate(82e6), 82e6, '82 Mbps is left exactly as typed');
is(fmtMbps(82e6), '82 Mbps', 'a round number reads round');
is(fmtMbps(8.5e6), '8.5 Mbps', 'a small number keeps its decimal');

/* ── The custom preset exists and is reachable ───────────────── */
{
  const custom = EXPORT_PRESETS.find(p => p.id === 'custom');
  if (custom?.custom) ok('there is a custom tier');
  else bad('no custom tier in EXPORT_PRESETS');
}

console.log('\n════════════════════════════════════════');
if (problems.length) {
  console.log(`QUALITY FAILED — ${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.log(' • ' + p);
  process.exit(1);
} else {
  console.log('QUALITY PASSED — any bitrate asked for is a bitrate that can be encoded.');
}
