import { bus, raf } from '../../core/events.js';
import { drawGuides } from './safe-guides.js';
import { Gizmo } from './transform-gizmo.js';
import { initCropTool } from './crop-tool.js';
import { initTextEdit } from './text-edit.js';
import { ASPECTS } from '../../project/presets.js';

export function initPreview({ store, comp, playback, cmds, history }) {
  const viewport = document.getElementById('previewViewport');
  const frame    = document.getElementById('previewFrame');
  const overlay  = document.getElementById('previewOverlay');
  const guidesEl = document.getElementById('previewGuides');
  const resChip  = document.getElementById('resChip');
  const fpsChip  = document.getElementById('fpsChip');
  const projMeta = document.getElementById('projMeta');

  const gizmo = new Gizmo({
    overlay, store, comp, cmds, history,
    onChange: () => { comp.render(); bus.emit('inspector:refresh'); },
  });

  /* ── Frame sizing: contain the project aspect in the viewport ─ */
  const fit = () => {
    const vr = viewport.getBoundingClientRect();
    const pad = 36;
    const availW = Math.max(80, vr.width - pad);
    const availH = Math.max(60, vr.height - pad);
    const ar = store.doc.width / store.doc.height;
    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    frame.style.width = Math.round(w) + 'px';
    frame.style.height = Math.round(h) + 'px';
    redrawGuides();
    bus.emit('preview:fit');
  };

  const redrawGuides = () => drawGuides(guidesEl, {
    w: store.doc.width, h: store.doc.height, aspect: store.doc.aspect,
    guides: store.ui.guides, grid: store.ui.grid,
  });

  const seg = document.getElementById('aspectSeg');

  /**
   * Every readout of the project format is derived from the document here, and
   * this runs on the `doc` event. Setting the active pill at click time instead
   * left it lying after an undo — the project would be back at 1920×1080 with
   * 9:16 still lit. A custom resolution lights nothing, which is honest.
   */
  const syncMeta = () => {
    resChip.textContent = `${store.doc.width} × ${store.doc.height}`;
    projMeta.textContent = `${store.doc.width}×${store.doc.height} · ${store.doc.fps}fps`;
    seg.querySelectorAll('.seg__btn').forEach(b =>
      b.classList.toggle('is-active', b.dataset.ar === store.doc.aspect));
  };

  /* ── FPS meter + quality governor ─────────────────────────── */

  /**
   * Automatic preview quality.
   *
   * A 1080p source composited into a full-size preview canvas measures ~32ms a
   * frame, which caps playback near 30fps no matter how fast the machine is;
   * at half size the same paint is effectively free. Rather than expect anyone
   * to know that, the preview drops a step whenever paints are overrunning the
   * frame budget and returns to the chosen quality when the transport stops.
   * Premiere and Resolve both do exactly this, and for the same reason.
   */
  const STEPS = [1, 0.5, 0.25];
  const BUDGET_MS = 11;            // of a 16.7ms frame, leaving room for decode
  let paintAvg = 0, sampled = 0, lastDrop = 0;

  const label = (q) => (q >= 1 ? 'full' : q >= 0.5 ? 'half' : 'quarter');

  const govern = (paintMs) => {
    if (!store.rt.playing || paintMs <= 0) return;
    // Exponential average — one slow frame shouldn't move the picture quality.
    paintAvg = paintAvg ? paintAvg * 0.85 + paintMs * 0.15 : paintMs;
    if (++sampled < 25) return;

    const chosen = store.ui.previewScale || 1;
    const current = store.rt.renderScale || chosen;
    const idx = STEPS.indexOf(current);
    if (idx < 0) return;
    const now = performance.now();

    if (paintAvg > BUDGET_MS && idx < STEPS.length - 1 && now - lastDrop > 1500) {
      store.rt.renderScale = STEPS[idx + 1];
      lastDrop = now;
      paintAvg = 0; sampled = 0;
      comp.resize();
      bus.emit('toast', {
        msg: `Preview dropped to ${label(store.rt.renderScale)} to keep playback smooth`,
      });
      return;
    }

    /**
     * Climb back while still playing.
     *
     * A heavy second at the head of a clip used to leave the rest of a
     * twenty-minute pass looking soft, because quality was only ever given back
     * on pause. Recovery is deliberately harder to trigger than a drop — well
     * under half the budget, and a long cooldown — so the two can't ping-pong.
     */
    if (paintAvg < BUDGET_MS * 0.4 && idx > 0 && STEPS[idx - 1] <= chosen
        && now - lastDrop > 4000) {
      const next = STEPS[idx - 1];
      store.rt.renderScale = next === chosen ? null : next;
      lastDrop = now;
      paintAvg = 0; sampled = 0;
      comp.resize();
    }
  };

  /** Give back the chosen quality once nothing is racing the clock. */
  const restoreQuality = () => {
    if (!store.rt.renderScale) return;
    store.rt.renderScale = null;
    paintAvg = 0; sampled = 0;
    comp.resize();
    comp.render();
  };

  /**
   * The number on the chip is *pictures reaching the screen* — frames actually
   * painted, not transport ticks. Counting ticks reported a confident 60 while
   * the picture visibly stuttered, because the transport runs at display rate
   * whether or not a decoder produced anything to show.
   *
   * The tooltip splits it in two: how many frames the decoder delivered versus
   * how many were painted. When those two disagree the bottleneck is decode,
   * not compositing, and no amount of preview-quality dropping will help.
   */
  let frames = 0, decoded0 = 0, last = performance.now();
  const meter = (painted) => {
    const q = store.rt.renderScale || store.ui.previewScale || 1;
    const suffix = q < 1 ? ` · ${label(q)}` : '';
    if (!store.rt.playing) {
      fpsChip.textContent = `${store.doc.fps} fps${suffix}`;
      fpsChip.title = 'Project frame rate. Starts measuring once you press play.';
      frames = 0; last = performance.now(); decoded0 = comp.pool.decodedFrames;
      return;
    }
    if (painted) frames++;
    const now = performance.now();
    const span = now - last;
    if (span > 500) {
      const shown = Math.round((frames * 1000) / span);
      const dec = Math.round(((comp.pool.decodedFrames - decoded0) * 1000) / span);
      fpsChip.textContent = `${shown} fps${suffix}`;
      fpsChip.title = dec > 0
        ? `${shown} pictures a second on screen · video decoding at ${dec} fps`
        : `${shown} pictures a second on screen`;
      frames = 0; last = now; decoded0 = comp.pool.decodedFrames;
    }
  };

  playback.onTick = (t, paintMs, painted) => { meter(painted); govern(paintMs); gizmo.sync(t); };
  store.on('rt', (patch) => { if ('playing' in patch && !patch.playing) restoreQuality(); });

  /* ── Crop tool ────────────────────────────────────────────── */
  const cropBtn = document.getElementById('btnCrop');
  const crop = initCropTool({
    overlay, store, comp, cmds, playback,
    onDone: (on) => cropBtn?.classList.toggle('is-active', on),
  });
  cropBtn?.addEventListener('click', () => crop.toggle());
  // The right-click menu on a clip offers the crop tool too, so it needs a way
  // in that does not depend on holding a reference to the preview panel.
  bus.on('crop:start', () => crop.arm());

  /* ── Typing straight onto the picture ─────────────────────── */
  const textEdit = initTextEdit({ overlay, frame, store, comp, cmds, playback });

  /* ── Canvas selection ─────────────────────────────────────── */
  overlay.addEventListener('pointerdown', (e) => {
    if (crop.isArmed()) return;          // the crop tool owns the drag
    if (textEdit.isEditing()) return;    // so is the text field
    if (e.target !== overlay) return;
    const r = overlay.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top) / r.height;
    const hit = comp.hitTest(nx, ny, store.rt.playhead);
    store.select(hit ? [hit.id] : []);
  });
  overlay.style.pointerEvents = 'auto';

  /* ── Aspect ratio presets ─────────────────────────────────── */
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg__btn');
    if (!btn) return;
    const preset = ASPECTS[btn.dataset.ar];
    if (!preset) return;
    cmds.setResolution(preset);          // the doc listener re-syncs the pills
    comp.resize();
    syncMeta(); fit();
    comp.render();
    bus.emit('toast', { msg: `${preset.aspect} — ${preset.label}` });
  });

  /* ── Preview quality ──────────────────────────────────────── */
  const qSel = document.getElementById('previewQuality');
  if (qSel) {
    qSel.value = String(store.ui.previewScale ?? 0.5);
    qSel.addEventListener('change', () => {
      store.ui.previewScale = parseFloat(qSel.value) || 1;
      store.rt.renderScale = null;         // an explicit choice overrides the governor
      comp.resize();
      comp.render();
      fit();
      bus.emit('toast', {
        msg: `Preview at ${qSel.selectedOptions[0].textContent.toLowerCase()} quality — exports are unaffected`,
      });
    });
  }

  /* ── Fullscreen ───────────────────────────────────────────── */
  const panel = document.getElementById('previewPanel');
  const fsBtn = document.getElementById('btnFullscreen');
  const icoEnter = fsBtn?.querySelector('.ico-fsEnter');
  const icoExit = fsBtn?.querySelector('.ico-fsExit');

  const isFullscreen = () => document.fullscreenElement === panel;

  async function toggleFullscreen() {
    try {
      if (isFullscreen()) await document.exitFullscreen();
      else await panel.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      bus.emit('toast', { msg: 'Fullscreen was refused by the window', kind: 'err' });
      console.warn('fullscreen failed', err);
    }
  }

  fsBtn?.addEventListener('click', toggleFullscreen);

  // The frame is sized from the viewport's box, which changes the moment we
  // enter or leave fullscreen — refit after the browser has settled the layout.
  document.addEventListener('fullscreenchange', () => {
    const on = isFullscreen();
    // toggleAttribute, not `.hidden` — see the note in transport.js: SVG
    // elements have no `hidden` IDL property, so assigning it does nothing.
    icoEnter?.toggleAttribute('hidden', on);
    icoExit?.toggleAttribute('hidden', !on);
    fsBtn?.classList.toggle('is-active', on);
    if (fsBtn) fsBtn.title = on ? 'Exit fullscreen (F or Esc)' : 'Fullscreen preview (F)';
    // Fit immediately so the picture is never briefly the old size, then again
    // on the next frame once the browser has finished settling the new box.
    // The normal ResizeObserver path is rAF-coalesced, which is a beat too late
    // for a transition this visible.
    fit();
    requestAnimationFrame(() => { fit(); gizmo.sync(store.rt.playhead); });
  });

  /* ── View toggles ─────────────────────────────────────────── */
  const bindToggle = (id, key, after) => {
    const el = document.getElementById(id);
    el.addEventListener('click', () => {
      store.ui[key] = !store.ui[key];
      el.classList.toggle('is-active', store.ui[key]);
      after?.();
    });
  };
  bindToggle('tglGuides', 'guides', redrawGuides);
  bindToggle('tglGrid', 'grid', redrawGuides);
  bindToggle('tglSnap', 'snap', () => {
    document.getElementById('btnMagnet').classList.toggle('is-active', store.ui.snap);
  });

  /* ── Wiring ───────────────────────────────────────────────── */
  const refit = raf(fit);
  bus.on('layout', refit);
  new ResizeObserver(refit).observe(viewport);
  store.on('selection', () => gizmo.sync(store.rt.playhead));
  store.on('doc', () => { comp.resize(); syncMeta(); fit(); comp.render(); gizmo.sync(store.rt.playhead); });
  store.on('playhead', () => gizmo.sync(store.rt.playhead));

  syncMeta();
  fit();
  comp.render(0);

  return { fit, gizmo, crop, textEdit, toggleFullscreen, isFullscreen };
}
