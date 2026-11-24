/**
 * The caption editor: every caption line in one list.
 *
 * Fix a word by typing, click a word to style it (colour, size, an emoji,
 * shake), split a line before a word or join it to the next, nudge it earlier
 * or later, find and replace across all of them, and change the look or the
 * animation of every caption at once. Each change is one undo step.
 *
 * It sits beside the preview rather than over it: Space still plays, and the
 * word being said is lit in the list as the video runs.
 *
 * The edits themselves are plain functions on the document (exported for the
 * tests); the panel only calls them inside `history.run`.
 */
import { bus } from '../core/events.js';
import { CAPTION_LOOKS } from './captions.js';
import { WORD_ANIMS } from '../engine/layers/text-layer.js';
import { uid as makeUid } from '../core/schema.js';

/* ── The edits ────────────────────────────────────────────────── */

const EPS = 1e-6;

/** The caption lines, in time order: the Captions lane, or every clip made by Auto-captions. */
export function captionClips(doc) {
  const lane = doc.tracks.find(t => t.kind === 'text' && t.name === 'Captions');
  const list = lane ? lane.clips.filter(c => c.type === 'text') : doc.tracks.flatMap(t => t.clips.filter(c => c.type === 'text' && c.caption));
  return list.slice().sort((a, b) => a.start - b.start);
}
const findIn = (doc, id) => {
  for (const t of doc.tracks) { const c = t.clips.find(x => x.id === id); if (c) return { clip: c, track: t }; }
  return { clip: null, track: null };
};
const splitWords = (text) => String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/** Words' times shared over `dur` seconds by length (for text that has no timings of its own). */
function spreadTimes(words, dur) {
  const total = words.reduce((n, w) => n + w.length + 1, 0) || 1;
  let t = 0;
  return words.map((w) => { const d = dur * (w.length + 1) / total; const o = { s: t, e: t + d }; t += d; return o; });
}

/**
 * New text for a line. Same number of words: timings kept (it was a spelling
 * fix). Different: timings shared out again, and per-word styles and
 * keywords that no longer line up are dropped.
 */
export function setLineText(clip, text) {
  const words = splitWords(text);
  if (!words.length) return false;
  const t = clip.text;
  const same = Array.isArray(t.words) && t.words.length === words.length;
  t.text = words.join(' ');
  if (!same) {
    t.words = spreadTimes(words, clip.duration);
    delete t.keys;
    delete t.wordStyle;
  }
  return true;
}

/** Split a line so word `idx` starts a new one. Returns the new clip, or null. */
export function splitLine(track, clip, idx, makeId) {
  const t = clip.text;
  const words = splitWords(t.text);
  if (!(idx > 0 && idx < words.length) || !Array.isArray(t.words) || t.words.length !== words.length) return null;
  const at = t.words[idx].s;
  if (!(at > EPS && at < clip.duration - EPS)) return null;
  const right = structuredClone(clip);
  right.id = makeId();
  right.start = clip.start + at;
  right.duration = clip.duration - at;
  right.text.text = words.slice(idx).join(' ');
  right.text.words = t.words.slice(idx).map(w => ({ s: Math.max(0, w.s - at), e: Math.max(0.05, w.e - at) }));
  const part = (obj, from, to, shift) => {
    if (!obj) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(obj)) { const i = +k; if (i >= from && i < to) out[i - shift] = v; }
    return Object.keys(out).length ? out : undefined;
  };
  right.text.keys = (t.keys || []).filter(i => i >= idx).map(i => i - idx);
  if (!right.text.keys.length) delete right.text.keys;
  right.text.wordStyle = part(t.wordStyle, idx, words.length, idx);
  if (!right.text.wordStyle) delete right.text.wordStyle;
  delete right.keys;            // property keyframes are timed from the old start; leave them with the left half
  right.keys = {};
  t.text = words.slice(0, idx).join(' ');
  t.words = t.words.slice(0, idx);
  t.keys = (t.keys || []).filter(i => i < idx);
  if (!t.keys.length) delete t.keys;
  const ws = part(t.wordStyle, 0, idx, 0);
  if (ws) t.wordStyle = ws; else delete t.wordStyle;
  clip.duration = at;
  track.clips.push(right);
  track.clips.sort((a, b) => a.start - b.start);
  return right;
}

/** Join a line with the next one on its lane. Returns true when it did. */
export function mergeWithNext(track, clip) {
  const next = track.clips.filter(c => c.type === 'text' && c.start > clip.start + EPS).sort((a, b) => a.start - b.start)[0];
  if (!next) return false;
  const a = clip.text, b = next.text;
  const aw = splitWords(a.text), bw = splitWords(b.text);
  const off = next.start - clip.start;
  const aT = Array.isArray(a.words) && a.words.length === aw.length ? a.words : spreadTimes(aw, clip.duration);
  const bT = Array.isArray(b.words) && b.words.length === bw.length ? b.words : spreadTimes(bw, next.duration);
  a.text = [...aw, ...bw].join(' ');
  a.words = [...aT, ...bT.map(w => ({ s: w.s + off, e: w.e + off }))];
  const keys = [...(a.keys || []), ...(b.keys || []).map(i => i + aw.length)];
  if (keys.length) a.keys = keys; else delete a.keys;
  const ws = { ...(a.wordStyle || {}) };
  for (const [k, v] of Object.entries(b.wordStyle || {})) ws[+k + aw.length] = v;
  if (Object.keys(ws).length) a.wordStyle = ws; else delete a.wordStyle;
  clip.duration = Math.max(clip.duration, next.start + next.duration - clip.start);
  track.clips = track.clips.filter(c => c !== next);
  return true;
}

/** Style one word: { color, scale, emoji, shake } (null / falsy values remove that part). */
export function styleWord(clip, idx, patch) {
  const t = clip.text;
  const cur = { ...(t.wordStyle?.[idx] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === false || v === '' || (k === 'scale' && v === 1)) delete cur[k]; else cur[k] = v;
  }
  const all = { ...(t.wordStyle || {}) };
  if (Object.keys(cur).length) all[idx] = cur; else delete all[idx];
  if (Object.keys(all).length) t.wordStyle = all; else delete t.wordStyle;
}

/** Replace text across every caption (whole words or any text, ignoring case). Returns how many lines changed. */
export function replaceAll(doc, find, repl, { whole = true } = {}) {
  const f = String(find || '').trim();
  if (!f) return 0;
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(whole ? `(^|[^\\p{L}\\p{N}'])${esc}(?=$|[^\\p{L}\\p{N}'])` : esc, 'giu');
  let n = 0;
  for (const c of captionClips(doc)) {
    const before = c.text.text;
    const after = whole ? before.replace(re, (m, pre) => pre + repl) : before.replace(re, repl);
    if (after !== before && setLineText(c, after)) n++;
  }
  return n;
}

/* ── The panel ────────────────────────────────────────────────── */

const COLOURS = ['#facc15', '#ef4444', '#22c55e', '#C6FF3D', '#38bdf8', '#f472b6', '#a78bfa', '#ffffff'];
const SIZES = [[1, 'Normal'], [1.3, 'Big'], [1.7, 'Huge']];
const EMOJI = ['🔥', '💀', '😂', '😱', '👀', '💯', '🏆', '⚡', '🎯', '😤', '🤯', '❤️'];

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initCaptionEditor({ store, history, playback, cmds }) {
  const el = document.createElement('aside');
  el.className = 'cape';
  el.id = 'captionEditor';
  el.hidden = true;
  el.setAttribute('aria-label', 'Caption editor');
  document.body.appendChild(el);

  let editing = null;      // clip id whose text box is open
  let pop = null;          // { id, idx } of the word whose style box is open
  let lastLive = '';

  const uid = () => makeUid('clip');
  const run = (label, fn) => {
    let out;
    history.run(label, (doc) => { out = fn(doc); });
    window.gc?.comp?.render?.();
    return out;
  };
  const say = (msg, kind) => bus.emit('toast', { msg, kind, key: 'cape', ms: 3200 });

  function open() {
    el.hidden = false;
    document.documentElement.classList.add('has-cape');
    render();
    if (!captionClips(store.doc).length) {
      say('No captions yet: make them with Auto-captions, or bring in an .srt from that box.');
    }
  }
  function close() {
    el.hidden = true; editing = null; pop = null;
    document.documentElement.classList.remove('has-cape');
  }
  const toggle = () => (el.hidden ? open() : close());

  function render() {
    if (el.hidden) return;
    const clips = captionClips(store.doc);
    const first = clips[0]?.text || {};
    const lookNow = CAPTION_LOOKS.find(l => l.style.color === first.color && l.style.weight === first.weight && (l.style.hiColor || '') === (first.hiColor || '') && (l.style.wordAnim || 'none') === (first.wordAnim || 'none'))?.id;
    const animNow = first.wordAnim || 'none';
    el.innerHTML = `
      <header class="cape__head">
        <b>Captions</b><span>${clips.length} line${clips.length === 1 ? '' : 's'}</span>
        <button class="cape__x" data-close title="Close (the captions stay)" aria-label="Close">✕</button>
      </header>
      ${clips.length ? `
      <div class="cape__sec">
        <div class="cape__lbl">Look of every caption</div>
        <div class="cape__tiles">${CAPTION_LOOKS.map(l => `<button class="cape__tile${l.id === lookNow ? ' is-on' : ''}" data-look="${l.id}" title="${esc(l.note)}">${esc(l.name)}</button>`).join('')}</div>
        <div class="cape__lbl">How the words appear</div>
        <div class="cape__tiles">${WORD_ANIMS.map(a => `<button class="cape__tile${a.id === animNow ? ' is-on' : ''}" data-anim="${a.id}" title="${esc(a.note)}">${esc(a.name)}</button>`).join('')}</div>
      </div>
      <div class="cape__find">
        <input type="text" id="capeFind" placeholder="Find" spellcheck="false" aria-label="Find">
        <input type="text" id="capeRepl" placeholder="Replace with" spellcheck="false" aria-label="Replace with">
        <button class="btn btn--ghost btn--sm" id="capeReplace" title="Replace that word in every caption">Replace all</button>
      </div>` : ''}
      <ol class="cape__list" id="capeList">
        ${clips.map(c => row(c)).join('') || '<li class="cape__empty">No captions yet. Open Auto-captions (Ctrl+K → captions) to make them, or bring in an .srt file there.</li>'}
      </ol>
      <footer class="cape__foot">Click a word to colour it, make it bigger, give it an emoji or a shake · ✎ to fix the typing · Space plays</footer>`;
    paintLive(true);
  }

  function row(c) {
    const words = splitWords(c.text.text);
    const ws = c.text.wordStyle || {};
    const keys = new Set(c.text.keys || []);
    const body = editing === c.id
      ? `<input class="cape__edit" type="text" value="${esc(c.text.text)}" data-edit="${c.id}" spellcheck="true" aria-label="Caption text">`
      : `<span class="cape__words">${words.map((w, i) => {
          const st = ws[i];
          const style = st?.color ? ` style="color:${st.color}"` : '';
          const cls = 'cape__w' + (st ? ' is-styled' : '') + (keys.has(i) ? ' is-key' : '') + (st?.scale > 1 ? ' is-big' : '');
          return `<button class="${cls}" data-word="${c.id}:${i}"${style}>${st?.emoji ? `<i>${st.emoji}</i>` : ''}${esc(w)}${st?.shake ? '<sup>〰</sup>' : ''}</button>`;
        }).join('')}</span>`;
    return `<li class="cape__row" data-row="${c.id}">
      <button class="cape__time" data-seek="${c.id}" title="Go to this line">${mmss(c.start)}</button>
      ${body}
      <span class="cape__acts">
        <button data-nudge="${c.id}:-1" title="0.1 s earlier">◂</button>
        <button data-nudge="${c.id}:1" title="0.1 s later">▸</button>
        <button data-editbtn="${c.id}" title="Fix the typing">✎</button>
        <button data-merge="${c.id}" title="Join with the next line">⤓</button>
        <button data-del="${c.id}" title="Delete this line">✕</button>
      </span>
      ${pop && pop.id === c.id ? popBox(c, pop.idx) : ''}
    </li>`;
  }

  function popBox(c, idx) {
    const st = c.text.wordStyle?.[idx] || {};
    const word = splitWords(c.text.text)[idx] || '';
    return `<div class="cape__pop" role="dialog" aria-label="Style “${esc(word)}”">
      <div class="cape__poph"><b>“${esc(word)}”</b><button data-popclose aria-label="Close">✕</button></div>
      <div class="cape__pr"><span>Colour</span>${COLOURS.map(col => `<button class="cape__sw${st.color === col ? ' is-on' : ''}" data-wcolor="${col}" style="background:${col}" title="${col}"></button>`).join('')}<button class="cape__sw cape__sw--none${!st.color ? ' is-on' : ''}" data-wcolor="" title="The look's own colour">⦸</button></div>
      <div class="cape__pr"><span>Size</span>${SIZES.map(([v, n]) => `<button class="cape__chip${(st.scale || 1) === v ? ' is-on' : ''}" data-wscale="${v}">${n}</button>`).join('')}</div>
      <div class="cape__pr"><span>Emoji</span>${EMOJI.map(e => `<button class="cape__em${st.emoji === e ? ' is-on' : ''}" data-wemoji="${e}">${e}</button>`).join('')}<button class="cape__chip" data-wemoji="">None</button></div>
      <div class="cape__pr"><span>Move</span><button class="cape__chip${st.shake ? ' is-on' : ''}" data-wshake="1">Shake while said</button></div>
      <div class="cape__pr"><button class="cape__chip" data-split="1" ${idx > 0 ? '' : 'disabled'} title="Start a new caption line at this word">Split the line here</button><button class="cape__chip" data-wclear="1">Clear this word</button></div>
    </div>`;
  }

  /** Light the line and word being said, as the video plays (no rebuild). */
  function paintLive(force = false) {
    if (el.hidden) return;
    const t = store.rt.playhead;
    const c = captionClips(store.doc).find(x => t >= x.start && t < x.start + x.duration);
    let wi = -1;
    if (c && Array.isArray(c.text.words)) wi = c.text.words.findIndex(w => t - c.start >= w.s && t - c.start < w.e);
    const key = c ? `${c.id}:${wi}` : '';
    if (key === lastLive && !force) return;
    lastLive = key;
    el.querySelectorAll('.is-live').forEach(n => n.classList.remove('is-live'));
    if (!c) return;
    const r = el.querySelector(`[data-row="${c.id}"]`);
    r?.classList.add('is-live');
    if (wi >= 0) el.querySelector(`[data-word="${c.id}:${wi}"]`)?.classList.add('is-live');
    if (r && store.rt.playing && !editing && !pop) r.scrollIntoView({ block: 'nearest' });
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.close != null) { close(); return; }
    if (d.look) {
      const look = CAPTION_LOOKS.find(l => l.id === d.look);
      run(`Captions: ${look.name}`, (doc) => {
        for (const c of captionClips(doc)) {
          const keep = { text: c.text.text, words: c.text.words, keys: c.text.keys, wordStyle: c.text.wordStyle, font: c.text.font };
          const anim = c.text.wordAnim;
          Object.assign(c.text, look.style);
          Object.assign(c.text, keep);
          // A look that has its own word animation brings it; otherwise keep the one you picked.
          if (!look.style.wordAnim && anim) c.text.wordAnim = anim;
        }
      });
      render(); return;
    }
    if (d.anim) {
      run('Caption animation', (doc) => { for (const c of captionClips(doc)) { if (d.anim === 'none') delete c.text.wordAnim; else c.text.wordAnim = d.anim; } });
      render(); return;
    }
    if (d.seek) { const c = captionClips(store.doc).find(x => x.id === d.seek); if (c) { playback.pause(); playback.seek(c.start + 0.001); store.select([c.id]); } return; }
    if (d.nudge) {
      const [id, dir] = d.nudge.split(':');
      run('Nudge caption', (doc) => {
        const { clip, track } = findIn(doc, id);
        if (!clip) return;
        clip.start = Math.max(0, Math.round((clip.start + 0.1 * +dir) * 1000) / 1000);
        track.clips.sort((a, b) => a.start - b.start);
      });
      render(); return;
    }
    if (d.editbtn) { editing = d.editbtn; pop = null; render(); el.querySelector('.cape__edit')?.focus(); return; }
    if (d.merge) {
      const ok = run('Join caption lines', (doc) => { const { clip, track } = findIn(doc, d.merge); return clip ? mergeWithNext(track, clip) : false; });
      if (!ok) say('That is the last line: there is nothing after it to join.');
      render(); return;
    }
    if (d.del) {
      run('Delete caption', (doc) => { const { track } = findIn(doc, d.del); if (track) track.clips = track.clips.filter(c => c.id !== d.del); });
      render(); return;
    }
    if (d.word) {
      const [id, i] = d.word.split(':');
      pop = pop && pop.id === id && pop.idx === +i ? null : { id, idx: +i };
      editing = null;
      render(); return;
    }
    if (d.popclose != null) { pop = null; render(); return; }
    if (pop) {
      const { id, idx } = pop;
      const style = (patch, label) => run(label, (doc) => { const { clip } = findIn(doc, id); if (clip) styleWord(clip, idx, patch); });
      if (d.wcolor != null) style({ color: d.wcolor || null }, 'Word colour');
      else if (d.wscale) style({ scale: +d.wscale }, 'Word size');
      else if (d.wemoji != null) style({ emoji: d.wemoji || null }, 'Word emoji');
      else if (d.wshake) { const cur = findIn(store.doc, id).clip?.text.wordStyle?.[idx]?.shake; style({ shake: !cur }, 'Word shake'); }
      else if (d.wclear) style({ color: null, scale: null, emoji: null, shake: null }, 'Clear word style');
      else if (d.split) {
        const made = run('Split caption line', (doc) => { const { clip, track } = findIn(doc, id); return clip ? splitLine(track, clip, idx, uid) : null; });
        if (!made) say('That word has no time of its own to split at. Fix its timing first, or split nearer the middle.');
        pop = null;
      }
      render(); return;
    }
    if (b.id === 'capeReplace') {
      const f = el.querySelector('#capeFind').value, r = el.querySelector('#capeRepl').value;
      const n = run(`Replace “${f}”`, (doc) => replaceAll(doc, f, r));
      say(n ? `Changed ${n} line${n === 1 ? '' : 's'}` : `“${f}” is not in any caption`, n ? 'ok' : undefined);
      render();
    }
  });

  el.addEventListener('keydown', (e) => {
    const inp = e.target.closest?.('.cape__edit');
    if (inp) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const id = inp.dataset.edit, v = inp.value;
        editing = null;
        const ok = run('Fix caption', (doc) => { const { clip } = findIn(doc, id); return clip ? setLineText(clip, v) : false; });
        if (!ok) say('A caption needs at least one word. Use ✕ to delete the line.');
        render();
      } else if (e.key === 'Escape') { editing = null; render(); }
      return;
    }
    if (e.target.closest?.('#capeFind, #capeRepl')) {
      e.stopPropagation();
      if (e.key === 'Enter') el.querySelector('#capeReplace')?.click();
      return;
    }
    if (e.key === 'Escape') { e.stopPropagation(); if (pop) { pop = null; render(); } else close(); }
  });

  // Esc closes the word box, then the panel, wherever the focus is (before Esc's other jobs).
  window.addEventListener('keydown', (e) => {
    if (el.hidden || e.key !== 'Escape' || el.contains(e.target)) return;
    const a = document.activeElement;
    if (a && a !== document.body && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if ([...document.querySelectorAll('[aria-modal="true"]')].some(d => d.getClientRects().length)) return;
    e.preventDefault(); e.stopPropagation();
    if (pop) { pop = null; render(); } else close();
  }, true);

  store.on?.('doc', () => { if (!editing && !el.querySelector('#capeFind:focus, #capeRepl:focus')) render(); });
  store.on?.('history', () => { if (!editing) render(); });
  store.on?.('playhead', () => paintLive());

  bus.on('captions:editor', open);
  bus.emit('palette:add', [{ id: 'cap-editor', name: 'Edit captions: fix words, style words, split and join lines', sec: 'Text', key: 'Shift+C', run: toggle }]);

  return { open, close, toggle, get isOpen() { return !el.hidden; } };
}
