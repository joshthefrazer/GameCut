import { bus, raf } from '../../core/events.js';
import { drawRuler, drawPlayhead, drawSnapLine, drawRazorLine } from './ruler.js';
import { drawClip } from './clip-renderer.js';
import { renderTrackHeaders, GROUP_LABEL } from './track-header.js';
import { initTimelineInteractions } from './interactions.js';
import { zoomToSlider, sliderToZoom, zoomFit, zoomAt } from './zoom.js';
import { initOverview } from './overview.js';
import { TH } from '../theme.js';
import { layoutJunctions, drawJunctions, drawTransitionSpans } from './junction-badge.js';
import { makeTweener, easeOutCubic, easeInOutCubic } from '../../core/anim.js';

const RULER_H = 30;
/** The band that names a group of lanes (VIDEO, TEXT & GRAPHICS, AUDIO). */
export const GROUP_H = 22;
/** Every lane is the same height, picked with the S / M / L control. */
export const LANE_H = { S: 40, M: 54, L: 76 };
/** Auto: as tall as fits, so every lane is on screen without scrolling when it can be. */
const AUTO_MIN = 40, AUTO_MAX = 64;
const KIND_ORDER = ['text', 'video', 'audio'];

const SIZE_KEY = 'gamecut.trackSize';
const FOLD_KEY = 'gamecut.folded';
const TOOL_HINT = {
  select: 'Select: click a clip to pick it, drag to move it, drag an edge to trim',
  razor: 'Razor: click a clip to cut it there · Shift-click cuts every track',
  hand: 'Hand: drag to look around the timeline',
};

export function initTimeline({ store, cmds, history, playback, comp }) {
  let flash = null;     // the cut flash (see paint)
  const view    = document.getElementById('timelineView');
  const canvas  = document.getElementById('timelineCanvas');
  const headers = document.getElementById('trackHeaders');
  const hbar    = document.getElementById('tlHScroll');
  const thumb   = document.getElementById('tlHThumb');
  const status  = document.getElementById('tlStatus');
  const ctx     = canvas.getContext('2d');

  try { store.ui.trackSize = localStorage.getItem(SIZE_KEY) || 'A'; } catch { store.ui.trackSize = 'A'; }
  if (!LANE_H[store.ui.trackSize]) store.ui.trackSize = 'A';
  try { store.ui.folded = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch { store.ui.folded = {}; }
  store.ui.tool ||= 'select';

  /* ── Layout ───────────────────────────────────────────────── */
  const L = {
    W: 0, H: 0, RH: RULER_H, rows: [], groups: [], contentH: 0,
    t2x: (t) => (t - store.ui.scrollX) * store.pxPerSec,
    x2t: (x) => store.ui.scrollX + x / store.pxPerSec,
    rowAt(y) {
      for (const r of this.rows) if (y >= r.y && y < r.y + r.h) return r;
      return null;
    },
    groupAt(y) {
      for (const g of this.groups) if (y >= g.y && y < g.y + g.h) return g;
      return null;
    },
    rowFor(trackId) { return this.rows.find(r => r.track.id === trackId) || null; },
    /** Single source of truth for the vertical scroll ceiling. */
    maxScrollY() { return Math.max(0, this.contentH - (this.H - this.RH) + 10); },
    laneH() {
      if (LANE_H[store.ui.trackSize]) return LANE_H[store.ui.trackSize];
      const kinds = new Set(store.doc.tracks.map(t => t.kind));
      const lanes = store.doc.tracks.filter(t => !store.ui.folded?.[t.kind]).length || 1;
      const room = (this.H || 300) - RULER_H - kinds.size * GROUP_H - 4;
      return Math.max(AUTO_MIN, Math.min(AUTO_MAX, Math.floor(room / lanes)));
    },
  };

  /** The bottom picture lane: the one a finished video is built on. */
  const mainTrackId = () => [...store.doc.tracks].reverse().find(t => t.kind === 'video')?.id || null;

  /**
   * Lanes, grouped by what they hold, top of the stack first.
   *
   * The document's order IS the stacking order (index 0 is drawn last, on
   * top), so the groups are just runs of one kind. A folded group keeps its
   * name band and hides its lanes.
   */
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

    const lane = L.laneH();
    const plan = [];
    let kind = null;
    for (const track of store.doc.tracks) {
      if (track.kind !== kind) {
        kind = track.kind;
        plan.push({ group: kind, h: GROUP_H });
      }
      if (!store.ui.folded?.[kind]) plan.push({ track, h: lane });
    }
    L.contentH = plan.reduce((s, p) => s + p.h, 0);
    store.ui.scrollY = Math.max(0, Math.min(L.maxScrollY(), store.ui.scrollY || 0));

    L.rows = []; L.groups = [];
    L.mainId = mainTrackId();
    let y = RULER_H - store.ui.scrollY;
    for (const p of plan) {
      if (p.group) {
        const n = store.doc.tracks.filter(t => t.kind === p.group).length;
        L.groups.push({ kind: p.group, y, h: p.h, folded: !!store.ui.folded?.[p.group], count: n });
      } else {
        L.rows.push({ track: p.track, y, h: p.h });
      }
      y += p.h;
    }
  }

  /* ── Paint ────────────────────────────────────────────────── */
  function paint() {
    measure();
    ctx.clearRect(0, 0, L.W, L.H);

    const hw = headers.children[1];
    if (hw) hw.style.transform = `translateY(${-store.ui.scrollY}px)`;

    ctx.fillStyle = TH.lane;
    ctx.fillRect(0, RULER_H, L.W, L.H - RULER_H);

    for (const g of L.groups) {
      if (g.y + g.h < RULER_H || g.y > L.H) continue;
      ctx.fillStyle = TH.rulerBg;
      ctx.fillRect(0, g.y, L.W, g.h);
      ctx.fillStyle = TH.laneLine;
      ctx.fillRect(0, g.y + g.h - 1, L.W, 1);
    }

    for (const row of L.rows) {
      if (row.y + row.h < RULER_H || row.y > L.H) continue;
      const active = store.rt.activeTrack === row.track.id;
      const top = Math.max(RULER_H, row.y);
      const bot = Math.min(L.H, row.y + row.h);
      if (bot > top) {
        ctx.fillStyle = active ? TH.laneActive
          : row.track.kind === 'audio' ? TH.laneAudio : TH.laneAlt;
        ctx.fillRect(0, top, L.W, bot - top);
        if (row.track.color) {
          // A lane colour: a faint wash and a stripe down the left edge.
          ctx.fillStyle = row.track.color + '14';
          ctx.fillRect(0, top, L.W, bot - top);
          ctx.fillStyle = row.track.color + 'cc';
          ctx.fillRect(0, top, 3, bot - top);
        }
        if (row.track.locked) {
          ctx.fillStyle = 'rgba(244,63,94,.05)';
          ctx.fillRect(0, top, L.W, bot - top);
        }
      }
      ctx.fillStyle = TH.laneLine;
      ctx.fillRect(0, row.y + row.h - 1, L.W, 1);
    }

    drawRuler(ctx, store, L);

    if (!store.doc.tracks.some(t => t.clips.length)) drawEmptyHint(ctx, L);

    const pps = store.pxPerSec;
    const sel = new Set(store.rt.selection);
    const drag = store.rt.dragging;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER_H, L.W, L.H - RULER_H); ctx.clip();

    drawMainGaps(ctx);

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
          rect: { x, y: row.y + 3, w, h: row.h - 6 },
          full: { x: fx, y: row.y + 3, w: fw, h: row.h - 6 },
          selected: sel.has(clip.id),
          hover: store.rt.hoverClip === clip.id,
          conflict: drag?.conflicts?.includes(clip.id),
          main: row.track.id === L.mainId,
        });
      }
    }

    layoutJunctions(store, L);
    drawTransitionSpans(ctx, store, L);
    drawJunctions(ctx, store, L);

    // Where a dragged clip will slot in.
    if (drag?.insertAt != null) {
      const row = L.rowFor(drag.insertTrack);
      if (row) {
        const x = Math.round(L.t2x(drag.insertAt));
        ctx.fillStyle = TH.snap;
        ctx.fillRect(x - 1.5, row.y + 1, 3, row.h - 2);
        ctx.beginPath();
        ctx.moveTo(x - 6, row.y + 1); ctx.lineTo(x + 6, row.y + 1); ctx.lineTo(x, row.y + 8);
        ctx.closePath(); ctx.fill();
      }
    }

    if (drag?.ghost) {
      const row = L.rowFor(drag.ghost.trackId);
      if (row) {
        ctx.fillStyle = TH.ghostFill;
        ctx.strokeStyle = TH.ghostLine;
        ctx.lineWidth = 1.5;
        const x = L.t2x(drag.ghost.start), w = drag.ghost.duration * pps;
        ctx.fillRect(x, row.y + 3, w, row.h - 6);
        ctx.strokeRect(x + .5, row.y + 3.5, w - 1, row.h - 7);
      }
    }
    ctx.restore();

    // Cut flash: a bright line where a cut was just made, fading over a
    // third of a second, so a split you made by key is seen to happen.
    if (flash) {
      const k = 1 - (performance.now() - flash.at) / 380;
      if (k <= 0) flash = null;
      else {
        const x = Math.round(L.t2x(flash.t));
        ctx.save();
        ctx.globalAlpha = k;
        ctx.shadowColor = TH.snap; ctx.shadowBlur = 16 * k;
        ctx.fillStyle = TH.snap;
        ctx.fillRect(x - 1.5, RULER_H, 3, L.H - RULER_H);
        ctx.restore();
        repaint();
      }
    }

    drawRazorLine(ctx, store, L);
    drawSnapLine(ctx, store, L);
    drawPlayhead(ctx, store, L);
    paintScrollbar();
    paintVScrollbar();
    overview.paint();
  }

  /**
   * Hatch the holes in the main video track. A gap there is black in the
   * finished video; hatched, it reads as "something is missing here".
   */
  let hatch = null;
  function drawMainGaps(ctx) {
    const main = store.doc.tracks.find(t => t.id === L.mainId);
    const row = main && L.rowFor(main.id);
    if (!row || main.clips.length < 1) return;
    if (!hatch) {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const g = c.getContext('2d');
      g.strokeStyle = 'rgba(244,63,94,.45)';
      g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.moveTo(-2, 2); g.lineTo(2, -2); g.stroke();
      hatch = ctx.createPattern(c, 'repeat');
    }
    const sorted = [...main.clips].sort((a, b) => a.start - b.start);
    const holes = [];
    let reach = 0;
    for (const c of sorted) {
      if (c.start > reach + 1e-6) holes.push([reach, c.start]);
      reach = Math.max(reach, c.start + c.duration);
    }
    L.mainGaps = holes;
    if (!holes.length) return;
    ctx.save();
    ctx.fillStyle = hatch;
    for (const [a, b] of holes) {
      const x0 = Math.max(-2, L.t2x(a)), x1 = Math.min(L.W + 2, L.t2x(b));
      if (x1 - x0 < 1) continue;
      ctx.fillRect(x0, row.y + 3, x1 - x0, row.h - 6);
    }
    ctx.restore();
  }

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
    ctx.fillText('or press Ctrl+I to import — your first clip goes straight onto the timeline', cx, cy + 10);
    ctx.font = '11.5px system-ui, -apple-system, sans-serif';
    ctx.globalAlpha = .6;
    ctx.fillText('Ctrl+K finds any tool · ? shows what everything does', cx, cy + 30);
    ctx.restore();
  }

  const repaint = raf(paint);
  bus.on('cut:flash', ({ t }) => { flash = { t, at: performance.now() }; repaint(); });
  let menu = null;
  const rebuildHeaders = raf(() => {
    measure();
    renderTrackHeaders(headers, store, L, cmds, menu, {
      fold: (kind) => {
        store.ui.folded = { ...store.ui.folded, [kind]: !store.ui.folded?.[kind] };
        try { localStorage.setItem(FOLD_KEY, JSON.stringify(store.ui.folded)); } catch { /* private */ }
        rebuildHeaders(); repaint();
      },
    });
  });

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
    const contentH = L.contentH + 10;
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
      repaint();
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
    deferFollow(2400);
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
    zoomChip.textContent = Math.round(store.ui.zoom * 100) + '%';
  };
  zoomRange.addEventListener('input', () => {
    zoomTween.stop();
    deferFollow(1800);
    const before = store.ui.scrollX + (L.W / 2) / store.pxPerSec;
    store.ui.zoom = sliderToZoom(+zoomRange.value);
    store.ui.scrollX = Math.max(0, before - (L.W / 2) / store.pxPerSec);
    syncZoomUI(); repaint();
  });
  const zoomTween = makeTweener();
  function zoomTo(targetZoom, anchorPx = L.W / 2, ms = 200) {
    const z0 = store.ui.zoom;
    const t0 = store.ui.scrollX + anchorPx / store.pxPerSec;
    const base = store.ui.basePxPerSec;
    zoomTween.run({
      from: z0, to: targetZoom, ms, ease: easeInOutCubic,
      onStep: (z) => {
        store.ui.zoom = z;
        store.ui.scrollX = Math.max(0, t0 - anchorPx / (base * z));
        syncZoomUI(); repaint();
      },
    });
  }
  /** Zoom around the playhead when it is on screen, else around the middle. */
  const zoomAnchor = () => {
    const x = L.t2x(store.rt.playhead);
    return x >= 0 && x <= L.W ? x : L.W / 2;
  };
  $('btnZoomFit').addEventListener('click', () => fitAll());
  $('btnZoomIn')?.addEventListener('click', () => zoomTo(Math.min(24, store.ui.zoom * 1.5), zoomAnchor()));
  $('btnZoomOut')?.addEventListener('click', () => zoomTo(Math.max(0.05, store.ui.zoom / 1.5), zoomAnchor()));

  let fitting = false;
  function fitAll(ms = 240) {
    if (ms > 0) deferFollow(1200);
    const z0 = store.ui.zoom, s0 = store.ui.scrollX;
    zoomFit(store, L.W);
    const z1 = store.ui.zoom, s1 = store.ui.scrollX;
    store.ui.zoom = z0; store.ui.scrollX = s0;
    fitting = true;
    zoomTween.run({
      from: 0, to: 1, ms, ease: easeInOutCubic,
      onStep: (p) => {
        store.ui.zoom = z0 + (z1 - z0) * p;
        store.ui.scrollX = Math.max(0, s0 + (s1 - s0) * p);
        syncZoomUI(); repaint();
      },
      onDone: () => {
        fitting = false;
        store.ui.zoom = z1; store.ui.scrollX = s1;
        syncZoomUI(); repaint();
      },
    });
  }

  $('btnSplit').addEventListener('click', () => cmds.splitAt(store.rt.playhead, store.rt.selection));
  $('btnDelete').addEventListener('click', () => cmds.removeSelected());
  $('btnDuplicate').addEventListener('click', () => cmds.duplicateSelected());
  $('btnAddText').addEventListener('click', () => cmds.addTextClip(store.rt.playhead));
  $('btnMarker').addEventListener('click', () => cmds.addMarker(store.rt.playhead));
  $('btnCloseGaps')?.addEventListener('click', () => cmds.closeAllGaps());
  $('btnAddLane')?.addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    inter.menu?.forAddLane?.(r.left, r.top - 8 - 230);
  });

  /* Tools: Select, Razor, Hand. Lit when active, so a click is never a surprise. */
  const toolBtns = { select: $('btnToolSelect'), razor: $('btnToolRazor'), hand: $('btnToolHand') };
  function setTool(tool, { quiet = false } = {}) {
    store.ui.tool = TOOL_HINT[tool] ? tool : 'select';
    for (const [k, b] of Object.entries(toolBtns)) {
      b?.classList.toggle('is-active', k === store.ui.tool);
      b?.setAttribute('aria-pressed', String(k === store.ui.tool));
    }
    view.dataset.tool = store.ui.tool;
    store.rt.razorAt = null;
    if (!quiet) say(TOOL_HINT[store.ui.tool]);
    repaint();
  }
  for (const [k, b] of Object.entries(toolBtns)) b?.addEventListener('click', () => setTool(k));
  bus.on('timeline:tool', (t) => setTool(t));

  /* Lane size: one height for every lane. */
  const sizeBtn = $('btnTrackSize');
  const paintSize = () => { if (sizeBtn) sizeBtn.textContent = { A: 'Fit lanes', S: 'Small', M: 'Medium', L: 'Large' }[store.ui.trackSize] || 'Fit lanes'; };
  paintSize();
  sizeBtn?.addEventListener('click', () => {
    store.ui.trackSize = { A: 'S', S: 'M', M: 'L', L: 'A' }[store.ui.trackSize] || 'A';
    try { localStorage.setItem(SIZE_KEY, store.ui.trackSize); } catch { /* private */ }
    paintSize(); rebuildHeaders(); repaint();
  });

  /* The status line: what the tool will do, or what the drag is doing. */
  let sayTimer = 0;
  function say(msg, ms = 0) {
    if (!status) return;
    clearTimeout(sayTimer);
    status.textContent = msg || TOOL_HINT[store.ui.tool];
    status.classList.toggle('is-live', !!msg && msg !== TOOL_HINT[store.ui.tool]);
    if (ms) sayTimer = setTimeout(() => say(''), ms);
  }
  bus.on('timeline:status', ({ msg, ms } = {}) => say(msg, ms));

  const magnet = $('btnMagnet');
  magnet.addEventListener('click', () => {
    store.ui.snap = !store.ui.snap;
    magnet.classList.toggle('is-active', store.ui.snap);
    magnet.setAttribute('aria-pressed', String(store.ui.snap));
    $('tglSnap')?.classList.toggle('is-active', store.ui.snap);
    say(store.ui.snap ? 'Snap on: clips stick to the playhead, markers and each other' : 'Snap off: clips go exactly where you drop them', 2600);
  });

  const RIPPLE_KEY = 'gamecut.ripple';
  const ripple = $('btnRipple');
  const paintRipple = () => {
    ripple.classList.toggle('is-active', !!store.ui.ripple);
    ripple.setAttribute('aria-pressed', String(!!store.ui.ripple));
  };
  try {
    const saved = localStorage.getItem(RIPPLE_KEY);
    store.ui.ripple = saved == null ? true : saved === '1';
  } catch { store.ui.ripple = true; }
  paintRipple();
  ripple.addEventListener('click', () => {
    store.ui.ripple = !store.ui.ripple;
    paintRipple();
    try { localStorage.setItem(RIPPLE_KEY, store.ui.ripple ? '1' : '0'); } catch { /* private window */ }
    say(store.ui.ripple
      ? 'Ripple on: deleting closes the gap, and a clip dropped onto another slots in beside it'
      : 'Ripple off: deleting leaves a gap, and a clip dropped onto another goes on a new layer', 3600);
  });

  const beatBtn = $('btnBeatGrid');
  const beatWell = $('tlBeat');
  const paintBeat = () => {
    beatBtn.classList.toggle('is-active', !!store.ui.beatGrid);
    beatBtn.setAttribute('aria-pressed', String(!!store.ui.beatGrid));
    beatWell?.classList.toggle('is-on', !!store.ui.beatGrid);
  };
  paintBeat();
  beatBtn.addEventListener('click', () => {
    store.ui.beatGrid = !store.ui.beatGrid;
    paintBeat();
    repaint();
  });
  const bpmInput = $('bpmInput');
  bpmInput.value = store.doc.bpm;
  bpmInput.addEventListener('change', () => { cmds.setBPM(+bpmInput.value); repaint(); });
  store.on('doc', () => { if (document.activeElement !== bpmInput) bpmInput.value = store.doc.bpm; });

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

  /* ── Keeping the playhead in sight ──────────────────────── */
  const follow = makeTweener();
  let followUntil = 0;
  const deferFollow = (ms = 900) => {
    follow.stop();
    followUntil = performance.now() + ms;
  };

  function keepPlayheadInView() {
    if (!store.rt.playing) return;
    if (performance.now() < followUntil) return;
    if (!L.W || !store.pxPerSec) return;
    const x = L.t2x(store.rt.playhead);
    const lead = L.W * 0.2;
    if (x <= L.W * 0.82 && x >= 0) return;
    const to = Math.max(0, store.rt.playhead - lead / store.pxPerSec);
    follow.run({
      from: store.ui.scrollX, to, ms: 260, ease: easeOutCubic,
      onStep: (v) => { store.ui.scrollX = v; repaint(); },
    });
  }

  store.on('playhead', keepPlayheadInView);
  store.on('rt', (patch) => { if (patch && 'playing' in patch) follow.stop(); });

  /* ── Overview strip ───────────────────────────────────────── */
  const overview = initOverview({ store, L, repaint, deferFollow, playback });

  /* ── Wiring ───────────────────────────────────────────────── */
  const inter = initTimelineInteractions({ view, store, cmds, history, playback, L, repaint, comp, deferFollow, say });
  menu = inter.menu;

  let lastDur = store.rt.duration;
  store.on('doc', (reason) => {
    if (history.inGesture || store.rt.dragging) return;
    const d = store.rt.duration;
    const before = lastDur;
    lastDur = d;
    if (typeof reason === 'string' && /^(undo|redo):/.test(reason)) return;
    if (!(d > 0) || !L.W) return;
    if (reason === 'replace') { fitAll(0); return; }
    const visibleEnd = store.ui.scrollX + L.W / store.pxPerSec;
    if (before <= 1e-6) fitAll(0);
    else if (d > before * 1.5 && d > visibleEnd) fitAll(0);
  });
  bus.on('timeline:zoom', () => zoomTween.stop());

  bus.on('timeline:reveal', ({ trackId, start, duration } = {}) => {
    // A lane in a folded group cannot be shown, so open the group.
    const tr = store.doc.tracks.find(t => t.id === trackId);
    if (tr && store.ui.folded?.[tr.kind]) {
      store.ui.folded = { ...store.ui.folded, [tr.kind]: false };
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(store.ui.folded)); } catch { /* private */ }
    }
    measure();
    const row = L.rowFor(trackId);
    if (row) {
      const top = RULER_H, bottom = L.H;
      let sy = store.ui.scrollY;
      if (row.y < top) sy -= top - row.y;
      else if (row.y + row.h > bottom) sy += (row.y + row.h) - bottom;
      store.ui.scrollY = Math.max(0, Math.min(L.maxScrollY(), sy));
    }
    if (!fitting && Number.isFinite(start)) {
      const visible = L.W / store.pxPerSec;
      const end = start + (duration || 0);
      if (start < store.ui.scrollX || start > store.ui.scrollX + visible * 0.95) {
        store.ui.scrollX = Math.max(0, start - visible * 0.1);
      } else if (end > store.ui.scrollX + visible && duration < visible) {
        store.ui.scrollX = Math.max(0, end - visible * 0.9);
      }
    }
    store.setRT({ activeTrack: trackId ?? store.rt.activeTrack });
    rebuildHeaders();
    repaint();
  });

  store.on('doc', () => { rebuildHeaders(); repaint(); });
  bus.on('theme', () => { rebuildHeaders(); repaint(); });
  store.on('rt', (patch) => { if (patch && 'activeTrack' in patch) rebuildHeaders(); repaint(); });
  store.on('ui', repaint);
  store.on('selection', repaint);
  store.on('playhead', repaint);
  bus.on('layout', () => { repaint(); });
  bus.on('assets', repaint);
  bus.on('filmstrip', repaint);
  new ResizeObserver(() => { rebuildHeaders(); repaint(); }).observe(view);

  setTool(store.ui.tool, { quiet: true });
  say('');
  rebuildHeaders();
  zoomFit(store, view.clientWidth || 800);
  syncZoomUI();
  repaint();

  return { repaint, L, syncZoomUI, zoomTo, deferFollow, fitAll, setTool, say, menu: inter.menu, KIND_ORDER };
}
