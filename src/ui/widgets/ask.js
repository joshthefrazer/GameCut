/**
 * A small "type a name" box that lives inside the app.
 *
 * The browser's own prompt() is not available in the desktop shell — calling it
 * throws, quietly, and nothing happens. "Save this look" sat behind exactly
 * that call and never once worked. This is the replacement: same idea (a
 * question, an answer, or nothing), drawn by the app so it matches, and safe to
 * type in — the editor's single-key shortcuts cannot fire while it is open.
 *
 * Resolves with the trimmed answer, or null if the person backed out.
 */
export function askText({ title, label = '', value = '', ok = 'Save', placeholder = '', maxLength = 60 } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'askd';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `
      <form class="askd__card">
        <b class="askd__title"></b>
        <label class="askd__label"></label>
        <input class="askd__in" type="text" autocomplete="off" spellcheck="false">
        <div class="askd__row">
          <button type="button" class="askd__no">Cancel</button>
          <button type="submit" class="askd__ok"></button>
        </div>
      </form>`;
    const q = (s) => wrap.querySelector(s);
    q('.askd__title').textContent = title || '';
    q('.askd__label').textContent = label;
    q('.askd__label').hidden = !label;
    q('.askd__ok').textContent = ok;
    const input = q('.askd__in');
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = maxLength;

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      // Nothing typed here may reach the editor's shortcuts.
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    q('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      finish(v || null);
    });
    q('.askd__no').addEventListener('click', () => finish(null));
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) finish(null); });

    document.body.appendChild(wrap);
    input.focus();
    input.select();
  });
}
