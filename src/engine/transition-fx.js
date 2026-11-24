/**
 * What every transition looks like.
 *
 *   paintTransition(ctx, A, B, { kind, dir, raw, amount, ease, color }, W, H)
 *
 * A and B are the two shots as full-frame pictures (canvases). `raw` runs 0 → 1
 * across the transition; everything else is how it was set up. The panel's
 * tiles, the preview and the export all call this one function, so what you
 * pick from is what you get.
 *
 * Three rules make these look like camera moves instead of slideshow effects:
 *   1. Fast movement is BLURRED along its own path (`smear`), by how fast it is
 *      going at that moment, the way a shutter would.
 *   2. Nothing ever slides in from empty space: past its edges a moving picture
 *      carries on as a mirror of itself (`mirrored`).
 *   3. Every frame depends only on `raw`, never on a clock or Math.random, so
 *      the same moment always paints the same picture.
 */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

/* ── Feel ─────────────────────────────────────────────────────── */
export const EASES = [
  { id: 'smooth', name: 'Smooth', note: 'Eases in and out' },
  { id: 'snappy', name: 'Snappy', note: 'Slow, then all at once' },
  { id: 'bouncy', name: 'Bouncy', note: 'Goes a little past, then settles' },
  { id: 'even',   name: 'Even',   note: 'The same speed all the way' },
];
const EASE = {
  even: (p) => p,
  smooth: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  snappy: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? Math.pow(2, 18 * p - 9) / 2 : (2 - Math.pow(2, -18 * p + 9)) / 2),
  bouncy: (p) => { const c1 = 1.35, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
};
export const easeOf = (id, p) => (EASE[id] || EASE.smooth)(clamp(p));

/** A repeatable "random" number 0..1. */
const hash = (a, b = 0) => { const s = Math.sin(a * 127.1 + b * 311.7 + 74.7) * 43758.5453; return s - Math.floor(s); };

/* ── The catalogue ────────────────────────────────────────────── */
export const GROUPS = [
  { id: 'smooth', name: 'Smooth' }, { id: 'move', name: 'Move' }, { id: 'zoom', name: 'Zoom' },
  { id: 'glitch', name: 'Glitch' }, { id: 'shape', name: 'Shapes' }, { id: 'light', name: 'Light' },
];
const D4 = ['left', 'right', 'up', 'down'];
/**
 * dirs: which way it can go · amount: what its strength slider is called ·
 * color: it has a colour · ease: its movement can be given a feel ·
 * d: { dur, amount, ease, color, dir } it starts with.
 */
export const KINDS = [
  { id: 'dissolve', group: 'smooth', name: 'Dissolve',    blurb: 'One shot melts into the next. The safe one.', d: { dur: 0.45 } },
  { id: 'blur',     group: 'smooth', name: 'Blur through', blurb: 'Goes soft, changes, comes back sharp.', amount: 'Blur', d: { dur: 0.5, amount: 0.6 } },
  { id: 'dip',      group: 'smooth', name: 'Fade through', blurb: 'Out to a colour and back. A beat between two scenes.', color: true, d: { dur: 0.6, color: '#000000' } },
  { id: 'whip',     group: 'move', name: 'Whip pan',  blurb: 'The camera snaps sideways into the next shot.', dirs: D4, amount: 'Motion blur', d: { dur: 0.4, amount: 0.8, dir: 'left', ease: 'snappy' }, ease: true, pop: true },
  { id: 'slide',    group: 'move', name: 'Slide',     blurb: 'The new shot pushes the old one off.', dirs: D4, amount: 'Motion blur', d: { dur: 0.45, amount: 0.5, dir: 'left', ease: 'smooth' }, ease: true },
  { id: 'cover',    group: 'move', name: 'Cover',     blurb: 'The new shot slides over the top, with a shadow.', dirs: D4, amount: 'Motion blur', d: { dur: 0.5, amount: 0.35, dir: 'left', ease: 'smooth' }, ease: true },
  { id: 'spin',     group: 'move', name: 'Spin',      blurb: 'Spins out of one shot and into the other.', dirs: ['left', 'right'], amount: 'Spin', d: { dur: 0.5, amount: 0.6, dir: 'right', ease: 'snappy' }, ease: true, pop: true },
  { id: 'flip',     group: 'move', name: 'Flip',      blurb: 'Turns over like a card.', dirs: ['left', 'up'], d: { dur: 0.5, dir: 'left', ease: 'smooth' }, ease: true },
  { id: 'zoomin',   group: 'zoom', name: 'Zoom in',   blurb: 'Rushes forward through the cut.', amount: 'Speed', d: { dur: 0.45, amount: 0.65, ease: 'snappy' }, ease: true, pop: true },
  { id: 'zoomout',  group: 'zoom', name: 'Zoom out',  blurb: 'Pulls back through the cut.', amount: 'Speed', d: { dur: 0.45, amount: 0.65, ease: 'snappy' }, ease: true },
  { id: 'punch',    group: 'zoom', name: 'Punch',     blurb: 'A hit: slams in, shakes, settles. For kills and drops.', amount: 'Hit', d: { dur: 0.5, amount: 0.7 }, pop: true },
  { id: 'glitch',   group: 'glitch', name: 'Glitch',   blurb: 'The picture tears apart and comes back as the next shot.', amount: 'Damage', d: { dur: 0.45, amount: 0.7 }, pop: true },
  { id: 'rgb',      group: 'glitch', name: 'RGB split', blurb: 'The colours pull apart and snap back.', dirs: ['left', 'up'], amount: 'Split', d: { dur: 0.4, amount: 0.6, dir: 'left' } },
  { id: 'pixel',    group: 'glitch', name: 'Pixelate', blurb: 'Breaks into blocks, changes, sharpens.', amount: 'Block size', d: { dur: 0.5, amount: 0.6 } },
  { id: 'vhs',      group: 'glitch', name: 'Old tape',  blurb: 'Rolls, tears and fuzzes like a worn tape.', amount: 'Wear', d: { dur: 0.55, amount: 0.6 } },
  { id: 'wipe',     group: 'shape', name: 'Soft wipe', blurb: 'Uncovers the next shot with a soft edge.', dirs: D4, amount: 'Softness', d: { dur: 0.5, amount: 0.4, dir: 'left', ease: 'smooth' }, ease: true },
  { id: 'slash',    group: 'shape', name: 'Slash',     blurb: 'A coloured blade cuts across the screen.', dirs: ['left', 'right'], color: true, amount: 'Blade', d: { dur: 0.5, amount: 0.5, dir: 'left', color: '#C6FF3D', ease: 'snappy' }, ease: true, pop: true },
  { id: 'circle',   group: 'shape', name: 'Circle',    blurb: 'Opens from the middle with a coloured rim.', dirs: ['out', 'in'], color: true, amount: 'Rim', d: { dur: 0.55, amount: 0.4, dir: 'out', color: '#C6FF3D', ease: 'smooth' }, ease: true },
  { id: 'clock',    group: 'shape', name: 'Clock',     blurb: 'Sweeps round like a clock hand.', dirs: ['right', 'left'], d: { dur: 0.6, dir: 'right', ease: 'smooth' }, ease: true },
  { id: 'blinds',   group: 'shape', name: 'Blinds',    blurb: 'Strips open one after another.', dirs: ['left', 'up'], amount: 'Strips', d: { dur: 0.55, amount: 0.45, dir: 'left', ease: 'smooth' }, ease: true },
  { id: 'blocks',   group: 'shape', name: 'Blocks',    blurb: 'The next shot arrives in tiles.', amount: 'Tiles', d: { dur: 0.6, amount: 0.45 } },
  { id: 'flash',    group: 'light', name: 'Flash',     blurb: 'A burst of light hides the cut.', color: true, amount: 'Brightness', d: { dur: 0.4, amount: 0.9, color: '#ffffff' }, pop: true },
  { id: 'leak',     group: 'light', name: 'Light leak', blurb: 'Warm light washes across, like film.', dirs: ['left', 'right'], color: true, amount: 'Light', d: { dur: 0.8, amount: 0.75, dir: 'left', color: '#ff7a18' } },
];
export const kindOf = (id) => KINDS.find(k => k.id === id) || null;

/* ── Scratch canvases ─────────────────────────────────────────── */
const pool = new Map();
function sheet(name, w, h) {
  let c = pool.get(name);
  if (!c) { c = document.createElement('canvas'); pool.set(name, c); }
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.reset?.();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

/** A picture and its mirror images all round it, on a 3×3 sheet at `q` size. */
function mirrored(name, img, W, H, q) {
  const w = Math.round(W * q), h = Math.round(H * q);
  const g = sheet(name, w * 3, h * 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    g.save();
    g.translate(x * w + (x === 1 ? 0 : w), y * h + (y === 1 ? 0 : h));
    g.scale(x === 1 ? 1 : -1, y === 1 ? 1 : -1);
    g.drawImage(img, 0, 0, w, h);
    g.restore();
  }
  return g.canvas;
}

/**
 * Draw something several times along its movement and average the copies: motion blur.
 * `at(g, k)` sets the transform for k in −0.5..0.5 of the shutter and draws once.
 */
function smear(g, n, at) {
  const base = g.globalAlpha;
  for (let i = 0; i < n; i++) {
    g.save();
    g.globalAlpha = base / (i + 1);
    at(g, n > 1 ? i / (n - 1) - 0.5 : 0);
    g.restore();
  }
  g.globalAlpha = base;
}

/** A second, finer pass over a smear: fills the steps between its copies, so it reads as blur. */
function fine(name, img, w, h, n, at) {
  const g = sheet(name, w, h);
  g.drawImage(img, 0, 0);
  for (let i = 1; i < n; i++) {
    g.save();
    g.globalAlpha = 1 / (i + 1);
    at(g, (i % 2 ? 1 : -1) * Math.ceil(i / 2) / n);
    g.restore();
  }
  return g.canvas;
}

/** One colour channel of a picture. */
function channel(name, img, W, H, col) {
  const g = sheet(name, W, H);
  g.drawImage(img, 0, 0, W, H);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = col;
  g.fillRect(0, 0, W, H);
  // Multiply paints the colour on see-through parts too; keep the picture's own shape.
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0, W, H);
  return g.canvas;
}
/** A picture with its red, green and blue moved apart. */
function split(g, img, W, H, dx, dy) {
  const r = channel('cr', img, W, H, '#ff0000'), gr = channel('cg', img, W, H, '#00ff00'), b = channel('cb', img, W, H, '#0000ff');
  g.save();
  g.drawImage(r, dx, dy, W, H);
  g.globalCompositeOperation = 'lighter';
  g.drawImage(gr, 0, 0, W, H);
  g.drawImage(b, -dx, -dy, W, H);
  g.restore();
}

/** Fuzz, the same every time. */
let grainTile = null;
function grain() {
  if (grainTile) return grainTile;
  const c = document.createElement('canvas'); c.width = c.height = 192;
  const g = c.getContext('2d'), im = g.createImageData(192, 192);
  for (let i = 0; i < im.data.length; i += 4) { const v = Math.floor(hash(i, 3) * 255); im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  g.putImageData(im, 0, 0);
  grainTile = c;
  return c;
}
const hexA = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${clamp(a).toFixed(3)})`;
};
const VEC = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** How fast an eased movement is going at `raw` (about 1 for even speed). */
const speedAt = (ease, raw) => Math.abs(easeOf(ease, raw + 0.02) - easeOf(ease, raw - 0.02)) / 0.04;

/* ── The painters ─────────────────────────────────────────────── */
const PAINT = {
  dissolve(g, A, B, s) {
    g.drawImage(A, 0, 0, s.W, s.H);
    g.globalAlpha = s.p;
    g.drawImage(B, 0, 0, s.W, s.H);
  },

  blur(g, A, B, s) {
    const bell = Math.sin(Math.PI * s.raw);
    const px = bell * bell * (0.006 + 0.05 * s.amount) * Math.min(s.W, s.H);
    // Blurred at half size (nobody can tell, and it is four times less work), from a
    // mirrored sheet so the edges do not go dark.
    const q = lowRes(s.H);
    const soft = (name, img) => {
      if (px < 0.8) return null;
      const m = mirrored('m' + name, img, s.W, s.H, q);
      const w = s.W * q, h = s.H * q;
      const o = sheet('bl' + name, w, h);
      o.filter = `blur(${(px * q).toFixed(2)}px)`;
      o.drawImage(m, -w, -h);
      return o.canvas;
    };
    g.drawImage(soft('a', A) || A, 0, 0, s.W, s.H);
    g.globalAlpha = clamp((s.raw - 0.3) / 0.4);
    if (g.globalAlpha > 0) g.drawImage(soft('b', B) || B, 0, 0, s.W, s.H);
  },

  dip(g, A, B, s) {
    const first = s.raw < 0.5;
    g.drawImage(first ? A : B, 0, 0, s.W, s.H);
    const k = first ? s.raw * 2 : 2 - s.raw * 2;
    s.tint(g, hexA(s.color, EASE.smooth(clamp(k * 1.08))));
  },

  slide(g, A, B, s) {
    const [vx, vy] = VEC[s.dir] || VEC.left;
    const n = blurCopies(s, 0.55 * s.amount);
    const shut = s.speed * 0.16 * s.amount;
    const strip = (p) => {
      g.drawImage(A, vx * p * s.W, vy * p * s.H, s.W, s.H);
      g.drawImage(B, vx * (p - 1) * s.W, vy * (p - 1) * s.H, s.W, s.H);
    };
    smear(g, n, (_, k) => strip(s.e + k * shut * 0.25));
  },

  whip(g, A, B, s) {
    const [vx, vy] = VEC[s.dir] || VEC.left;
    // One long strip: A, then B twice as far away, mirrored where there is nothing.
    const blur = s.speed * (0.06 + 0.3 * s.amount);
    const n = blurCopies(s, 0.4 + s.amount);
    const strip = (c, w, h, k) => {
      const p = s.e + k * blur * 0.35;
      const at = (img, o, flip) => {
        const x = vx * (p - o) * w, y = vy * (p - o) * h;
        c.save();
        c.translate(x + (flip && vx ? w : 0), y + (flip && vy ? h : 0));
        c.scale(flip && vx ? -1 : 1, flip && vy ? -1 : 1);
        c.drawImage(img, 0, 0, w, h);
        c.restore();
      };
      at(A, -1, true); at(A, 0, false); at(B, 1, false); at(B, 2, true);
    };
    if (n <= 1) { strip(g, s.W, s.H, 0); return; }
    const q = lowRes(s.H), w = Math.round(s.W * q), h = Math.round(s.H * q);
    const o = sheet('whip', w, h);
    smear(o, n, (c, k) => strip(c, w, h, k));
    const gap = blur * 0.35 / Math.max(1, n - 1);
    const done = fine('whip2', o.canvas, w, h, s.lite ? 3 : 7, (c, k) => c.drawImage(o.canvas, vx * k * gap * w, vy * k * gap * h));
    // Sharp underneath while slow, smeared once it is moving.
    const mix = clamp((s.speed - 0.35) / 0.8);
    if (mix < 1) strip(g, s.W, s.H, 0);
    g.globalAlpha = mix;
    g.drawImage(done, 0, 0, s.W, s.H);
  },

  cover(g, A, B, s) {
    const [vx, vy] = VEC[s.dir] || VEC.left;
    const d = 1 - s.e;
    g.drawImage(A, vx * s.e * 0.22 * s.W, vy * s.e * 0.22 * s.H, s.W, s.H);
    s.tint(g, `rgba(0,0,0,${(0.45 * clamp(s.e)).toFixed(3)})`);
    const x = -vx * d * s.W, y = -vy * d * s.H;
    // The shadow it throws on the shot beneath.
    if (d > 0.002) {
      const L = 0.09 * Math.max(s.W * Math.abs(vx), s.H * Math.abs(vy));
      const ex = vx < 0 ? x : vx > 0 ? x + s.W : 0, ey = vy < 0 ? y : vy > 0 ? y + s.H : 0;
      const sh = g.createLinearGradient(ex, ey, ex + vx * L, ey + vy * L);
      sh.addColorStop(0, 'rgba(0,0,0,.6)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sh;
      g.globalCompositeOperation = 'source-atop';
      g.fillRect(Math.min(ex, ex + vx * L), Math.min(ey, ey + vy * L), vx ? L : s.W, vy ? L : s.H);
      g.globalCompositeOperation = 'source-over';
    }
    const n = blurCopies(s, 0.5 * s.amount), shut = s.speed * 0.05 * s.amount;
    smear(g, n, (c, k) => c.drawImage(B, x + vx * k * shut * s.W, y + vy * k * shut * s.H, s.W, s.H));
  },

  spin(g, A, B, s) {
    const sign = s.dir === 'left' ? -1 : 1;
    const turn = (0.35 + 1.0 * s.amount) * Math.PI;
    const first = s.raw < 0.5;
    const ang = (p) => sign * turn * (p < 0.5 ? p : p - 1);
    const q = lowRes(s.H);
    const pic = first ? A : B;
    const m = mirrored('m', pic, s.W, s.H, q);
    const n = blurCopies(s, 0.9), shut = s.speed * 0.07;
    const zoom = 1 + 0.35 * Math.sin(Math.PI * s.raw);
    const w = Math.round(s.W * q), h = Math.round(s.H * q);
    const one = (c, W, H, k) => {
      c.translate(W / 2, H / 2);
      c.rotate(ang(clamp(s.e, -0.2, 1.2)) + sign * k * shut * turn);
      c.scale(zoom, zoom);
      c.drawImage(m, -W * 1.5, -H * 1.5, W * 3, H * 3);
      if (n <= 1) c.drawImage(pic, -W / 2, -H / 2, W, H);      // sharp while it is slow
    };
    if (n <= 1) { g.save(); one(g, s.W, s.H, 0); g.restore(); return; }
    const o = sheet('spin', w, h);
    smear(o, n, (c, k) => one(c, w, h, k));
    g.drawImage(o.canvas, 0, 0, s.W, s.H);
  },

  flip(g, A, B, s) {
    const e = clamp(s.e, 0, 1.15);
    const c = Math.cos(e * Math.PI);
    const front = c > 0;
    const k = Math.max(0.004, Math.abs(c));
    const vert = s.dir === 'up';
    // A dim, blurred copy behind, so the gap is never plain black.
    g.drawImage(front ? B : A, 0, 0, s.W, s.H);
    s.tint(g, 'rgba(0,0,0,.72)');
    g.save();
    g.translate(s.W / 2, s.H / 2);
    const lift = 1 - 0.12 * Math.sin(Math.PI * clamp(e));
    g.scale((vert ? 1 : k) * lift, (vert ? k : 1) * lift);
    g.drawImage(front ? A : B, -s.W / 2, -s.H / 2, s.W, s.H);
    g.restore();
    g.save();
    g.translate(s.W / 2, s.H / 2);
    g.scale((vert ? 1 : k) * lift, (vert ? k : 1) * lift);
    g.fillStyle = `rgba(0,0,0,${(0.5 * (1 - k)).toFixed(3)})`;
    g.fillRect(-s.W / 2, -s.H / 2, s.W, s.H);
    g.restore();
  },

  zoomin(g, A, B, s) { zoom(g, A, B, s, 1); },
  zoomout(g, A, B, s) { zoom(g, A, B, s, -1); },

  punch(g, A, B, s) {
    const cut = 0.36;
    const a = s.amount;
    if (s.raw < cut) {
      const p = s.raw / cut, z = 1 + 0.3 * a * p * p * p;
      const n = p > 0.4 ? 6 : 1;
      smear(g, n, (c, k) => centred(c, A, s.W, s.H, z * (1 + k * 0.07 * a * p * p), 0, 0));
      return;
    }
    const p = (s.raw - cut) / (1 - cut);
    const decay = Math.pow(1 - p, 2.2);
    const z = 1 + 0.34 * a * decay;
    const amp = 0.028 * a * decay * Math.min(s.W, s.H);
    const step = Math.floor(p * 14);
    const dx = (hash(step, 1) - 0.5) * 2 * amp, dy = (hash(step, 2) - 0.5) * 2 * amp;
    const n = decay > 0.25 ? 7 : 1;
    smear(g, n, (c, k) => centred(c, B, s.W, s.H, z * (1 + k * 0.1 * a * decay), dx, dy));
    if (decay > 0.35) {
      const src = sheet('pn', s.W, s.H); src.drawImage(g.canvas, 0, 0);
      g.clearRect(0, 0, s.W, s.H);
      split(g, src.canvas, s.W, s.H, amp * 0.5, 0);
    }
    s.light(g, `rgba(255,255,255,${(0.85 * a * Math.pow(1 - p, 7)).toFixed(3)})`);
  },

  glitch(g, A, B, s) {
    const bell = Math.sin(Math.PI * clamp(s.raw));
    const beat = Math.floor(s.raw * 9);
    const pow = bell * bell * (0.35 + 0.9 * s.amount);
    // Which shot shows flickers around the middle, then settles.
    const b = s.raw > 0.62 || (s.raw > 0.36 && hash(beat, 9) > 0.45);
    const img = b ? B : A, other = b ? A : B;
    const rows = 16;
    const o = sheet('gl', s.W, s.H);
    o.drawImage(img, 0, 0, s.W, s.H);
    for (let i = 0; i < rows; i++) {
      if (hash(i, beat) > 0.75 * pow) continue;
      const y = Math.floor(i / rows * s.H + hash(i, beat + 3) * s.H / rows), h = Math.max(2, Math.floor(s.H / rows * (0.25 + hash(i, beat + 5) * 1.3)));
      const dx = (hash(i, beat + 7) - 0.5) * 0.3 * pow * s.W;
      const from = hash(i, beat + 11) > 0.72 ? other : img;
      const hh = Math.min(h, s.H - y);
      if (hh <= 0) continue;
      o.drawImage(from, 0, y / s.H * from.height, from.width, hh / s.H * from.height, dx, y, s.W, hh);
      o.drawImage(from, 0, y / s.H * from.height, from.width, hh / s.H * from.height, dx > 0 ? dx - s.W : dx + s.W, y, s.W, hh);
    }
    const d = 0.022 * pow * s.W * (hash(beat, 21) > 0.5 ? 1 : -1);
    if (Math.abs(d) > 0.6) split(g, o.canvas, s.W, s.H, d, 0); else g.drawImage(o.canvas, 0, 0);
    if (hash(beat, 31) > 0.72 && pow > 0.5) s.light(g, 'rgba(255,255,255,.14)');
  },

  rgb(g, A, B, s) {
    const bell = Math.pow(Math.sin(Math.PI * s.raw), 1.5);
    const d = bell * (0.01 + 0.075 * s.amount) * s.W;
    const o = sheet('rgbm', s.W, s.H);
    o.drawImage(A, 0, 0, s.W, s.H);
    o.globalAlpha = clamp((s.raw - 0.38) / 0.24);
    o.drawImage(B, 0, 0, s.W, s.H);
    if (d < 0.6) { g.drawImage(o.canvas, 0, 0); return; }
    const v = s.dir === 'up';
    // Each channel a touch larger than the frame, so moving it never bares an edge.
    const z = 1 + 2.02 * d / (v ? s.H : s.W);
    const two = sheet('rgb2', s.W, s.H);
    const part = (name, col, k) => { const c = channel(name, o.canvas, s.W, s.H, col); two.globalCompositeOperation = 'lighter'; centred(two, c, s.W, s.H, z, v ? 0 : d * k, v ? d * k : 0); };
    part('cr', '#ff0000', 1); part('cg', '#00ff00', 0); part('cb', '#0000ff', -1);
    g.drawImage(two.canvas, 0, 0);
  },

  pixel(g, A, B, s) {
    const bell = Math.sin(Math.PI * s.raw);
    const most = Math.max(4, (0.012 + 0.075 * s.amount) * s.H);
    const size = 1 + Math.pow(bell, 1.6) * most;
    const img = s.raw < 0.5 ? A : B;
    if (size < 2) { g.drawImage(img, 0, 0, s.W, s.H); return; }
    const w = Math.max(2, Math.round(s.W / size)), h = Math.max(2, Math.round(s.H / size));
    const o = sheet('px', w, h);
    o.imageSmoothingQuality = 'high';
    o.drawImage(img, 0, 0, w, h);
    g.imageSmoothingEnabled = false;
    g.drawImage(o.canvas, 0, 0, w, h, 0, 0, s.W, s.H);
  },

  vhs(g, A, B, s) {
    const bell = Math.sin(Math.PI * s.raw), a = s.amount;
    const beat = Math.floor(s.raw * 12);
    const img = s.raw < 0.5 ? A : B;
    const roll = Math.pow(bell, 3) * 0.55 * a * s.H * (s.raw < 0.5 ? 1 : -1);
    const o = sheet('vh', s.W, s.H);
    o.drawImage(img, 0, roll, s.W, s.H);
    o.drawImage(img, 0, roll - s.H, s.W, s.H);
    o.drawImage(img, 0, roll + s.H, s.W, s.H);
    // Wobble every line band sideways, worst near a tear that travels down.
    const w = sheet('vw', s.W, s.H);
    const band = Math.max(2, Math.round(s.H / 90));
    const tear = ((s.raw * 1.6) % 1) * s.H;
    for (let y = 0; y < s.H; y += band) {
      const near = Math.exp(-Math.pow((y - tear) / (s.H * 0.09), 2));
      const dx = (Math.sin(y * 0.06 + s.raw * 40) * 0.003 + (hash(Math.floor(y / band), beat) - 0.5) * 0.01 + near * 0.06 * (hash(beat, 4) - 0.3)) * bell * (0.4 + a) * s.W;
      w.drawImage(o.canvas, 0, y, s.W, band, dx, y, s.W, band);
      if (Math.abs(dx) > 1) w.drawImage(o.canvas, dx > 0 ? 0 : s.W - 4, y, 4, band, dx > 0 ? 0 : s.W + dx, y, Math.abs(dx), band);
    }
    const d = 0.008 * bell * (0.5 + a) * s.W;
    if (d > 0.6) split(g, w.canvas, s.W, s.H, d, 0); else g.drawImage(w.canvas, 0, 0);
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = bell * (0.15 + 0.45 * a);
    const tile = grain(), gs = Math.max(1, s.H / 360);
    g.imageSmoothingEnabled = false;
    const ox = -Math.floor(hash(beat, 1) * 192) * gs, oy = -Math.floor(hash(beat, 2) * 192) * gs;
    for (let y = oy; y < s.H; y += 192 * gs) for (let x = ox; x < s.W; x += 192 * gs) g.drawImage(tile, x, y, 192 * gs, 192 * gs);
    g.globalCompositeOperation = 'source-atop';
    g.globalAlpha = bell * 0.22;
    g.fillStyle = '#000';
    for (let y = 0; y < s.H; y += band * 2) g.fillRect(0, y, s.W, Math.max(1, band / 2));
  },

  wipe(g, A, B, s) {
    const [vx, vy] = VEC[s.dir] || VEC.left;
    g.drawImage(A, 0, 0, s.W, s.H);
    const soft = 0.004 + 0.5 * s.amount;
    const p = lerp(-soft, 1, clamp(s.e)), L = vx ? s.W : s.H;
    const o = sheet('wi', s.W, s.H);
    o.drawImage(B, 0, 0, s.W, s.H);
    // "left" travels left: it starts at the right edge.
    const rev = vx < 0 || vy < 0;
    const a = (rev ? 1 - p : p) * L, b = (rev ? 1 - p - soft : p + soft) * L;
    const m = vx ? o.createLinearGradient(a, 0, b, 0) : o.createLinearGradient(0, a, 0, b);
    m.addColorStop(0, '#000'); m.addColorStop(1, 'rgba(0,0,0,0)');
    o.globalCompositeOperation = 'destination-in';
    o.fillStyle = m;
    o.fillRect(0, 0, s.W, s.H);
    g.drawImage(o.canvas, 0, 0);
  },

  slash(g, A, B, s) {
    const flip = s.dir === 'right';
    const lean = 0.32 * s.H;
    const span = s.W + lean * 2;
    const blade = (0.03 + 0.2 * s.amount) * s.W;
    const total = span + blade * 2.2;
    const x = -lean - blade * 2.2 + clamp(s.e) * total;      // where the cut is, moving right
    g.save();
    if (!flip) { g.translate(s.W, 0); g.scale(-1, 1); }
    const unflip = (img) => { g.save(); if (!flip) { g.translate(s.W, 0); g.scale(-1, 1); } g.drawImage(img, 0, 0, s.W, s.H); g.restore(); };
    unflip(A);
    const poly = (x0, x1) => { g.beginPath(); g.moveTo(x0 + lean, 0); g.lineTo(x1 + lean, 0); g.lineTo(x1 - lean, s.H); g.lineTo(x0 - lean, s.H); g.closePath(); };
    g.save();
    poly(-span * 2, x); g.clip();
    unflip(B);
    g.restore();
    g.globalCompositeOperation = 'source-atop';
    const bars = [[0, 0.55, s.color, 1], [0.68, 0.16, '#ffffff', 0.95], [0.96, 0.3, s.color, 0.55], [1.4, 0.1, s.color, 0.35]];
    for (const [o, w, col, al] of bars) { g.globalAlpha = al; g.fillStyle = col; poly(x + o * blade, x + (o + w) * blade); g.fill(); }
    g.restore();
  },

  circle(g, A, B, s) {
    const out = s.dir !== 'in';
    const e = clamp(s.e, 0, 1.1);
    const R = Math.hypot(s.W, s.H) / 2 * 1.03;
    g.drawImage(out ? A : B, 0, 0, s.W, s.H);
    const r = Math.max(0, (out ? e : 1 - e) * R);
    g.save();
    g.beginPath(); g.arc(s.W / 2, s.H / 2, r, 0, TAU); g.clip();
    const z = out ? lerp(1.12, 1, clamp(e)) : lerp(1, 1.12, clamp(e));
    centred(g, out ? B : A, s.W, s.H, z, 0, 0);
    g.restore();
    const rim = 0.05 * s.amount * Math.min(s.W, s.H) * Math.sin(Math.PI * clamp(s.raw));
    if (rim > 0.5 && r > 1) {
      g.globalCompositeOperation = 'source-atop';
      g.lineWidth = rim; g.strokeStyle = s.color; g.shadowColor = s.color; g.shadowBlur = rim * 1.5;
      g.beginPath(); g.arc(s.W / 2, s.H / 2, r, 0, TAU); g.stroke();
    }
  },

  clock(g, A, B, s) {
    const e = clamp(s.e), dir = s.dir === 'left' ? -1 : 1;
    g.drawImage(A, 0, 0, s.W, s.H);
    const R = Math.hypot(s.W, s.H), cx = s.W / 2, cy = s.H / 2, a0 = -Math.PI / 2;
    // A handful of slightly different angles: a soft edge on the hand.
    const o = sheet('ck', s.W, s.H);
    o.drawImage(B, 0, 0, s.W, s.H);
    const mk = sheet('cm', s.W, s.H);
    const soft = 0.05;
    for (let i = 0; i < 6; i++) {
      const a = clamp(e * (1 + soft) - soft * i / 5) * TAU;
      if (a <= 0) continue;
      mk.globalAlpha = 1 / 6 + (i === 5 ? 0.5 : 0.12);
      mk.beginPath(); mk.moveTo(cx, cy); mk.arc(cx, cy, R, a0, a0 + dir * Math.min(a, TAU - 1e-4), dir < 0); mk.closePath();
      if (a >= TAU - 1e-3) { mk.globalAlpha = 1; mk.fillRect(0, 0, s.W, s.H); } else mk.fill();
    }
    o.globalCompositeOperation = 'destination-in';
    o.drawImage(mk.canvas, 0, 0);
    g.drawImage(o.canvas, 0, 0);
  },

  blinds(g, A, B, s) {
    const n = Math.round(lerp(4, 20, s.amount)), vert = s.dir === 'up';
    g.drawImage(A, 0, 0, s.W, s.H);
    const L = (vert ? s.H : s.W) / n;
    g.save();
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const k = clamp(easeOf(s.ease, clamp(s.raw * 1.6 - i / n * 0.6)));
      const w = L * k + (k >= 1 ? 1 : 0);
      if (w <= 0) continue;
      if (vert) g.rect(0, i * L, s.W, w); else g.rect(i * L, 0, w, s.H);
    }
    g.clip();
    g.drawImage(B, 0, 0, s.W, s.H);
    g.restore();
  },

  blocks(g, A, B, s) {
    const cols = Math.round(lerp(6, 24, s.amount)), size = s.W / cols, rows = Math.ceil(s.H / size);
    g.drawImage(A, 0, 0, s.W, s.H);
    const kx = B.width / s.W, ky = B.height / s.H;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const wait = 0.62 * (0.55 * (x / cols) + 0.15 * (y / rows) + 0.3 * hash(x, y));
      const k = EASE.bouncy(clamp((s.raw - wait) / 0.36));
      if (s.raw <= wait) continue;
      const cell = Math.min(size, s.W - x * size), ch = Math.min(size, s.H - y * size);
      const done = s.raw - wait >= 0.36;
      const w = done ? cell + 0.6 : cell * clamp(k, 0, 1.06), h = done ? ch + 0.6 : ch * clamp(k, 0, 1.06);
      const cx = x * size + cell / 2, cy = y * size + ch / 2;
      g.drawImage(B, x * size * kx, y * size * ky, cell * kx, ch * ky, done ? x * size : cx - w / 2, done ? y * size : cy - h / 2, w, h);
    }
  },

  flash(g, A, B, s) {
    const first = s.raw < 0.42;
    const img = first ? A : B;
    const k = first ? Math.pow(s.raw / 0.42, 2.4) : Math.pow(1 - (s.raw - 0.42) / 0.58, 2.2);
    const z = first ? 1 + 0.05 * k : 1 + 0.07 * k;
    g.filter = k > 0.02 ? `brightness(${(1 + 1.6 * s.amount * k).toFixed(3)}) saturate(${(1 + 0.4 * k).toFixed(3)})` : 'none';
    centred(g, img, s.W, s.H, z, 0, 0);
    g.filter = 'none';
    s.light(g, hexA(s.color, clamp(k * (0.35 + 0.8 * s.amount))));
  },

  leak(g, A, B, s) {
    const bell = Math.sin(Math.PI * s.raw);
    g.drawImage(A, 0, 0, s.W, s.H);
    g.globalAlpha = EASE.smooth(clamp((s.raw - 0.25) / 0.5));
    g.drawImage(B, 0, 0, s.W, s.H);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'screen';
    const sign = s.dir === 'right' ? 1 : -1;
    const cols = [s.color, '#ffd27a', '#ff3d6e'];
    for (let i = 0; i < 4; i++) {
      const prog = s.raw * 1.5 - 0.25 + (hash(i, 1) - 0.5) * 0.35;
      const cx = (sign > 0 ? prog : 1 - prog) * s.W, cy = (0.15 + 0.7 * hash(i, 2)) * s.H;
      const R = (0.35 + 0.4 * hash(i, 3)) * s.W;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      const al = bell * s.amount * (0.55 + 0.45 * hash(i, 4));
      gr.addColorStop(0, hexA(i === 1 ? '#fff4dc' : cols[i % 3], al));
      gr.addColorStop(0.35, hexA(cols[i % 3], al * 0.55));
      gr.addColorStop(1, hexA(cols[i % 3], 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, s.W, s.H);
    }
  },
};

/** How many copies a blur needs: none when slow, more the faster it goes. */
function blurCopies(s, strength) {
  const v = s.speed * strength;
  return v < 0.12 ? 1 : Math.min(s.lite ? 7 : 13, Math.max(3, Math.round(3 + v * 5)));
}
/** Blurred frames are made small: half size at 1080p, less at 4K. */
const lowRes = (H) => Math.min(0.5, 640 / H);
function centred(g, img, W, H, z, dx, dy) {
  g.save();
  g.translate(W / 2 + dx, H / 2 + dy);
  g.scale(z, z);
  g.drawImage(img, -W / 2, -H / 2, W, H);
  g.restore();
}
function zoom(g, A, B, s, way) {
  const big = 1 + 0.6 + 2.0 * s.amount;
  const p = clamp(s.e, 0, 1.06);
  // In: A grows past the camera, B arrives from further away. Out: the other way round.
  const zA = way > 0 ? lerp(1, big, clamp(p * 2) ** 1.4) : lerp(1, 1 / big * 1.25, clamp(p * 2) ** 1.4);
  const zB = way > 0 ? lerp(1 / big * 1.25, 1, clamp(p * 2 - 1)) : lerp(big, 1, clamp(p * 2 - 1));
  const q = lowRes(s.H), w = Math.round(s.W * q), h = Math.round(s.H * q);
  const n = blurCopies(s, 0.8 + 0.6 * s.amount), shut = Math.min(0.55, s.speed * 0.12 * (0.4 + s.amount));
  const layer = (name, img, z) => {
    const m = mirrored('m', img, s.W, s.H, q);
    const o = sheet(name, w, h);
    smear(o, n, (c, k) => {
      const zz = Math.max(0.345, z * (1 + k * shut));      // the mirrored sheet is three frames wide, no more
      c.translate(w / 2, h / 2); c.scale(zz, zz);
      c.drawImage(m, -w * 1.5, -h * 1.5, w * 3, h * 3);
    });
    const gap = shut / Math.max(1, n - 1);
    return fine(name + '2', o.canvas, w, h, s.lite ? 2 : 5, (c, k) => centred(c, o.canvas, w, h, 1 + (k + 0.5) * gap, 0, 0));
  };
  const mix = clamp((s.raw - 0.42) / 0.16);
  // Slow: the mirrored sheet behind (for the edges) and the sharp picture on top.
  const slow = (img, z) => {
    if (z < 1) { const m = mirrored('m', img, s.W, s.H, q); g.save(); g.translate(s.W / 2, s.H / 2); g.scale(z, z); g.drawImage(m, -s.W * 1.5, -s.H * 1.5, s.W * 3, s.H * 3); g.restore(); }
    centred(g, img, s.W, s.H, z, 0, 0);
  };
  const sharp = n <= 1;
  if (mix < 1) { if (sharp) slow(A, zA); else g.drawImage(layer('zA', A, zA), 0, 0, s.W, s.H); }
  if (mix > 0) {
    g.globalAlpha = mix;
    if (sharp) slow(B, zB); else g.drawImage(layer('zB', B, zB), 0, 0, s.W, s.H);
    g.globalAlpha = 1;
  }
}

/**
 * Paint one moment of a transition onto `ctx` (W×H, at the identity transform).
 * `lite` uses fewer blur copies (the panel's little tiles).
 */
export function paintTransition(ctx, A, B, tr, W, H, { lite = false } = {}) {
  const k = kindOf(tr.kind);
  const d = k?.d || {};
  const raw = clamp(tr.raw ?? 0);
  const ease = tr.ease || d.ease || 'smooth';
  const s = {
    W, H, raw, lite, ease,
    p: EASE.smooth(raw), e: easeOf(ease, raw), speed: speedAt(ease, raw),
    dir: tr.dir && (!k?.dirs || k.dirs.includes(tr.dir)) ? tr.dir : d.dir || 'left',
    amount: clamp(tr.amount ?? d.amount ?? 0.5), color: tr.color || d.color || '#ffffff',
    /** Colour over what is painted, and only there (a small overlay stays small). */
    tint(g, col) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-atop'; g.fillStyle = col; g.fillRect(0, 0, W, H); g.restore(); },
    light(g, col) { s.tint(g, col); },
  };
  // The ends are exactly the two shots, whatever the effect.
  if (raw <= 0.0005 || raw >= 0.9995) { ctx.drawImage(raw < 0.5 ? A : B, 0, 0, W, H); return; }
  const out = sheet('out', W, H);
  out.save();
  (PAINT[tr.kind] || PAINT.dissolve)(out, A, B, s);
  out.restore();
  ctx.drawImage(out.canvas, 0, 0, W, H);
}
