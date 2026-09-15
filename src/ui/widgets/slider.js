/**
 * A fader.
 *
 * Numbers you can drag are fine for a position or an angle, where you want a
 * precise figure and have no idea in advance what it should be. Volume is the
 * opposite: you know roughly where you want it, you want to see how far along
 * the range you are without reading anything, and you want to get back to
 * normal instantly when you overdo it. So: a track you can see, a fill you can
 * judge at a glance, a notch at the default, and double-click to go home.
 *
 * Click anywhere on the track to jump there, then keep dragging — the pointer
 * is captured, so the value keeps following even when the cursor leaves the
 * widget, which is what people do when they push a fader hard.
 */
export function slider({
  value = 1, min = 0, max = 2, step = 0.01,
  /** Where double-click returns to, and where the notch is drawn. */
  reset = null,
  /** Turn a number into what the readout says. */
  format = (v) => `${Math.round(v * 100)}%`,
  /**
   * Fired once, as the gesture begins, before anything has changed.
   *
   * A fader that writes straight onto the document while it moves has already
   * changed the document by the time it commits — so the "before" snapshot the
   * undo system takes on commit is identical to the "after", and one Ctrl+Z
   * does nothing. Whoever owns the value uses this to remember where it started
   * and put it back for the instant the command is issued.
   */
  onStart,
  onInput, onCommit,
} = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sldr';
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'slider');
  wrap.setAttribute('aria-valuemin', String(min));
  wrap.setAttribute('aria-valuemax', String(max));

  wrap.innerHTML = `
    <div class="sldr__track">
      ${reset != null ? '<i class="sldr__notch"></i>' : ''}
      <div class="sldr__fill"></div>
      <div class="sldr__knob"></div>
    </div>
    <output class="sldr__val"></output>`;

  const track = wrap.querySelector('.sldr__track');
  const fill = wrap.querySelector('.sldr__fill');
  const knob = wrap.querySelector('.sldr__knob');
  const out = wrap.querySelector('.sldr__val');
  const notch = wrap.querySelector('.sldr__notch');

  const clamp = (v) => Math.min(max, Math.max(min, v));
  const quant = (v) => Math.round(v / step) * step;
  const frac = (v) => (v - min) / (max - min || 1);

  let current = clamp(value);

  function paint() {
    const p = Math.max(0, Math.min(1, frac(current))) * 100;
    fill.style.width = p + '%';
    knob.style.left = p + '%';
    out.textContent = format(current);
    wrap.setAttribute('aria-valuenow', current.toFixed(3));
    wrap.setAttribute('aria-valuetext', out.textContent);
  }
  if (notch) notch.style.left = (frac(reset) * 100) + '%';

  function valueAt(clientX) {
    const r = track.getBoundingClientRect();
    return clamp(quant(min + ((clientX - r.left) / (r.width || 1)) * (max - min)));
  }

  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    wrap.focus();
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add('is-dragging');
    onStart?.(current);

    // Fine mode: hold Shift and the fader moves at a fifth of your hand, so the
    // last two percent is reachable without a mouse made of glass.
    let anchorX = e.clientX;
    let anchorV = valueAt(e.clientX);
    current = anchorV; paint(); onInput?.(current);

    const move = (ev) => {
      if (ev.shiftKey) {
        const r = track.getBoundingClientRect();
        current = clamp(quant(anchorV + ((ev.clientX - anchorX) / (r.width || 1)) * (max - min) * 0.2));
      } else {
        current = valueAt(ev.clientX);
        anchorX = ev.clientX; anchorV = current;   // so releasing Shift is seamless
      }
      paint();
      onInput?.(current);
    };
    const up = () => {
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerup', up);
      wrap.classList.remove('is-dragging');
      onCommit?.(current);
    };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', up);
  });

  wrap.addEventListener('dblclick', () => {
    if (reset == null) return;
    onStart?.(current);
    current = clamp(reset);
    paint();
    onInput?.(current);
    onCommit?.(current);
  });

  wrap.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    let d = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = step * big;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -step * big;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();          // never let an arrow key nudge the clip as well
    onStart?.(current);
    current = clamp(quant(current + d));
    paint();
    onInput?.(current);
    onCommit?.(current);
  });

  paint();
  wrap.setValue = (v) => { current = clamp(v); paint(); };
  wrap.getValue = () => current;
  return wrap;
}

/** A small on/off pill — mute, solo, "show this". */
export function toggleBtn({ label, on = false, title = '', onChange }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tgl' + (on ? ' is-on' : '');
  b.textContent = label;
  if (title) b.title = title;
  b.setAttribute('aria-pressed', String(!!on));
  b.addEventListener('click', () => {
    on = !on;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
    onChange?.(on);
  });
  b.setOn = (v) => {
    on = !!v;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  };
  return b;
}
