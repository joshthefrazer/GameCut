import { makeClip, trackAccepts } from '../../core/schema.js';
import { assets } from '../../media/asset-store.js';
import { bus } from '../../core/events.js';

/**
 * The one place an asset becomes a clip on the timeline.
 *
 * Both the drag-and-drop handler and the media pool's click-to-add go through
 * here, so a video dropped on a lane and a video added from the pool land with
 * identical geometry, naming and track selection.
 *
 * Where things go, when nobody pointed at a lane:
 *
 *   video   the MAIN video track — the bottom one, the base of the picture.
 *   image   a track ABOVE every piece of footage showing at that moment, so
 *           it is never buried underneath it (see `overlayTrack`).
 *   audio   the first sound lane with room (Music comes first), else a new one.
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
 * A video track for a picture that must show OVER the footage.
 *
 * Tracks paint bottom-of-the-list first, so the first video track in the list
 * is the one on top. Placement used to take the first video track with room —
 * in a new project that is the bottom one, "Video 1", underneath "Video 2" — so
 * a logo or an emote was added underneath the gameplay and simply never
 * appeared. Now: find the highest video track with anything on it during this
 * span, and use a free track above that one (the nearest, to keep the stack
 * tidy). If there is none, make an "Overlay" track right above it — which is
 * still under every text track, because text belongs on top of a graphic.
 */
function overlayTrack(store, cmds, start, dur) {
  const tracks = store.doc.tracks;
  const end = start + dur;
  const busy = (t) => t.clips.some(c => c.start < end - 1e-6 && c.start + c.duration > start + 1e-6);
  const videoAt = (i) => tracks[i].kind === 'video';

  let top = -1;
  for (let i = 0; i < tracks.length; i++) if (videoAt(i) && busy(tracks[i])) { top = i; break; }

  if (top >= 0) {
    for (let i = top - 1; i >= 0; i--) {
      const t = tracks[i];
      if (t.kind === 'video' && !t.locked && !busy(t)) return t;
    }
    return cmds.addTrack('video', tracks[top].id, { name: 'Overlay' });
  }

  // Nothing showing then. Keep the main track for footage: use the nearest
  // free picture track above it, and only fall back to the main one if there
  // is no other.
  const vids = tracks.filter(t => t.kind === 'video' && !t.locked);
  const main = vids.at(-1);
  const upper = vids.slice(0, -1).reverse().find(t => !busy(t));
  if (upper) return upper;
  if (main && !busy(main)) return main;
  return cmds.addTrack('video', main?.id ?? null, { name: 'Overlay' });
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
 *                   (Pictures never shift — they get a layer of their own at the
 *                   playhead, which is where you were looking.)
 * @param at.patch  extra fields folded into the clip BEFORE it is added.
 *   Whoever places the clip usually wants it to arrive already configured — a
 *   graphic with a look and a size, say. Setting those afterwards works but
 *   costs one undo step each, so undoing "add a graphic" walks backwards
 *   through four states, three of which nobody ever asked for.
 *
 * Returns the created clip, or null. One undo step, even when a track had to
 * be made for it.
 */
export function placeAsset(store, cmds, assetId, at = {}) {
  const asset = assets.get(assetId);
  if (!asset || asset.kind === 'font') return null;

  const type = clipTypeFor(asset.kind);
  const dur = durationFor(asset);
  const label = at.label || 'Add media';

  const run = () => {
    let start = Math.max(0, at.start ?? store.rt.playhead);
    const usable = (t) => t && !t.locked && trackAccepts(t.kind, type);
    let track = store.doc.tracks.find(t => t.id === at.trackId && usable(t));
    const pointed = !!track;

    if (!track && type === 'image') {
      track = overlayTrack(store, cmds, start, dur);
    } else if (!track && type === 'video') {
      const vids = store.doc.tracks.filter(t => t.kind === 'video' && usable(t));
      const main = vids.at(-1) || cmds.addTrack('video');
      track = main;
      if (!isFree(main, start, dur)) {
        if (at.allowShift) start = firstGap(main, start, dur);
        else {
          // Asked for this exact moment: the nearest free track above the main one.
          track = [...vids].reverse().find(t => isFree(t, start, dur)) || main;
        }
      }
    } else if (!track) {
      const lanes = store.doc.tracks.filter(t => t.kind === 'audio' && usable(t));
      track = lanes.find(t => isFree(t, start, dur));
      if (!track && at.allowShift && lanes[0]) {
        track = lanes[0];
        start = firstGap(track, start, dur);
      }
      // Asked for this exact moment and every lane is busy: a new lane at the
      // bottom, rather than two sounds stacked on one lane where only one plays.
      if (!track) track = cmds.addTrack('audio');
    }
    if (!track) return null;

    if (pointed && at.allowShift && !isFree(track, start, dur)) start = firstGap(track, start, dur);

    // The first recording sets the canvas, so 1440p / 4K footage isn't
    // scaled down to 1080p before an export can ever use it.
    if (type === 'video' && !at.keepProject) {
      const fitted = cmds.fitProjectToFootage?.(asset);
      if (fitted) {
        bus.emit('toast', {
          msg: `Project set to ${fitted.width}×${fitted.height} to match your footage — change it in Project settings`,
          kind: 'ok', ms: 5200,
        });
      }
    }

    const patch = { ...(at.patch || {}) };
    /**
     * A landscape recording in a tall (or square) project arrives fitted inside
     * the frame over a blurred copy of itself, instead of cropped to a sliver
     * of the middle of the screen — which is what 'cover' does to a 16:9 game
     * capture in a 9:16 frame, and is the reason a first TikTok edit looks
     * zoomed into nothing. Anyone who wants it filled can still pick 'cover'.
     */
    if (type === 'video' && !('fit' in patch)
        && asset.width > asset.height && store.doc.height >= store.doc.width) {
      patch.fit = 'blur';
    }

    const clip = makeClip(type, {
      name: asset.name.replace(/\.[^.]+$/, ''),
      assetId,
      start,
      duration: dur,
      sourceDuration: asset.duration || Infinity,
      ...patch,
    });
    // (makeClip merges a partial transform onto the defaults itself — doing it
    // here as well used to merge the patch with a copy of itself.)

    cmds.addClip(track.id, clip, { label });
    bus.emit('toast', { msg: `${clip.name} → ${track.name}`, kind: 'ok' });
    // Let the timeline bring the lane it landed on into view.
    bus.emit('timeline:reveal', { trackId: track.id, start: clip.start, duration: clip.duration });
    return clip;
  };

  return cmds.batch ? cmds.batch(label, run) : run();
}
