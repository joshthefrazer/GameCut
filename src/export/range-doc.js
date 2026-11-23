/**
 * Export only In to Out: a copy of the project cut down to that stretch.
 *
 * Every clip that overlaps the range is trimmed to it and moved so the range
 * starts at 0; everything else is left out. The real project is never touched:
 * the export renders this copy through a "view" of the store, the same way the
 * extra shapes (vertical, square) and the 4K preview copies are made.
 */
const EPS = 1e-6;

/** Cut a document to [from, to) seconds. Returns a new document. */
export function trimDocToRange(doc, from, to) {
  const out = structuredClone(doc);
  const span = to - from;
  for (const tr of out.tracks) {
    const keep = [];
    for (const c of tr.clips) {
      const s = c.start, e = c.start + c.duration;
      if (e <= from + EPS || s >= to - EPS) continue;
      const head = Math.max(0, from - s);          // seconds cut off the front
      if (head > 0) {
        // Footage: start further into the source (at the clip's own speed).
        if (c.inPoint != null) c.inPoint = (c.inPoint || 0) + head * (c.speed || 1);
        // Keyframes and anything timed from the clip's own start move with it.
        if (c.keys) {
          for (const list of Object.values(c.keys)) {
            if (!Array.isArray(list)) continue;
            for (const k of list) if (typeof k.t === 'number') k.t -= head;
          }
        }
        c.fadeIn = 0;                              // the cut lands mid-shot: no fade from black there
        c.duration -= head;
      }
      const tail = Math.max(0, (c.start + c.duration) - to);
      if (tail > 0) { c.duration -= tail; c.fadeOut = 0; }
      c.start = Math.max(0, s + head - from);
      if (c.duration <= EPS) continue;
      keep.push(c);
    }
    tr.clips = keep;
  }
  out.markers = (out.markers || []).filter(m => m.t >= from && m.t < to).map(m => ({ ...m, t: m.t - from }));
  delete out.range;
  out.__rangeSpan = span;
  return out;
}

/**
 * A view of the store showing only In to Out (store.doc.range), or null when
 * no complete range is set.
 */
export function rangedStore(store, base = store) {
  const r = store.doc.range;
  if (!r || r.in == null || r.out == null || !(r.out - r.in > 1 / (store.doc.fps || 30))) return null;
  const to = Math.min(r.out, store.rt.duration);
  const doc = trimDocToRange(base.doc, r.in, to);
  const shadow = Object.create(base);
  shadow.doc = doc;
  shadow.rt = { ...base.rt, duration: to - r.in, playing: false, playhead: 0 };
  return shadow;
}

/** The complete range, if any: { in, out, span }. */
export function rangeOf(store) {
  const r = store.doc.range;
  if (!r || r.in == null || r.out == null || !(r.out - r.in > 1 / (store.doc.fps || 30))) return null;
  const out = Math.min(r.out, store.rt.duration);
  return { in: r.in, out, span: out - r.in };
}
