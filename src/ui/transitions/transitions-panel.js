import { bus, raf } from '../../core/events.js';
import {
  TRANSITION_PICKS, DEFAULT_TRANS_DUR, pickFor, junctions, maxDurFor,
} from '../../engine/transitions.js';

/**
 * The transitions browser — a panel of pictures, not a dropdown of words.
 *
 * The old way to set a transition was: select exactly the right clip, find a
 * group in the Inspector, and read four names. Nobody found it, and that is a
 * fair verdict on the design rather than on the person. You choose a transition
 * by looking at it, so this is a grid of tiles that each show what they do,
 * sitting in the left panel next to your footage — the same place CapCut puts
 * it, for the same reason.
 *
 * What it acts on is the CUT, not the clip. Pick a cut by clicking the badge on
 * the timeline (or by selecting the clip on the right of it) and the whole panel
 * points at that seam: the current choice is lit, the length applies to it, and
 * hovering a tile says what it will do.
 */
export function initTransitions({ store, cmds, comp, playback }) {
  const root = document.getElementById('transRoot');
  if (!root) return { refresh() {} };

  const rerender = raf(build);

  /* ── Which cut are we pointing at? ─────────────────────────── */

  /**
   * The selected junction, resolved against the live document.
   *
   * Falls back to the selection: if you have a clip selected and there is a cut
   * immediately before it, that is obviously the cut you mean, and making you
   * click a second target to say so would be pedantry.
   */
  function target() {
    const all = junctions(store.doc);
    const byId = (id) => all.find(j => j.next.id === id) || null;
    return byId(store.rt.junction)
        || byId(store.rt.selection[0])
        || null;
  }

  function apply(pick) {
    const j = target();
    if (!j) {
      bus.emit('toast', {
        msg: 'Pick a cut first — click the ⋈ button between two clips on the timeline.',
        ms: 4200,
      });
      return;
    }
    const cur = j.next.transIn;
    const next = pick === null ? null : {
      kind: pick.kind,
      dur: Math.min(cur?.dur ?? DEFAULT_TRANS_DUR, maxDurFor(j.prev, j.next)),
      dir: pick.dir || 'left',
    };
    cmds.setClipProp(j.next.id, 'transIn', next, { merge: false, label: 'Transition' });
    store.setRT({ junction: j.next.id });

    // Park on the middle of the transition and draw it, so the thing you just
    // chose is on screen rather than described.
    if (next) {
      playback.pause();
      playback.seek(j.t);
    }
    comp.render();
    bus.emit('inspector:refresh');
    rerender();
  }

  function setDur(v) {
    const j = target();
    if (!j || !j.next.transIn) return;
    const dur = Math.max(0.1, Math.min(v, maxDurFor(j.prev, j.next)));
    cmds.setClipProp(j.next.id, 'transIn', { ...j.next.transIn, dur },
      { merge: false, label: 'Transition length' });
    comp.render();
    rerender();
  }

  /* ── Tile artwork ─────────────────────────────────────────── */

  /**
   * Each tile draws the effect rather than naming it.
   *
   * Two coloured panels standing in for two shots, arranged the way the
   * transition arranges them halfway through. It is a diagram, not a preview,
   * and a diagram is the honest thing here: a real preview would need two
   * decoders per tile running all the time, for six tiles, to say something a
   * drawing says in one glance.
   */
  function art(pick) {
    const A = '#2563eb', B = '#22d3ee';
    const box = (x, y, w, h, fill, op = 1) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${fill}" opacity="${op}"/>`;

    if (pick.kind === 'dissolve') {
      return `<svg viewBox="0 0 64 36" aria-hidden="true">
        <defs><linearGradient id="gDis" x1="0" x2="1">
          <stop offset="0" stop-color="${A}"/><stop offset="1" stop-color="${B}"/>
        </linearGradient></defs>
        ${box(2, 2, 60, 32, 'url(#gDis)')}
      </svg>`;
    }
    if (pick.kind === 'dip') {
      return `<svg viewBox="0 0 64 36" aria-hidden="true">
        <defs><linearGradient id="gDip" x1="0" x2="1">
          <stop offset="0" stop-color="${A}"/><stop offset="0.5" stop-color="#05070d"/>
          <stop offset="1" stop-color="${B}"/>
        </linearGradient></defs>
        ${box(2, 2, 60, 32, 'url(#gDip)')}
      </svg>`;
    }
    // Slide: two panels mid-push, with an arrow saying which way they are going.
    const arrows = {
      left:  'M40 18 H24 M29 13 L24 18 L29 23',
      right: 'M24 18 H40 M35 13 L40 18 L35 23',
      up:    'M32 26 V10 M27 15 L32 10 L37 15',
      down:  'M32 10 V26 M27 21 L32 26 L37 21',
    };
    const horiz = pick.dir === 'left' || pick.dir === 'right';
    const first = pick.dir === 'left' || pick.dir === 'up';
    const a = horiz
      ? box(2, 2, 30, 32, A) : box(2, 2, 60, 15, A);
    const b = horiz
      ? box(34, 2, 28, 32, B) : box(2, 19, 60, 15, B);
    return `<svg viewBox="0 0 64 36" aria-hidden="true">
      ${first ? a + b : b + a}
      <path d="${arrows[pick.dir]}" fill="none" stroke="#fff" stroke-width="2.2"
            stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>
    </svg>`;
  }

  /* ── Build ────────────────────────────────────────────────── */
  function build() {
    const j = target();
    const cur = j ? pickFor(j.next) : null;
    root.innerHTML = '';

    /* Which cut, in words. */
    const head = document.createElement('div');
    head.className = 'trs__head';
    if (j) {
      head.innerHTML = `<b>The cut you picked</b><span></span>`;
      head.querySelector('span').textContent =
        `${j.prev.name || 'clip'} → ${j.next.name || 'clip'} · ${j.t.toFixed(2)}s on ${j.track.name}`;
    } else {
      const n = junctions(store.doc).length;
      head.innerHTML = `<b>No cut picked</b><span></span>`;
      head.querySelector('span').textContent = n
        ? `Click the ⋈ button on any of the ${n} cut${n === 1 ? '' : 's'} on your timeline.`
        : 'Put two clips next to each other on one track and a ⋈ button appears on the join.';
    }
    root.appendChild(head);

    /* The grid. */
    const grid = document.createElement('div');
    grid.className = 'trs__grid';
    for (const pick of TRANSITION_PICKS) {
      const b = document.createElement('button');
      b.className = 'trs' + (cur?.key === pick.key ? ' is-on' : '');
      b.dataset.pick = pick.key;
      b.disabled = !j;
      b.innerHTML = `<span class="trs__art">${art(pick)}</span><span class="trs__name"></span>`;
      b.querySelector('.trs__name').textContent = pick.name;
      b.title = pick.blurb;
      b.addEventListener('click', () => apply(pick));
      grid.appendChild(b);
    }
    root.appendChild(grid);

    /* Length + remove, only once there is something to adjust. */
    if (j && cur) {
      const max = maxDurFor(j.prev, j.next);
      const dur = Math.min(j.next.transIn.dur ?? DEFAULT_TRANS_DUR, max);

      const wrap = document.createElement('div');
      wrap.className = 'trs__len';
      wrap.innerHTML = `
        <label for="transDur">How long <b id="transDurVal"></b></label>
        <input type="range" class="rng" id="transDur" min="0.1" step="0.05">
        <p class="trs__note"></p>`;
      const rng = wrap.querySelector('#transDur');
      const val = wrap.querySelector('#transDurVal');
      rng.max = String(max.toFixed(2));
      rng.value = String(dur);
      val.textContent = dur.toFixed(2) + 's';
      rng.addEventListener('input', () => {
        val.textContent = (+rng.value).toFixed(2) + 's';
        const t = target();
        if (t?.next.transIn) { t.next.transIn.dur = +rng.value; comp.render(); }
      });
      rng.addEventListener('change', () => setDur(+rng.value));
      wrap.querySelector('.trs__note').textContent =
        'It sits across the cut — half before, half after — so the shot still '
        + 'changes exactly where you cut it.';
      root.appendChild(wrap);

      const off = document.createElement('button');
      off.className = 'trs__off';
      off.id = 'transRemove';
      off.textContent = 'Remove — go back to a hard cut';
      off.addEventListener('click', () => apply(null));
      root.appendChild(off);

      const all = document.createElement('button');
      all.className = 'trs__all';
      all.id = 'transAll';
      all.textContent = `Use this on every cut (${junctions(store.doc).length})`;
      all.addEventListener('click', () => {
        const list = junctions(store.doc);
        if (!list.length) return;
        for (const k of list) {
          cmds.setClipProp(k.next.id, 'transIn', {
            kind: cur.kind, dir: cur.dir || 'left',
            dur: Math.min(dur, maxDurFor(k.prev, k.next)),
          }, { merge: false, label: 'Transition on every cut' });
        }
        comp.render();
        bus.emit('toast', { msg: `${cur.name} on all ${list.length} cuts`, kind: 'ok' });
        rerender();
      });
      root.appendChild(all);
    }
  }

  /* ── Opening the tab ──────────────────────────────────────── */
  function open() {
    const tab = document.querySelector('#leftTabs [data-tab="trans"]');
    if (tab && !tab.classList.contains('is-active')) tab.click();
  }

  bus.on('transitions:open', () => { open(); rerender(); });
  store.on('selection', rerender);
  store.on('doc', rerender);
  store.on('rt', (patch) => { if ('junction' in patch) rerender(); });

  build();
  return { refresh: rerender, open, target };
}
