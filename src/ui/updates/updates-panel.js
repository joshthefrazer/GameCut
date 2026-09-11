import { bus } from '../../core/events.js';

/**
 * Everything the person sees about updates.
 *
 * Three pieces, and they are separate on purpose:
 *
 *  - A CARD in the corner when a new version has finished downloading. It never
 *    interrupts: nothing is installed until it is clicked, and it does not
 *    appear at all while an export is running, because losing a render to a
 *    reload would be unforgivable.
 *  - A PANEL behind the version chip: what is running, what is available, the
 *    log of everything that has changed, a Check now, and the two escape
 *    hatches — install a file by hand, or go back to the built-in version.
 *  - A WHAT'S NEW card the first time the app opens on a version it has not
 *    shown you yet, so an update that arrived quietly still gets to say what it
 *    brought.
 *
 * None of this decides anything. The address, the key, the version comparison
 * and the verification all live in the main process; this asks and reports.
 */
export function initUpdates({ store }) {
  const api = window.gamecut;
  if (!api?.isDesktop) return { open() {}, refresh() {} };

  let state = null;
  let status = null;
  let card = null;

  /* ── The panel ────────────────────────────────────────────── */
  const el = document.createElement('div');
  el.className = 'upd';
  el.id = 'updPanel';
  el.hidden = true;
  el.innerHTML = `
    <div class="upd__card" role="dialog" aria-modal="true" aria-label="Updates">
      <header class="upd__top">
        <b>Updates</b>
        <button class="upd__x" id="updClose" aria-label="Close">✕</button>
      </header>
      <div class="upd__body" id="updBody"></div>
    </div>`;
  document.body.appendChild(el);
  const body = el.querySelector('#updBody');

  el.querySelector('#updClose').addEventListener('click', close);
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) { e.preventDefault(); close(); }
  });

  function close() {
    el.classList.remove('is-on');
    setTimeout(() => { el.hidden = true; }, 160);
  }
  async function open() {
    // The panel says everything the card says, and better. Two of them on
    // screen at once is just clutter.
    dismissCard();
    await refresh();
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-on'));
  }

  const fmtWhen = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const fmtAgo = (ms) => {
    if (!ms) return 'never';
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)} hours ago`;
    return `${Math.round(mins / 1440)} days ago`;
  };

  /** One line of plain English for whatever the updater is doing. */
  function phaseLine(s) {
    if (!s) return ['Updates', 'Checking is not available in this build.'];
    if (!s.configured) {
      return ['Updates are off in this build',
        'This copy was built without an update address, so it will only ever '
        + 'change when you install a file by hand.'];
    }
    switch (s.phase) {
      case 'checking':     return ['Checking…', 'Asking whether there is a newer version.'];
      case 'downloading':  return [`Downloading ${s.available?.version || ''}`,
        'It is being fetched in the background. Nothing changes until you say so.'];
      case 'ready':        return [`Version ${s.available?.version || s.staged?.version} is ready`,
        'Downloaded and checked. It installs when you click, and takes a second.'];
      case 'needs-installer': return [`Version ${s.available?.version} needs the full installer`,
        'This one changes the app itself, not just the editor, so it cannot '
        + 'install itself. Download it and run it like the first time.'];
      case 'error':        return ['Could not check', s.lastError || 'The update server did not answer.'];
      case 'off':          return ['Updates are off', 'This build has no update key.'];
      default:             return ['Up to date', 'You have the newest version.'];
    }
  }

  function notesList(notes) {
    const ul = document.createElement('ul');
    ul.className = 'upd__notes';
    for (const n of notes || []) {
      const li = document.createElement('li');
      li.textContent = n;
      ul.appendChild(li);
    }
    return ul;
  }

  async function refresh() {
    try { status = await api.updateStatus(); } catch { status = null; }
    state = status?.net || null;
    build();
    paintChip();
  }

  function build() {
    body.innerHTML = '';
    const [head, sub] = phaseLine(state);

    const now = document.createElement('div');
    now.className = 'upd__now';
    now.dataset.phase = state?.phase || 'idle';
    now.innerHTML = `<b></b><span></span>`;
    now.querySelector('b').textContent = head;
    now.querySelector('span').textContent = sub;
    body.appendChild(now);

    if (state?.available?.notes?.length && (state.phase === 'ready' || state.phase === 'needs-installer')) {
      body.appendChild(notesList(state.available.notes));
    }

    /* Actions */
    const row = document.createElement('div');
    row.className = 'upd__actions';

    if (state?.phase === 'ready') {
      row.appendChild(btn('updInstall', 'Install and restart', 'primary', install));
    }
    if (state?.phase === 'needs-installer' && state.available?.installerUrl) {
      row.appendChild(btn('updGetInstaller', 'Download the installer', 'primary', async () => {
        const r = await api.openInstallerPage(state.available.installerUrl);
        if (!r?.ok) bus.emit('toast', { msg: r?.reason || 'Could not open that page.', kind: 'err' });
      }));
    }
    if (state?.configured) {
      row.appendChild(btn('updCheck', 'Check now', '', async () => {
        const b = document.getElementById('updCheck');
        if (b) { b.disabled = true; b.textContent = 'Checking…'; }
        try { await api.checkForUpdate(); } catch { /* reported through state */ }
        await refresh();
      }));
    }
    body.appendChild(row);

    /* What is actually running */
    const facts = document.createElement('dl');
    facts.className = 'upd__facts';
    const put = (k, v) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      facts.append(dt, dd);
    };
    put('Editor version', status?.running?.version || status?.built || '—');
    put('App version', status?.built || '—');
    if (state?.configured) put('Last checked', fmtAgo(state.lastCheck));
    body.appendChild(facts);

    /* The log */
    const hist = state?.history || [];
    if (hist.length) {
      const h = document.createElement('h3');
      h.className = 'upd__h';
      h.textContent = 'What has changed';
      body.appendChild(h);
      for (const entry of hist) {
        const box = document.createElement('section');
        box.className = 'upd__rel';
        const head2 = document.createElement('div');
        head2.className = 'upd__relhead';
        head2.innerHTML = `<b></b><span></span>`;
        head2.querySelector('b').textContent = entry.version;
        head2.querySelector('span').textContent = fmtWhen(entry.published);
        box.appendChild(head2);
        if (entry.notes?.length) box.appendChild(notesList(entry.notes));
        body.appendChild(box);
      }
    }

    /* Escape hatches, last and quiet. */
    const foot = document.createElement('div');
    foot.className = 'upd__foot';
    foot.appendChild(btn('updFromFile', 'Install from a file…', '', async () => {
      const r = await api.installUpdate();
      if (r?.cancelled) return;
      if (!r?.ok) { bus.emit('toast', { msg: r?.reason || 'That update could not be installed.', kind: 'err' }); return; }
      bus.emit('toast', { msg: `Update ${r.version} installed — reloading…`, kind: 'ok' });
    }));
    if (status?.running) {
      foot.appendChild(btn('updRevert', 'Go back to the built-in version', '', async () => {
        await api.revertUpdate();
      }));
    }
    body.appendChild(foot);
  }

  function btn(id, label, kind, onClick) {
    const b = document.createElement('button');
    b.id = id;
    b.className = 'upd__btn' + (kind === 'primary' ? ' upd__btn--primary' : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  async function install() {
    if (store?.rt?.exporting) {
      bus.emit('toast', { msg: 'Finish the export first — installing restarts the editor.', kind: 'err' });
      return;
    }
    const b = document.getElementById('updInstall');
    if (b) { b.disabled = true; b.textContent = 'Installing…'; }
    const r = await api.applyStagedUpdate();
    if (!r?.ok) {
      bus.emit('toast', { msg: r?.reason || 'That update could not be installed.', kind: 'err' });
      await refresh();
      return;
    }
    bus.emit('toast', { msg: `Update ${r.version} installed — reloading…`, kind: 'ok' });
  }

  /* ── The corner card ──────────────────────────────────────── */

  /**
   * Shown once per version, and never over an export.
   *
   * An update that shoulders its way in front of your work is one you learn to
   * dismiss without reading. This waits, says what it is, and gets out of the
   * way — "Later" means later, not in five minutes.
   */
  function showCard() {
    if (card || !state?.available) return;
    if (store?.rt?.exporting) return;
    const v = state.available.version;

    card = document.createElement('div');
    card.className = 'updcard';
    card.id = 'updCard';
    card.innerHTML = `
      <div class="updcard__head">
        <i class="updcard__dot"></i>
        <b></b>
        <button class="updcard__x" id="updCardClose" aria-label="Later">✕</button>
      </div>
      <div class="updcard__body"></div>
      <div class="updcard__row">
        <button class="upd__btn upd__btn--primary" id="updCardGo"></button>
        <button class="upd__btn" id="updCardMore">What&rsquo;s new</button>
      </div>`;
    card.querySelector('b').textContent = `GameCut ${v} is ready`;

    const notes = state.available.notes || [];
    const bodyEl = card.querySelector('.updcard__body');
    if (notes.length) {
      bodyEl.appendChild(notesList(notes.slice(0, 3)));
      if (notes.length > 3) {
        const more = document.createElement('p');
        more.className = 'updcard__more';
        more.textContent = `and ${notes.length - 3} more`;
        bodyEl.appendChild(more);
      }
    } else {
      bodyEl.textContent = 'Downloaded and checked. Nothing changes until you install it.';
    }

    const go = card.querySelector('#updCardGo');
    go.textContent = state.available.needsInstaller ? 'Get the installer' : 'Install and restart';
    go.addEventListener('click', () => {
      if (state.available.needsInstaller) { dismissCard(); open(); return; }
      install();
    });
    card.querySelector('#updCardMore').addEventListener('click', () => { dismissCard(); open(); });
    card.querySelector('#updCardClose').addEventListener('click', dismissCard);

    document.body.appendChild(card);
    placeCard();
    requestAnimationFrame(() => card.classList.add('is-on'));
  }

  /**
   * Sit the card just above the timeline rather than on top of it.
   *
   * Bottom-left is the right corner — the toasts own bottom-right — but the
   * bottom-left of the window is the track headers, and covering the name of
   * the track you are working on to tell you about an update is exactly the
   * kind of thing that makes people close these without reading them.
   */
  function placeCard() {
    if (!card) return;
    const tl = document.getElementById('timelinePanel');
    const gap = 14;
    const above = tl ? window.innerHeight - tl.getBoundingClientRect().top + gap : 18;
    card.style.bottom = Math.max(18, Math.round(above)) + 'px';
  }
  bus.on('layout', placeCard);

  function dismissCard() {
    card?.classList.remove('is-on');
    const c = card;
    card = null;
    setTimeout(() => c?.remove(), 200);
  }

  /* ── "What's new", after an update has landed ─────────────── */
  function showWhatsNew(whats) {
    if (!whats?.notes?.length) return;
    const n = document.createElement('div');
    n.className = 'updcard updcard--new';
    n.id = 'updWhatsNew';
    n.innerHTML = `
      <div class="updcard__head"><i class="updcard__dot"></i><b></b>
        <button class="updcard__x" id="updNewClose" aria-label="Close">✕</button></div>
      <div class="updcard__body"></div>`;
    n.querySelector('b').textContent = `You are now on ${whats.version}`;
    n.querySelector('.updcard__body').appendChild(notesList(whats.notes));
    n.querySelector('#updNewClose').addEventListener('click', () => {
      n.classList.remove('is-on');
      setTimeout(() => n.remove(), 200);
    });
    document.body.appendChild(n);
    requestAnimationFrame(() => n.classList.add('is-on'));
    api.markUpdateSeen?.(whats.version);
  }

  /* ── The version chip ─────────────────────────────────────── */
  const chip = document.getElementById('verChip');
  function paintChip() {
    if (!chip) return;
    const running = status?.running;
    const v = running?.version || status?.built || '—';
    chip.textContent = 'v' + v;
    chip.classList.toggle('is-updated', !!running);
    const waiting = state?.phase === 'ready' || state?.phase === 'needs-installer';
    chip.classList.toggle('has-update', waiting);
    chip.setAttribute('aria-label', waiting
      ? `Version ${v}. Version ${state.available?.version} is waiting — click to see it.`
      : `Version ${v}. Click for updates and what has changed.`);
  }

  /* ── Wiring ───────────────────────────────────────────────── */
  chip?.addEventListener('click', open);

  api.onUpdateState?.((s) => {
    state = s;
    paintChip();
    if (!el.hidden) build();
    if (s.phase === 'ready' || s.phase === 'needs-installer') showCard();
  });

  refresh().then(() => {
    if (status?.whatsNew) showWhatsNew(status.whatsNew);
    if (state?.phase === 'ready' || state?.phase === 'needs-installer') showCard();
  });

  /* Test seam: the suite has to be able to ask for the card without standing
     up a server, precisely so it can prove the card does NOT appear during an
     export. It goes through the same guard the real path does. */
  function __test_offer() {
    state = { ...(state || {}), phase: 'ready',
              available: { version: '99.0.0', notes: ['test'], needsInstaller: false } };
    showCard();
  }

  return { open, close, refresh, __test_offer, get state() { return state; } };
}
