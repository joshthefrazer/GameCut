import { bus } from '../core/events.js';
import { assets } from '../media/asset-store.js';
import { findHighlights, detectBeat, assetHighlights } from './analysis.js';
import { makeClip, uid } from '../core/schema.js';
import { snapFrame } from '../core/time.js';

/**
 * Edits that start from listening: highlight markers, the beat of the song,
 * cutting to it, and a first-cut highlight reel. Each is one undo step.
 */
export function initSmartEdit({ store, cmds, history, playback }) {
  const q = (t) => snapFrame(Math.max(0, t), store.doc.fps);
  const mainTrack = (doc = store.doc) => [...doc.tracks].reverse().find(t => t.kind === 'video');

  function markHighlights() {
    const found = findHighlights(store);
    if (!found.length) {
      bus.emit('toast', { msg: 'No loud moments found — is there game sound on the timeline?', kind: 'err' });
      return [];
    }
    let added = 0;
    history.run('Find highlights', (doc) => {
      for (const h of found) {
        if (doc.markers.some(m => Math.abs(m.t - h.t) < 0.5)) continue;
        doc.markers.push({ id: uid('mk'), t: q(h.t), label: 'Highlight', color: '#f43f5e', auto: true });
        added++;
      }
      doc.markers.sort((a, b) => a.t - b.t);
    });
    bus.emit('toast', { msg: `Marked ${added} loud moment${added === 1 ? '' : 's'} in red — [ and ] jump between them`, kind: 'ok', ms: 5200, action: { label: 'Undo', run: () => history.undo() } });
    return found;
  }

  /** The song: the selected sound clip, else the first clip on a sound lane. */
  function songClip() {
    const sel = store.selectedClips.find(x => x.clip.type === 'audio');
    if (sel) return sel.clip;
    for (const t of store.doc.tracks) if (t.kind === 'audio') for (const c of t.clips) if (c.type === 'audio') return c;
    return null;
  }

  function beatFromSong() {
    const c = songClip();
    if (!c) { bus.emit('toast', { msg: 'Add a song to a sound lane first.' }); return null; }
    const a = assets.get(c.assetId);
    const sp = c.speed || 1;
    const r = detectBeat(a, c.inPoint, c.duration * sp);
    if (!r) { bus.emit('toast', { msg: 'Could not find a steady beat in that song.', kind: 'err' }); return null; }
    const bpm = Math.round(r.bpm * sp * 2) / 2;
    const period = 60 / bpm;
    let off = c.start + (r.offset - c.inPoint) / sp;
    off = ((off % period) + period) % period;
    history.run('Beat from song', (doc) => { doc.bpm = bpm; doc.beatOffset = +off.toFixed(4); });
    if (!store.ui.beatGrid) document.getElementById('btnBeatGrid')?.click();
    bus.emit('toast', { msg: `${bpm} BPM — the beat grid is on, and cuts now snap to the beat`, kind: 'ok', ms: 4200 });
    return { bpm, offset: off };
  }

  /**
   * Cut the main lane to the beat. `every` = a fixed number of beats per shot
   * (a montage), or null to round each shot to its nearest whole beat.
   */
  function cutToBeat(every = null) {
    const main = mainTrack();
    if (!main?.clips.length) { bus.emit('toast', { msg: 'Put your clips on the main lane first.' }); return 0; }
    const beat = 60 / store.doc.bpm;
    const off = store.doc.beatOffset || 0;
    let changed = 0;
    bus.emit('checkpoint', 'Before cutting to the beat');
    history.run(every ? `Cut every ${every} beats` : 'Cut to the beat', (doc) => {
      const tr = doc.tracks.find(t => t.id === main.id);
      const list = [...tr.clips].filter(c => !c.locked).sort((a, b) => a.start - b.start);
      let t = list[0].start;
      // Start on a beat.
      t = off + Math.ceil((t - off - 1e-6) / beat) * beat;
      for (const c of list) {
        const sp = c.speed || 1;
        const room = Number.isFinite(c.sourceDuration) ? (c.sourceDuration - c.inPoint) / sp : Infinity;
        let n = every || Math.max(1, Math.round(c.duration / beat));
        while (n > 1 && n * beat > room + 1e-6) n--;
        const d = Math.min(room, n * beat);
        if (Math.abs(c.start - t) > 1e-6 || Math.abs(c.duration - d) > 1e-6) changed++;
        c.start = q(t); c.duration = Math.max(1 / doc.fps, q(d));
        t = c.start + c.duration;
      }
      tr.clips.sort((a, b) => a.start - b.start);
    });
    if (!store.ui.beatGrid) document.getElementById('btnBeatGrid')?.click();
    bus.emit('toast', { msg: `Cut ${changed} shot${changed === 1 ? '' : 's'} to the beat (${store.doc.bpm} BPM)`, kind: 'ok', action: { label: 'Undo', run: () => history.undo() } });
    return changed;
  }

  /**
   * A first cut from a pile of recordings: the loudest moments of each,
   * a few seconds either side, laid end to end on the main lane after
   * whatever is already there — loudest file first, moments in order.
   */
  function highlightReel(assetIds = null, { perFile = 3, before = 3, after = 2 } = {}) {
    const pool = (assetIds ? assetIds.map(id => assets.get(id)) : assets.all()).filter(a => a?.kind === 'video');
    const picks = [];
    for (const a of pool) {
      // Windows around moments close together are joined, not repeated.
      const wins = assetHighlights(a, { max: perFile })
        .map(h => ({ s: Math.max(0, h.t - before), e: Math.min(a.duration || h.t + after, h.t + after), score: h.score, t: h.t }))
        .sort((x, y) => x.s - y.s);
      const joined = [];
      for (const w of wins) {
        const last = joined.at(-1);
        if (last && w.s <= last.e + 0.25) { last.e = Math.max(last.e, w.e); last.score = Math.max(last.score, w.score); last.hits.push(w.t); }
        else joined.push({ ...w, hits: [w.t] });
      }
      for (const w of joined) if (w.e - w.s > 0.5) picks.push({ a, ...w });
    }
    if (!picks.length) { bus.emit('toast', { msg: 'No loud moments found in those recordings.', kind: 'err' }); return []; }
    const byFile = new Map();
    for (const p of picks) { if (!byFile.has(p.a.id)) byFile.set(p.a.id, []); byFile.get(p.a.id).push(p); }
    const order = [...byFile.values()].sort((x, y) => Math.max(...y.map(p => p.score)) - Math.max(...x.map(p => p.score)));
    const made = [];
    bus.emit('checkpoint', 'Before the highlight reel');
    history.run('Highlight reel', (doc) => {
      const tr = mainTrack(doc);
      let t = tr.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      for (const list of order) {
        for (const p of list.sort((x, y) => x.s - y.s)) {
          const c = makeClip('video', {
            name: `${p.a.name.replace(/\.[^.]+$/, '')} · ${Math.floor(p.t / 60)}:${String(Math.floor(p.t % 60)).padStart(2, '0')}`,
            assetId: p.a.id, start: q(t), duration: q(p.e - p.s), inPoint: p.s,
            sourceDuration: p.a.duration || Infinity, trackId: tr.id,
          });
          tr.clips.push(c);
          made.push(c.id);
          t = c.start + c.duration;
          for (const h of p.hits) doc.markers.push({ id: uid('mk'), t: q(c.start + (h - p.s)), label: 'Highlight', color: '#f43f5e', auto: true });
        }
      }
      tr.clips.sort((a, b) => a.start - b.start);
      doc.markers.sort((a, b) => a.t - b.t);
    });
    store.select(made);
    bus.emit('timeline:reveal', { trackId: mainTrack().id, start: 0, duration: store.rt.duration });
    bus.emit('toast', { msg: `Built a ${made.length}-shot highlight reel from ${order.length} recording${order.length === 1 ? '' : 's'} — the hits are marked in red`, kind: 'ok', ms: 5200, action: { label: 'Undo', run: () => history.undo() } });
    return made;
  }

  /** [ and ]: previous / next marker. */
  function jumpMarker(dir) {
    const t = store.rt.playhead;
    const ms = store.doc.markers.map(m => m.t).sort((a, b) => a - b);
    const next = dir > 0 ? ms.find(m => m > t + 1e-3) : [...ms].reverse().find(m => m < t - 1e-3);
    if (next == null) return false;
    playback.pause(); playback.seek(next);
    return true;
  }

  bus.emit('palette:add', [
    { id: 'highlights', name: 'Find my highlights (mark the loud moments)', sec: 'Smart', run: markHighlights },
    { id: 'reel', name: 'Build a highlight reel from my recordings', sec: 'Smart', run: () => highlightReel() },
    { id: 'beatsong', name: 'Find the beat of the song', sec: 'Smart', run: beatFromSong },
    { id: 'cutbeat', name: 'Cut the main lane to the beat', sec: 'Smart', run: () => cutToBeat(null) },
    { id: 'cutbeat2', name: 'Montage: a new shot every 2 beats', sec: 'Smart', run: () => cutToBeat(2) },
    { id: 'cutbeat4', name: 'Montage: a new shot every 4 beats', sec: 'Smart', run: () => cutToBeat(4) },
    { id: 'mknext', name: 'Next marker', key: ']', sec: 'Playback', run: () => jumpMarker(1) },
    { id: 'mkprev', name: 'Previous marker', key: '[', sec: 'Playback', run: () => jumpMarker(-1) },
  ]);

  document.getElementById('btnHighlights')?.addEventListener('click', markHighlights);
  document.getElementById('btnReel')?.addEventListener('click', () => highlightReel());
  document.getElementById('btnBeatSong')?.addEventListener('click', beatFromSong);
  document.getElementById('btnCutBeat')?.addEventListener('click', () => cutToBeat(null));

  return { markHighlights, beatFromSong, cutToBeat, highlightReel, jumpMarker };
}
