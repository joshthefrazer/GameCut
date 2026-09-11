/**
 * Scrubbable numeric field. Drag horizontally to change; click to type.
 * Shift = ×0.2 precision, Ctrl/Cmd = ×5 coarse.
 */
export function numField({ label = '', value = 0, min = -Infinity, max = Infinity,
                           step = 0.01, decimals = 2, suffix = '', onInput, onCommit }) {
  const wrap = document.createElement('div');
  wrap.className = 'num';
  wrap.innerHTML = label ? `<span class="num__k">${label}</span>` : '';
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  wrap.appendChild(input);

  const fmt = (v) => (decimals === 0 ? Math.round(v) : (+v).toFixed(decimals)) + suffix;
  const parse = (s) => {
    const n = parseFloat(String(s).replace(/[^\d.eE+-]/g, ''));
    return Number.isFinite(n) ? n : value;
  };
  const clampv = (v) => Math.min(max, Math.max(min, v));

  let current = value;
  input.value = fmt(current);

  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === input && document.activeElement === input) return;
    e.preventDefault();
    const x0 = e.clientX, v0 = current;
    let moved = false;
    const move = (ev) => {
      const mult = ev.shiftKey ? 0.2 : (ev.ctrlKey || ev.metaKey) ? 5 : 1;
      const d = (ev.clientX - x0) * step * mult;
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      current = clampv(v0 + d);
      input.value = fmt(current);
      onInput?.(current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) onCommit?.(current);
      else { input.focus(); input.select(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const commit = () => {
    current = clampv(parse(input.value));
    input.value = fmt(current);
    onInput?.(current);
    onCommit?.(current);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { input.blur(); e.stopPropagation(); }
    if (e.key === 'Escape') { input.value = fmt(current); input.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1) * 10;
      current = clampv(current + d);
      input.value = fmt(current);
      onInput?.(current); onCommit?.(current);
    }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());

  wrap.setValue = (v) => { current = v; if (document.activeElement !== input) input.value = fmt(v); };
  return wrap;
}

export function row(labelText, ...controls) {
  const r = document.createElement('div');
  r.className = 'row';
  const l = document.createElement('label');
  l.textContent = labelText;
  r.appendChild(l);
  if (controls.length === 1) r.appendChild(controls[0]);
  else {
    const pair = document.createElement('div');
    pair.className = 'row__pair';
    controls.forEach(c => pair.appendChild(c));
    r.appendChild(pair);
  }
  return r;
}

export function group(title, open = true) {
  const g = document.createElement('section');
  g.className = 'group' + (open ? '' : ' is-closed');
  g.innerHTML = `<button class="group__h">
      <svg class="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>${title}
    </button><div class="group__c"></div>`;
  g.querySelector('.group__h').addEventListener('click', () => g.classList.toggle('is-closed'));
  g.body = g.querySelector('.group__c');
  return g;
}
