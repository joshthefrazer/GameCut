/**
 * Smart crop: picking ANYTHING on the screen, so you click the thing instead of
 * tracing it. It does not know or care what the thing is — a map, a counter, a
 * player, a sign, a piece of the interface — and it never guesses a name for it.
 *
 * 1. Find what stays still. Sampling a handful of frames from the clip, the
 *    parts that are sharp (lots of edges) AND unchanging are grouped into
 *    pieces and boxed. They are only SUGGESTIONS, numbered "Piece 1, 2, …"
 *    (no guessed names — it used to call them Minimap, Kill feed and so on,
 *    which was wrong whenever the thing was anything else). Untick what you do
 *    not want, or ignore them and pick your own.
 *
 * 2. Click to cut out. Clicking anything selects the connected region of
 *    similar colour around the point, stopping at strong edges: a logo, a
 *    bar, an emote, a sign. One click, no tracing.
 *
 * Everything here is plain arithmetic on small greyscale/colour copies of the
 * frame, so it runs offline, instantly, on any machine.
 */

/** Grey copy of an RGBA buffer. */
export function toGrey(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let p = 0, q = 0; q < g.length; p += 4, q++) g[q] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  return g;
}

/** Edge strength at every pixel (Sobel magnitude, roughly 0..255). */
function edges(g, w, h) {
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      e[i] = Math.min(255, Math.hypot(gx, gy) / 4);
    }
  }
  return e;
}

/** Grow (r > 0) or shrink (r < 0) a binary map by a square of radius |r|. */
function morph(bits, w, h, r) {
  const grow = r > 0; r = Math.abs(r);
  // Separable: rows then columns, with running counts.
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w && x + r >= 0) c += bits[y * w + x + r];
      if (x - r - 1 >= 0 && x - r - 1 < w) c -= bits[y * w + x - r - 1];
      if (x >= 0 && x < w) {
        const span = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
        tmp[y * w + x] = grow ? (c > 0 ? 1 : 0) : (c === span ? 1 : 0);
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h && y + r >= 0) c += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0 && y - r - 1 < h) c -= tmp[(y - r - 1) * w + x];
      if (y >= 0 && y < h) {
        const span = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
        out[y * w + x] = grow ? (c > 0 ? 1 : 0) : (c === span ? 1 : 0);
      }
    }
  }
  return out;
}

/** Connected pieces of a binary map: [{x0,y0,x1,y1,n,bits}] in pixels. */
function components(bits, w, h, minN = 6) {
  const seen = new Int32Array(w * h).fill(-1);
  const out = [];
  const stack = [];
  for (let i = 0; i < bits.length; i++) {
    if (!bits[i] || seen[i] >= 0) continue;
    const id = out.length;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    stack.push(i); seen[i] = id;
    const members = [];
    while (stack.length) {
      const p = stack.pop();
      members.push(p);
      const x = p % w, y = (p / w) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [p - 1, p + 1, p - w, p + w];
      if (x === 0) nb[0] = -1;
      if (x === w - 1) nb[1] = -1;
      for (const q of nb) if (q >= 0 && q < bits.length && bits[q] && seen[q] < 0) { seen[q] = id; stack.push(q); }
    }
    if (n >= minN) out.push({ x0, y0, x1, y1, n, members });
  }
  return out;
}

/**
 * Find what stays still.
 *
 * `still` is the frame on screen ({data, w, h} RGBA at analysis size);
 * `frames` are greyscale samples from across the clip at the same size.
 * Returns pieces in 0..1 of the frame, biggest first, each with its own pixel
 * map (`bits`, analysis size) for an exact cut-out. Pieces are numbered, never
 * named: this tool has no idea what they are.
 */
export function findStill(still, frames) {
  const { w, h } = still;
  const g = toGrey(still.data, w, h);
  const e = edges(g, w, h);
  const n = frames.length;
  if (n < 3) return { items: [], reason: 'The clip is too short to tell what stays still.' };
  // How much each pixel changes across the clip.
  const sum = new Float32Array(w * h), sq = new Float32Array(w * h);
  for (const f of frames) for (let i = 0; i < sum.length; i++) { sum[i] += f.grey[i]; sq[i] += f.grey[i] * f.grey[i]; }
  const sd = new Float32Array(w * h);
  let movingPx = 0;
  for (let i = 0; i < sd.length; i++) {
    const m = sum[i] / n;
    sd[i] = Math.sqrt(Math.max(0, sq[i] / n - m * m));
    if (sd[i] > 10) movingPx++;
  }
  if (movingPx < sd.length * 0.25) {
    return { items: [], reason: 'The picture hardly moves in this clip, so what stays still cannot be told apart from the rest. Click what you want instead, or draw a box around it.' };
  }
  // Sharp and still.
  const bits = new Uint8Array(w * h);
  for (let i = 0; i < bits.length; i++) bits[i] = e[i] > 20 && sd[i] < 7 ? 1 : 0;
  // Join letters and icons into whole pieces, then tidy the outline.
  const joined = morph(morph(bits, w, h, 3), w, h, -1);
  const comps = components(joined, w, h, Math.max(8, (w * h) / 3000));
  let boxes = comps.map(c => ({
    x: c.x0 / w, y: c.y0 / h, w: (c.x1 - c.x0 + 1) / w, h: (c.y1 - c.y0 + 1) / h,
    n: c.n, members: c.members,
  })).map(b => ({ ...b, parts: [b] })).filter(b => {
    const area = b.w * b.h;
    const density = b.n / (b.w * w * b.h * h);
    return area > 0.0015 && area < 0.3 && b.w * w >= 6 && b.h * h >= 5 && density > 0.18;
  });
  // Pieces that nearly touch are one thing (a kill feed is several lines).
  const pad = 0.012;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x - pad < b.x + b.w && b.x - pad < a.x + a.w && a.y - pad < b.y + b.h && b.y - pad < a.y + a.h) {
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          boxes[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y,
            n: a.n + b.n, members: a.members.concat(b.members), parts: a.parts.concat(b.parts) };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  boxes = boxes.filter(b => b.w * b.h < 0.35).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 8);
  const make = (b, id, name) => {
    const m = new Uint8Array(w * h);
    for (const p of b.members) m[p] = 1;
    // A little breathing room around a neat box.
    const px = 3 / w, py = 3 / h;
    const box = { x: Math.max(0, b.x - px), y: Math.max(0, b.y - py) };
    box.w = Math.min(1 - box.x, b.w + 2 * px); box.h = Math.min(1 - box.y, b.h + 2 * py);
    return { id, name, box, bits: morph(m, w, h, 1), mw: w, mh: h, on: true };
  };
  const items = boxes.map((b, k) => {
    const name = `Piece ${k + 1}`;
    const item = make(b, 'still' + k, name);
    /*
     * Pieces that sat close together were joined into one (a kill feed is
     * several lines). Keep what it was joined from, so one bar of a stack of
     * three can still be cut on its own: Split in the list, or Shift+click it.
     */
    if (b.parts.length > 1) {
      item.parts = b.parts.slice().sort((p, q) => p.y - q.y || p.x - q.x)
        .map((p, i) => make(p, `still${k}p${i}`, `${name} · ${i + 1}`));
    }
    return item;
  });
  return { items, reason: items.length ? '' : 'Nothing on screen stayed still and sharp in this clip. Click what you want instead, or draw a box around it.' };
}

/**
 * Click to cut out: the region around (u, v) of colour close to the colour
 * there, stopping at strong edges. `tol` is how different a colour may be.
 */
export function magicSelect(img, u, v, tol = 22) {
  const { data, w, h } = img;
  const sx = Math.max(0, Math.min(w - 1, Math.round(u * w)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(v * h)));
  // The seed colour is the average around the click, so a noisy pixel does not decide.
  let r = 0, g = 0, b = 0, k = 0;
  for (let y = Math.max(0, sy - 2); y <= Math.min(h - 1, sy + 2); y++) {
    for (let x = Math.max(0, sx - 2); x <= Math.min(w - 1, sx + 2); x++) {
      const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; k++;
    }
  }
  r /= k; g /= k; b /= k;
  const grey = toGrey(data, w, h);
  const e = edges(grey, w, h);
  const bits = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  bits[stack[0]] = 1;
  let x0 = sx, y0 = sy, x1 = sx, y1 = sy, n = 0;
  const limit = w * h * 0.6;
  while (stack.length) {
    const p = stack.pop();
    n++;
    const x = p % w, y = (p / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (n > limit) break;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= bits.length || bits[q]) continue;
      const i = q * 4;
      const d = Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
      if (d > tol * 3 || e[q] > 60) continue;
      bits[q] = 1;
      stack.push(q);
    }
  }
  if (n > limit) return null;                         // ran into the whole picture
  const tidy = morph(morph(bits, w, h, 2), w, h, -2); // fill pinholes
  return { box: { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h }, bits: tidy, mw: w, mh: h, n };
}

/**
 * An item's pixels as a soft-edged PNG cropped to `box` — the same kind of
 * mask the brush makes, so the renderer treats both the same.
 */
export function maskPng(items, box, softPx = 1) {
  const { mw, mh } = items[0];
  const x0 = Math.floor(box.x * mw), y0 = Math.floor(box.y * mh);
  const x1 = Math.ceil((box.x + box.w) * mw), y1 = Math.ceil((box.y + box.h) * mh);
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const im = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = 0;
    for (const it of items) if (it.bits[(y + y0) * mw + (x + x0)]) { on = 1; break; }
    if (on) { const i = (y * w + x) * 4; im.data[i] = im.data[i + 1] = im.data[i + 2] = 255; im.data[i + 3] = 255; }
  }
  g.putImageData(im, 0, 0);
  if (softPx > 0) {
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const o = out.getContext('2d');
    o.filter = `blur(${softPx}px)`;
    o.drawImage(c, 0, 0);
    return out.toDataURL('image/png');
  }
  return c.toDataURL('image/png');
}
