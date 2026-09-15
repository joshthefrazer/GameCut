/**
 * Ready-made movement.
 *
 * The hard part of animation is not the maths, it is the blank page: a
 * keyframe editor with nothing in it asks you to invent a motion from
 * scratch, and most people quite reasonably close it again.
 *
 * So every entry here writes REAL KEYFRAMES onto the clip rather than setting a
 * named mode. That one decision is what makes this both easy and advanced at
 * once: pick "Slide in from the left" and you get the move; open the keyframe
 * strip and there are the three keys that produce it, at times and values you
 * can drag. Nothing is hidden, nothing has to be unpicked before you can start
 * making it yours.
 *
 * ── Shape of a preset ──────────────────────────────────────────
 *   build(clip, opts) -> { 'transform.x': [{t, v, e}], ... }
 * Times are seconds from the clip's own start, which is the same space
 * `evalProp` reads them in. A preset may look at the clip's current transform
 * so that "slide in" ends where the layer already is rather than dragging it
 * to the middle of the frame.
 */

const IN_MAX = 0.45;    // how long an entrance takes, at most
const OUT_MAX = 0.4;   // and an exit

/**
 * An entrance can never be longer than the clip it is entering.
 *
 * Fixed durations look fine on a four-second graphic and are silently broken on
 * a short one: a 0.45s slide-in on a 0.3s sticker never reaches its arrival
 * key, so the layer sits off the edge at partial opacity for its whole life and
 * simply never appears. Speeding a clip up shortens it the same way, which is
 * how you get there without meaning to.
 */
const inDur = (clip) => Math.min(IN_MAX, Math.max(0.06, clip.duration * 0.38));
const outDur = (clip) => Math.min(OUT_MAX, Math.max(0.06, clip.duration * 0.34));

/** A loop that ends where it started, so it can run any number of times. */
function cycle(dur, n, at) {
  const keys = [];
  const step = dur / n;
  for (let i = 0; i <= n; i++) keys.push({ t: +(i * step).toFixed(4), v: at(i), e: 'inout' });
  return keys;
}

export const MOTIONS = [
  {
    id: 'none', name: 'None', note: 'Sits still',
    build: () => ({}),
  },
  {
    id: 'pop', name: 'Pop in', note: 'Springs up to size, then stays',
    build: (clip) => {
      const s = clip.transform.scale ?? 1;
      const d = inDur(clip);
      return {
        'transform.scale': [
          { t: 0, v: s * 0.2, e: 'back' },
          { t: d * 0.75, v: s, e: 'ease' },
        ],
        'transform.opacity': [
          { t: 0, v: 0, e: 'out' },
          { t: d * 0.4, v: clip.transform.opacity ?? 1, e: 'ease' },
        ],
      };
    },
  },
  {
    id: 'slide-l', name: 'In from left', note: 'Slides in from off the left edge',
    build: (clip) => slideIn(clip, -1, 0),
  },
  {
    id: 'slide-r', name: 'In from right', note: 'Slides in from off the right edge',
    build: (clip) => slideIn(clip, 1, 0),
  },
  {
    id: 'slide-u', name: 'Up from below', note: 'Rises into place',
    build: (clip) => slideIn(clip, 0, 1),
  },
  {
    id: 'slide-d', name: 'Down from above', note: 'Drops into place',
    build: (clip) => slideIn(clip, 0, -1),
  },
  {
    id: 'float', name: 'Float', note: 'Drifts gently up and down, forever',
    build: (clip) => {
      const y = clip.transform.y ?? 0.5;
      const n = Math.max(2, Math.round(clip.duration / 1.6) * 2);
      return {
        'transform.y': cycle(clip.duration, n, (i) => +(y + (i % 2 ? 0.018 : -0.018)).toFixed(4)),
      };
    },
  },
  {
    id: 'pulse', name: 'Pulse', note: 'Breathes in and out — draws the eye',
    build: (clip) => {
      const s = clip.transform.scale ?? 1;
      const n = Math.max(2, Math.round(clip.duration / 1.1) * 2);
      return {
        'transform.scale': cycle(clip.duration, n, (i) => +(s * (i % 2 ? 1.055 : 1)).toFixed(4)),
      };
    },
  },
  {
    id: 'spin', name: 'Spin', note: 'One full turn across the clip',
    build: (clip) => {
      const r = clip.transform.rotation ?? 0;
      return {
        'transform.rotation': [
          { t: 0, v: r, e: 'inout' },
          { t: clip.duration, v: r + 360, e: 'linear' },
        ],
      };
    },
  },
  {
    id: 'sway', name: 'Sway', note: 'Rocks side to side like a hanging sign',
    build: (clip) => {
      const r = clip.transform.rotation ?? 0;
      const n = Math.max(2, Math.round(clip.duration / 1.4) * 2);
      return {
        'transform.rotation': cycle(clip.duration, n, (i) => +(r + (i % 2 ? 3.5 : -3.5)).toFixed(3)),
      };
    },
  },
  {
    id: 'push', name: 'Slow push', note: 'Creeps closer the whole way through',
    build: (clip) => {
      const s = clip.transform.scale ?? 1;
      return {
        'transform.scale': [
          { t: 0, v: s, e: 'linear' },
          { t: clip.duration, v: +(s * 1.14).toFixed(4), e: 'linear' },
        ],
      };
    },
  },
  {
    id: 'popout', name: 'Pop in and out', note: 'Arrives, holds, then leaves the same way',
    build: (clip) => {
      const s = clip.transform.scale ?? 1;
      const o = clip.transform.opacity ?? 1;
      const end = clip.duration;
      // In and out have to share the clip. On anything short they each get a
      // third of it, which keeps the hold in the middle and keeps the keys in
      // order — `Math.max(IN, end - OUT)` put the "hold" key past the end on a
      // clip shorter than the entrance, and it sorted into the middle.
      const din = Math.min(inDur(clip), end / 3);
      const dout = Math.min(outDur(clip), end / 3);
      const holdTo = Math.max(din, end - dout);
      return {
        'transform.scale': [
          { t: 0, v: s * 0.2, e: 'back' },
          { t: din * 0.75, v: s, e: 'ease' },
          { t: holdTo, v: s, e: 'in' },
          { t: end, v: s * 0.25, e: 'ease' },
        ],
        'transform.opacity': [
          { t: 0, v: 0, e: 'out' },
          { t: din * 0.4, v: o, e: 'ease' },
          { t: Math.max(din * 0.4, end - dout * 0.7), v: o, e: 'in' },
          { t: end, v: 0, e: 'ease' },
        ],
      };
    },
  },
];

/**
 * An entrance from off-frame.
 *
 * It ends wherever the layer currently sits, not in the middle — a graphic
 * parked in the corner should slide into that corner, and a preset that
 * silently recentred it would be a preset nobody could use twice.
 */
function slideIn(clip, dx, dy) {
  const x = clip.transform.x ?? 0.5;
  const y = clip.transform.y ?? 0.5;
  const o = clip.transform.opacity ?? 1;
  const d = inDur(clip);
  const keys = {
    'transform.opacity': [
      { t: 0, v: 0, e: 'out' },
      { t: d * 0.45, v: o, e: 'ease' },
    ],
  };
  if (dx) keys['transform.x'] = [
    { t: 0, v: +(x + dx * 0.65).toFixed(4), e: 'out' },
    { t: d, v: x, e: 'ease' },
  ];
  if (dy) keys['transform.y'] = [
    { t: 0, v: +(y + dy * 0.55).toFixed(4), e: 'out' },
    { t: d, v: y, e: 'ease' },
  ];
  return keys;
}

export const motionById = (id) => MOTIONS.find(m => m.id === id) || null;

/** Every property a preset could have written. Used when clearing. */
export const MOTION_PATHS = [
  'transform.x', 'transform.y', 'transform.scale',
  'transform.rotation', 'transform.opacity',
];
