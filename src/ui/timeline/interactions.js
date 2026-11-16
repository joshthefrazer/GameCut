import { snapCandidates, snapClipEdges, resolveSnap } from './snapping.js';
import { zoomAt } from './zoom.js';
import { clamp, snapFrame } from '../../core/time.js';
import { trackAccepts } from '../../core/schema.js';
import { assets } from '../../media/asset-store.js';
import { bus } from '../../core/events.js';
import { placeAsset as place } from './place-asset.js';
import { initContextMenu } from './context-menu.js';
import { junctionAt } from './junction-badge.js';
import { animById } from '../../anim/defs.js';
import { clashes, settle, closeHoles } from '../../core/links.js';

/** How far inside a clip its trim handle reaches, in pixels. */
const EDGE_PX = 9;
/** How far OUTSIDE a narrow clip its handles still answer — so tiny clips can be trimmed. */
const OUTER_PX = 6;
/** Fade dots: grab radius, and how far in from the corner they sit at zero. */
const FADE_PX = 6;
const FADE_INSET = 12;
/** Grab distance for the playhead line itself. */
const HEAD_PX = 4;

export function initTimelineInteractions({ view, store, cmds, history, playback, L, repaint,
                                           deferFollow = () => {}, say = () => {} }) {
  const drop = document.getElementById('tlDrop');
  const local = (e) => {
    const r = view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const fps = () => store.doc.fps;
  const fmt = (s) => (s < 10 ? s.toFixed(2) : s.toFixed(1)) + 's';

  /**
   * What is under the pointer.
   *
   * Trim handles take a third of a clip at most, so the middle of even a short
   * clip still moves it; a clip too narrow to have an inside handle answers on
   * its OUTSIDE edges instead, which is what makes a two-frame clip trimmable
   * at all. The playhead line can be grabbed and dragged from anywhere on it.
   */
  function hit(p) {
    if (p.y < L.RH) return { zone: 'ruler' };
    const j = junctionAt(L, p.x, p.y);
    if (j) return { zone: 'junction', junction: j, row: L.rowFor(j.track.id) };
    const g = L.groupAt?.(p.y);
    if (g) return { zone: 'group', group: g };
    const row = L.rowAt(p.y);
    if (!row) return { zone: 'empty' };
    const pps = store.pxPerSec;
    const clips = row.track.clips;
    // Inside a clip.
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i];
      const x0 = L.t2x(clip.start), x1 = x0 + clip.duration * pps;
      if (p.x < x0 || p.x > x1) continue;
      if (row.track.locked || clip.locked) return { zone: 'locked', clip, row };
      // The fade handles: small dots on the top corners, dragged inwards.
      const fh = fadeHandles(clip, row, x0, x1);
      if (fh) {
        for (const [which, hx, hy] of fh) {
          if (Math.abs(p.x - hx) <= FADE_PX && Math.abs(p.y - hy) <= FADE_PX) return { zone: which, clip, row };
        }
      }
      const edge = Math.min(EDGE_PX, (x1 - x0) / 3);
      if (edge >= 3 && p.x <= x0 + edge) return { zone: 'in', clip, row };
      if (edge >= 3 && p.x >= x1 - edge) return { zone: 'out', clip, row };
      return { zone: 'body', clip, row };
    }
    // Just outside a clip's edge.
    let best = null, bestD = OUTER_PX + 1;
    for (const clip of clips) {
      if (row.track.locked || clip.locked) continue;
      const x0 = L.t2x(clip.start), x1 = x0 + clip.duration * pps;
      if (p.x < x0 && x0 - p.x < bestD) { best = { zone: 'in', clip, row }; bestD = x0 - p.x; }
      if (p.x > x1 && p.x - x1 < bestD) { best = { zone: 'out', clip, row }; bestD = p.x - x1; }
    }
    if (best) return best;
    if (Math.abs(p.x - L.t2x(store.rt.playhead)) <= HEAD_PX) return { zone: 'head', row };
    return { zone: 'lane', row };
  }

  /** Where a clip's two fade dots are, or null for clips too small to have them. */
  function fadeHandles(clip, row, x0, x1) {
    if (clip.type === 'effect' || x1 - x0 < 46 || row.h < 26) return null;
    const pps = store.pxPerSec;
    const hy = row.y + Math.min(15, row.h * .34);
    const fi = Math.min((x1 - x0) / 2 - 4, Math.max(FADE_INSET, (clip.fadeIn || 0) * pps));
    const fo = Math.min((x1 - x0) / 2 - 4, Math.max(FADE_INSET, (clip.fadeOut || 0) * pps));
    return [['fadeIn', x0 + fi, hy], ['fadeOut', x1 - fo, hy]];
  }
  view.fadeHandles = (clip) => {
    const row = L.rowFor(clip.trackId) || L.rows.find(r => r.track.clips.includes(clip));
    if (!row) return null;
    const x0 = L.t2x(clip.start);
    return fadeHandles(clip, row, x0, x0 + clip.duration * store.pxPerSec);
  };

  /* ── Hover info: name, length, speed ───────────────────────── */
  let tip = null, tipTimer = 0, tipFor = null;
  function showTip(clip, e) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tl-tip';
      tip.id = 'tlTip';
      document.body.appendChild(tip);
    }
    const bits = [shortLen(clip.duration)];
    if ((clip.speed || 1) !== 1) bits.push(`${+(clip.speed).toFixed(2)}× speed`);
    if (clip.fadeIn > 0) bits.push(`fades in ${shortLen(clip.fadeIn)}`);
    if (clip.fadeOut > 0) bits.push(`fades out ${shortLen(clip.fadeOut)}`);
    if (clip.muted) bits.push('muted');
    const name = clip.type === 'text' ? (clip.text?.text || clip.name || 'Text').split('\n')[0] : (clip.name || clip.type);
    tip.innerHTML = '<b></b><span></span>';
    tip.firstChild.textContent = name.length > 48 ? name.slice(0, 47) + '…' : name;
    tip.lastChild.textContent = `${fmt(clip.start)} · ${bits.join(' · ')}`;
    tip.style.left = Math.min(window.innerWidth - 260, e.clientX + 14) + 'px';
    tip.style.top = (e.clientY - 46) + 'px';
    tip.hidden = false;
  }
  const hideTip = () => { clearTimeout(tipTimer); tipFor = null; if (tip) tip.hidden = true; };
  const shortLen = (t) => (t < 60 ? `${t < 10 ? t.toFixed(1) : Math.round(t)}s` : `${Math.floor(t / 60)}m ${Math.round(t % 60)}s`);

  /* ── Hover: cursor, handles, razor line ───────────────────── */
  view.addEventListener('pointermove', (e) => {
    if (store.rt.dragging) return;
    const p = local(e);
    const h = hit(p);
    const tool = store.ui.tool || 'select';
    let cursor = '';
    if (h.zone === 'ruler' || h.zone === 'head') cursor = 'scrub';
    else if (h.zone === 'junction') cursor = 'pick';
    else if (tool === 'hand') cursor = 'hand';
    else if (tool === 'razor') cursor = h.clip ? 'razor' : '';
    else if (h.zone === 'in' || h.zone === 'out') cursor = 'trim';
    else if (h.zone === 'fadeIn' || h.zone === 'fadeOut') cursor = 'trim';
    else if (h.zone === 'body') cursor = 'move';
    view.dataset.cursor = cursor;

    if (h.zone === 'body' && tool === 'select') {
      if (tipFor !== h.clip.id) {
        hideTip();
        tipFor = h.clip.id;
        const clip = h.clip, ev = { clientX: e.clientX, clientY: e.clientY };
        tipTimer = setTimeout(() => { if (tipFor === clip.id && !store.rt.dragging) showTip(clip, ev); }, 550);
      } else if (tip && !tip.hidden) {
        tip.style.left = Math.min(window.innerWidth - 260, e.clientX + 14) + 'px';
        tip.style.top = (e.clientY - 46) + 'px';
      }
    } else hideTip();

    const hover = h.clip && h.zone !== 'locked' ? h.clip.id : null;
    let dirty = hover !== store.rt.hoverClip;
    store.rt.hoverClip = hover;

    if (tool === 'razor') {
      const was = store.rt.razorAt;
      if (h.clip && h.zone !== 'locked') {
        const t = razorTime(p.x);
        store.rt.razorAt = { t, all: e.shiftKey, y0: h.row.y + 2, y1: h.row.y + h.row.h - 2 };
      } else store.rt.razorAt = null;
      dirty ||= was?.t !== store.rt.razorAt?.t || was?.all !== store.rt.razorAt?.all;
    }
    if (dirty) repaint();
  });
  view.addEventListener('pointerleave', () => {
    hideTip();
    if (store.rt.hoverClip || store.rt.razorAt) { store.rt.hoverClip = null; store.rt.razorAt = null; repaint(); }
  });

  /** Where the razor cuts: the pointer, pulled onto the playhead, a marker or an edge when close. */
  function razorTime(x) {
    const cands = snapCandidates(store, { includeBeats: store.ui.beatGrid });
    const s = resolveSnap(store, Math.max(0, L.x2t(x)), cands, 8);
    return snapFrame(s.t, fps());
  }

  /* ── Pointer down ─────────────────────────────────────────── */
  view.addEventListener('pointerdown', (e) => {
    deferFollow(1600);
    if (e.button === 1) return startPan(e);
    if (e.button !== 0) return;
    const p = local(e);
    const h = hit(p);
    hideTip();
    view.setPointerCapture?.(e.pointerId);
    const tool = store.ui.tool || 'select';
    if ((h.zone === 'fadeIn' || h.zone === 'fadeOut') && tool === 'select') return startFade(e, h);

    if (h.zone === 'ruler' || h.zone === 'head') return startScrub(e);
    if (h.zone === 'group') return;
    if (tool === 'hand') return startPan(e);
    if (h.zone === 'junction') return pickJunction(e, h);
    if (tool === 'razor') {
      if (h.clip && h.zone !== 'locked') return razorCut(h.clip, p.x, e.shiftKey);
      if (h.zone === 'locked') say('That lane is locked — unlock it to cut there.', 2400);
      return;
    }
    if (h.zone === 'body')  return startMove(e, h, p);
    if (h.zone === 'in' || h.zone === 'out') return startTrim(e, h);
    if (h.zone === 'locked') { say('Locked — unlock the lane (or the clip) to change it.', 2400); }
    if (h.row) store.setRT({ activeTrack: h.row.track.id });
    if (!e.shiftKey) store.select([]);
    startMarquee(e, p);
  });

  view.addEventListener('dblclick', (e) => {
    const h = hit(local(e));
    if (h.zone === 'junction') return;
    if (h.zone === 'body') { playback.pause(); playback.seek(h.clip.start); }
  });

  function razorCut(clip, x, all) {
    const t = razorTime(x);
    if (!(t > clip.start + 1e-4 && t < clip.start + clip.duration - 1e-4)) {
      say('Too close to the edge of the clip to cut there.', 2400);
      return;
    }
    const made = cmds.splitAt(t, all ? [] : [clip.id]);
    if (made?.length) say(all ? `Cut every lane at ${fmt(t)}` : `Cut at ${fmt(t)} — one undo puts it back`, 3000);
    store.rt.razorAt = null;
    repaint();
  }

  function pickJunction(e, h) {
    const j = h.junction;
    store.setRT({ junction: j.next.id, activeTrack: j.track.id });
    store.select([j.next.id]);
    playback.pause();
    playback.seek(j.t);
    bus.emit('transitions:open', { clipId: j.next.id });
    repaint();
  }

  /* ── Right-click ──────────────────────────────────────────── */
  const ctx = initContextMenu({ store, cmds, playback });
  view.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = local(e);
    const h = hit(p);
    const t = Math.max(0, L.x2t(p.x));
    if (h.zone === 'ruler') ctx.forRuler(t, e.clientX, e.clientY);
    else if (h.zone === 'junction') {
      store.setRT({ junction: h.junction.next.id });
      repaint();
      ctx.forJunction(h.junction, e.clientX, e.clientY);
    }
    else if (h.clip) ctx.forClip(h.clip, h.row.track, e.clientX, e.clientY);
    else ctx.forLane(h.row?.track || null, t, e.clientX, e.clientY);
  });

  function seekToX(x) {
    const cands = snapCandidates(store, { includeBeats: store.ui.beatGrid });
    const raw = Math.max(0, L.x2t(x));
    const s = resolveSnap(store, raw, cands.filter(c => c.kind !== 'playhead'), 6);
    playback.seek(s.t);
  }

  /* ── Scrub ────────────────────────────────────────────────── */
  function startScrub(e) {
    const was = store.rt.playing;
    if (was) playback.pause();
    store.rt.dragging = { kind: 'scrub' };
    view.dataset.cursor = 'scrub';
    const move = (ev) => {
      const p = local(ev);
      seekToX(p.x);
      autoScroll(p.x);
    };
    move(e);
    const up = () => {
      store.rt.dragging = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (was) playback.play();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  let cancelDrag = null;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cancelDrag) { e.preventDefault(); e.stopPropagation(); cancelDrag(); }
  }, true);

  /* ── Move clips ───────────────────────────────────────────────
   *
   * A clip may never end up hidden under another one on its lane. When a
   * drag would put it there:
   *   Ripple on  — it slots in BEFORE or AFTER that clip (whichever half you
   *                are over), the rest of the lane makes room, and the hole it
   *                left behind closes. Reordering shots is just dragging.
   *   Ripple off — it goes on a new layer above when you let go, and is
   *                tinted "↑ new layer" while you drag so that is no surprise.
   * Alt while dragging drops it exactly where it is, on a new layer if need be.
   */
  function startMove(e, h, p0) {
    const clip = h.clip;
    if (!store.rt.selection.includes(clip.id)) store.select([clip.id], e.shiftKey);
    else if (e.shiftKey) {
      store.toggleSelect(clip.id);
      if (!store.rt.selection.includes(clip.id)) { repaint(); return; }
    }

    const selected = store.selectedClips.filter(({ clip: c, track }) => !c.locked && !track.locked);
    const selIds = new Set(selected.map(x => x.clip.id));
    // A linked copy whose footage is also being dragged just follows it.
    const picks = selected
      .filter(({ clip: c }) => !(c.linkTo && selIds.has(c.linkTo)) && !(c.badgeFor && selIds.has(c.badgeFor)))
      .map(({ clip: c, track }) => ({
        id: c.id, start0: c.start, trackId: track.id, duration: c.duration, type: c.type,
        alone: !!(c.linkTo && !selIds.has(c.linkTo)),
      }));
    const anchor = picks.find(x => x.id === clip.id) || picks[0];
    if (!anchor) return;
    const rowIndex0 = L.rows.findIndex(r => r.track.id === anchor.trackId);
    const grabOffset = L.x2t(p0.x) - clip.start;
    const earliest = Math.min(...picks.map(x => x.start0));
    let moved = false;
    let gesture = null;
    let last = { mode: 'free', conflicts: [] };

    const move = (ev) => {
      const p = local(ev);
      if (!moved && Math.abs(p.x - p0.x) < 3 && Math.abs(p.y - p0.y) < 3) return;
      moved = true;
      gesture ||= history.gesture(picks.length > 1 ? `Move ${picks.length} clips` : 'Move clip');
      // Every step starts from how things were when the drag began, so making
      // room for the clip at one spot never leaves the lane shoved about at
      // the next.
      gesture.restore();

      const rawStart = Math.max(0, L.x2t(p.x) - grabOffset);
      const cands = snapCandidates(store, { excludeIds: [...selIds] });
      const snapped = ev.altKey
        ? { start: rawStart, line: null, kind: null }
        : snapClipEdges(store, rawStart, anchor.duration, cands);
      const delta = Math.max(snapFrame(snapped.start - anchor.start0, fps()), -earliest);
      store.rt.snapLine = snapped.line;
      store.rt.snapKind = snapped.kind;

      const row = L.rowAt(p.y);
      const rowIndex = row ? L.rows.indexOf(row) : rowIndex0;
      const rowDelta = ev.shiftKey ? 0 : rowIndex - rowIndex0;

      history.begin('Move clip');
      const doc = store.doc;
      for (const pick of picks) {
        const src = L.rows.findIndex(r => r.track.id === pick.trackId);
        const dstRow = L.rows[clamp(src + rowDelta, 0, L.rows.length - 1)];
        const dst = dstRow && doc.tracks.find(t => t.id === dstRow.track.id);
        const dstId = dst && trackAccepts(dst.kind, pick.type) && !dst.locked ? dst.id : pick.trackId;
        applyMove(pick.id, Math.max(0, pick.start0 + delta), dstId, pick.alone);
      }

      // Would anything now sit on top of something else?
      const conflicts = [];
      const lanes = new Set();
      for (const pick of picks) {
        const at = locate(pick.id);
        if (!at) continue;
        lanes.add(at.track.id);
        if (clashes(at.track, at.clip.start, at.clip.start + at.clip.duration, selIds)) conflicts.push(pick.id);
      }
      let mode = 'free', ins = null;
      if (conflicts.length) {
        mode = store.ui.ripple && lanes.size === 1 && !ev.altKey ? 'insert' : 'layer';
        if (mode === 'insert') ins = insertBlock([...lanes][0], L.x2t(p.x), picks);
        if (mode === 'insert' && !ins) mode = 'layer';
      }
      history.commit();

      last = { mode, conflicts: mode === 'layer' ? conflicts : [] };
      store.rt.dragging = {
        kind: 'move', mode,
        conflicts: last.conflicts,
        insertAt: ins?.at ?? null, insertTrack: ins?.trackId ?? null,
      };
      if (mode === 'insert') {
        store.rt.snapLine = null;
        say(ins.before ? `Slots in before “${ins.name}” — the rest moves along` : `Slots in after “${ins.name}” — the rest moves along`);
      } else if (mode === 'layer') {
        say('Let go and it goes on a new layer above, so nothing is covered');
      } else {
        const a = locate(anchor.id)?.clip;
        say(a ? `Starts at ${fmt(a.start)}` : '');
      }
      autoScroll(p.x);
      repaint();
    };

    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cancelDrag = null;
      store.rt.dragging = null;
      store.rt.snapLine = null;
      store.rt.snapKind = null;
      view.dataset.cursor = '';
      say('');
      repaint();
    };
    const up = () => {
      if (!moved) seekToX(p0.x);
      if (moved && last.mode === 'layer') {
        history.begin('Move clip');
        settle(store.doc, last.conflicts);
        history.commit();
      }
      store.rt.dragging = null;
      gesture?.end();
      finish();
    };
    cancelDrag = () => { gesture?.cancel(); finish(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function locate(id) {
    for (const t of store.doc.tracks) {
      const c = t.clips.find(x => x.id === id);
      if (c) return { clip: c, track: t };
    }
    return null;
  }

  /**
   * Slot the dragged clips (already on `trackId`) in beside the clip under
   * the pointer, pushing the rest of the lane along. Returns where, or null
   * when there is nothing sensible to slot next to.
   */
  function insertBlock(trackId, pointerT, picks) {
    const doc = store.doc;
    const track = doc.tracks.find(t => t.id === trackId);
    if (!track) return null;
    const sel = new Set(store.rt.selection);
    const block = track.clips.filter(c => sel.has(c.id));
    const others = track.clips.filter(c => !sel.has(c.id));
    if (!block.length || !others.length) return null;
    const bs = Math.min(...block.map(c => c.start));
    const be = Math.max(...block.map(c => c.start + c.duration));

    let target = others.find(o => pointerT >= o.start && pointerT < o.start + o.duration);
    let before;
    if (target) before = pointerT < target.start + target.duration / 2;
    else {
      let bestOv = 0;
      for (const o of others) {
        const ov = Math.min(be, o.start + o.duration) - Math.max(bs, o.start);
        if (ov > bestOv) { bestOv = ov; target = o; }
      }
      if (!target) return null;
      before = (bs + be) / 2 < target.start + target.duration / 2;
    }
    if (target.locked) return null;

    // The hole the block left on this lane closes first (Ripple is on).
    const q = (t) => snapFrame(Math.max(0, t), fps());
    const fromHere = picks.filter(p => p.trackId === trackId).map(p => ({ start: p.start0, duration: p.duration }));
    if (fromHere.length) closeHoles(others, fromHere, q);

    const at = before ? target.start : target.start + target.duration;
    const len = be - bs;
    for (const o of others) if (!o.locked && o.start >= at - 1e-6) o.start = q(o.start + len);
    for (const b of block) b.start = q(b.start + (at - bs));
    track.clips.sort((a, b) => a.start - b.start);
    return { at, trackId, before, name: target.name || 'that clip' };
  }

  /** In-place move used inside an already-open history transaction. */
  function applyMove(clipId, start, trackId, unlink = false) {
    const doc = store.doc;
    let found = null, from = null;
    for (const t of doc.tracks) {
      const c = t.clips.find(c => c.id === clipId);
      if (c) { found = c; from = t; break; }
    }
    if (!found || found.locked || from.locked) return;
    // Dragging a crop or a clip's sound on its own frees it from the footage.
    if (unlink) delete found.linkTo;
    found.start = snapFrame(start, doc.fps);
    if (trackId !== from.id) {
      const to = doc.tracks.find(t => t.id === trackId);
      if (to && !to.locked) {
        from.clips.splice(from.clips.indexOf(found), 1);
        found.trackId = to.id;
        to.clips.push(found);
      }
    }
    for (const t of doc.tracks) t.clips.sort((a, b) => a.start - b.start);
  }

  /* ── Trim ─────────────────────────────────────────────────── */
  function startTrim(e, h) {
    const clip = h.clip;
    store.select([clip.id]);
    view.dataset.cursor = 'trim';
    const edge = h.zone;
    const gesture = history.gesture('Trim clip');

    const move = (ev) => {
      const p = local(ev);
      store.rt.dragging = { kind: 'trim' };
      gesture.restore();
      const cands = snapCandidates(store, { excludeIds: [clip.id] });
      const raw = L.x2t(p.x);
      const s = ev.altKey ? { t: raw, snapped: false, kind: null } : resolveSnap(store, raw, cands);
      store.rt.snapLine = s.snapped ? s.t : null;
      store.rt.snapKind = s.kind;
      cmds.trimClip(clip.id, edge === 'in' ? 'in' : 'out', s.t);
      const now = locate(clip.id)?.clip;
      if (now) say(`${edge === 'in' ? 'Starts' : 'Ends'} at ${fmt(edge === 'in' ? now.start : now.start + now.duration)} · ${fmt(now.duration)} long`);
      autoScroll(p.x);
      repaint();
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cancelDrag = null;
      store.rt.dragging = null;
      store.rt.snapLine = null;
      store.rt.snapKind = null;
      view.dataset.cursor = '';
      say('');
      repaint();
    };
    const up = () => { store.rt.dragging = null; gesture.end(); finish(); };
    cancelDrag = () => { gesture.cancel(); finish(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /* ── Fade handles ─────────────────────────────────────────── */
  function startFade(e, h) {
    const clip = h.clip, which = h.zone;
    store.select([clip.id]);
    const gesture = history.gesture(which === 'fadeIn' ? 'Fade in' : 'Fade out');
    const x0 = L.t2x(clip.start);
    const move = (ev) => {
      const p = local(ev);
      store.rt.dragging = { kind: 'fade' };
      gesture.restore();
      const pps = store.pxPerSec;
      const raw = which === 'fadeIn' ? (p.x - x0) / pps : (x0 + clip.duration * pps - p.x) / pps;
      // Snaps to whole tenths of a second; dragged back to the corner it is off.
      let v = Math.max(0, Math.min(clip.duration / 2, Math.round(raw * 10) / 10));
      if (v * pps < FADE_INSET * 0.6) v = 0;
      cmds.setClipProp(clip.id, which, v, { merge: true, label: which === 'fadeIn' ? 'Fade in' : 'Fade out' });
      say(v ? `${which === 'fadeIn' ? 'Fades in' : 'Fades out'} over ${v.toFixed(1)}s — picture and sound` : 'No fade');
      repaint();
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cancelDrag = null;
      store.rt.dragging = null;
      say('');
      repaint();
    };
    const up = () => { store.rt.dragging = null; gesture.end(); finish(); };
    cancelDrag = () => { gesture.cancel(); finish(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /* ── Marquee select ───────────────────────────────────────── */
  function startMarquee(e, p0) {
    let box = null;
    const move = (ev) => {
      const p = local(ev);
      if (!box && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return;
      box ||= Object.assign(document.createElement('div'), { className: 'tl-marquee' });
      if (!box.parentNode) view.appendChild(box);
      const x = Math.min(p.x, p0.x), y = Math.min(p.y, p0.y);
      const w = Math.abs(p.x - p0.x), hgt = Math.abs(p.y - p0.y);
      Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hgt + 'px' });

      const t0 = L.x2t(x), t1 = L.x2t(x + w);
      const ids = [];
      for (const row of L.rows) {
        if (row.y + row.h < y || row.y > y + hgt) continue;
        if (row.track.locked) continue;
        for (const c of row.track.clips)
          if (!c.locked && c.start < t1 && c.start + c.duration > t0) ids.push(c.id);
      }
      store.select(ids, ev.shiftKey);
      say(ids.length ? `${ids.length} clip${ids.length === 1 ? '' : 's'} selected` : '');
    };
    const up = () => {
      if (!box) seekToX(p0.x);
      box?.remove();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      repaint();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ── Pan (Hand tool, middle button) ───────────────────────── */
  function startPan(e) {
    const x0 = e.clientX, y0 = e.clientY;
    const sx = store.ui.scrollX, sy = store.ui.scrollY;
    view.dataset.cursor = 'grabbing';
    const move = (ev) => {
      store.ui.scrollX = Math.max(0, sx - (ev.clientX - x0) / store.pxPerSec);
      store.ui.scrollY = Math.max(0, Math.min(maxScrollY(), sy - (ev.clientY - y0)));
      repaint();
    };
    const up = () => {
      view.dataset.cursor = store.ui.tool === 'hand' ? 'hand' : '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const maxScrollY = () => L.maxScrollY();

  function autoScroll(x) {
    const edge = 48;
    if (x < edge) store.ui.scrollX = Math.max(0, store.ui.scrollX - (edge - x) / store.pxPerSec * 0.35);
    else if (x > L.W - edge) store.ui.scrollX += (x - (L.W - edge)) / store.pxPerSec * 0.35;
  }

  /* ── Wheel ────────────────────────────────────────────────────
   *   wheel          up and down the tracks, when there are more than fit;
   *                  along the timeline when every track is already on screen
   *   Shift + wheel  along the timeline
   *   Ctrl + wheel   zoom, centred on the pointer
   *   sideways swipe (trackpad) along the timeline, always
   */
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    deferFollow();
    const r = view.getBoundingClientRect();
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(store, Math.pow(0.9985, e.deltaY), e.clientX - r.left);
      bus.emit('timeline:zoom');
    } else if (!e.shiftKey && !sideways && maxScrollY() > 0) {
      store.ui.scrollY = Math.max(0, Math.min(maxScrollY(), store.ui.scrollY + e.deltaY));
    } else {
      const dx = sideways ? e.deltaX : e.deltaY;
      store.ui.scrollX = Math.max(0, store.ui.scrollX + dx / store.pxPerSec);
    }
    repaint();
  }, { passive: false });

  /* ── Drag & drop from the media pool ──────────────────────── */
  drop.addEventListener('dragover', (e) => {
    const animId = e.dataTransfer.types.includes('application/x-strike-anim') ? window.__strike_dragAnim : null;
    if (!animId && !e.dataTransfer.types.includes('application/x-gamecut-asset') &&
        !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    drop.classList.add('is-over');

    const r = view.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    const row = L.rowAt(p.y);
    if (animId) {
      // An animation from the library: a ghost as long as it lasts, on the
      // lane under the pointer when that lane can show it.
      const dur = animById(animId)?.dur || 2;
      const s = snapClipEdges(store, Math.max(0, L.x2t(p.x)), dur, snapCandidates(store));
      const fits = row && !row.track.locked && row.track.kind !== 'audio' && !clashes(row.track, s.start, s.start + dur);
      store.rt.dragging = { ghost: { trackId: fits ? row.track.id : null, start: s.start, duration: dur, anim: animId } };
      store.rt.snapLine = s.line;
      store.rt.snapKind = s.kind;
      say(fits ? `Drops at ${fmt(s.start)}` : `Drops at ${fmt(s.start)} on a free text lane`);
      repaint();
      return;
    }
    const id = window.__gc_dragAsset;
    const asset = id ? assets.get(id) : null;
    if (row && asset) {
      const dur = asset.kind === 'image' ? 5 : Math.max(0.5, asset.duration || 4);
      const cands = snapCandidates(store);
      const s = snapClipEdges(store, Math.max(0, L.x2t(p.x)), dur, cands);
      const busy = clashes(row.track, s.start, s.start + dur);
      store.rt.dragging = { ghost: { trackId: row.track.id, start: s.start, duration: dur } };
      store.rt.snapLine = s.line;
      store.rt.snapKind = s.kind;
      say(busy ? 'Something is already there — it will go on a new layer above' : `Drops at ${fmt(s.start)}`);
      repaint();
    } else if (!asset) {
      store.rt.snapLine = fileDropTime(p.x);
      repaint();
    }
  });

  function fileDropTime(x) {
    const raw = Math.max(0, L.x2t(x));
    return snapFrame(resolveSnap(store, raw, snapCandidates(store)).t, store.doc.fps);
  }

  drop.addEventListener('dragleave', () => {
    drop.classList.remove('is-over');
    store.rt.dragging = null; store.rt.snapLine = null; store.rt.snapKind = null; say(''); repaint();
  });

  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const ghost = store.rt.dragging?.ghost;
    store.rt.dragging = null; store.rt.snapLine = null; store.rt.snapKind = null;
    say('');

    const animId = e.dataTransfer.getData('application/x-strike-anim');
    if (animId) {
      window.__strike_dragAnim = null;
      const c = cmds.addAnimation(animId, ghost?.start ?? store.rt.playhead, { trackId: ghost?.trackId || null });
      if (c) store.select([c.id]);
      repaint();
      return;
    }
    const assetId = e.dataTransfer.getData('application/x-gamecut-asset') || window.__gc_dragAsset;
    if (assetId) { placeAsset(assetId, ghost); return; }

    if (e.dataTransfer.files?.length) {
      const r = view.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      const row = L.rowAt(p.y);
      const at = fileDropTime(p.x);
      const { importFiles } = await import('../../media/importer.js');
      const made = await importFiles(e.dataTransfer.files);
      bus.emit('assets');
      const picked = [];
      cmds.batch('Add media', () => {
        let lane = row && !row.track.locked && row.track.kind === 'video' ? row.track.id : null;
        let soundLane = row && !row.track.locked && row.track.kind === 'audio' ? row.track.id : null;
        let next = at;
        for (const a of made) {
          if (a.kind === 'font') continue;
          if (a.kind === 'audio') {
            const c = place(store, cmds, a.id, { start: at, trackId: soundLane });
            soundLane = null;
            if (c) picked.push(c.id);
            continue;
          }
          const still = a.kind === 'image';
          const c = place(store, cmds, a.id, { start: next, trackId: still ? null : lane });
          if (!c) continue;
          picked.push(c.id);
          if (!still) lane = c.trackId;
          next = c.start + c.duration;
        }
      });
      if (picked.length) store.select(picked);
    }
    store.rt.snapLine = null;
    repaint();
  });

  const placeAsset = (assetId, ghost) =>
    place(store, cmds, assetId, { trackId: ghost?.trackId, start: ghost?.start });

  return { hit, menu: ctx };
}
