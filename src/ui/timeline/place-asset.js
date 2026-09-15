import { makeClip, trackAccepts } from '../../core/schema.js';
import { assets } from '../../media/asset-store.js';
import { bus } from '../../core/events.js';

/**
 * The one place an asset becomes a clip on the timeline.
 *
 * Both the drag-and-drop handler and the media pool's click-to-add go through
 * here, so a video dropped on a lane and a video added from the pool land with
 * identical geometry, naming and track selection.
 */

const clipTypeFor = (kind) =>
  kind === 'audio' ? 'audio' : kind === 'image' ? 'image' : 'video';

const durationFor = (asset) =>
  asset.kind === 'image' ? 5 : Math.max(0.5, asset.duration || 4);

/** True when [start, start+dur) touches nothing already on `track`. */
function isFree(track, start, dur, ignoreId = null) {
  const end = start + dur;
  return !track.clips.some(c =>
    c.id !== ignoreId && start < c.start + c.duration - 1e-6 && end > c.start + 1e-6);
}

/** First moment at or after `from` where `dur` fits on `track`. */
function firstGap(track, from, dur) {
  if (isFree(track, from, dur)) return from;
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  let t = from;
  for (const c of sorted) {
    const end = c.start + c.duration;
    if (end <= t) continue;
    if (c.start >= t + dur) break;      // the gap before this clip is big enough
    t = end;
  }
  return t;
}

/**
 * Place `assetId` on the timeline.
 *
 * `at.trackId`  — preferred track (from a drop); ignored if it can't take the type.
 * `at.start`    — preferred time; defaults to the playhead.
 * `at.allowShift` — when the preferred spot is occupied, slide later to the first
 *                   gap instead of stacking clips on top of each other. Drops keep
 *                   the exact spot the ghost showed; click-to-add shifts, because
 *                   silently burying a clip under another is never what was meant.
 *
 * Returns the created clip, or null.
 */
/**
 * @param at.patch  extra fields folded into the clip BEFORE it is added.
 *   Whoever places the clip usually wants it to arrive already configured — a
 *   graphic with a look and a size, say. Setting those afterwards works but
 *   costs one undo step each, so undoing "add a graphic" walks backwards
 *   through four states, three of which nobody ever asked for.
 */
export function placeAsset(store, cmds, assetId, at = {}) {
  const asset = assets.get(assetId);
  if (!asset || asset.kind === 'font') return null;

  const type = clipTypeFor(asset.kind);
  const wantKind = type === 'audio' ? 'audio' : 'video';
  const dur = durationFor(asset);
  let start = Math.max(0, at.start ?? store.rt.playhead);

  // Preferred track first, then any unlocked track of the right kind.
  const usable = (t) => t && !t.locked && trackAccepts(t.kind, type);
  let track = store.doc.tracks.find(t => t.id === at.trackId && usable(t));

  if (!track) {
    const pool = store.doc.tracks.filter(t => t.kind === wantKind && usable(t));
    // Prefer one with room at the requested time so a second clip doesn't stack.
    track = pool.find(t => isFree(t, start, dur)) || pool[0];
  }

  // Still nothing — the project has no track of this kind yet. Make one.
  if (!track) {
    cmds.addTrack(wantKind);
    track = store.doc.tracks.filter(t => t.kind === wantKind && !t.locked).at(-1);
  }
  if (!track) return null;

  if (at.allowShift && !isFree(track, start, dur)) start = firstGap(track, start, dur);

  const clip = makeClip(type, {
    name: asset.name.replace(/\.[^.]+$/, ''),
    assetId,
    start,
    duration: dur,
    sourceDuration: asset.duration || Infinity,
    ...(at.patch || {}),
  });
  if (at.patch?.transform) clip.transform = { ...clip.transform, ...at.patch.transform };

  cmds.addClip(track.id, clip, { label: at.label || 'Add media' });
  bus.emit('toast', { msg: `${clip.name} → ${track.name}`, kind: 'ok' });
  return clip;
}
