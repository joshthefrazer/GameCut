/**
 * Caption files: save captions as .srt / .vtt, and bring in an .srt / .vtt you already have.
 *
 * Saving uses the lines on the Captions lane (or, with no Captions lane, every
 * title on the text lanes), in time order. Bringing a file in lays it down on
 * the Captions lane in the look you pick, the same as Auto-captions does, with
 * each word given a share of its line's time (by length) so the word-by-word
 * highlight still moves along.
 */
import { bus } from '../core/events.js';
import { addCaptions, CAPTION_LOOKS } from './captions.js';

/* ── Reading ─────────────────────────────────────────────────── */

/** "00:01:02,345" / "01:02.345" / "1:02:03.4" → seconds, or NaN. */
export function parseStamp(s) {
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const ms = m[4] ? +m[4].padEnd(3, '0') : 0;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + ms / 1000;
}

/** Both SubRip (.srt) and WebVTT (.vtt): [{ start, end, text }] in time order. */
export function parseCaptions(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n{2,}/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').map(l => l.trimEnd()).filter(l => l.length);
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, rest] = lines[i].split('-->');
    const start = parseStamp(a);
    const end = parseStamp(String(rest).trim().split(/\s+/)[0]);   // VTT may add position settings after the time
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const words = lines.slice(i + 1).join(' ')
      .replace(/<[^>]+>/g, '')            // <i>, <b>, <c.colour>, VTT voice tags
      .replace(/\{[^}]*\}/g, '')          // SSA-style override tags some .srt files carry
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
    if (words) out.push({ start, end, text: words });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** A file line → a caption line with a time for every word (shared out by word length). */
export function lineWithWords(c) {
  const words = c.text.split(' ').filter(Boolean);
  const total = words.reduce((n, w) => n + w.length + 1, 0) || 1;
  let t = c.start;
  const span = c.end - c.start;
  return {
    start: c.start, end: c.end,
    words: words.map((w) => {
      const d = span * (w.length + 1) / total;
      const o = { text: w, s: t, e: t + d };
      t += d;
      return o;
    }),
  };
}

/* ── Writing ─────────────────────────────────────────────────── */

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
function stamp(t, sep) {
  const s = Math.max(0, t);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const whole = Math.floor(s) + (ms === 1000 ? 1 : 0);
  return `${pad(whole / 3600)}:${pad((whole % 3600) / 60)}:${pad(whole % 60)}${sep}${pad(ms === 1000 ? 0 : ms, 3)}`;
}
export function toSRT(lines) {
  return lines.map((l, i) => `${i + 1}\n${stamp(l.start, ',')} --> ${stamp(l.end, ',')}\n${l.text}\n`).join('\n');
}
export function toVTT(lines) {
  return 'WEBVTT\n\n' + lines.map(l => `${stamp(l.start, '.')} --> ${stamp(l.end, '.')}\n${l.text}\n`).join('\n');
}

/** What would be saved: the Captions lane, or failing that every title, in time order. */
export function captionLines(doc) {
  const cap = doc.tracks.find(t => t.kind === 'text' && t.name === 'Captions' && !t.hidden);
  const tracks = cap ? [cap] : doc.tracks.filter(t => t.kind === 'text' && !t.hidden);
  const lines = [];
  for (const t of tracks) {
    for (const c of t.clips) {
      if (c.type !== 'text') continue;
      const text = String(c.text?.text || '').replace(/\s*\n\s*/g, ' ').trim();
      if (text) lines.push({ start: c.start, end: c.start + c.duration, text });
    }
  }
  return lines.sort((a, b) => a.start - b.start);
}

/* ── The two actions ──────────────────────────────────────────── */

export function initCaptionFiles({ store, cmds, history }) {
  const say = (msg, kind) => bus.emit('toast', { msg, kind, key: 'capfile', ms: 4200 });

  async function saveCaptions(kind = 'srt') {
    const lines = captionLines(store.doc);
    if (!lines.length) { say('There are no captions or titles to save. Make some with Auto-captions first.'); return false; }
    const api = window.gamecut;
    if (!api?.saveAs || !api?.writeFile) { say('Saving caption files needs the desktop app.', 'err'); return false; }
    const base = (store.doc.name || 'Captions').replace(/[^\w\- ]+/g, '').trim() || 'Captions';
    const path = await api.saveAs({
      title: 'Save captions', defaultPath: `${base}.${kind}`,
      filters: kind === 'vtt' ? [{ name: 'WebVTT captions', extensions: ['vtt'] }] : [{ name: 'SubRip captions', extensions: ['srt'] }],
    });
    if (!path) return false;
    const text = kind === 'vtt' ? toVTT(lines) : toSRT(lines);
    try {
      await api.writeFile(path, new TextEncoder().encode(text));
    } catch (e) {
      say(`Could not save the captions: ${e?.message || e}`, 'err');
      return false;
    }
    say(`Saved ${lines.length} caption line${lines.length === 1 ? '' : 's'} to ${String(path).split(/[\\/]/).pop()}`, 'ok');
    return true;
  }

  let picker = null;
  function importCaptions({ look = 'clean' } = {}) {
    if (!picker) {
      picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.srt,.vtt,text/vtt';
      picker.hidden = true;
      picker.id = 'captionFilePicker';
      document.body.appendChild(picker);
      picker.addEventListener('change', async () => {
        const f = picker.files?.[0];
        picker.value = '';
        if (!f) return;
        await importText(await f.text(), { look: picker.dataset.look || 'clean', name: f.name });
      });
    }
    picker.dataset.look = look;
    picker.click();
  }

  /** Lay a caption file's text down on the Captions lane. */
  async function importText(text, { look = 'clean', name = 'the file' } = {}) {
    const parsed = parseCaptions(text);
    if (!parsed.length) { say(`No captions found in ${name}. Strike reads .srt and .vtt files.`, 'err'); return 0; }
    const lines = parsed.map(lineWithWords);
    const n = addCaptions({ store, cmds, history }, lines, {
      look: CAPTION_LOOKS.some(l => l.id === look) ? look : 'clean',
      from: lines[0].start, to: lines[lines.length - 1].end, keywords: false, safe: true,
    });
    store.recompute?.();
    bus.emit('toast', {
      msg: `Added ${n} caption${n === 1 ? '' : 's'} from ${name} on the Captions lane`, kind: 'ok', key: 'capfile', ms: 5200,
      action: { label: 'Undo', run: () => history.undo() },
    });
    return n;
  }

  // The buttons in the Auto-captions box.
  bus.on('captions:file', ({ action, look } = {}) => {
    if (action === 'import') importCaptions({ look });
    else saveCaptions('srt');
  });

  bus.emit('palette:add', [
    { id: 'cap-save-srt', name: 'Save captions as a subtitle file (.srt)', sec: 'Text', run: () => saveCaptions('srt') },
    { id: 'cap-save-vtt', name: 'Save captions as a web subtitle file (.vtt)', sec: 'Text', run: () => saveCaptions('vtt') },
    { id: 'cap-import', name: 'Bring in captions from a subtitle file (.srt / .vtt)', sec: 'Text', run: () => importCaptions() },
  ]);

  return { saveCaptions, importCaptions, importText };
}
