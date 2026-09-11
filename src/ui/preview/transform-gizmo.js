import { clamp } from '../../core/time.js';

const HANDLES = [
  ['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0],
  ['w', 0, .5],               ['e', 1, .5],
  ['sw', 0, 1], ['s', .5, 1], ['se', 1, 1],
];

/**
 * On-canvas transform gizmo. Operates in normalized frame space so the same
 * numbers drive preview, timeline keyframes and the export renderer.
 *
 * Shift  — uniform / axis-locked
 * Alt    — scale about the centre
 */
export class Gizmo {
  constructor({ overlay, store, comp, cmds, history, onChange }) {
    this.overlay = overlay;
    this.store = store;
    this.comp = comp;
    this.cmds = cmds;
    this.history = history;
    this.onChange = onChange;
    this.el = null;
    this.clip = null;
  }

  detach() { this.el?.remove(); this.el = null; this.clip = null; }

  /** Rebuild for the current selection, or hide. */
  sync(t) {
    const sel = this.store.selectedClips
      .filter(({ track }) => track.kind !== 'audio')
      .filter(({ clip }) => t >= clip.start && t < clip.start + clip.duration);

    if (sel.length !== 1) { this.detach(); return; }
    const clip = sel[0].clip;
    if (!this.el || this.clip?.id !== clip.id) { this.detach(); this.#build(clip); }
    this.clip = clip;
    this.#place(t);
  }

  #build(clip) {
    const g = document.createElement('div');
    g.className = 'gizmo';
    g.innerHTML =
      `<div class="gizmo__hitbox"></div><div class="gizmo__box"></div>` +
      `<div class="gizmo__rot" data-h="rot"></div>` +
      `<div class="gizmo__label"></div>` +
      HANDLES.map(([h, x, y]) =>
        `<div class="gizmo__h" data-h="${h}" style="left:${x * 100}%;top:${y * 100}%"></div>`).join('');
    this.overlay.appendChild(g);
    this.el = g;
    g.querySelector('.gizmo__label').textContent = clip.name || clip.type;

    g.addEventListener('pointerdown', (e) => {
      const h = e.target.dataset.h;
      e.preventDefault(); e.stopPropagation();
      if (h === 'rot') this.#drag(e, 'rot');
      else if (h) this.#drag(e, h);
      else this.#drag(e, 'move');
    });
  }

  #place(t) {
    const b = this.comp.bounds(this.clip, t);
    const s = this.el.style;
    s.left   = (b.cx - b.w / 2) * 100 + '%';
    s.top    = (b.cy - b.h / 2) * 100 + '%';
    s.width  = b.w * 100 + '%';
    s.height = b.h * 100 + '%';
    s.transform = `rotate(${b.rot}deg)`;
  }

  #rect() { return this.overlay.getBoundingClientRect(); }

  #drag(e, mode) {
    const clip = this.clip;
    const rect = this.#rect();
    const t = this.store.rt.playhead;
    const start = {
      x: clip.transform.x, y: clip.transform.y,
      scale: clip.transform.scale, rot: clip.transform.rotation,
      w: clip.transform.w, h: clip.transform.h,
      px: e.clientX, py: e.clientY,
    };
    const b0 = this.comp.bounds(clip, t);
    this.history.begin('Transform', 'gizmo:' + clip.id);

    const move = (ev) => {
      const dx = (ev.clientX - start.px) / rect.width;
      const dy = (ev.clientY - start.py) / rect.height;

      if (mode === 'move') {
        let nx = start.x + dx, ny = start.y + dy;
        if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (ny = start.y) : (nx = start.x);
        if (this.store.ui.snap) { nx = snapTo(nx, [0.5, 0.05, 0.95]); ny = snapTo(ny, [0.5, 0.05, 0.95]); }
        clip.transform.x = clamp(nx, -0.5, 1.5);
        clip.transform.y = clamp(ny, -0.5, 1.5);
      } else if (mode === 'rot') {
        const cx = rect.left + b0.cx * rect.width;
        const cy = rect.top + b0.cy * rect.height;
        let deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        clip.transform.rotation = Math.round(deg * 10) / 10;
      } else {
        // Corner/edge scale — distance ratio from the anchor point.
        const signX = mode.includes('e') ? 1 : mode.includes('w') ? -1 : 0;
        const signY = mode.includes('s') ? 1 : mode.includes('n') ? -1 : 0;
        const dw = signX ? (dx * signX * 2) / Math.max(b0.w, .001) : 0;
        const dh = signY ? (dy * signY * 2) / Math.max(b0.h, .001) : 0;
        const f = 1 + (signX && signY ? Math.max(dw, dh) : signX ? dw : dh);
        if (clip.type === 'shape' && !ev.shiftKey && (signX === 0 || signY === 0)) {
          if (signX) clip.transform.w = Math.max(.01, start.w * (1 + dw));
          if (signY) clip.transform.h = Math.max(.01, start.h * (1 + dh));
        } else {
          clip.transform.scale = Math.max(0.02, start.scale * f);
        }
      }
      this.onChange?.();
      this.#place(this.store.rt.playhead);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.history.commit();
      this.onChange?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

function snapTo(v, targets, tol = 0.012) {
  for (const t of targets) if (Math.abs(v - t) < tol) return t;
  return v;
}
