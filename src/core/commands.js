import { makeClip, makeTrack, findClip, trackById, trackAccepts, uid } from './schema.js';
import { snapFrame, clamp } from './time.js';
import { bus } from './events.js';
import { assets } from '../media/asset-store.js';
import { evalProp } from '../engine/keyframes.js';
import { projectForFootage } from '../project/presets.js';
import { syncLinks, settle, roomAround, childrenOf } from './links.js';
import { EFFECTS as EFFECT_LIST } from '../engine/layers/effects.js';
import { brandTextStyle } from '../project/brand.js';
import { animById, valuesFor } from '../anim/defs.js';
import { soundAssetFor } from '../anim/sfx.js';

/** Ready-made lanes (see addLane). */
export const LANE_PRESETS = {
  // Plain lanes keep the usual numbering (Video 3, Text 2).
  video:   { kind: 'video', name: 'Video',   numbered: true, note: 'Footage and pictures' },
  facecam: { kind: 'video', name: 'Facecam', note: 'Your camera, on top of the game', patch: { color: '#38bdf8' } },
  text:    { kind: 'text',  name: 'Text',    numbered: true, note: 'Titles, captions, stickers' },
  voice:   { kind: 'audio', name: 'Voice',   note: 'Mic or voice-over — cleaned up automatically', patch: { voice: true, color: '#22c55e' } },
  music:   { kind: 'audio', name: 'Music',   note: 'Dips by itself when someone talks', patch: { duck: { on: true, depth: 0.7 }, color: '#a855f7' } },
  sfx:     { kind: 'audio', name: 'SFX',     note: 'Hits, whooshes, sound effects', patch: { color: '#f59e0b' } },
  zoom:    { kind: 'video', name: 'Zoom',    note: 'Smart Zoom: punch-ins on the big moments', patch: { color: '#C6FF3D', zoomLane: true } },
};

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
  let lookClipboard = null;
  const fps = () => store.doc.fps;
  const q = (t) => snapFrame(Math.max(0, t), fps());

  /** Ripple mode: edits pull (or push) the later clips on the same track. */
  const rippling = () => !!store.ui.ripple;

  /**
   * After every edit: linked copies follow their footage, and a copy that now
   * lands on something moves to a free lane. See core/links.js.
   */
  history.onBeforeCommit = (doc) => {
    const moved = syncLinks(doc);
    if (moved.length) settle(doc, moved.map(m => m.clip.id));
  };

  /**
   * Whether a clip may be changed at all.
   *
   * A lock on the TRACK has to protect its clips exactly as a lock on the clip
   * does. Several commands only ever checked `clip.locked`, so locking a lane
   * to keep the gameplay safe while cutting the music stopped nothing: Delete,
   * S, the arrow keys and dragging all went straight through it.
   */
  const editable = (clip, track) => !!clip && !clip.locked && !(track && track.locked);

  /** Move a clip's speed badge along with it, if it has one. */
  function followBadge(doc, clip, delta) {
    if (!delta) return;
    for (const t of doc.tracks) {
      for (const b of t.clips) {
        if (b.badgeFor === clip.id) b.start = q(b.start + delta);
      }
    }
  }

  /**
   * Ripple: slide every clip on `track` that starts at or after `from` by
   * `delta` seconds — negative pulls them back into a gap, positive makes room.
   *
   * Strictly one track. Rippling every track would drag the music out from
   * under the picture it was cut to, which is the opposite of what anyone
   * pressing Delete on a single clip meant. Locked clips stay where they are.
   */
  function shiftAfter(doc, track, from, delta, skip = null) {
    if (!track || Math.abs(delta) < 1e-9) return;
    for (const c of track.clips) {
      if (c === skip || c.locked) continue;
      if (c.start >= from - 1e-6) {
        c.start = q(c.start + delta);
        followBadge(doc, c, delta);
      }
    }
    track.clips.sort((a, b) => a.start - b.start);
  }

  /** Union of [start, end) intervals, merged and sorted. */
  function union(list) {
    const iv = list.map(c => [c.start, c.start + c.duration]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [a, b] of iv) {
      const last = out.at(-1);
      if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  /**
   * After clips are removed from a track in ripple mode, pull the survivors
   * back over the time that is now empty.
   *
   * "Empty" is the time the removed clips covered that no surviving clip also
   * covers — so deleting a clip that was stacked over another does not drag
   * anything, and deleting several separated clips closes each hole exactly.
   * Each survivor moves back by the empty time that lies before it, which can
   * never make two survivors collide: the time between them only shrinks by
   * the empty part of it.
   */
  function closeFreed(doc, track, removed, keep) {
    const cover = union(keep);
    const freed = [];
    for (const [a, b] of union(removed)) {
      let pieces = [[a, b]];
      for (const [ka, kb] of cover) {
        const next = [];
        for (const [pa, pb] of pieces) {
          if (kb <= pa || ka >= pb) { next.push([pa, pb]); continue; }
          if (ka > pa) next.push([pa, ka]);
          if (kb < pb) next.push([kb, pb]);
        }
        pieces = next;
      }
      freed.push(...pieces.filter(([pa, pb]) => pb - pa > 1e-6));
    }
    if (!freed.length) return false;
    let moved = false;
    for (const c of keep) {
      if (c.locked) continue;
      let back = 0;
      for (const [a, b] of freed) if (a < c.start - 1e-6) back += Math.min(b, c.start) - a;
      if (back > 1e-6) {
        c.start = q(c.start - back);
        followBadge(doc, c, -back);
        moved = true;
      }
    }
    keep.sort((a, b) => a.start - b.start);
    return moved;
  }

  /** Shift every keyframe on a clip by `delta` seconds, in place. */
  function shiftKeysInPlace(clip, delta) {
    if (!delta) return;
    for (const list of Object.values(clip.keys || {})) {
      for (const k of list) k.t = +(k.t + delta).toFixed(5);
    }
  }

  /**
   * Trim one edge of a clip, inside whatever transaction is already open.
   *
   * Shared by the trim drag and by the Inspector's Duration field, so both
   * respect the footage that actually exists and both ripple.
   */
  function applyTrim(doc, clip, track, edge, time) {
    const frame = 1 / fps();
    const minLen = 2 * frame;
    const speed = clip.speed || 1;
    const t = q(time);
    /**
     * Only real footage has a beginning to run out of. A title, a shape or a
     * still picture can be stretched to the left as far as the timeline goes;
     * checking `inPoint` (always 0 for those) used to pin their left edge in
     * place, so a title could only ever be lengthened from the right.
     */
    const media = Number.isFinite(clip.sourceDuration);
    const oldEnd = clip.start + clip.duration;

    if (edge === 'in') {
      /**
       * `inPoint` is in SOURCE seconds; how far left the edge may move is in
       * TIMELINE seconds. At 2× there is half as much timeline left in the
       * footage before the in-point as there is footage. Treating the two as
       * the same let a sped-up clip be dragged past the start of its own
       * recording — the clip grew, the in-point clamped at 0, and the extra
       * length was the clip's own first frames repeated. Rounded down to a whole
       * frame so the clip's start stays on one.
       */
      const headroom = media
        ? Math.floor((Math.max(0, clip.inPoint) / speed) * fps() + 1e-6) / fps()
        : Infinity;
      let delta;
      if (rippling()) {
        // The clip keeps its place on the timeline and the cut moves inside it;
        // everything after it follows the change in length.
        delta = clamp(t - clip.start, -headroom, clip.duration - minLen);
      } else {
        // Never under the clip before it: the edge stops at the neighbour.
        const lo = Math.max(0, clip.start - headroom, roomAround(track, clip).lo);
        delta = clamp(t, lo, oldEnd - minLen) - clip.start;
        clip.start = q(clip.start + delta);
        delta = clip.start - (oldEnd - clip.duration);
      }
      if (Math.abs(delta) < 1e-9) return;
      clip.duration = rippling() ? clip.duration - delta : oldEnd - clip.start;
      if (media) clip.inPoint = Math.max(0, clip.inPoint + delta * speed);
      // Keyframes are measured from the clip's start. The picture under them
      // has just moved by `delta`, so they move back by the same amount and
      // stay on the moment they were set on — the way a split already treats
      // them.
      shiftKeysInPlace(clip, -delta);
      if (rippling()) shiftAfter(doc, track, oldEnd, -delta, clip);
    } else {
      let tail = media ? clip.start + (clip.sourceDuration - clip.inPoint) / speed : Infinity;
      // Without Ripple nothing makes room, so the edge stops at the next clip.
      if (!rippling()) tail = Math.min(tail, roomAround(track, clip).hi);
      const nt = clamp(t, clip.start + minLen, Math.max(clip.start + minLen, tail));
      clip.duration = nt - clip.start;
      if (rippling()) shiftAfter(doc, track, oldEnd, nt - oldEnd, clip);
    }
    // A speed badge spans its clip; keep it doing so.
    const badge = api.badgeOf(clip.id);
    if (badge) { badge.start = clip.start; badge.duration = clip.duration; }
  }

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
        // Never on top of something already there.
        settle(doc, [clip.id]);
      });
      if (select) store.select([clip.id]);
      return clip;
    },

    /**
     * A text layer at `at`.
     *
     * `trackId` is a preference, honoured only when that track can actually
     * show text. Right-clicking an audio lane and choosing "Add a text layer
     * here" used to put a text clip on the audio track — where nothing ever
     * draws it, so it looked like the command had failed. Anything else goes to
     * a text track with room at that moment (a new one if every one is busy),
     * rather than on top of a title that is already there.
     */
    addTextClip(at = store.rt.playhead, trackId = null, preset = null) {
      /*
       * `preset` is `{ name, text, style }` — a saved text or a built-in look.
       * It is folded into the clip before the clip is added, so the whole thing
       * is ONE step of undo: adding text and then styling it as two commands
       * means Ctrl+Z walks back through a plain default text nobody asked for.
       */
      const style = preset?.style || null;
      // Long enough for what it does: a text that types or slides over a
      // second would otherwise be cut off before it finished arriving.
      const moves = style ? (style.animDur || 0.35) * ((style.animUnit && style.animUnit !== 'all') ? 3 : 1)
        + (style.animOut && style.animOut !== 'none' ? (style.animOutDur || 0.35) : 0) : 0;
      const dur = Math.max(3, Math.ceil((moves + 1.2) * 2) / 2);
      const want = trackById(store.doc, trackId);
      const track = want && !want.locked && trackAccepts(want.kind, 'text')
        ? want
        : api.textTrackFor(Math.max(0, at), dur);
      if (!track) return null;
      const clip = makeClip('text', { name: preset?.name || 'Text', start: at, duration: dur });
      // Your brand's font and colour first; a chosen look then wins.
      Object.assign(clip.text, brandTextStyle());
      if (style) Object.assign(clip.text, style);
      if (preset?.text) clip.text.text = preset.text;
      const made = api.addClip(track.id, clip, { label: preset ? `Add text: ${preset.name || 'saved'}` : 'Add text' });
      // Show the lane it went on — it may be scrolled out of sight.
      bus.emit('timeline:reveal', { trackId: made.trackId, start: made.start, duration: made.duration });
      return made;
    },

    /**
     * An animation from the library at `at` (src/anim/defs.js).
     *
     * It lands where that animation belongs (a kill counter top-left, a
     * subscribe button low in the middle), on a free text lane, with its sound
     * attached. A kill counter carries on counting: the next one placed after
     * another shows the number after it.
     */
    addAnimation(id, at = store.rt.playhead, { p = {}, trackId = null, select = true } = {}) {
      const def = animById(id);
      if (!def) return null;
      const start = q(at);
      const params = { ...p };
      if (id === 'killCounter' && params.count == null) {
        let last = 0;
        for (const t of store.doc.tracks) for (const c of t.clips) {
          if (c.type === 'anim' && c.anim?.id === 'killCounter' && c.start <= start + 1e-6) {
            last = Math.max(last, Number(valuesFor(def, c.anim.p).count) || 0);
          }
        }
        if (last) params.count = last + 1;
      }
      const dur = def.durFor?.(valuesFor(def, params)) ?? def.dur;
      const want = trackById(store.doc, trackId);
      const track = want && !want.locked && trackAccepts(want.kind, 'anim') ? want : api.textTrackFor(start, dur);
      if (!track) return null;
      const clip = makeClip('anim', {
        name: def.name, start, duration: dur,
        anim: { id, p: params },
        assetId: soundAssetFor(def, valuesFor(def, params), dur),
        sourceDuration: Infinity,
        transform: { x: def.place.x, y: def.place.y },
      });
      const made = api.addClip(track.id, clip, { select, label: `Add ${def.name.toLowerCase()}` });
      bus.emit('timeline:reveal', { trackId: made.trackId, start: made.start, duration: made.duration });
      return made;
    },

    /**
     * Change an animation's settings; its sound follows (a countdown from 5
     * beeps five times). `sound: false` skips the sound while typing, so a
     * half-typed word does not leave a sound behind for every keystroke.
     */
    setAnimParam(clipId, key, value, { merge = true, sound = true } = {}) {
      const { clip } = findClip(store.doc, clipId);
      if (!clip || clip.type !== 'anim') return;
      const def = animById(clip.anim.id);
      if (def && valuesFor(def, clip.anim.p)[key] === value) return;
      const p = { ...(clip.anim.p || {}), [key]: value };
      /*
       * Some animations are as long as what they show — a countdown from 5
       * needs longer than one from 3. They grow (or shrink) to fit, but never
       * into the next clip on their lane.
       */
      let dur = clip.duration;
      const want = def?.durFor?.(valuesFor(def, p));
      if (want) {
        const { track } = findClip(store.doc, clipId);
        const next = Math.min(Infinity, ...track.clips.filter(o => o !== clip && o.start >= clip.start + 1e-6).map(o => o.start));
        dur = q(Math.min(want, next - clip.start));
      }
      const assetId = sound && def && !clip.soundOff ? soundAssetFor(def, valuesFor(def, p), dur) : clip.assetId;
      history.run(`Customize ${def?.name.toLowerCase() || 'animation'}`, (doc) => {
        const c = findClip(doc, clipId).clip;
        if (!c) return;
        c.anim = { ...c.anim, p };
        c.duration = dur;
        c.assetId = assetId;
      }, merge ? `anim:${clipId}:${key}` : null);
    },

    /** Swap an animation for another, keeping where and when it is. */
    swapAnimation(clipId, id) {
      const def = animById(id);
      const { clip } = findClip(store.doc, clipId);
      if (!def || !clip || clip.type !== 'anim') return;
      // Words carry over when the new one has a field of the same name.
      const keep = {};
      for (const prm of def.params) if (clip.anim.p?.[prm.key] != null && prm.type === 'text') keep[prm.key] = clip.anim.p[prm.key];
      const assetId = clip.soundOff ? null : soundAssetFor(def, valuesFor(def, keep), clip.duration);
      history.run(`Swap for ${def.name.toLowerCase()}`, (doc) => {
        const c = findClip(doc, clipId).clip;
        if (!c) return;
        c.anim = { id, p: keep };
        c.name = def.name;
        c.assetId = assetId;
      });
    },

    /** Every Customize change undone in one go. */
    resetAnimation(clipId) {
      const { clip } = findClip(store.doc, clipId);
      if (!clip || clip.type !== 'anim') return;
      const def = animById(clip.anim.id);
      const assetId = clip.soundOff || !def ? clip.assetId : soundAssetFor(def, valuesFor(def, {}), clip.duration);
      history.run('Reset animation', (doc) => {
        const c = findClip(doc, clipId).clip;
        if (!c) return;
        c.anim = { id: c.anim.id, p: {} };
        c.assetId = assetId;
      });
    },

    /** Animation sound on or off. */
    setAnimSound(clipId, on) {
      const { clip } = findClip(store.doc, clipId);
      if (!clip || clip.type !== 'anim') return;
      const def = animById(clip.anim.id);
      const assetId = on && def ? soundAssetFor(def, valuesFor(def, clip.anim.p), clip.duration) : null;
      history.run(on ? 'Sound on' : 'Sound off', (doc) => {
        const c = findClip(doc, clipId).clip;
        if (!c) return;
        c.soundOff = !on;
        c.assetId = assetId;
      });
    },

    /**
     * An effect moment at `at`: punch-in zoom, shake, flash and the rest
     * (engine/layers/effects.js). It goes on the topmost picture lane that is
     * free then — above the footage, below the titles — and a fresh lane is
     * made at the top of the picture lanes when none is.
     */
    addEffect(kind = 'zoom', at = store.rt.playhead, patch = {}) {
      const info = EFFECT_LIST.find(e => e.id === kind) || EFFECT_LIST[0];
      const dur = patch.duration || info.dur;
      const start = Math.max(0, at);
      const top = store.doc.tracks.find(t => t.kind === 'video' && !t.locked);
      if (!top) return null;
      const clip = makeClip('effect', {
        name: info.name, start, duration: dur,
        effect: { kind: info.id, amount: patch.amount ?? 0.6, x: patch.x ?? 0.5, y: patch.y ?? 0.5 },
      });
      // addClip settles it onto a free lane (a new one at the top if needed).
      const made = api.addClip(top.id, clip, { label: `Add ${info.name.toLowerCase()}` });
      bus.emit('timeline:reveal', { trackId: made.trackId, start: made.start, duration: made.duration });
      return made;
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
        // Follows the footage it was cut from through every later edit.
        linkTo: clip.id,
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
    /* ── Speed badges ─────────────────────────────────────────
     * The little "2×" that sits in the corner of a sped-up shot.
     *
     * It is a plain text layer, not a new kind of object — which means it can
     * be dragged, restyled, keyframed, faded and deleted with everything you
     * already know, and costs the renderer nothing new. The one thing that
     * makes it a badge is `badgeFor`: the id of the clip it is about. That is
     * what lets it rewrite itself from 2× to 4× when you change your mind, and
     * follow the clip when the new speed makes it shorter.
     */

    /** How a speed reads on screen. 2 is "2×", 1.5 is "1.5×", 0.5 is "0.5×". */
    speedLabel(speed) {
      const v = Number(speed) || 1;
      const n = v >= 10 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, '');
      return `${n}\u00d7`;
    },

    /** The badge belonging to a clip, if it has one. */
    badgeOf(clipId) {
      for (const t of store.doc.tracks) {
        const c = t.clips.find(x => x.badgeFor === clipId);
        if (c) return c;
      }
      return null;
    },

    /** A text track with room for [start, start+duration), making one if need be. */
    textTrackFor(start, duration) {
      const end = start + duration;
      for (const t of store.doc.tracks) {
        if (t.kind !== 'text' || t.locked) continue;
        const clash = t.clips.some(c => c.start < end && c.start + c.duration > start);
        if (!clash) return t;
      }
      return api.addTrack('text');
    },

    addSpeedBadge(clipId) {
      const { clip } = findClip(store.doc, clipId);
      if (!clip) return null;
      if (clip.type !== 'video' && clip.type !== 'image')
        return { ok: false, reason: 'Only a clip with footage can have a speed badge.' };

      const existing = api.badgeOf(clipId);
      if (existing) { store.select([existing.id]); return { ok: true, clip: existing, existed: true }; }

      const track = api.textTrackFor(clip.start, clip.duration);
      const badge = makeClip('text', {
        name: 'Speed badge',
        start: clip.start,
        duration: clip.duration,
        badgeFor: clipId,
      });
      Object.assign(badge.text, {
        text: api.speedLabel(clip.speed),
        font: 'Inter', weight: 900, size: 0.052,
        fill: 'solid', color: '#ffffff',
        letterSpacing: 0.01,
        strokeWidth: 0, glow: 0,
        shadow: 0.012, shadowColor: '#000000', shadowY: 0.004,
        // A plate, because a bare number over busy gameplay disappears.
        bg: 'pill', bgColor: '#1d4ed8e6', bgPad: 0.022, bgRadius: 0.5,
        anim: 'pop', animDur: 0.28,
      });
      /**
       * Top-left, inside the safe guides.
       *
       * It used to sit bottom-right, which on a 9:16 post is exactly where
       * TikTok, Shorts and Reels stack their like / comment / share buttons —
       * the badge vanished under them on the phone. Top-left is clear on every
       * platform. A tall frame needs it further in from the side, because the
       * side margins of the guides are wider there.
       */
      const portrait = store.doc.height > store.doc.width;
      badge.transform.x = portrait ? 0.18 : 0.12;
      badge.transform.y = 0.12;
      badge.transform.w = 0.24;

      api.addClip(track.id, badge, { label: 'Add speed badge' });
      return { ok: true, clip: badge, track };
    },

    removeSpeedBadge(clipId) {
      const badge = api.badgeOf(clipId);
      if (!badge) return false;
      history.run('Remove speed badge', (doc) => {
        for (const t of doc.tracks) {
          const i = t.clips.findIndex(c => c.id === badge.id);
          if (i >= 0) { t.clips.splice(i, 1); return; }
        }
      });
      return true;
    },

    /**
     * Keep a badge telling the truth.
     *
     * Called from inside the speed command's own history step, so changing a
     * clip from 2× to 4× is one undo, not two — and the badge can never be left
     * announcing a speed the clip no longer runs at.
     */
    syncSpeedBadge(clip) {
      const badge = api.badgeOf(clip.id);
      if (!badge) return;
      badge.text.text = api.speedLabel(clip.speed);
      badge.start = clip.start;
      badge.duration = clip.duration;
    },

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
        linkTo: clip.id,
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
      if (!editable(clip, track)) return history.abort();
      clip.start = q(newStart);
      if (newTrackId && newTrackId !== track.id) {
        const dst = trackById(doc, newTrackId);
        if (dst && !dst.locked && trackAccepts(dst.kind, clip.type)) {
          track.clips.splice(track.clips.indexOf(clip), 1);
          clip.trackId = dst.id;
          dst.clips.push(clip);
          dst.clips.sort((a, b) => a.start - b.start);
        }
      } else {
        track.clips.sort((a, b) => a.start - b.start);
      }
      settle(doc, [clipId]);
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
      const { clip, track } = findClip(store.doc, clipId);
      if (!clip) return history.abort();
      if (!editable(clip, track)) {
        history.abort();
        bus.emit('toast', { msg: 'That clip is locked — unlock it (or its track) to change its speed.' });
        return clip.duration;
      }
      const oldEnd = clip.start + clip.duration;

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

      const room = roomAround(track, clip).hi;
      clip.speed = to;
      clip.duration = dur;
      api.syncSpeedBadge(clip);
      // Faster makes the clip shorter; with Ripple on, what follows closes up
      // behind it instead of leaving a gap of black (and slower pushes it on).
      if (rippling()) shiftAfter(store.doc, track, oldEnd, clip.start + dur - oldEnd, clip);
      // Ripple off: slower still has to push whatever it would now run into,
      // or the end of this clip would play hidden under the next one.
      else if (clip.start + dur > room + 1e-6) shiftAfter(store.doc, track, oldEnd, clip.start + dur - room, clip);
      history.commit();
      return dur;
    },

    /**
     * Speed ramp around a moment: slow into the headshot, hold it, snap back.
     *
     * Done the honest way rather than with a hidden time curve: the clip is
     * cut into a few pieces, each at its own steady speed, so every piece is an
     * ordinary clip you can see, trim or change. Later clips on the lane move
     * along by however much longer the ramp made it. One undo.
     */
    speedRamp(clipId, at = store.rt.playhead, preset = 'hit') {
      const { clip, track } = findClip(store.doc, clipId);
      if (!clip || clip.type !== 'video') { bus.emit('toast', { msg: 'Speed ramps work on video clips.' }); return null; }
      if (!editable(clip, track)) { bus.emit('toast', { msg: 'That clip is locked.' }); return null; }
      if (!(at > clip.start + 1e-3 && at < clip.start + clip.duration - 1e-3)) {
        bus.emit('toast', { msg: 'Put the playhead on the moment inside the clip you want to slow down.' });
        return null;
      }
      const v0 = clip.speed || 1;
      const s0 = clip.inPoint, s1 = clip.inPoint + clip.duration * v0;
      const sm = clip.inPoint + (at - clip.start) * v0;
      const PRESETS = {
        hit:    [[-0.5, -0.25, 0.5], [-0.25, 0.35, 0.25], [0.35, 0.55, 0.5]],
        smooth: [[-0.8, -0.4, 0.6], [-0.4, -0.15, 0.4], [-0.15, 0.45, 0.3], [0.45, 0.7, 0.4], [0.7, 1.0, 0.6]],
        rush:   [[-Infinity, -0.3, Math.max(3, v0)], [-0.3, 0.5, 0.5]],
      };
      const plan = (PRESETS[preset] || PRESETS.hit)
        .map(([a, b, v]) => [Math.max(s0, sm + a), Math.min(s1, sm + b), v])
        .filter(([a, b]) => b - a > 1e-3);
      // Fill the rest of the clip at its own speed.
      const segs = [];
      let cur = s0;
      for (const [a, b, v] of plan) {
        if (a > cur + 1e-3) segs.push([cur, a, v0]);
        segs.push([Math.max(a, cur), b, v]);
        cur = b;
      }
      if (s1 > cur + 1e-3) segs.push([cur, s1, v0]);
      const frame = 1 / fps();
      // Pieces too short to show a frame join the one before them.
      const merged = [];
      for (const sg of segs) {
        if ((sg[1] - sg[0]) / sg[2] < 2 * frame && merged.length) merged.at(-1)[1] = sg[1];
        else merged.push([...sg]);
      }
      const made = [];
      history.run(`Speed ramp`, (doc) => {
        const { clip: c, track: tr } = findClip(doc, clipId);
        const children = childrenOf(doc, c.id).filter(x => x.clip.linkTo);
        const oldEnd = c.start + c.duration;
        let t = c.start;
        const pieces = merged.map(([a, b, v], i) => {
          const p = i === 0 ? c : structuredClone(c);
          if (i) { p.id = uid('clip'); p.transIn = null; delete p.badgeFor; p.keys = {}; p.fadeIn = 0; }
          p.inPoint = a; p.speed = v; p.start = q(t);
          p.duration = Math.max(frame, q((b - a) / v));
          if (i < merged.length - 1) p.fadeOut = 0;
          t = p.start + p.duration;
          return p;
        });
        pieces.at(-1).fadeOut = c.fadeOut;
        const grow = t - oldEnd;
        for (const o of tr.clips) if (o !== c && !o.locked && o.start >= oldEnd - 1e-6) o.start = q(o.start + grow);
        for (const p of pieces.slice(1)) tr.clips.push(p);
        tr.clips.sort((x, y) => x.start - y.start);
        // A cropped layer of this shot gets a piece for every piece.
        for (const { clip: ch, track: ct } of children) {
          for (const p of pieces.slice(1)) {
            const cp = structuredClone(ch);
            cp.id = uid('clip'); cp.linkTo = p.id;
            ct.clips.push(cp);
          }
        }
        made.push(...pieces.map(p => p.id));
      });
      store.select(made);
      bus.emit('toast', { msg: `Speed ramp: ${made.length} pieces, slowest ${Math.min(...merged.map(m => m[2]))}×`, kind: 'ok', key: 'edit', action: { label: 'Undo', run: () => history.undo() } });
      return made;
    },

    /** Trim one edge. `edge` is 'in' | 'out'. Respects source media bounds. */
    trimClip(clipId, edge, timelineTime, merge = true) {
      history.begin('Trim clip', merge ? 'trim:' + clipId + edge : null);
      const { clip, track } = findClip(store.doc, clipId);
      if (!editable(clip, track)) return history.abort();
      delete clip.linkTo;              // trimming a copy by hand frees it
      applyTrim(store.doc, clip, track, edge === 'in' ? 'in' : 'out', timelineTime);
      history.commit();
    },

    /**
     * Video clips that a freeze at `time` would pause: on the picture at that
     * moment, on unlocked tracks, not locked themselves.
     */
    freezeTargets(time = store.rt.playhead) {
      const t = q(time);
      const out = [];
      for (const track of store.doc.tracks) {
        if (track.locked) continue;
        for (const clip of track.clips) {
          if (clip.type !== 'video' || clip.locked) continue;
          if (t >= clip.start - 1e-4 && t < clip.start + clip.duration - 1e-4) out.push({ clip, track, t });
        }
      }
      return out;
    },

    /**
     * Freeze frame: the picture stops at `time` for `hold` seconds, then plays on.
     *
     * Each video clip under the playhead is cut there and a still of that exact
     * frame (`stills[clipId]` → an image asset) is put in the gap. The still
     * copies the clip's look — crop, fit, effects, and position/size as they
     * are at that moment, keyframes included — so the pause is seamless.
     * Everything that starts at or after the freeze moves later by `hold`, on
     * every unlocked track, so titles and cuts stay with the footage they
     * belong to. Clips that are already playing across the freeze (a song)
     * carry on underneath it.
     */
    insertFreeze(time, stills, hold = 2) {
      const t = q(time);
      const h = Math.max(1 / fps(), q(hold));
      const made = [];
      history.run('Freeze frame', (doc) => {
        const targets = [];
        for (const track of doc.tracks) {
          if (track.locked) continue;
          for (const clip of track.clips) {
            if (clip.type !== 'video' || clip.locked || !stills[clip.id]) continue;
            if (t >= clip.start - 1e-4 && t < clip.start + clip.duration - 1e-4) targets.push({ clip, track });
          }
        }
        if (!targets.length) return;

        // 1. Cut each target at the freeze (unless the freeze is its first frame).
        const frozen = [];
        for (const { clip, track } of targets) {
          const shape = structuredClone(clip);       // the look at the freeze moment
          for (const path of Object.keys(clip.keys || {})) setPath(shape, path, evalProp(clip, path, t));
          if (t > clip.start + 1e-4) {
            const offset = t - clip.start;
            const right = structuredClone(clip);
            right.id = uid('clip');
            right.start = t;
            right.duration = clip.duration - offset;
            right.inPoint = clip.inPoint + offset * (clip.speed || 1);
            right.fadeIn = 0;
            right.keys = shiftKeys(clip.keys, -offset);
            right.transIn = null;
            delete right.badgeFor;
            clip.duration = offset;
            clip.fadeOut = 0;
            track.clips.push(right);
          }
          frozen.push({ shape, track, assetId: stills[clip.id] });
        }

        // 2. Make room: everything from the freeze on moves later by the hold.
        for (const track of doc.tracks) {
          if (track.locked) continue;
          for (const c of track.clips) if (c.start >= t - 1e-4) c.start = q(c.start + h);
        }
        for (const m of doc.markers || []) if (m.t >= t - 1e-4) m.t = q(m.t + h);

        // 3. The stills, in the gap.
        for (const { shape, track, assetId } of frozen) {
          const still = makeClip('image', {
            trackId: track.id, assetId,
            name: `${shape.name || 'Clip'} (frozen)`,
            start: t, duration: h,
            crop: shape.crop ? { ...shape.crop } : null,
            transform: { ...shape.transform },
          });
          for (const k of ['fit', 'fx']) if (shape[k] !== undefined) still[k] = structuredClone(shape[k]);
          track.clips.push(still);
          made.push(still.id);
        }
        for (const track of doc.tracks) track.clips.sort((a, b) => a.start - b.start);
      });
      if (made.length) store.select(made);
      return made;
    },

    /* ── Copy look / paste look ──────────────────────────────────
     * A clip's crop, look (shadow, glow…), motion, framing and size — or a
     * title's whole style — copied once and pasted onto any number of clips
     * in one undo. Cropping the minimap out of one recording and pasting that
     * crop onto the next ten is the everyday case. */
    copyLook(clipId) {
      const { clip } = findClip(store.doc, clipId);
      if (!clip) return null;
      const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, structuredClone(o[k])]));
      const look = { from: clip.type, name: clip.name };
      if (clip.type === 'text') {
        const { text, ...style } = clip.text || {};
        void text;
        look.textStyle = structuredClone(style);
      }
      if (clip.type === 'effect') look.effect = structuredClone(clip.effect);
      Object.assign(look, pick(clip, ['fx', 'motion', 'fit', 'crop', 'flipH', 'flipV']));
      look.transform = pick(clip.transform || {}, ['x', 'y', 'scale', 'rotation', 'opacity']);
      lookClipboard = look;
      bus.emit('toast', { msg: `Copied the look of “${clip.name || clip.type}” — select clips and paste it (Ctrl+Alt+V)`, ms: 3200, key: 'look' });
      return look;
    },

    get copiedLook() { return lookClipboard; },

    pasteLook(ids = store.rt.selection) {
      const look = lookClipboard;
      if (!look) { bus.emit('toast', { msg: 'Copy a look first: right-click a clip → Copy look.' }); return 0; }
      let n = 0;
      history.run('Paste look', (doc) => {
        for (const t of doc.tracks) {
          if (t.locked) continue;
          for (const c of t.clips) {
            if (!ids.includes(c.id) || c.locked) continue;
            const textToText = c.type === 'text' && look.textStyle;
            const picToPic = (c.type === 'video' || c.type === 'image') && look.from !== 'text' && look.from !== 'effect';
            const fxToFx = c.type === 'effect' && look.effect;
            if (!textToText && !picToPic && !fxToFx && !(c.type === 'shape' && look.motion)) continue;
            if (textToText) c.text = { ...c.text, ...structuredClone(look.textStyle) };
            if (fxToFx) c.effect = structuredClone(look.effect);
            if (picToPic) {
              for (const k of ['fx', 'fit', 'crop', 'flipH', 'flipV']) {
                if (look[k] === undefined) delete c[k]; else c[k] = structuredClone(look[k]);
              }
            }
            if (look.motion && c.type !== 'text') c.motion = structuredClone(look.motion);
            if (c.type !== 'effect' && c.type !== 'audio') c.transform = { ...c.transform, ...look.transform };
            n++;
          }
        }
      });
      bus.emit('toast', n
        ? { msg: `Pasted the look onto ${n} clip${n === 1 ? '' : 's'}`, kind: 'ok', key: 'look', action: { label: 'Undo', run: () => history.undo() } }
        : { msg: 'None of the selected clips can take that look (text looks go on text, picture looks on footage and pictures).', key: 'look' });
      return n;
    },

    /** Razor: split every selected (or all) clip crossing `time`. */
    splitAt(time = store.rt.playhead, clipIds = store.rt.selection) {
      const t = q(time);
      const made = [];
      history.run('Split', (doc) => {
        const rightOf = new Map();          // left id -> right id, for links
        for (const track of doc.tracks) {
          if (track.locked) continue;
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
            /**
             * The new cut is a hard cut. A transition belongs to the cut BEFORE
             * a clip, and the right half's "cut before" is the one just made —
             * copying the left half's dissolve put a dissolve on it, so pressing
             * S on a clip with a transition made a second transition appear in
             * the middle of the shot.
             */
            right.transIn = null;
            // Only one clip can own a speed badge; a split badge's right half
            // is just text.
            delete right.badgeFor;
            clip.duration = offset;
            clip.fadeOut = 0;
            track.clips.push(right);
            made.push(right.id);
            rightOf.set(clip.id, right.id);
          }
          track.clips.sort((a, b) => a.start - b.start);
        }
        /*
         * Linked copies (a cropped HUD layer, extracted sound) are cut with
         * their footage even when only the footage was selected: the right
         * half of the shot gets the right half of its crop. A copy that was
         * split itself just points at the matching half.
         */
        for (const track of doc.tracks) {
          for (const c of [...track.clips]) {
            if (!c.linkTo || made.includes(c.id)) continue;
            const r = rightOf.get(c.linkTo);
            if (!r || rightOf.has(c.id)) continue;   // a copy split itself is fixed below
            if (track.locked || c.locked) continue;
            const copy = structuredClone(c);
            copy.id = uid('clip');
            copy.linkTo = r;
            track.clips.push(copy);
            track.clips.sort((a, b) => a.start - b.start);
          }
        }
        // Right halves of copies that were split themselves: follow the right
        // half of the parent rather than the left.
        for (const track of doc.tracks) for (const c of track.clips) {
          if (made.includes(c.id) && c.linkTo && rightOf.has(c.linkTo)) c.linkTo = rightOf.get(c.linkTo);
        }
      });
      if (made.length) {
        store.select(made);
        bus.emit('cut:flash', { t });
        bus.emit('toast', {
          msg: made.length === 1 ? 'Split' : `Split ${made.length} clips`,
          key: 'edit', ms: 3000,
          action: { label: 'Undo', run: () => history.undo() },
        });
      } else {
        const locked = store.doc.tracks.some(tr => tr.clips.some(c =>
          (tr.locked || c.locked) && t > c.start + 1e-4 && t < c.start + c.duration - 1e-4));
        bus.emit('toast', {
          msg: locked && !store.doc.tracks.some(tr => !tr.locked && tr.clips.some(c =>
            !c.locked && t > c.start + 1e-4 && t < c.start + c.duration - 1e-4))
            ? 'That clip is locked — unlock its track to cut it.'
            : 'Nothing to split — put the playhead over the middle of a clip first.',
        });
      }
      return made;
    },

    /** Ids of every clip that can be selected for editing — not on a locked track, not locked. */
    selectableIds() {
      const out = [];
      for (const t of store.doc.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) if (!c.locked) out.push(c.id);
      }
      return out;
    },

    removeSelected({ ripple: forceRipple = false } = {}) {
      const ids = new Set(store.rt.selection);
      // Pressing a key and getting nothing back reads as a broken key. Saying
      // what is missing costs a line and turns it into an instruction.
      if (!ids.size) return bus.emit('toast', { msg: 'Select a clip first, then Delete.' });
      // Shift+Delete closes the gap whether or not Ripple is switched on.
      const ripple = forceRipple || rippling();
      let removed = 0, kept = 0, closed = false;
      history.run('Delete', (doc) => {
        const gone = new Set();
        for (const track of doc.tracks) {
          for (const c of track.clips) {
            if (!ids.has(c.id)) continue;
            if (editable(c, track)) gone.add(c.id); else kept++;
          }
        }
        // A speed badge about a clip that no longer exists is just a stray
        // "2×" floating over the next shot, and a crop of footage that is gone
        // shows a moment of nothing — both go with their clip.
        const badges = new Set();
        for (const track of doc.tracks) {
          if (track.locked) continue;
          for (const c of track.clips) {
            if (c.locked) continue;
            if ((c.badgeFor && gone.has(c.badgeFor)) || (c.linkTo && gone.has(c.linkTo))) badges.add(c.id);
          }
        }
        for (const track of doc.tracks) {
          const out = track.clips.filter(c => gone.has(c.id));
          const extra = track.clips.filter(c => badges.has(c.id) && !gone.has(c.id));
          if (!out.length && !extra.length) continue;
          const keep = track.clips.filter(c => !gone.has(c.id) && !badges.has(c.id));
          // Only what you deleted closes up — a badge leaving with its clip
          // must not drag the other titles on its track.
          if (ripple && out.length && closeFreed(doc, track, out, keep)) closed = true;
          track.clips = keep;
          removed += out.length;
        }
      });
      store.select([...ids].filter(id => findClip(store.doc, id).clip));
      if (removed) {
        bus.emit('toast', {
          msg: (removed === 1 ? 'Deleted 1 clip' : `Deleted ${removed} clips`)
            + (closed ? ' and closed the gap' : '')
            + (kept ? ` · ${kept} locked left alone` : ''),
          key: 'edit', ms: 4200,
          action: { label: 'Undo', run: () => history.undo() },
        });
      } else if (kept) {
        bus.emit('toast', { msg: 'Those clips are locked — unlock them (or their track) to delete them.' });
      }
    },

    duplicateSelected() {
      const ids = new Set(store.rt.selection);
      if (!ids.size) return bus.emit('toast', { msg: 'Select a clip first, then Ctrl+D to copy it.' });
      /**
       * Copies land after the WHOLE selection, keeping their layout.
       *
       * Each copy used to go straight after its own original — fine for one
       * clip, but with two clips side by side the first one's copy landed
       * exactly on top of the second. Offsetting everything by the length of the
       * selection drops the group in again, intact, right after itself.
       */
      let lo = Infinity, hi = -Infinity;
      for (const t of store.doc.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) {
          if (!ids.has(c.id) || c.locked) continue;
          lo = Math.min(lo, c.start); hi = Math.max(hi, c.start + c.duration);
        }
      }
      if (!Number.isFinite(lo)) {
        return bus.emit('toast', { msg: 'Those clips are locked — unlock them to copy them.' });
      }
      const span = hi - lo;
      const made = [];
      const idMap = new Map();
      // A clip's linked copies (its crop layers, its sound) come with it.
      for (const id of [...ids]) for (const { clip: ch } of childrenOf(store.doc, id)) if (ch.linkTo) ids.add(ch.id);
      history.run('Duplicate', (doc) => {
        const copies = [];
        for (const track of doc.tracks) {
          if (track.locked) continue;
          for (const clip of [...track.clips]) {
            if (!ids.has(clip.id) || clip.locked) continue;
            const copy = structuredClone(clip);
            copy.id = uid('clip');
            copy.start = q(clip.start + span);
            // The copy's "cut before" is its own original: a hard cut. Copying
            // the transition put a dip to black between a clip and its copy.
            copy.transIn = null;
            idMap.set(clip.id, copy.id);
            copies.push(copy);
            track.clips.push(copy);
            made.push(copy.id);
          }
          track.clips.sort((a, b) => a.start - b.start);
        }
        // A badge copied with its clip belongs to the copy; copied on its own,
        // it is just text (two badges claiming one clip would fight).
        for (const c of copies) {
          if (c.linkTo) {
            if (idMap.has(c.linkTo)) c.linkTo = idMap.get(c.linkTo);
            else delete c.linkTo;
          }
          if (!c.badgeFor) continue;
          if (idMap.has(c.badgeFor)) c.badgeFor = idMap.get(c.badgeFor);
          else delete c.badgeFor;
        }
        // Copies that land on something already there get a lane of their own.
        settle(doc, copies.map(c => c.id));
      });
      store.select(made);
    },

    /**
     * Arrow-key nudge: move the selection by whole frames.
     *
     * Every start stays on a frame and every track stays sorted — nudging used
     * to add `1/fps` with floating point and never re-sort, so starts drifted
     * off the frame grid and a clip nudged past its neighbour kept its old place
     * in the list. The group moves as a group: if one clip would hit 0:00 the
     * whole selection stops there, rather than that one clip piling up at zero
     * while the rest carry on.
     */
    nudgeSelected(frames) {
      const step = frames / fps();
      const picks = [];
      for (const t of store.doc.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) if (store.rt.selection.includes(c.id) && !c.locked) picks.push(c);
      }
      if (!picks.length) return false;
      const lo = Math.min(...picks.map(c => c.start));
      let d = Math.max(step, -lo);
      // A nudge stops at the neighbour rather than sliding under it.
      const mine = new Set(picks.map(c => c.id));
      for (const t of store.doc.tracks) {
        for (const c of t.clips) {
          if (!mine.has(c.id)) continue;
          const others = { clips: t.clips.filter(x => !mine.has(x.id) || x === c) };
          const room = roomAround(others, c);
          if (d > 0) d = Math.min(d, room.hi - (c.start + c.duration));
          else d = Math.max(d, room.lo - c.start);
        }
      }
      if (Math.sign(d) !== Math.sign(step)) d = 0;
      if (Math.abs(d) < 1e-9) {
        bus.emit('toast', { msg: 'It is right up against the next clip.', key: 'nudge', ms: 1800 });
        return true;
      }
      if (Math.abs(d) < 1e-9) return false;
      history.run('Nudge', (doc) => {
        for (const t of doc.tracks) {
          if (t.locked) continue;
          for (const c of t.clips) {
            if (!store.rt.selection.includes(c.id) || c.locked) continue;
            c.start = q(c.start + d);
          }
          t.clips.sort((a, b) => a.start - b.start);
        }
      }, 'nudge');
      return true;
    },

    /** Deep-set a property path on one clip, e.g. 'text.size' or 'transform.x'. */
    setClipProp(clipId, path, value, { merge = true, label = 'Adjust' } = {}) {
      history.begin(label, merge ? `prop:${clipId}:${path}` : null);
      const { clip, track } = findClip(store.doc, clipId);
      if (!clip) return history.abort();
      if (path === 'start') {
        /**
         * Timing goes through the same rules as dragging: on a frame, never
         * negative, and the track kept in time order (the renderer and the
         * transition finder both walk it in order).
         */
        const v = Number(value);
        if (Number.isFinite(v)) {
          clip.start = q(v);
          delete clip.linkTo;          // you moved it yourself
          track.clips.sort((a, b) => a.start - b.start);
          settle(store.doc, [clip.id]);
        }
      } else if (path === 'duration') {
        // Typing a length is trimming the end: it cannot run past the footage,
        // and with Ripple on what follows moves with it.
        const v = Number(value);
        if (Number.isFinite(v)) { delete clip.linkTo; applyTrim(store.doc, clip, track, 'out', clip.start + v); }
      } else {
        setDeep(clip, path, value);
      }
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

    /** Take one keyframe off a track, and the track itself if it was the last. */
    removeKeyAt(clipId, path, localT) {
      history.run('Remove keyframe', () => {
        const { clip } = findClip(store.doc, clipId);
        const list = clip?.keys?.[path];
        if (!list) return;
        const i = list.findIndex(k => Math.abs(k.t - localT) < 1e-3);
        if (i < 0) return;
        list.splice(i, 1);
        if (!list.length) delete clip.keys[path];
      });
    },

    /**
     * Slide one keyframe along in time.
     *
     * Merged under a per-key label so dragging a diamond across the strip is a
     * single undo rather than one per frame of the drag.
     */
    moveKeyTo(clipId, path, fromT, toT) {
      history.run('Move keyframe', () => {
        const { clip } = findClip(store.doc, clipId);
        const list = clip?.keys?.[path];
        if (!list) return;
        const k = list.find(x => Math.abs(x.t - fromT) < 1e-3);
        if (!k) return;
        k.t = Math.max(0, Math.min(clip.duration, +toT.toFixed(5)));
        list.sort((a, b) => a.t - b.t);
      }, `movekey:${clipId}:${path}`);
    },

    setKeyEasing(clipId, path, localT, easing) {
      history.run('Keyframe easing', () => {
        const { clip } = findClip(store.doc, clipId);
        const k = clip?.keys?.[path]?.find(x => Math.abs(x.t - localT) < 1e-3);
        if (k) k.e = easing;
      });
    },

    /**
     * Replace whole key tracks in one step.
     *
     * This is how a movement preset is applied: the paths it writes are cleared
     * and rewritten together, so the result is one undo and there is never a
     * moment where half of the old animation is still running alongside half of
     * the new one.
     */
    setKeyTracks(clipId, tracks, { clear = [], label = 'Animate' } = {}) {
      history.run(label, () => {
        const { clip } = findClip(store.doc, clipId);
        if (!clip) return;
        clip.keys ||= {};
        for (const path of clear) delete clip.keys[path];
        for (const [path, list] of Object.entries(tracks || {})) {
          if (!list || !list.length) { delete clip.keys[path]; continue; }
          clip.keys[path] = list
            .map(k => ({ t: Math.max(0, +(+k.t).toFixed(5)), v: k.v, e: k.e || 'ease' }))
            .sort((a, b) => a.t - b.t);
        }
      });
    },

    /* ── Tracks ──────────────────────────────────────────────── */

    /**
     * Add a track where a track of that kind belongs.
     *
     * Index 0 is the TOP of the stack — the compositor paints it last, over
     * everything else. Every new track used to go there, so "+ Video" put a
     * picture layer over every title in the project, and "+ Audio" put a
     * sound lane above all the pictures. Now:
     *
     *   text   at the very top, above everything;
     *   video  just above the existing picture tracks, but under the text;
     *   audio  at the bottom, under the other sound lanes.
     *
     * `aboveId` still puts it directly above a given track (crop layers and
     * overlays need exactly that). `name` overrides the generated one.
     */
    addTrack(kind, aboveId = null, { name = null } = {}) {
      let created;
      history.run('Add track', (doc) => {
        const base = `${kind[0].toUpperCase()}${kind.slice(1)}`;
        const taken = new Set(doc.tracks.map(t => t.name));
        // A deleted track leaves a hole in the numbering; never reuse a name
        // that is still on screen.
        let label = name;
        if (!label || taken.has(label)) {
          const stem = name || base;
          let n = name ? 2 : doc.tracks.filter(t => t.kind === kind).length + 1;
          label = `${stem} ${n}`;
          while (taken.has(label)) label = `${stem} ${++n}`;
        }
        created = makeTrack(kind, label);
        let i;
        if (aboveId) i = doc.tracks.findIndex(t => t.id === aboveId);
        else if (kind === 'text') i = 0;
        else if (kind === 'audio') i = doc.tracks.length;
        else {
          const firstVideo = doc.tracks.findIndex(t => t.kind === 'video');
          if (firstVideo >= 0) i = firstVideo;
          else {
            // No picture tracks yet: under the last text track, above any audio.
            const firstAudio = doc.tracks.findIndex(t => t.kind === 'audio');
            i = firstAudio >= 0 ? firstAudio : doc.tracks.length;
          }
        }
        doc.tracks.splice(Math.max(0, i), 0, created);
      });
      return created;
    },

    renameTrack(trackId, name) {
      history.run('Rename lane', (doc) => {
        const t = trackById(doc, trackId);
        if (t && name) t.name = String(name);
      });
    },

    /**
     * Close every gap on the main picture lane in one step.
     *
     * Black holes left by deleting with Ripple off, or by dragging shots
     * apart, are the most common way an edit ends up with a flash of black in
     * it. Their crops and extracted sound come along (they are linked), and so
     * do titles that sit over a shot that moves, so nothing falls out of sync.
     */
    closeAllGaps() {
      const main = [...store.doc.tracks].reverse().find(t => t.kind === 'video');
      if (!main || main.locked || !main.clips.length) {
        bus.emit('toast', { msg: main?.locked ? 'The main lane is locked.' : 'There is nothing on the main lane yet.' });
        return 0;
      }
      let closed = 0, total = 0;
      history.run('Close gaps', (doc) => {
        const track = trackById(doc, main.id);
        const sorted = [...track.clips].sort((a, b) => a.start - b.start);
        // Titles and stickers riding on a shot keep their place on it.
        const riders = [];
        for (const t of doc.tracks) {
          if (t === track || t.locked || t.kind === 'audio') continue;
          for (const c of t.clips) {
            if (c.locked || c.linkTo || c.badgeFor) continue;
            const host = sorted.find(h => c.start >= h.start - 1e-6 && c.start < h.start + h.duration - 1e-6);
            if (host) riders.push({ c, host, off: c.start - host.start });
          }
        }
        let reach = 0;
        for (const c of sorted) {
          if (c.locked) { reach = Math.max(reach, c.start + c.duration); continue; }
          if (c.start > reach + 1e-6) { total += c.start - reach; closed++; c.start = q(reach); }
          reach = Math.max(reach, c.start + c.duration);
        }
        for (const r of riders) r.c.start = q(r.host.start + r.off);
        for (const t of doc.tracks) t.clips.sort((a, b) => a.start - b.start);
      });
      bus.emit('toast', closed
        ? { msg: `Closed ${closed} gap${closed === 1 ? '' : 's'} (${total < 10 ? total.toFixed(1) : Math.round(total)}s of black)`, key: 'edit', ms: 4000, action: { label: 'Undo', run: () => history.undo() } }
        : { msg: 'No gaps on the main lane — it already plays straight through.', key: 'edit' });
      return closed;
    },

    setTrackFlag(trackId, flag, value) {
      history.run('Track ' + flag, (doc) => {
        const t = trackById(doc, trackId);
        if (t) t[flag] = value;
      });
    },

    /**
     * Delete a track and whatever is on it. Refuses to remove the last one.
     * Returns true if it went. The caller asks first when the track has clips;
     * either way it is one undo step.
     */
    removeTrack(trackId) {
      const doc0 = store.doc;
      const track = trackById(doc0, trackId);
      if (!track || doc0.tracks.length <= 1) return false;
      const ids = new Set(track.clips.map(c => c.id));
      history.run('Delete track', (doc) => {
        doc.tracks = doc.tracks.filter(t => t.id !== trackId);
        // Badges about clips that just went would be left announcing nothing.
        for (const t of doc.tracks) t.clips = t.clips.filter(c => !(c.badgeFor && ids.has(c.badgeFor)));
      });
      const sel = store.rt.selection.filter(id => !ids.has(id));
      if (sel.length !== store.rt.selection.length) store.select(sel);
      if (store.rt.activeTrack === trackId) store.setRT({ activeTrack: null });
      return true;
    },

    /* ── Lanes ───────────────────────────────────────────────── */

    /**
     * A ready-made lane: Video, Facecam, Text, Voice, Music or SFX. Each comes
     * set up for its job — a Voice lane cleans up speech, a Music lane dips by
     * itself whenever anything else is talking — and is one undo step.
     */
    addLane(preset, aboveId = null) {
      const P = LANE_PRESETS[preset];
      if (!P) return null;
      return api.batch(`Add ${P.name} lane`, () => {
        const t = api.addTrack(P.kind, aboveId, { name: P.numbered ? null : P.name });
        if (P.patch) {
          history.run('Lane setup', (doc) => {
            const tr = trackById(doc, t.id);
            Object.assign(tr, JSON.parse(JSON.stringify(P.patch)));
          });
        }
        return trackById(store.doc, t.id);
      });
    },

    /**
     * Move a lane up (-1) or down (+1) among the lanes of its own kind: a
     * picture lane can go in front of or behind another picture lane, but
     * never into the sound lanes.
     */
    moveTrack(trackId, dir) {
      const tracks = store.doc.tracks;
      const i = tracks.findIndex(t => t.id === trackId);
      if (i < 0) return false;
      const kind = tracks[i].kind;
      let j = i + dir;
      while (j >= 0 && j < tracks.length && tracks[j].kind !== kind) j += dir;
      if (j < 0 || j >= tracks.length) return false;
      return api.moveTrackTo(trackId, j);
    },

    /** Put a lane at index `to` (same kind only — see moveTrack). */
    moveTrackTo(trackId, to) {
      const tracks = store.doc.tracks;
      const i = tracks.findIndex(t => t.id === trackId);
      if (i < 0 || to === i || to < 0 || to >= tracks.length) return false;
      if (tracks[to].kind !== tracks[i].kind) return false;
      history.run('Move lane', (doc) => {
        const [t] = doc.tracks.splice(i, 1);
        doc.tracks.splice(to, 0, t);
      });
      return true;
    },

    /** A copy of a lane and everything on it, placed just above it. */
    duplicateTrack(trackId) {
      const src = trackById(store.doc, trackId);
      if (!src) return null;
      let made = null;
      history.run('Duplicate lane', (doc) => {
        const t = trackById(doc, trackId);
        const copy = JSON.parse(JSON.stringify(t));
        copy.id = uid('trk');
        const taken = new Set(doc.tracks.map(x => x.name));
        let n = 2, name = `${t.name} copy`;
        while (taken.has(name)) name = `${t.name} copy ${n++}`;
        copy.name = name;
        const ids = new Map();
        for (const c of copy.clips) { const id = uid('clip'); ids.set(c.id, id); c.id = id; c.trackId = copy.id; }
        // Clips that pointed at each other on the lane point at the copies.
        for (const c of copy.clips) {
          if (c.linkTo && ids.has(c.linkTo)) c.linkTo = ids.get(c.linkTo);
          if (c.badgeFor && ids.has(c.badgeFor)) c.badgeFor = ids.get(c.badgeFor);
        }
        doc.tracks.splice(doc.tracks.findIndex(x => x.id === trackId), 0, copy);
        made = copy;
      });
      return made;
    },

    setTrackColor(trackId, color) {
      history.run('Lane colour', (doc) => {
        const t = trackById(doc, trackId);
        if (t) { if (color) t.color = color; else delete t.color; }
      });
    },

    /* ── Clip housekeeping ───────────────────────────────────── */

    /** A colour label on clips, to tell them apart at a glance. null clears it. */
    labelClips(ids, color) {
      const set = new Set(ids);
      if (!set.size) return;
      history.run(color ? 'Colour label' : 'Clear colour label', (doc) => {
        for (const t of doc.tracks) for (const c of t.clips) {
          if (!set.has(c.id)) continue;
          if (color) c.label = color; else delete c.label;
        }
      });
    },

    renameClip(clipId, name) {
      const v = String(name || '').trim().slice(0, 80);
      if (!v) return;
      api.setClipProp(clipId, 'name', v, { merge: false, label: 'Rename clip' });
    },

    /** This clip and everything that starts at or after it, on every unlocked lane. */
    selectFrom(clipId) {
      const { clip } = findClip(store.doc, clipId);
      if (!clip) return;
      const ids = [];
      for (const t of store.doc.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) if (!c.locked && c.start >= clip.start - 1e-6) ids.push(c.id);
      }
      store.select(ids);
    },

    /** Every place something starts or ends — where ↑ and ↓ jump to. */
    editPoints() {
      const pts = new Set([0]);
      for (const t of store.doc.tracks) {
        if (t.hidden) continue;
        for (const c of t.clips) { pts.add(q(c.start)); pts.add(q(c.start + c.duration)); }
      }
      return [...pts].sort((a, b) => a - b);
    },

    /** The next (dir 1) or previous (dir -1) edit point from `t`. */
    nextEdit(t = store.rt.playhead, dir = 1) {
      const pts = api.editPoints(), eps = 0.5 / fps();
      if (dir > 0) return pts.find(p => p > t + eps) ?? null;
      for (let i = pts.length - 1; i >= 0; i--) if (pts[i] < t - eps) return pts[i];
      return null;
    },

    /**
     * The empty stretch of a track around time `t`, or null.
     *
     * A gap is time with a clip before it (or the start of the timeline) and a
     * clip after it, and nothing covering `t` — the space after the last clip
     * is not a gap, it is just the end.
     */
    gapAt(trackId, t) {
      const track = trackById(store.doc, trackId);
      if (!track) return null;
      let prevEnd = 0, next = Infinity;
      for (const c of track.clips) {
        const end = c.start + c.duration;
        if (c.start <= t + 1e-6 && end > t + 1e-6) return null;   // something is here
        if (end <= t + 1e-6) prevEnd = Math.max(prevEnd, end);
        if (c.start >= t - 1e-6) next = Math.min(next, c.start);
      }
      if (!Number.isFinite(next) || next - prevEnd < 1e-6) return null;
      return { start: prevEnd, end: next, dur: next - prevEnd };
    },

    /**
     * Close the gap under `t` on a track: everything after it slides back to
     * meet the clip before it. The fix for a black hole left by an edit made
     * with Ripple off — one right-click instead of dragging every later clip.
     */
    closeGap(trackId, t) {
      const track = trackById(store.doc, trackId);
      if (!track || track.locked) return false;
      const gap = api.gapAt(trackId, t);
      if (!gap) return false;
      history.run('Close gap', (doc) => {
        shiftAfter(doc, trackById(doc, trackId), gap.end, -gap.dur);
      });
      bus.emit('toast', {
        msg: `Closed a ${gap.dur < 10 ? gap.dur.toFixed(1) : Math.round(gap.dur)}s gap`,
        key: 'edit', ms: 4000,
        action: { label: 'Undo', run: () => history.undo() },
      });
      return true;
    },

    /**
     * Run several commands as ONE undo step.
     *
     * Placing a file can mean "make a track, then put the clip on it", and a
     * drop of three files is three placements. Each was its own undo step, so
     * undoing a drop took several presses and passed through states nobody had
     * seen. Nested batches fold into the outer one.
     */
    batch(label, fn) {
      const g = history.gesture(label);
      try { return fn(); } finally { g.end(); }
    },

    /** For the Undo button on a toast raised outside the commands. */
    undo() { return history.undo(); },

    /* ── Project ─────────────────────────────────────────────── */

    setResolution({ width, height, aspect, fps: f }) {
      history.run('Project settings', (doc) => {
        if (width) doc.width = width;
        if (height) doc.height = height;
        if (aspect) doc.aspect = aspect;
        if (f) doc.fps = f;
      });
    },

    /**
     * First recording into a fresh project: make the canvas as sharp as the
     * footage. See projectForFootage. Runs inside the placing step, so Undo
     * puts the old size back together with the clip.
     */
    fitProjectToFootage(asset) {
      const d = store.doc;
      if (!asset?.width || d.tracks.some(t => t.clips.length)) return null;
      const stock = d.aspect === '16:9' && d.width === 1920 && d.height === 1080;
      const untouched = !history.canUndo && stock;
      const next = projectForFootage(asset.width, asset.height, d, { keepShape: !untouched });
      if (!next) return null;
      history.run('Match project to footage', (doc) => {
        doc.width = next.width; doc.height = next.height; doc.aspect = next.aspect;
      });
      return next;
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

/** Set `a.b.c` on an object, making the steps that are missing. */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts.at(-1)] = value;
}

function shiftKeys(keys, delta) {
  const out = {};
  for (const [k, list] of Object.entries(keys || {}))
    out[k] = list.map(x => ({ ...x, t: x.t + delta }));
  return out;
}
