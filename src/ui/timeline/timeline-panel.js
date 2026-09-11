import { bus, raf } from '../../core/events.js';
import { drawRuler, drawPlayhead, drawSnapLine } from './ruler.js';
import { drawClip } from './clip-renderer.js';
import { renderTrackHeaders } from './track-header.js';
import { initTimelineInteractions } from './interactions.js';
import { zoomToSlider, sliderToZoom, zoomFit, zoomAt } from './zoom.js';
import { TH } from '../theme.js';
import { layoutJunctions, drawJunctions, drawTransitionSpans } from './junction-badge.js';

const RULER_H = 30;
/** Height of the trailing "+ track" row; it has to stay reachable when scrolled. */
const ADD_ROW_H = 30;

export function initTimeline({ store, cmds, history, playback, comp }) {
  const view    = document.getElementById('timelineView');
  const canvas  = document.getElementById('timelineCanvas');
  const headers = document.getElementById('trackHeaders');
  const hbar    = document.getElementById('tlHScroll');
  const thumb   = document.getElementById('tlHThumb');
  const ctx     = canvas.getContext('2d');

  /* ── Layout ───────────────────────────────────────────────── */
  const L = {
    W: 0, H: 0, RH: RULER_H, rows: [], contentH: 0,
    t2x: (t) => (t - store.ui.scrollX) * store.pxPerSec,
    x2t: (x) => store.ui.scrollX + x / store.pxPerSec,
    rowAt(y) {
      for (const r of this.rows) if (y >= r.y && y < r.y + r.h) return r;
      return null;
    },
    rowFor(trackId) { return this.rows.find(r => r.track.id === trackId) || null; },
    /** Single source of truth for the vertical scroll ceiling. */
    maxScrollY() { return Math.max(0, this.contentH - (this.H - this.RH) + ADD_ROW_H); },
  };

  function measure() {
    const r = view.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    L.W = Math.max(1, Math.round(r.width));
    L.H = Math.max(1, Math.round(r.height));
    if (canvas.width !== L.W * dpr || canvas.height !== L.H * dpr) {
      canvas.width = L.W * dpr;
      canvas.height = L.H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Content height is a pure function of the track stack, independent of scroll.
    let total = 0;
    for (const track of store.doc.tracks) total += track.height;
    L.contentH = total;

    // Re-clamp every frame, not just on wheel/drag. Content shrinks when tracks
    // are deleted and the viewport grows when the panel is resized; either would
    // otherwise strand the lanes scrolled off-screen with no way to get back.
    store.ui.scrollY = Math.max(0, Math.min(L.maxScrollY(), store.ui.scrollY || 0));

    L.rows = [];
    let y = RULER_H - store.ui.scrollY;
    for (const track of store.doc.tracks) {
      L.rows.push({ track, y, h: track.height });
      y += track.height;
    }
  }

  /* ── Paint ────────────────────────────────────────────────── */
  function paint() {
    measure();
    ctx.clearRect(0, 0, L.W, L.H);

    // keep DOM headers vertically locked to the canvas lanes
    const hw = headers.children[1];
    if (hw) hw.style.transform = `translateY(${-store.ui.scrollY}px)`;

    // lane ground — opaque, so clip bodies sit on white rather than the panel glass
    ctx.fillStyle = TH.lane;
    ctx.fillRect(0, RULER_H, L.W, L.H - RULER_H);

    // track lanes
    for (const row of L.rows) {
      if (row.y + row.h < RULER_H || row.y > L.H) continue;
      const active = store.rt.activeTrack === row.track.id;
      const top = Math.max(RULER_H, row.y);
      const bot = Math.min(L.H, row.y + row.h);
      if (bot > top) {
        ctx.fillStyle = active ? TH.laneActive
          : row.track.kind === 'audio' ? TH.laneAudio : TH.laneAlt;
        ctx.fillRect(0, top, L.W, bot - top);
      }
      ctx.fillStyle = TH.laneLine;
      ctx.fillRect(0, row.y + row.h - 1, L.W, 1);
    }

    drawRuler(ctx, store, L);

    if (!store.doc.tracks.some(t => t.clips.length)) drawEmptyHint(ctx, L);

    const pps = store.pxPerSec;
    const sel = new Set(store.rt.selection);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER_H, L.W, L.H - RULER_H); ctx.clip();

    for (const row of L.rows) {
      if (row.y + row.h < RULER_H || row.y > L.H) continue;
      for (const clip of row.track.clips) {
        const fx = L.t2x(clip.start);
        const fw = clip.duration * pps;
        if (fx + fw < -8 || fx > L.W + 8) continue;
        const x = Math.max(fx, -4);
        const w = Math.min(fx + fw, L.W + 4) - x;
        drawClip(ctx, {
          clip, track: row.track, pps, L,
          rect: { x, y: row.y + 2, w, h: row.h - 5 },
          full: { x: fx, y: row.y + 2, w: fw, h: row.h - 5 },
          selected: sel.has(clip.id),
        });
      }
    }

    // Transitions sit on top of the clips they join, and the badge on top of
    // the shaded span. Both inside the lane clip so they cannot spill into the
    // ruler when a track is scrolled half off the top.
    layoutJunctions(store, L);
    drawTransitionSpans(ctx, store, L);
    drawJunctions(ctx, store, L);

    // drop / drag ghost
    const d = store.rt.dragging;
    if (d?.ghost) {
      const row = L.rowFor(d.ghost.trackId);
      if (row) {
        ctx.fillStyle = TH.ghostFill;
        ctx.strokeStyle = TH.ghostLine;
        ctx.lineWidth = 1.5;
        const x = L.t2x(d.ghost.start), w = d.ghost.duration * pps;
        ctx.fillRect(x, row.y + 2, w, row.h - 5);
        ctx.strokeRect(x + .5, row.y + 2.5, w - 1, row.h - 6);
      }
    }
    ctx.restore();

    drawSnapLine(ctx, store, L);
    drawPlayhead(ctx, store, L);
    paintScrollbar();
    paintVScrollbar();
  }

  /**
   * What an empty timeline says.
   *
   * A blank grid gives a first-time user nothing to act on — the app looks
   * finished and inert. Two lines telling them where footage comes from and
   * what to do with it cost one draw call on the one screen where nothing else
   * is happening, and they disappear the moment the first clip lands.
   */
  function drawEmptyHint(ctx, L) {
    const cx = L.W / 2;
    const cy = L.RH + (L.H - L.RH) / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = TH.rulerText;
    ctx.font = '600 13.5px system-ui, -apple-system, sans-serif';
    ctx.fillText('Drop your recordings here', cx, cy - 10);
    ctx.globalAlpha = .78;
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.fillText('or press I to import — then double-click a tile in the Media panel', cx, cy + 10);
    ctx.font = '11.5px system-ui, -apple-system, sans-serif';
    ctx.globalAlpha = .6;
    ctx.fillText('Press ? at any time for what every tool does', cx, cy + 30);
    ctx.restore();
  }

  const repaint = raf(paint);
  const rebuildHeaders = raf(() => renderTrackHeaders(headers, store, L, cmds));

  /* ── Horizontal scrollbar ─────────────────────────────────── */
  function paintScrollbar() {
    const span = Math.max(store.rt.duration + 8, L.W / store.pxPerSec);
    const visible = L.W / store.pxPerSec;
    const frac = Math.min(1, visible / span);
    const w = Math.max(28, hbar.clientWidth * frac);
    const maxScroll = Math.max(0.0001, span - visible);
    const left = (store.ui.scrollX / maxScroll) * (hbar.clientWidth - w);
    thumb.style.width = w + 'px';
    thumb.style.left = Math.max(0, Math.min(hbar.clientWidth - w, left)) + 'px';
    thumb._span = span; thumb._visible = visible;
  }

  /* ── Vertical scrollbar ───────────────────────────────────── */
  const vbar = document.getElementById('tlVScroll');
  const vthumb = document.getElementById('tlVThumb');

  function paintVScrollbar() {
    const viewH = L.H - L.RH;
    const contentH = L.contentH + ADD_ROW_H;
    if (contentH <= viewH + 2) { vbar.hidden = true; return; }
    vbar.hidden = false;
    const trackH = vbar.clientHeight;
    const h = Math.max(24, trackH * (viewH / contentH));
    const maxScroll = Math.max(1, L.maxScrollY());
    vthumb.style.height = h + 'px';
    vthumb.style.top = (store.ui.scrollY / maxScroll) * (trackH - h) + 'px';
    vthumb._max = maxScroll;
  }

  vthumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    vthumb.classList.add('is-drag');
    const y0 = e.clientY, s0 = store.ui.scrollY;
    const runway = vbar.clientHeight - vthumb.clientHeight;
    const move = (ev) => {
      store.ui.scrollY = Math.max(0, Math.min(vthumb._max,
        s0 + ((ev.clientY - y0) / Math.max(1, runway)) * vthumb._max));
      rebuildHeaders(); repaint();
    };
    const up = () => {
      vthumb.classList.remove('is-drag');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  thumb.addEventListener('pointerdown', (e) => {
    thumb.setPointerCapture(e.pointerId);
    thumb.classList.add('is-drag');
    const x0 = e.clientX, s0 = store.ui.scrollX;
    const track = hbar.clientWidth - thumb.clientWidth;
    const maxScroll = Math.max(0.0001, thumb._span - thumb._visible);
    const move = (ev) => {
      store.ui.scrollX = Math.max(0, s0 + ((ev.clientX - x0) / Math.max(1, track)) * maxScroll);
      repaint();
    };
    const up = () => {
      thumb.classList.remove('is-drag');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /* ── Toolbar ──────────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const zoomRange = $('zoomRange'), zoomChip = $('zoomChip');

  const syncZoomUI = () => {
    zoomRange.value = zoomToSlider(store.ui.zoom);
    zoomRange.style.setProperty('--fill', (zoomRange.value / 10) + '%');
    zoomChip.textContent = store.ui.zoom.toFixed(store.ui.zoom < 1 ? 2 : 1) + '×';
  };
  zoomRange.addEventListener('input', () => {
    const before = store.ui.scrollX + (L.W / 2) / store.pxPerSec;
    store.ui.zoom = sliderToZoom(+zoomRange.value);
    store.ui.scrollX = Math.max(0, before - (L.W / 2) / store.pxPerSec);
    syncZoomUI(); repaint();
  });
  $('btnZoomFit').addEventListener('click', () => { zoomFit(store, L.W); syncZoomUI(); repaint(); });

  $('btnSplit').addEventListener('click', () => cmds.splitAt(store.rt.playhead, store.rt.selection));
  $('btnDelete').addEventListener('click', () => cmds.removeSelected());
  $('btnDuplicate').addEventListener('click', () => cmds.duplicateSelected());
  $('btnAddText').addEventListener('click', () => cmds.addTextClip(store.rt.playhead));
  $('btnMarker').addEventListener('click', () => cmds.addMarker(store.rt.playhead));

  const magnet = $('btnMagnet');
  magnet.addEventListener('click', () => {
    store.ui.snap = !store.ui.snap;
    magnet.classList.toggle('is-active', store.ui.snap);
    $('tglSnap').classList.toggle('is-active', store.ui.snap);
  });
  const ripple = $('btnRipple');
  ripple.addEventListener('click', () => {
    store.ui.ripple = !store.ui.ripple;
    ripple.classList.toggle('is-active', store.ui.ripple);
  });
  const beatBtn = $('btnBeatGrid');
  beatBtn.addEventListener('click', () => {
    store.ui.beatGrid = !store.ui.beatGrid;
    beatBtn.classList.toggle('is-active', store.ui.beatGrid);
    repaint();
  });
  const bpmInput = $('bpmInput');
  bpmInput.value = store.doc.bpm;
  bpmInput.addEventListener('change', () => { cmds.setBPM(+bpmInput.value); repaint(); });

  // Tap tempo — four taps is enough to lock a Suno track's grid.
  let taps = [];
  $('btnTapTempo').addEventListener('click', () => {
    const now = performance.now();
    taps = taps.filter(t => now - t < 2500);
    taps.push(now);
    if (taps.length >= 2) {
      const gaps = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const bpm = Math.round((60000 / avg) * 10) / 10;
      bpmInput.value = bpm;
      cmds.setBPM(bpm);
      store.doc.beatOffset = store.rt.playhead;
      repaint();
    }
  });

  /* ── Wiring ───────────────────────────────────────────────── */
  initTimelineInteractions({ view, store, cmds, history, playback, L, repaint, comp });

  store.on('doc', () => { rebuildHeaders(); repaint(); });
  store.on('rt', repaint);
  store.on('ui', repaint);
  store.on('selection', repaint);
  store.on('playhead', repaint);
  bus.on('layout', repaint);
  bus.on('assets', repaint);
  new ResizeObserver(repaint).observe(view);

  rebuildHeaders();
  zoomFit(store, view.clientWidth || 800);
  syncZoomUI();
  repaint();

  return { repaint, L, syncZoomUI };
}
