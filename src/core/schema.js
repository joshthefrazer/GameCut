/** Document factories + invariants. Everything here must be JSON-serializable. */

let _seq = 0;
export const uid = (p = 'id') => `${p}_${(_seq++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const TRACK_H = { video: 62, audio: 54, text: 46 };

/** Clip body gradients — blue family, saturated enough to carry white labels. */
export const CLIP_COLORS = {
  video: ['#2563eb', '#60a5fa'],
  image: ['#4f46e5', '#818cf8'],
  audio: ['#0d9488', '#2dd4bf'],
  text:  ['#4338ca', '#6366f1'],
  shape: ['#0284c7', '#38bdf8'],
};

/** Animatable transform defaults, in normalized project space (0..1). */
export const defaultTransform = () => ({
  x: 0.5, y: 0.5,          // center point, fraction of frame
  w: 1.0, h: 1.0,          // box size, fraction of frame
  scale: 1,
  rotation: 0,
  opacity: 1,
});

export const defaultTextStyle = () => ({
  text: 'YOUR TEXT',
  font: 'Inter',
  size: 0.10,               // fraction of frame height — resolution independent
  weight: 800,
  italic: false,

  /* Fill — solid, or a gradient between two colours at an angle. */
  fill: 'solid',            // solid | gradient
  color: '#ffffff',
  color2: '#38bdf8',
  gradAngle: 90,            // degrees; 90 = top to bottom

  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.12,

  /* Outline. */
  strokeWidth: 0,
  strokeColor: '#000000',

  /**
   * Glow and shadow are deliberately separate.
   *
   * A shadow is offset and dark and sits behind the type to lift it off the
   * picture. A glow is centred, coloured and usually the point of the look —
   * neon captions, an accent that matches the game's UI. Editors that offer one
   * "shadow blur" control force you to choose, and you end up with neither.
   */
  glow: 0,
  glowColor: '#38bdf8',
  shadow: 0,
  shadowColor: '#000000',
  shadowX: 0,
  shadowY: 0.012,

  /* Plate behind the words. */
  bg: 'none',               // none | box | pill
  bgColor: '#0b1220cc',
  bgPad: 0.02,
  bgRadius: 0.25,           // fraction of the plate's height

  /* One-click entrance. Written as a named move, not as keyframes, so it can
     be changed or removed later without unpicking anything. */
  anim: 'none',             // none | pop | rise | fade | type | slam
  animDur: 0.35,
});

export function makeClip(type, patch = {}) {
  const base = {
    id: uid('clip'),
    type,                    // video | image | audio | text | shape
    trackId: null,
    name: type.toUpperCase(),
    assetId: null,
    start: 0,                // timeline seconds
    duration: 4,
    inPoint: 0,              // offset into source media
    sourceDuration: Infinity,
    speed: 1,
    /**
     * Show only part of the source picture.
     *
     * `{ x, y, w, h }`, all 0..1 of the source frame — so it survives a change
     * of project resolution or a switch to a different quality preview, like
     * every other measurement in the document. Null means the whole frame.
     */
    crop: null,
    /** Never schedule this clip's audio — a cropped copy would double it. */
    silent: false,
    /**
     * How this clip arrives after the cut before it.
     * { kind, dur, dir } — see engine/transitions.js. Null is a hard cut.
     */
    transIn: null,
    volume: 1,
    /** Silenced by hand in the mixer. Distinct from `silent`, which means
     *  another clip is already playing this media's sound. */
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    transform: defaultTransform(),
    keys: {},                // { propPath: [{t, v, e}] }
    locked: false,
  };
  if (type === 'text') base.text = defaultTextStyle();
  if (type === 'shape') base.shape = { kind: 'rect', fill: '#2563eb', radius: 0.02 };
  return Object.assign(base, patch);
}

export function makeTrack(kind, name, patch = {}) {
  return Object.assign({
    id: uid('trk'),
    kind,                    // video | audio | text
    name,
    height: TRACK_H[kind] ?? 56,
    muted: false,
    hidden: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [],
  }, patch);
}

export function makeProject(preset) {
  const tracks = [
    makeTrack('text',  'Text 2'),
    makeTrack('text',  'Text 1'),
    makeTrack('video', 'Video 2'),
    makeTrack('video', 'Video 1'),
    makeTrack('audio', 'Music'),
    makeTrack('audio', 'SFX'),
  ];
  return {
    id: uid('proj'),
    name: 'Untitled Project',
    fps: preset.fps,
    width: preset.width,
    height: preset.height,
    aspect: preset.aspect,
    bg: '#000000',
    bpm: 128,
    beatOffset: 0,
    tracks,
    markers: [],
    assets: [],
    createdAt: Date.now(),
  };
}

/** Longest clip end across all tracks (seconds). */
export function projectDuration(doc) {
  let end = 0;
  for (const t of doc.tracks)
    for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return end;
}

export function findClip(doc, clipId) {
  for (const t of doc.tracks) {
    const c = t.clips.find(c => c.id === clipId);
    if (c) return { clip: c, track: t };
  }
  return { clip: null, track: null };
}

export const trackById = (doc, id) => doc.tracks.find(t => t.id === id) || null;

/** Clip types a given track kind will accept. */
export function trackAccepts(kind, clipType) {
  if (kind === 'audio') return clipType === 'audio';
  if (kind === 'text')  return clipType === 'text' || clipType === 'shape';
  return clipType === 'video' || clipType === 'image' || clipType === 'shape';
}
