import { snapCandidates, snapClipEdges, resolveSnap } from './snapping.js';
import { zoomAt } from './zoom.js';
import { clamp, snapFrame } from '../../core/time.js';
import { makeClip, trackAccepts } from '../../core/schema.js';
import { assets } from '../../media/asset-store.js';
import { bus } from '../../core/events.js';
import { placeAsset as place } from './place-asset.js';
import { initContextMenu } from './context-menu.js';
import { junctionAt } from './junction-badge.js';

const EDGE_PX = 7;

export function initTimelineInteractions({ view, store, cmds, history, playback, L, repaint }) {
  const drop = document.getElementById('tlDrop');
  const local = (e) => {
    const r = view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Clip under the cursor, plus which zone of it. */
  function hit(p) {
    if (p.y < L.RH) return { zone: 'ruler' };
    // The transition badge sits on the seam between two clips, which is also
    // the trim handle of both. It has to win, or the button is unclickable at
    // every zoom level where the clips are wider than a few pixels.
    const j = junctionAt(L, p.x, p.y);
    if (j) return { zone: 'junction', junction: j, row: L.rowFor(j.track.id) };
    const row = L.rowAt(p.y);
    if (!row) return { zone: 'empty' };
    const pps = store.pxPerSec;
    for (let i = row.track.clips.length - 1; i >= 0; i--) {
      const clip = row.track.clips[i];
      const x0 = L.t2x(clip.start), x1 = x0 + clip.duration * pps;
      if (p.x < x0 - 2 || p.x > x1 + 2) continue;
      if (row.track.locked || clip.locked) return { zone: 'locked', clip, row };
      const wide = x1 - x0 > EDGE_PX * 3;
      if (wide && p.x <= x0 + EDGE_PX) return { zone: 'in', clip, row };
      if (wide && p.x >= x1 - EDGE_PX) return { zone: 'out', clip, row };
      return { zone: 'body', clip, row };
    }
    return { zone: 'lane', row };
  }

  /* ── Cursor feedback ──────────────────────────────────────── */
  view.addEventListener('pointermove', (e) => {
    if (store.rt.dragging) return;
    const h = hit(local(e));
    view.dataset.cursor =
      h.zone === 'ruler' ? 'scrub' :
      h.zone === 'junction' ? 'pick' :
      h.zone === 'in' || h.zone === 'out' ? 'trim' :
      h.zone === 'body' ? 'move' : '';
  });

  /* ── Pointer down ─────────────────────────────────────────── */
  view.addEventListener('pointerdown', (e) => {
    if (e.button === 1) return startPan(e);
    if (e.button !== 0) return;
    const p = local(e);
    const h = hit(p);
    view.setPointerCapture?.(e.pointerId);

    if (h.zone === 'ruler') return startScrub(e);
    if (h.zone === 'junction') return pickJunction(e, h);
    if (h.zone === 'body')  return startMove(e, h, p);
    if (h.zone === 'in' || h.zone === 'out') return startTrim(e, h);
    if (h.row) store.setRT({ activeTrack: h.row.track.id });
    if (!e.shiftKey) store.select([]);
    startMarquee(e, p);
  });

  view.addEventListener('dblclick', (e) => {
    const h = hit(local(e));
    if (h.zone === 'junction') return;
    if (h.zone === 'body') { playback.pause(); playback.seek(h.clip.start); }
  });

  /**
   * Clicking the badge on a cut opens the transition picker on that cut.
   *
   * The playhead moves onto the seam as well. You are about to choose something
   * whose whole point is what it looks like, and looking at it requires being
   * parked where it happens — having to go and find the moment yourself
   * afterwards is the step that makes a picker feel like a form to fill in.
   */
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
    // Right-clicking the badge is right-clicking the cut, so it gets the
    // transition list straight away rather than the menu for empty space.
    else if (h.zone === 'junction') {
      store.setRT({ junction: h.junction.next.id });
      repaint();
      ctx.forJunction(h.junction, e.clientX, e.clientY);
    }
    else if (h.clip) ctx.forClip(h.clip, h.row.track, e.clientX, e.clientY);
    else ctx.forLane(h.row?.track || null, t, e.clientX, e.clientY);
  });

  /**
   * Put the playhead at a horizontal position in the timeline.
   *
   * Clicking anywhere — the ruler, an empty lane, a clip — moves the playhead
   * there. Playback is deliberately left running: `playback.seek` re-anchors
   * the transport clock, so a click mid-playback continues from the new spot
   * instead of stopping. It snaps to the same edges and beats a drag does.
   */
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
    const move = (ev) => {
      const p = local(ev);
      seekToX(p.x);
      autoScroll(p.x);
    };
    move(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (was) playback.play();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ── Move clips ───────────────────────────────────────────── */
  function startMove(e, h, p0) {
    const clip = h.clip;
    if (!store.rt.selection.includes(clip.id)) store.select([clip.id], e.shiftKey);
    else if (e.shiftKey) store.toggleSelect(clip.id);

    const picks = store.selectedClips.map(({ clip: c, track }) => ({
      id: c.id, start0: c.start, trackId: track.id, duration: c.duration, type: c.type,
    }));
    const anchor = picks.find(x => x.id === clip.id) || picks[0];
    const rowIndex0 = L.rows.findIndex(r => r.track.id === anchor.trackId);
    const grabOffset = L.x2t(p0.x) - clip.start;
    let moved = false;

    const move = (ev) => {
      const p = local(ev);
      if (!moved && Math.abs(p.x - p0.x) < 3 && Math.abs(p.y - p0.y) < 3) return;
      moved = true;
      store.rt.dragging = { kind: 'move' };

      const rawStart = Math.max(0, L.x2t(p.x) - grabOffset);
      const cands = snapCandidates(store, { excludeIds: picks.map(x => x.id) });
      const snapped = ev.altKey
        ? { start: rawStart, line: null }
        : snapClipEdges(store, rawStart, anchor.duration, cands);
      const delta = snapFrame(snapped.start - anchor.start0, store.doc.fps);
      store.rt.snapLine = snapped.line;

      // vertical track shift
      const row = L.rowAt(p.y);
      const rowIndex = row ? L.rows.indexOf(row) : rowIndex0;
      const rowDelta = ev.shiftKey ? 0 : rowIndex - rowIndex0;

      history.begin('Move clip', 'move-batch');
      for (const pick of picks) {
        const src = L.rows.findIndex(r => r.track.id === pick.trackId);
        const dstRow = L.rows[clamp(src + rowDelta, 0, L.rows.length - 1)];
        const dstId = dstRow && trackAccepts(dstRow.track.kind, pick.type) && !dstRow.track.locked
          ? dstRow.track.id : pick.trackId;
        applyMove(pick.id, Math.max(0, pick.start0 + delta), dstId);
      }
      history.commit();
      autoScroll(p.x);
      repaint();
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // A press that never turned into a drag was a click, so treat it as one
      // and move the playhead there. The clip is still selected either way.
      if (!moved) seekToX(p0.x);
      store.rt.dragging = null;
      store.rt.snapLine = null;
      view.dataset.cursor = '';
      repaint();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** In-place move used inside an already-open history transaction. */
  function applyMove(clipId, start, trackId) {
    const doc = store.doc;
    let found = null, from = null;
    for (const t of doc.tracks) {
      const c = t.clips.find(c => c.id === clipId);
      if (c) { found = c; from = t; break; }
    }
    if (!found) return;
    found.start = snapFrame(start, doc.fps);
    if (trackId !== from.id) {
      const to = doc.tracks.find(t => t.id === trackId);
      if (to) {
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

    const move = (ev) => {
      const p = local(ev);
      store.rt.dragging = { kind: 'trim' };
      const cands = snapCandidates(store, { excludeIds: [clip.id] });
      const raw = L.x2t(p.x);
      const s = ev.altKey ? { t: raw, snapped: false } : resolveSnap(store, raw, cands);
      store.rt.snapLine = s.snapped ? s.t : null;
      cmds.trimClip(clip.id, edge === 'in' ? 'in' : 'out', s.t);
      autoScroll(p.x);
      repaint();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store.rt.dragging = null;
      store.rt.snapLine = null;
      view.dataset.cursor = '';
      repaint();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ── Marquee select ───────────────────────────────────────── */
  function startMarquee(e, p0) {
    let box = null;
    const move = (ev) => {
      const p = local(ev);
      if (!box && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return;
      box ||= Object.assign(document.createElement('div'), { className: 'tl-marquee' });
      if (!box.parentNode) {
        Object.assign(box.style, {
          position: 'absolute', border: '1px solid rgba(37,99,235,.95)',
          background: 'rgba(37,99,235,.14)', pointerEvents: 'none', zIndex: 5,
        });
        view.appendChild(box);
      }
      const x = Math.min(p.x, p0.x), y = Math.min(p.y, p0.y);
      const w = Math.abs(p.x - p0.x), hgt = Math.abs(p.y - p0.y);
      Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hgt + 'px' });

      const t0 = L.x2t(x), t1 = L.x2t(x + w);
      const ids = [];
      for (const row of L.rows) {
        if (row.y + row.h < y || row.y > y + hgt) continue;
        for (const c of row.track.clips)
          if (c.start < t1 && c.start + c.duration > t0) ids.push(c.id);
      }
      store.select(ids, ev.shiftKey);
    };
    const up = () => {
      // No box was ever drawn, so this was a click in empty space rather than
      // a marquee — same rule as clicking a clip: the playhead goes there.
      if (!box) seekToX(p0.x);
      box?.remove();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      repaint();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ── Pan (middle drag / space drag) ───────────────────────── */
  function startPan(e) {
    const x0 = e.clientX, y0 = e.clientY;
    const sx = store.ui.scrollX, sy = store.ui.scrollY;
    const move = (ev) => {
      store.ui.scrollX = Math.max(0, sx - (ev.clientX - x0) / store.pxPerSec);
      store.ui.scrollY = Math.max(0, Math.min(maxScrollY(), sy - (ev.clientY - y0)));
      repaint();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Delegates to the layout object so the wheel, the pan and the scrollbar can
  // never disagree about where the bottom is.
  const maxScrollY = () => L.maxScrollY();

  function autoScroll(x) {
    const edge = 48;
    if (x < edge) store.ui.scrollX = Math.max(0, store.ui.scrollX - (edge - x) / store.pxPerSec * 0.35);
    else if (x > L.W - edge) store.ui.scrollX += (x - (L.W - edge)) / store.pxPerSec * 0.35;
  }

  /* ── Wheel ────────────────────────────────────────────────── */
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(store, Math.pow(0.9985, e.deltaY), e.clientX - r.left);
      bus.emit('timeline:zoom');
    } else if (e.shiftKey) {
      store.ui.scrollY = Math.max(0, Math.min(maxScrollY(), store.ui.scrollY + e.deltaY));
    } else {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      store.ui.scrollX = Math.max(0, store.ui.scrollX + dx / store.pxPerSec);
    }
    repaint();
  }, { passive: false });

  /* ── Drag & drop from the media pool ──────────────────────── */
  drop.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-gamecut-asset') &&
        !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    drop.classList.add('is-over');

    const r = view.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    const row = L.rowAt(p.y);
    const id = window.__gc_dragAsset;
    const asset = id ? assets.get(id) : null;
    if (row && asset) {
      const dur = asset.kind === 'image' ? 5 : Math.max(0.5, asset.duration || 4);
      const cands = snapCandidates(store);
      const s = snapClipEdges(store, Math.max(0, L.x2t(p.x)), dur, cands);
      store.rt.dragging = { ghost: { trackId: row.track.id, start: s.start, duration: dur } };
      store.rt.snapLine = s.line;
      repaint();
    }
  });

  drop.addEventListener('dragleave', () => {
    drop.classList.remove('is-over');
    store.rt.dragging = null; store.rt.snapLine = null; repaint();
  });

  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const ghost = store.rt.dragging?.ghost;
    store.rt.dragging = null; store.rt.snapLine = null;

    const assetId = e.dataTransfer.getData('application/x-gamecut-asset') || window.__gc_dragAsset;
    if (assetId) { placeAsset(assetId, ghost); return; }

    if (e.dataTransfer.files?.length) {
      const { importFiles } = await import('../../media/importer.js');
      const made = await importFiles(e.dataTransfer.files);
      bus.emit('assets');
      let at = ghost?.start ?? store.rt.playhead;
      for (const a of made) { placeAsset(a.id, { start: at }); at += a.duration || 4; }
    }
    repaint();
  });

  // A drop lands exactly where the ghost showed it, so no shifting.
  const placeAsset = (assetId, ghost) =>
    place(store, cmds, assetId, { trackId: ghost?.trackId, start: ghost?.start });

  return { hit };
}
