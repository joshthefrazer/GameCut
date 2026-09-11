import { makeClip, makeTrack, findClip, trackById, trackAccepts, uid } from './schema.js';
import { snapFrame, clamp } from './time.js';
import { bus } from './events.js';
import { assets } from '../media/asset-store.js';

/**
 * Every document mutation lives here and goes through History, so undo/redo,
 * autosave and dirty-tracking are automatic. UI modules never touch `doc`
 * directly.
 */
/**
 * Speed limits.
 *
 * A media element refuses playbackRate above 16, so anything faster is stepped
 * frame by frame instead (see engine/decoder-pool.js) — which is exactly what a
 * timelapse of a long recording needs, so the ceiling here is well past it.
 */
const MIN_SPEED = 0.1;
const MAX_SPEED = 64;

export function createCommands(store, history) {
  const fps = () => store.doc.fps;
  const q = (t) => snapFrame(Math.max(0, t), fps());

  const api = {

    /* ── Clips ───────────────────────────────────────────────── */

    addClip(trackId, clip, { select = true, label = 'Add clip' } = {}) {
      history.run(label, (doc) => {
        const track = trackById(doc, trackId);
        if (!track) return;
        clip.trackId = trackId;
        clip.start = q(clip.start);
        clip.duration = Math.max(1 / fps(), q(clip.duration));
        track.clips.push(clip);
        track.clips.sort((a, b) => a.start - b.start);
      });
      if (select) store.select([clip.id]);
      return clip;
    },

    addTextClip(at = store.rt.playhead, trackId = null) {
      const track = trackById(store.doc, trackId)
        || store.doc.tracks.find(t => t.kind === 'text');
      if (!track) return null;
      const clip = makeClip('text', { name: 'Text', start: at, duration: 3 });
      return api.addClip(track.id, clip, { label: 'Add text' });
    },

    /**
     * Lift a rectangle of a clip's picture onto its own layer above it.
     *
     * The source clip is left completely alone — the whole point is that the
     * gameplay keeps playing underneath while the cropped piece (a live view
     * of the same footage, not a freeze frame) can be moved and magnified over
     * the top of it.
     *
     * `crop` is in source space (0..1 of the source frame) and `transform` is
     * worked out by the crop tool so the new layer lands exactly over the
     * region that was drawn — nothing appears to move until you drag it.
     */
    cropClip(clipId, { crop, transform }, { label = 'Crop region' } = {}) {
      const { clip, track } = findClip(store.doc, clipId);
      if (!clip || !crop) return null;

      const copy = makeClip(clip.type, {
        name: `${clip.name || clip.type} crop`,
        assetId: clip.assetId,
        start: clip.start,
        duration: clip.duration,
        inPoint: clip.inPoint,
        sourceDuration: clip.sourceDuration,
        speed: clip.speed,
        fit: 'contain',
        crop,
        // The original underneath still carries the sound.
        silent: true,
        volume: 0,
        transform: { ...clip.transform, ...transform },
      });

      const host = api.trackForOverlay(track.id, clip.start, clip.duration);
      return api.addClip(host.id, copy, { label });
    },

    /**
     * Split a video clip's sound onto its own audio lane.
     *
     * Until now a clip's audio was welded to its picture: to duck the music
     * under a line of commentary, or to keep the sound of a moment while
     * cutting away from it, you had nothing to grab. This makes a real audio
     * clip on a real audio track — same file, same in-point, same speed — and
     * silences the video clip so the two do not play on top of each other a
     * fraction out of phase, which sounds like a broken file rather than a
     * doubled one.
     *
     * Nothing is copied or re-encoded; both clips point at the same imported
     * asset, exactly as a cropped layer does.
     */
    extractAudio(clipId) {
      const { clip } = findClip(store.doc, clipId);
      if (!clip) return null;
      if (clip.type !== 'video') return { ok: false, reason: 'Only video clips have sound to take out.' };

      const asset = assets.get(clip.assetId);
      if (!asset) return { ok: false, reason: 'That clip has no media behind it.' };
      if (!asset.peaks?.buffer && !asset.streamAudio) {
        return { ok: false, reason: `${asset.name} has no sound track to take out.` };
      }
      if (clip.silent) return { ok: false, reason: 'This clip’s audio is already somewhere else.' };

      // The lowest audio lane with room, so an extracted track does not land on
      // top of the music. A new one is added rather than overlapping anything.
      const end = clip.start + clip.duration;
      let host = null;
      for (let i = store.doc.tracks.length - 1; i >= 0; i--) {
        const t = store.doc.tracks[i];
        if (t.kind !== 'audio' || t.locked) continue;
        if (t.clips.some(c => c.start < end && c.start + c.duration > clip.start)) continue;
        host = t; break;
      }
      if (!host) host = api.addTrack('audio');

      const made = makeClip('audio', {
        name: `${clip.name || 'Clip'} audio`,
        assetId: clip.assetId,
        start: clip.start,
        duration: clip.duration,
        inPoint: clip.inPoint,
        sourceDuration: clip.sourceDuration,
        speed: clip.speed,
        volume: clip.volume ?? 1,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
      });

      history.run('Extract audio', (doc) => {
        const { clip: src } = findClip(doc, clipId);
        const to = trackById(doc, host.id);
        if (!src || !to) return;
        src.silent = true;
        made.trackId = to.id;
        to.clips.push(made);
        to.clips.sort((a, b) => a.start - b.start);
      });
      store.select([made.id]);
      return { ok: true, clip: made, track: host };
    },

    /**
     * A video track above `belowTrackId` with nothing occupying the given span.
     *
     * Reusing a free lane keeps the timeline from growing a new track for every
     * crop, but never at the cost of dropping the new layer on top of something
     * already there.
     */
    trackForOverlay(belowTrackId, start, duration) {
      const doc = store.doc;
      const below = doc.tracks.findIndex(t => t.id === belowTrackId);
      const end = start + duration;
      // Earlier in the array is higher up the stack — see Compositor.activeClips.
      for (let i = below - 1; i >= 0; i--) {
        const t = doc.tracks[i];
        if (t.kind !== 'video' || t.locked) continue;
        const clash = t.clips.some(c => c.start < end && c.start + c.duration > start);
        if (!clash) return t;
      }
      return api.addTrack('video', belowTrackId);
    },

    /**
     * Move a clip one track up or down the stack.
     *
     * `dir` is +1 for down (further behind) and -1 for up (further in front),
     * which reads the way the buttons are labelled rather than the way the
     * array is indexed — earlier in `doc.tracks` paints later, i.e. on top.
     * Returns false when there is no compatible track that way, so the caller
     * can say "already at the bottom" instead of silently doing nothing.
     */
    moveClipLayer(clipId, dir) {
      const doc = store.doc;
      const { clip, track } = findClip(doc, clipId);
      if (!clip || !track) return false;
      const from = doc.tracks.indexOf(track);

      let dst = null;
      for (let i = from + dir; i >= 0 && i < doc.tracks.length; i += dir) {
        const t = doc.tracks[i];
        if (!t.locked && trackAccepts(t.kind, clip.type)) { dst = t; break; }
      }
      if (!dst) return false;

      history.run('Change layer', (d) => {
        const { clip: c, track: src } = findClip(d, clipId);
        const to = trackById(d, dst.id);
        if (!c || !src || !to) return;
        src.clips.splice(src.clips.indexOf(c), 1);
        c.trackId = to.id;
        to.clips.push(c);
        to.clips.sort((a, b) => a.start - b.start);
      });
      return true;
    },

    /** Move a clip in time and (optionally) to another compatible track. */
    moveClip(clipId, newStart, newTrackId = null, merge = true) {
      history.begin('Move clip', merge ? 'move:' + clipId : null);
      const doc = store.doc;
      const { clip, track } = findClip(doc, clipId);
      if (!clip) return history.abort();
      clip.start = q(newStart);
      if (newTrackId && newTrackId !== track.id) {
        const dst = trackById(doc, newTrackId);
        if (dst && trackAccepts(dst.kind, clip.type)) {
          track.clips.splice(track.clips.indexOf(clip), 1);
          clip.trackId = dst.id;
          dst.clips.push(clip);
          dst.clips.sort((a, b) => a.start - b.start);
        }
      } else {
        track.clips.sort((a, b) => a.start - b.start);
      }
      history.commit();
    },

    /**
     * Change a clip's playback speed and resize it to match.
     *
     * Speed on its own is only half the change. A clip holds a stretch of
     * footage — `duration × speed` seconds of it — so playing that stretch
     * faster has to make the clip shorter, or the timeline still reserves the
     * original slot and the footage runs out partway through and repeats. That
     * was the 8× bug: the picture sped up and then looped, over and over, in a
     * clip that never changed length.
     *
     * Eight times faster, one eighth as long. Setting `speed` through the
     * generic property setter skips all of this, which is why it has its own
     * command.
     */
    setClipSpeed(clipId, speed, { label = 'Set speed' } = {}) {
      history.begin(label, `speed:${clipId}`);
      const { clip } = findClip(store.doc, clipId);
      if (!clip) return history.abort();

      const from = clip.speed || 1;
      const to = clamp(Number(speed) || 1, MIN_SPEED, MAX_SPEED);
      const minLen = 2 / fps();

      const frame = 1 / fps();
      let dur = q(clip.duration * (from / to));

      /**
       * Never reserve more timeline than there is footage to fill it, and clamp
       * AFTER quantizing rather than before.
       *
       * Clip lengths sit on frame boundaries, and `q` rounds to the nearest one
       * — which at high speed rounds up into footage that does not exist. Half
       * a frame of timeline at 16x is eight frames of source, so a clip that fit
       * exactly came out a quarter of a second over the end and looped on its
       * tail. When the clamp bites, the length is floored to a whole frame that
       * genuinely fits.
       */
      if (Number.isFinite(clip.sourceDuration)) {
        const maxDur = (clip.sourceDuration - clip.inPoint) / to;
        if (dur > maxDur) dur = Math.floor(maxDur / frame) * frame;
      }
      // Two frames is the shortest a clip is allowed to be — unless the source
      // genuinely cannot supply two frames at this speed, in which case one
      // frame of real footage beats two frames of loop.
      const shortest = Math.min(minLen, Math.max(frame, dur));
      dur = Math.max(shortest, dur);

      // Keyframe times are measured from the clip's own start, so they have to
      // shrink with it — otherwise an animation built at 1× sits past the end
      // of the same clip at 8× and simply never plays.
      const k = clip.duration > 0 ? dur / clip.duration : 1;
      if (Number.isFinite(k) && k > 0 && k !== 1) {
        for (const list of Object.values(clip.keys || {})) {
          for (const key of list) key.t = +(key.t * k).toFixed(5);
        }
      }

      clip.speed = to;
      clip.duration = dur;
      history.commit();
      return dur;
    },

    /** Trim one edge. `edge` is 'in' | 'out'. Respects source media bounds. */
    trimClip(clipId, edge, timelineTime, merge = true) {
      history.begin('Trim clip', merge ? 'trim:' + clipId + edge : null);
      const { clip } = findClip(store.doc, clipId);
      if (!clip) return history.abort();
      const minLen = 2 / fps();
      const t = q(timelineTime);

      if (edge === 'in') {
        const maxIn = clip.start + clip.duration - minLen;
        const headroom = clip.inPoint;                       // how far left we may go
        const lo = Number.isFinite(headroom) ? clip.start - headroom : 0;
        const nt = clamp(t, Math.max(0, lo), maxIn);
        const delta = nt - clip.start;
        clip.start = nt;
        clip.duration -= delta;
        clip.inPoint = Math.max(0, clip.inPoint + delta * (clip.speed || 1));
      } else {
        const tail = Number.isFinite(clip.sourceDuration)
          ? clip.start + (clip.sourceDuration - clip.inPoint) / (clip.speed || 1)
          : Infinity;
        const nt = clamp(t, clip.start + minLen, tail);
        clip.duration = nt - clip.start;
      }
      history.commit();
    },

    /** Razor: split every selected (or all) clip crossing `time`. */
    splitAt(time = store.rt.playhead, clipIds = store.rt.selection) {
      const t = q(time);
      const made = [];
      history.run('Split', (doc) => {
        for (const track of doc.tracks) {
          for (const clip of [...track.clips]) {
            const inRange = t > clip.start + 1e-4 && t < clip.start + clip.duration - 1e-4;
            const targeted = !clipIds?.length || clipIds.includes(clip.id);
            if (!inRange || !targeted || clip.locked) continue;
            const offset = t - clip.start;
            const right = structuredClone(clip);
            right.id = uid('clip');
            right.start = t;
            right.duration = clip.duration - offset;
            right.inPoint = clip.inPoint + offset * (clip.speed || 1);
            right.fadeIn = 0;
            right.keys = shiftKeys(clip.keys, -offset);
            clip.duration = offset;
            clip.fadeOut = 0;
            track.clips.push(right);
            made.push(right.id);
          }
          track.clips.sort((a, b) => a.start - b.start);
        }
      });
      if (made.length) store.select(made);
      else bus.emit('toast', {
        msg: 'Nothing to split — put the playhead over the middle of a clip first.',
      });
      return made;
    },

    removeSelected() {
      const ids = new Set(store.rt.selection);
      // Pressing a key and getting nothing back reads as a broken key. Saying
      // what is missing costs a line and turns it into an instruction.
      if (!ids.size) return bus.emit('toast', { msg: 'Select a clip first, then Delete.' });
      history.run('Delete', (doc) => {
        for (const track of doc.tracks)
          track.clips = track.clips.filter(c => !ids.has(c.id) || c.locked);
      });
      store.select([]);
    },

    duplicateSelected() {
      const ids = new Set(store.rt.selection);
      if (!ids.size) return bus.emit('toast', { msg: 'Select a clip first, then Ctrl+D to copy it.' });
      const made = [];
      history.run('Duplicate', (doc) => {
        for (const track of doc.tracks) {
          for (const clip of [...track.clips]) {
            if (!ids.has(clip.id)) continue;
            const copy = structuredClone(clip);
            copy.id = uid('clip');
            copy.start = clip.start + clip.duration;
            track.clips.push(copy);
            made.push(copy.id);
          }
          track.clips.sort((a, b) => a.start - b.start);
        }
      });
      store.select(made);
    },

    /** Deep-set a property path on one clip, e.g. 'text.size' or 'transform.x'. */
    setClipProp(clipId, path, value, { merge = true, label = 'Adjust' } = {}) {
      history.begin(label, merge ? `prop:${clipId}:${path}` : null);
      const { clip } = findClip(store.doc, clipId);
      if (!clip) return history.abort();
      setDeep(clip, path, value);
      history.commit();
    },

    setSelectedProp(path, value, opts) {
      for (const { clip } of store.selectedClips) api.setClipProp(clip.id, path, value, opts);
    },

    /* ── Keyframes ───────────────────────────────────────────── */

    toggleKeyTrack(clipId, path) {
      history.run('Toggle keyframes', () => {
        const { clip } = findClip(store.doc, clipId);
        if (!clip) return;
        if (clip.keys[path]) delete clip.keys[path];
        else clip.keys[path] = [{ t: store.rt.playhead - clip.start, v: getDeep(clip, path), e: 'ease' }];
      });
    },

    setKeyAt(clipId, path, time, value, easing = 'ease') {
      history.run('Keyframe', () => {
        const { clip } = findClip(store.doc, clipId);
        if (!clip) return;
        const local = +(time - clip.start).toFixed(5);
        const list = (clip.keys[path] ||= []);
        const hit = list.find(k => Math.abs(k.t - local) < 1e-3);
        if (hit) hit.v = value;
        else list.push({ t: local, v: value, e: easing });
        list.sort((a, b) => a.t - b.t);
      }, `key:${clipId}:${path}`);
    },

    /* ── Tracks ──────────────────────────────────────────────── */

    addTrack(kind, aboveId = null) {
      let created;
      history.run('Add track', (doc) => {
        const n = doc.tracks.filter(t => t.kind === kind).length + 1;
        created = makeTrack(kind, `${kind[0].toUpperCase()}${kind.slice(1)} ${n}`);
        const i = aboveId ? doc.tracks.findIndex(t => t.id === aboveId) : 0;
        doc.tracks.splice(Math.max(0, i), 0, created);
      });
      return created;
    },

    setTrackFlag(trackId, flag, value) {
      history.run('Track ' + flag, (doc) => {
        const t = trackById(doc, trackId);
        if (t) t[flag] = value;
      });
    },

    removeTrack(trackId) {
      history.run('Delete track', (doc) => {
        if (doc.tracks.length <= 1) return;
        doc.tracks = doc.tracks.filter(t => t.id !== trackId);
      });
    },

    /* ── Project ─────────────────────────────────────────────── */

    setResolution({ width, height, aspect, fps: f }) {
      history.run('Project settings', (doc) => {
        if (width) doc.width = width;
        if (height) doc.height = height;
        if (aspect) doc.aspect = aspect;
        if (f) doc.fps = f;
      });
    },

    addMarker(t = store.rt.playhead, label = '') {
      history.run('Add marker', (doc) => {
        doc.markers.push({ id: uid('mk'), t: q(t), label, color: '#ffb454' });
        doc.markers.sort((a, b) => a.t - b.t);
      });
    },

    /**
     * Markers could be added and never taken off again, which made a mistyped
     * M permanent and the ruler fill up with flags nobody wanted.
     */
    removeMarker(id) {
      const doc = store.doc;
      if (!doc.markers.some(m => m.id === id)) return false;
      history.run('Remove marker', (d) => {
        d.markers = d.markers.filter(m => m.id !== id);
      });
      return true;
    },

    clearMarkers() {
      if (!store.doc.markers.length) return false;
      history.run('Clear markers', (d) => { d.markers = []; });
      return true;
    },

    /** The marker nearest `t`, within `within` seconds. Null if none is close. */
    markerNear(t, within = 0.25) {
      let best = null, gap = within;
      for (const m of store.doc.markers) {
        const d = Math.abs(m.t - t);
        if (d <= gap) { gap = d; best = m; }
      }
      return best;
    },

    setBPM(bpm) {
      history.run('Set BPM', (doc) => { doc.bpm = clamp(bpm, 40, 300); }, 'bpm');
    },
  };

  return api;
}

/* ── helpers ──────────────────────────────────────────────────── */

export function getDeep(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setDeep(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ||= {}), obj);
  target[last] = value;
}

function shiftKeys(keys, delta) {
  const out = {};
  for (const [k, list] of Object.entries(keys || {}))
    out[k] = list.map(x => ({ ...x, t: x.t + delta }));
  return out;
}
