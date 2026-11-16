import { bus } from '../core/events.js';
import { makeClip } from '../core/schema.js';
import { mixTimeline } from '../audio/graph.js';
import { brandTextStyle } from '../project/brand.js';

/**
 * Auto-captions.
 *
 * Listens to the timeline (with the music and sound-effect lanes left out, so
 * the voice is what it hears), turns speech into words with the time each one
 * is said, and lays them down as short caption lines on their own lane. The
 * word being said lights up as it plays — the look every short-form clip uses.
 *
 * Everything happens on this computer. The speech model is downloaded once,
 * the first time, after the person says yes.
 */
export const MODEL = 'whisper-base.en';
const RATE = 16000;
const BLOCK_S = 240;          // seconds of sound per pass through the model

export const CAPTION_LOOKS = [
  {
    id: 'pop', name: 'Bold pop', note: 'White, heavy outline, the word being said turns yellow',
    style: {
      font: 'Inter', weight: 900, size: 0.07, fill: 'solid', color: '#ffffff',
      strokeWidth: 0.07, strokeColor: '#0b1220', glow: 0, shadow: 0.016, shadowColor: '#000000', shadowY: 0.008,
      bg: 'none', letterSpacing: 0, lineHeight: 1.08,
      anim: 'pop', animDur: 0.12, animOut: 'none', animLoop: 'none', animUnit: 'all',
      hiColor: '#facc15', hiPop: 1.14, keyColor: '#facc15',
    },
  },
  {
    id: 'clean', name: 'Clean', note: 'White on a dark plate, quiet highlight',
    style: {
      font: 'Inter', weight: 700, size: 0.056, fill: 'solid', color: '#ffffff',
      strokeWidth: 0, glow: 0, shadow: 0, bg: 'box', bgColor: '#0b1220d9', bgPad: 0.014, bgRadius: 0.22,
      letterSpacing: 0, lineHeight: 1.12,
      anim: 'fade', animDur: 0.1, animOut: 'none', animLoop: 'none', animUnit: 'all',
      hiColor: '#7dd3fc', hiPop: 1,
    },
  },
  {
    id: 'neon', name: 'Neon', note: 'Glowing, the word being said goes pink',
    style: {
      font: 'Inter', weight: 900, size: 0.066, fill: 'solid', color: '#ffffff',
      strokeWidth: 0.016, strokeColor: '#0ea5e9', glow: 0.04, glowColor: '#38bdf8', shadow: 0,
      bg: 'none', letterSpacing: 0.01, lineHeight: 1.08,
      anim: 'pop', animDur: 0.12, animOut: 'none', animLoop: 'none', animUnit: 'all',
      hiColor: '#f472b6', hiPop: 1.12,
    },
  },
  {
    id: 'box', name: 'Highlight box', note: 'A Volt box slides from word to word',
    style: {
      font: 'Inter', weight: 900, size: 0.066, fill: 'solid', color: '#ffffff',
      strokeWidth: 0, glow: 0, shadow: 0.022, shadowColor: '#000000', shadowY: 0.008,
      bg: 'none', letterSpacing: 0.02, lineHeight: 1.14,
      anim: 'pop', animDur: 0.12, animOut: 'none', animLoop: 'none', animUnit: 'all',
      hiColor: '#06080F', hiPop: 1, hiBox: '#C6FF3D', keyColor: '#C6FF3D',
    },
  },
  {
    id: 'single', name: 'One word at a time', note: 'Big single words, punchy for fast talking', lines: { maxWords: 1, maxChars: 14, maxDur: 0.9, gap: 0.3 },
    style: {
      font: 'Inter', weight: 900, size: 0.1, fill: 'solid', color: '#ffffff',
      strokeWidth: 0.08, strokeColor: '#06080F', glow: 0, shadow: 0.02, shadowColor: '#000000', shadowY: 0.01,
      bg: 'none', letterSpacing: 0, lineHeight: 1.05,
      anim: 'pop', animDur: 0.1, animOut: 'none', animLoop: 'none', animUnit: 'all',
      hiColor: '#ffffff', hiPop: 1, keyColor: '#C6FF3D', keyWins: true,
    },
  },
];

/** Filler words left out when "Remove um and uh" is on. */
const FILLER = /^(u+m+|u+h+|e+r+m*|hm+|mm+|uh-huh)[,.!?]*$/i;

/** Words worth shouting about: they get bigger and coloured. */
const KEYWORDS = /^(kill|kills|killed|ace|clutch|headshot|headshots|insane|crazy|no|way|win|won|wins|dead|died|triple|double|quad|penta|first|last|one|tap|snipe|sniped|flick|gg|bro|what|wow|omg|lets|let's|go|huge|massive|impossible|perfect|nuke|boom)[,.!?]*$/i;
export function keyIndices(words) {
  const out = [];
  words.forEach((w, i) => {
    const t = w.text.replace(/["'“”]/g, '');
    if (KEYWORDS.test(t) || /\d/.test(t) || /!$/.test(t) || (t.length > 2 && t === t.toUpperCase() && /[A-Z]/.test(t))) out.push(i);
  });
  // A line where everything is a keyword has no keywords.
  return out.length === words.length && words.length > 1 ? [] : out;
}
export const dropFillers = (words) => words.filter(w => !FILLER.test(w.text.trim()));

/* ── Listening ───────────────────────────────────────────────── */

const quietLane = (t) => t.kind === 'audio' && /music|song|beat|sfx|sound ?fx|effects?/i.test(t.name || '');

/** The timeline as the captioner hears it: music and SFX lanes muted. */
export function speechStore(store) {
  const shadow = Object.create(store);
  shadow.doc = { ...store.doc, tracks: store.doc.tracks.map(t => (quietLane(t) ? { ...t, muted: true, solo: false } : t)) };
  return shadow;
}

let worker = null;
let loaded = null;
const waiting = new Map();
let seq = 0;

function getWorker(onLoad) {
  if (!worker) {
    worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'loading') onLoad?.(data);
      else if (data.type === 'ready') waiting.get('load')?.resolve();
      else if (data.type === 'result') waiting.get(data.id)?.resolve(data.words);
      else if (data.type === 'error') (waiting.get(data.id ?? 'load') || [...waiting.values()][0])?.reject(new Error(data.message));
    };
    worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || 'the speech engine stopped')); };
  }
  return worker;
}
const ask = (key, msg, transfer) => new Promise((resolve, reject) => {
  waiting.set(key, { resolve: (v) => { waiting.delete(key); resolve(v); }, reject: (e) => { waiting.delete(key); reject(e); } });
  getWorker().postMessage(msg, transfer || []);
});

/** Start the model (reads it off disk; the first time takes a few seconds). */
export function loadModel(onLoad) {
  if (!loaded) {
    getWorker(onLoad);
    loaded = ask('load', { type: 'load', model: MODEL }).catch((e) => { loaded = null; throw e; });
  }
  return loaded;
}

/** Stop everything (Cancel): the worker is thrown away and made again next time. */
export function stopListening() {
  worker?.terminate();
  worker = null;
  loaded = null;
  for (const w of waiting.values()) w.reject(new Error('cancelled'));
  waiting.clear();
}

const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

/** Where to cut a block: the quietest tenth of a second in its last few seconds. */
function quietCut(buf, len) {
  const win = RATE / 10, look = Math.min(len - win, RATE * 6);
  let best = len, bestE = Infinity;
  for (let i = len - look; i + win <= len; i += win / 2) {
    const e = rms(buf, i, i + win);
    if (e < bestE) { bestE = e; best = i + win / 2; }
  }
  return Math.floor(best);
}

/**
 * Words said between `from` and `to` (timeline seconds).
 * Resolves with [{ text, s, e }] in timeline seconds.
 */
export async function transcribe(store, { from = 0, to = store.rt.duration, onProgress, alive = () => true } = {}) {
  const shadow = speechStore(store);
  const words = [];
  let buf = new Float32Array(RATE * (BLOCK_S + 40));
  let len = 0, bufStart = from;
  const cap = RATE * BLOCK_S;

  const flush = async (all) => {
    const cut = all ? len : quietCut(buf, len);
    const piece = buf.slice(0, cut);
    if (rms(piece) > 0.002) {
      const got = await ask(++seq, { type: 'run', id: seq, audio: piece }, [piece.buffer]);
      for (const w of got) words.push({ text: w.text, s: bufStart + w.s, e: bufStart + w.e });
    }
    buf.copyWithin(0, cut, len);
    len -= cut;
    bufStart += cut / RATE;
  };

  for await (const { buffer, frame } of mixTimeline(shadow, to, { sampleRate: RATE, segment: 30, from })) {
    if (!alive()) throw new Error('cancelled');
    const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    if (len + L.length > buf.length) {
      const bigger = new Float32Array(len + L.length + RATE * 10);
      bigger.set(buf.subarray(0, len));
      buf = bigger;
    }
    for (let i = 0; i < L.length; i++) buf[len + i] = (L[i] + R[i]) * 0.5;
    len += L.length;
    if (len >= cap) await flush(false);
    onProgress?.(Math.min(0.99, (frame / RATE + L.length / RATE - from) / Math.max(0.1, to - from)));
  }
  if (!alive()) throw new Error('cancelled');
  if (len > 0) await flush(true);
  onProgress?.(1);
  return words.filter(w => w.s < to && w.e > from);
}

/* ── Lines ───────────────────────────────────────────────────── */

/**
 * Group words into short caption lines: a few words each, broken at pauses
 * and at the end of sentences, never on screen longer than it takes to read.
 */
export function wordsToLines(words, { maxWords = 4, maxChars = 22, maxDur = 2.4, gap = 0.55 } = {}) {
  const lines = [];
  let cur = null;
  const close = () => { if (cur?.words.length) lines.push(cur); cur = null; };
  for (const w of words) {
    const text = w.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (cur) {
      const last = cur.words[cur.words.length - 1];
      const chars = cur.words.reduce((a, x) => a + x.text.length + 1, 0) + text.length;
      if (cur.words.length >= maxWords || chars > maxChars || w.e - cur.start > maxDur
        || w.s - last.e > gap || /[.?!]$/.test(last.text)) close();
    }
    if (!cur) cur = { start: w.s, end: w.e, words: [] };
    cur.words.push({ text, s: w.s, e: w.e });
    cur.end = w.e;
  }
  close();
  // Hold each line a moment after its last word, but never into the next one.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    lines[i].end = Math.min(next ? next.start : Infinity, Math.max(lines[i].end + 0.3, lines[i].start + 0.6));
  }
  return lines;
}

/* ── Laying them down ────────────────────────────────────────── */

export function addCaptions({ store, cmds, history }, lines, { look = 'pop', from = 0, to = Infinity, keywords = true, safe = true } = {}) {
  const preset = CAPTION_LOOKS.find(l => l.id === look) || CAPTION_LOOKS[0];
  const fps = store.doc.fps || 30;
  const f = (t) => Math.round(t * fps) / fps;
  const tall = store.doc.height > store.doc.width;
  const brand = brandTextStyle();
  let made = 0;
  cmds.batch('Auto-captions', () => {
    let track = store.doc.tracks.find(t => t.kind === 'text' && t.name === 'Captions');
    if (track) {
      // Running it again replaces the captions it made over the same stretch.
      history.run('Clear old captions', (doc) => {
        const t = doc.tracks.find(x => x.id === track.id);
        t.clips = t.clips.filter(c => !(c.caption && c.start < to && c.start + c.duration > from));
      });
    } else {
      track = cmds.addTrack('text', null, { name: 'Captions' });
    }
    for (const line of lines) {
      const start = f(line.start), end = Math.max(start + 1 / fps, f(line.end));
      const clip = makeClip('text', { name: 'Caption', start, duration: end - start });
      Object.assign(clip.text, preset.style);
      if (brand.font) clip.text.font = brand.font;
      clip.text.text = line.words.map(w => w.text).join(' ');
      clip.text.words = line.words.map(w => ({ s: Math.max(0, w.s - start), e: Math.max(0.05, w.e - start) }));
      if (keywords) { const k = keyIndices(line.words); if (k.length) clip.text.keys = k; }
      clip.caption = true;
      // Inside the phone apps' safe area on a vertical video: clear of the
      // caption, name and buttons they draw over the bottom.
      clip.transform.y = tall ? (safe ? 0.64 : 0.7) : 0.8;
      clip.transform.w = tall ? 0.86 : 0.8;
      cmds.addClip(track.id, clip, { select: false, label: 'Add caption' });
      made++;
    }
  });
  return made;
}

/* ── The box you start it from ───────────────────────────────── */

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function initCaptions({ store, cmds, history }) {
  const api = window.gamecut?.models;
  const el = document.createElement('div');
  el.className = 'pal capd';
  el.id = 'captions';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Auto-captions');
  document.body.appendChild(el);
  let look = 'pop', running = false, runId = 0;
  const opts = { keywords: true, fillers: true, safe: true };

  const rangeOf = (which) => {
    if (which === 'sel') {
      const sel = store.doc.tracks.flatMap(t => t.clips).filter(c => store.rt.selection.includes(c.id));
      if (sel.length) return { from: Math.min(...sel.map(c => c.start)), to: Math.max(...sel.map(c => c.start + c.duration)) };
    }
    return { from: 0, to: store.rt.duration };
  };

  async function open() {
    if (running) { el.hidden = false; return; }
    const st = api ? await api.status(MODEL).catch(() => null) : null;
    const hasSel = store.rt.selection.length > 0;
    el.innerHTML = `
      <div class="pal__box capd__box">
        <div class="vers__head"><b>Auto-captions</b><span>Strike listens to your clip and writes the words on screen, timed to your voice.</span>
          <button class="btn btn--ghost btn--sm" data-close aria-label="Close">Close</button></div>
        <div class="capd__body">
          <div class="capd__lbl">Caption</div>
          <div class="capd__opts">
            <label><input type="radio" name="capRange" value="all" ${hasSel ? '' : 'checked'}> The whole video (${mmss(store.rt.duration)})</label>
            <label ${hasSel ? '' : 'class="is-off"'}><input type="radio" name="capRange" value="sel" ${hasSel ? 'checked' : 'disabled'}> Just the selected clips</label>
          </div>
          <div class="capd__lbl">Look</div>
          <div class="capd__looks capd__looks--5">${CAPTION_LOOKS.map(l => `<button class="capd__look${l.id === look ? ' is-on' : ''}" data-look="${l.id}" title="${l.note}"><b>${l.name}</b><span>${l.note}</span></button>`).join('')}</div>
          <div class="capd__checks">
            <label><input type="checkbox" id="capKeys" ${opts.keywords ? 'checked' : ''}> Make keywords bigger</label>
            <label><input type="checkbox" id="capUm" ${opts.fillers ? 'checked' : ''}> Remove "um" and "uh"</label>
            <label><input type="checkbox" id="capSafe" ${opts.safe ? 'checked' : ''}> Keep inside the phone safe zone</label>
          </div>
          <p class="capd__note">${!api ? 'Auto-captions need the desktop app.'
            : st?.ready ? 'Music and sound-effect lanes are left out so it hears your voice. Click any caption afterwards to fix a word.'
            : 'The first time, Strike downloads its speech model (about 80 MB) — once. After that captions work offline, and your audio never leaves this computer.'}</p>
          <div class="capd__bar" hidden><i></i></div>
          <div class="capd__status" id="capStatus" aria-live="polite"></div>
        </div>
        <div class="capd__foot">
          <button class="btn btn--ghost" data-close>Cancel</button>
          <button class="btn btn--primary" id="btnCapGo" ${api ? '' : 'disabled'}>${st?.ready ? 'Make captions' : 'Download & make captions'}</button>
        </div>
      </div>`;
    el.hidden = false;
  }
  function close() {
    if (running) { runId++; running = false; stopListening(); api?.cancel(MODEL); }
    el.hidden = true;
  }
  const status = (msg, frac) => {
    const s = el.querySelector('#capStatus'); if (s) s.textContent = msg;
    const bar = el.querySelector('.capd__bar');
    if (bar) { bar.hidden = frac == null; bar.firstElementChild.style.width = `${Math.round((frac || 0) * 100)}%`; }
  };

  async function go() {
    if (running) return;
    const which = el.querySelector('input[name="capRange"]:checked')?.value || 'all';
    const { from, to } = rangeOf(which);
    if (!(to > from)) { status('There is nothing on the timeline to listen to yet.'); return; }
    running = true;
    const id = ++runId;
    const alive = () => id === runId;
    const btn = el.querySelector('#btnCapGo');
    if (btn) btn.disabled = true;
    try {
      let st = await api.status(MODEL);
      if (!st.ready) {
        const off = api.onProgress((p) => { if (alive() && p.id === MODEL) status(`Downloading the speech model… ${Math.round(p.bytes / 1e6)} of ~${Math.round(p.approxBytes / 1e6)} MB`, Math.min(0.99, p.bytes / p.approxBytes)); });
        status('Downloading the speech model…', 0);
        const r = await api.download(MODEL).finally(off);
        if (!alive()) return;
        if (r?.error) throw new Error(r.error === 'cancelled' ? 'cancelled' : `could not download the speech model (${r.error})`);
      }
      status('Starting the speech engine…', null);
      await loadModel();
      if (!alive()) return;
      status('Listening…', 0);
      const words = await transcribe(store, {
        from, to, alive,
        onProgress: (p) => status(`Listening… ${mmss(from + (to - from) * p)} of ${mmss(to)}`, p),
      });
      if (!alive()) return;
      const kept = opts.fillers ? dropFillers(words) : words;
      const lines = wordsToLines(kept, CAPTION_LOOKS.find(l => l.id === look)?.lines);
      if (!lines.length) {
        status('No speech was heard. Is the voice on a lane named Music or SFX? Those are left out.', null);
        running = false; if (btn) btn.disabled = false;
        return;
      }
      const n = addCaptions({ store, cmds, history }, lines, { look, from, to, keywords: opts.keywords, safe: opts.safe });
      running = false;
      el.hidden = true;
      bus.emit('toast', { msg: `Added ${n} caption${n === 1 ? '' : 's'} on the Captions lane — click one to fix a word. Ctrl+Z removes them all.`, kind: 'ok', ms: 6000 });
    } catch (e) {
      if (!alive()) return;
      running = false;
      if (btn) btn.disabled = false;
      status(e.message === 'cancelled' ? 'Stopped.' : `Captions failed: ${e.message}`, null);
    }
  }

  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) { close(); return; }
    const l = e.target.closest('[data-look]');
    if (l) { look = l.dataset.look; for (const b of el.querySelectorAll('[data-look]')) b.classList.toggle('is-on', b === l); return; }
    if (e.target.closest('#btnCapGo')) go();
  });
  el.addEventListener('change', (e) => {
    if (e.target.id === 'capKeys') opts.keywords = e.target.checked;
    if (e.target.id === 'capUm') opts.fillers = e.target.checked;
    if (e.target.id === 'capSafe') opts.safe = e.target.checked;
  });
  window.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
  bus.on('captions:open', open);
  bus.emit('palette:add', [{ id: 'captions', name: 'Auto-captions: write what is said on screen', sec: 'Text', run: open }]);
  return { open, close, transcribe: (o) => transcribe(store, o), wordsToLines, addCaptions: (lines, o) => addCaptions({ store, cmds, history }, lines, o) };
}
