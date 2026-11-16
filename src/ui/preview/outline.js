/**
 * "Click to outline anything": the page's side.
 *
 * Talks to outline-worker.js, which runs the outline model. The model is an
 * optional download (about 14 MB, once, checked by checksum in the main
 * process, then offline). Until it is downloaded the crop window keeps using
 * the colour-based click-select, so nothing depends on it.
 *
 *   const o = await ensureOutline({ onProgress });   // downloads (only if asked) and starts it
 *   const id = await lookAt(canvas);                  // the slow part, once per picture
 *   const piece = await outlineAt(id, [{ x, y, add }]); // fast, every click
 */
export const OUTLINE_MODEL = 'outline-small';
export const OUTLINE_MB = 14;

const api = () => window.gamecut?.models || null;

let worker = null;
let ready = null;          // Promise<{ device }>
let seq = 0;
const waiting = new Map();
let lookedId = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./outline-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const key = data.type === 'ready' ? 'load' : data.id ?? 'load';
    const w = waiting.get(key);
    if (!w) return;
    if (data.type === 'error') w.reject(new Error(data.message));
    else w.resolve(data);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'the outline engine stopped');
    for (const w of waiting.values()) w.reject(err);
    stopOutline();
  };
  return worker;
}
function ask(key, msg, transfer) {
  return new Promise((resolve, reject) => {
    waiting.set(key, {
      resolve: (v) => { waiting.delete(key); resolve(v); },
      reject: (e) => { waiting.delete(key); reject(e); },
    });
    getWorker().postMessage(msg, transfer || []);
  });
}

/** Is the model on this computer? { available: desktop app?, ready: downloaded? } */
export async function outlineStatus() {
  const m = api();
  if (!m) return { available: false, ready: false };
  try { const st = await m.status(OUTLINE_MODEL); return { available: true, ready: !!st?.ready }; }
  catch { return { available: true, ready: false }; }
}

/** Is the engine started (model downloaded and loaded)? */
export const outlineRunning = () => !!ready;

/**
 * Make sure the model is downloaded and started. Downloads only when
 * `download` is true (the person pressed the button); otherwise a missing
 * model is an error the caller turns into "use colour select instead".
 */
export async function ensureOutline({ download = false, onProgress = null } = {}) {
  if (ready) return ready;
  const m = api();
  if (!m) throw new Error('Click to outline needs the desktop app');
  let st = await m.status(OUTLINE_MODEL);
  if (!st?.ready) {
    if (!download) throw Object.assign(new Error('the outline model is not downloaded'), { notDownloaded: true });
    const off = m.onProgress((p) => { if (p.id === OUTLINE_MODEL) onProgress?.({ phase: 'download', frac: Math.min(0.99, p.bytes / (p.approxBytes || 1)), bytes: p.bytes, total: p.approxBytes }); });
    try {
      const r = await m.download(OUTLINE_MODEL);
      if (r?.error) throw new Error(r.error === 'cancelled' ? 'cancelled' : r.error);
    } finally { off(); }
  }
  onProgress?.({ phase: 'start' });
  let forced = null;
  try { forced = localStorage.getItem('strike.outlineDevice') || null; } catch { /* storage off */ }
  ready = ask('load', { type: 'load', model: OUTLINE_MODEL, device: forced }).catch((e) => { ready = null; throw e; });
  return ready;
}

/** Cancel a download in progress. */
export function cancelOutlineDownload() { api()?.cancel(OUTLINE_MODEL); }

/** Throw the engine away (frees its memory). Started again on the next use. */
export function stopOutline() {
  worker?.terminate();
  worker = null; ready = null; lookedId = null;
  for (const w of waiting.values()) w.reject(new Error('cancelled'));
  waiting.clear();
}

/**
 * Let the model look at a picture (any canvas or image). The picture is sent
 * at most 1024 px on its long side: the model works at that size anyway.
 * Returns an id to outline from, and how long it took.
 */
export async function lookAt(source, w = source.width, h = source.height) {
  await ready;
  const k = Math.min(1, 1024 / Math.max(w, h));
  const cw = Math.max(8, Math.round(w * k)), ch = Math.max(8, Math.round(h * k));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, cw, ch);
  const data = g.getImageData(0, 0, cw, ch).data;
  const id = 'img' + (++seq);
  const r = await ask(id, { type: 'image', id, width: cw, height: ch, data }, [data.buffer]);
  lookedId = id;
  return { id, ms: r.ms, width: cw, height: ch };
}

/**
 * Outline from clicks on the picture that was looked at. `points` are
 * { x, y } in 0..1 of the picture, `add: false` for "not this bit".
 * Returns a piece in the crop window's own format: a full-frame bit mask
 * (bits, mw, mh) and its tight box in 0..1, or null if nothing was outlined.
 */
export async function outlineAt(id, points) {
  if (id !== lookedId) throw new Error('that picture is no longer the one looked at');
  // The worker answers with the picture's id, so one click at a time per picture.
  if (waiting.has(id)) throw Object.assign(new Error('still outlining the last click'), { busy: true });
  const r = await ask(id, { type: 'points', id, points });
  const { width: mw, height: mh, mask } = r;
  const plane = mw * mh;
  // Every outline the model offered, smallest first, so "bigger" and "smaller" mean what they say.
  const options = [];
  for (let k = 0; k < (r.count || 1); k++) {
    const bits = new Uint8Array(plane);
    let x0 = mw, y0 = mh, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const i = y * mw + x;
        if (!mask[k * plane + i]) continue;
        bits[i] = 1; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) continue;
    options.push({ bits, area: n / plane, score: r.scores?.[k] ?? r.score, best: k === r.best,
      box: { x: x0 / mw, y: y0 / mh, w: (x1 - x0 + 1) / mw, h: (y1 - y0 + 1) / mh } });
  }
  if (!options.length) return null;
  options.sort((a, b) => a.area - b.area);
  // Two outlines that are nearly the same are one choice, not two.
  const distinct = options.filter((o, i) => i === 0 || o.area > options[i - 1].area * 1.04 || o.best);
  const pick = Math.max(0, distinct.findIndex(o => o.best));
  return { mw, mh, ms: r.ms, options: distinct, pick, ...distinct[pick] };
}

/** The same piece, switched to another of the outlines the model offered (step: +1 bigger, -1 smaller). */
export function stepOutline(piece, step) {
  if (!piece?.options?.length) return false;
  const next = piece.pick + step;
  if (next < 0 || next >= piece.options.length) return false;
  piece.pick = next;
  const o = piece.options[next];
  piece.bits = o.bits; piece.box = o.box; piece.score = o.score; piece.area = o.area;
  return true;
}
