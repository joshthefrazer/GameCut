import { bus, raf } from '../../core/events.js';
import { createTransPreview, grabCutFrames, demoFrames, drawMoment } from './trans-preview.js';
import {
  TRANSITION_PICKS, DEFAULT_TRANS_DUR, pickFor, junctions, maxDurFor, freshTransition,
} from '../../engine/transitions.js';
import { starEl, isStarred } from '../stars.js';
import { GROUPS, EASES } from '../../engine/transition-fx.js';

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

  /* ── The moving preview ───────────────────────────────────────
     Built once and re-appended on every rebuild rather than recreated, so
     hovering a tile does not throw away frames that took a seek to capture. */
  const stage = document.createElement('div');
  stage.className = 'trs__stage';
  stage.innerHTML = `<canvas class="trs__cv" id="transPreview"></canvas>
    <div class="trs__cap" id="transPreviewCap"></div>`;
  const preview = createTransPreview(stage.querySelector('canvas'));
  const cap = stage.querySelector('.trs__cap');

  /** Which cut the frames in hand belong to, and which one is being fetched. */
  let framesKey = null;
  let grabbing = false;
  let wanted = null;

  /** Is this panel the one on screen? */
  const onScreen = () =>
    !!document.querySelector('#leftPanel .tabpane[data-pane="trans"]')?.classList.contains('is-active');

  const keyOf = (j) => (j ? `${j.prev.id}|${j.next.id}|${j.t.toFixed(3)}` : null);

  /**
   * Get one frame from either side of the cut, at most once at a time.
   *
   * Three things this must not do, each of which it did:
   *
   * - Run while the timeline is playing. Grabbing a frame seeks a decoder and
   *   waits on it, so pressing a clip during playback froze the picture for
   *   seconds while the sound carried on.
   * - Run while the tab is not on screen. `build()` is driven by selection and
   *   document events, which fire whether or not anyone has ever opened this
   *   panel.
   * - Forget a request made while another was in flight. Clicking cut A then
   *   cut B used to leave A's frames on screen for good, because the key had
   *   already been recorded against the grab that was still running.
   */
  async function ensureFrames(j) {
    wanted = keyOf(j) || 'demo';
    if (!onScreen() || store.rt.playing) return;
    if (wanted === framesKey || grabbing) return;
    if (!j) { if (framesKey !== 'demo') { framesKey = 'demo'; preview.setFrames(demoFrames()); paintTiles(); } return; }

    grabbing = true;
    const key = wanted;
    stage.classList.add('is-loading');
    try {
      const got = await grabCutFrames(j, { store, comp });
      preview.setFrames(got.a && got.b ? got : { ...demoFrames(), a: got.a || demoFrames().a, b: got.b || demoFrames().b });
      framesKey = key;
      paintTiles();
    } catch {
      preview.setFrames(demoFrames());
      framesKey = null;      // so the same cut can be tried again
      paintTiles();
    } finally {
      grabbing = false;
      stage.classList.remove('is-loading');
      showCurrent();
      // Somebody picked a different cut while that was running.
      if (wanted !== framesKey) ensureFrames(target());
    }
  }

  /** Park the preview on whatever this cut is actually set to. */
  function showCurrent() {
    // A canvas inside a hidden pane redrawing at 60fps is pure waste, and it
    // competes with the decoder and the compositor for exactly the machine the
    // person is trying to play their timeline on.
    if (!onScreen()) { preview.stop(); return; }
    const j = target();
    const cur = j ? pickFor(j.next) : null;
    if (cur) {
      preview.show(j.next.transIn, j.next.transIn.dur);
      cap.textContent = `${cur.name} \u00b7 on this cut`;
    } else {
      preview.show(null);
      cap.textContent = j ? 'A hard cut \u2014 hover a tile to try one' : 'Hover a tile to see what it does';
    }
  }

  /** What a tile would put on this cut. */
  const wouldBe = (pick) => freshTransition(pick.kind, target()?.next.transIn);

  /** Show a transition that is not (yet) set, while the pointer is over it. */
  function previewPick(pick) {
    cap.textContent = `${pick.name} \u2014 ${pick.blurb}`;
    const tr = wouldBe(pick);
    preview.show(tr, tr.dur);
  }

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

  /** Every cut the selection covers (two or more clips picked), or just the one. */
  function targets() {
    const sel = new Set(store.rt.selection);
    const many = sel.size > 1 ? junctions(store.doc).filter(j => sel.has(j.next.id)) : [];
    const one = target();
    return many.length > 1 ? many : one ? [one] : [];
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
    const list = targets();
    let next = null;
    cmds.batch('Transition', () => {
      for (const k of list) {
        next = pick === null ? null : freshTransition(pick.kind, k.next.transIn);
        if (next) next.dur = Math.min(next.dur ?? DEFAULT_TRANS_DUR, maxDurFor(k.prev, k.next));
        cmds.setClipProp(k.next.id, 'transIn', next, { merge: false, label: 'Transition' });
      }
    });
    if (list.length < 2) store.setRT({ junction: j.next.id });
    else bus.emit('toast', { msg: pick ? `${pick.name} on ${list.length} cuts` : `${list.length} cuts back to hard cuts`, kind: 'ok' });

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

  /** Change one setting of the transition on this cut, live; `commit` makes it one undo step. */
  function setting(key, v, commit, before) {
    const list = targets();
    if (!list.length) return;
    if (!commit) {
      for (const k of list) if (k.next.transIn) k.next.transIn = { ...k.next.transIn, [key]: v };
      comp.render();
      preview.show(list[0].next.transIn, list[0].next.transIn?.dur);
      return;
    }
    // The slider has been writing the "after" onto the document; put the "before" back for the snapshot.
    if (before !== undefined) for (const k of list) if (k.next.transIn) k.next.transIn = { ...k.next.transIn, [key]: before };
    cmds.batch('Transition ' + key, () => {
      for (const k of list) if (k.next.transIn) cmds.setClipProp(k.next.id, 'transIn', { ...k.next.transIn, [key]: v }, { merge: false, label: 'Transition ' + key });
    });
    comp.render();
    rerender();
  }

  /* ── Tiles: the real effect, on your own two shots ────────── */
  let group = 'all', query = '';
  try { group = localStorage.getItem('strike.transGroup') || 'all'; } catch { /* storage off */ }
  /** The moment that shows each one best. */
  const MOMENT = { whip: 0.47, zoomin: 0.44, zoomout: 0.56, punch: 0.42, flash: 0.5, spin: 0.46, blocks: 0.5, dip: 0.36, blinds: 0.4, leak: 0.45, pixel: 0.42, blur: 0.42, flip: 0.36, clock: 0.45 };
  let tileJob = 0;
  function tileCanvas(pick) {
    const c = document.createElement('canvas');
    c.width = 176; c.height = 99;
    c.className = 'trs__pic';
    let raf = 0, t0 = 0;
    const tr = () => wouldBe(pick);
    const still = () => drawMoment(c, preview.frames || demoFrames(), tr(), MOMENT[pick.kind] ?? 0.48);
    const loop = (now) => {
      const d = Math.max(0.45, tr().dur * 1.4), at = ((now - t0) / 1000) % (d + 0.5);
      drawMoment(c, preview.frames || demoFrames(), tr(), at < 0.2 ? 0 : Math.min(1, (at - 0.2) / d));
      raf = requestAnimationFrame(loop);
    };
    c.__still = still;
    c.__play = () => { if (!raf) { t0 = performance.now(); raf = requestAnimationFrame(loop); } };
    c.__stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; still(); } };
    return c;
  }
  /** Redraw every tile's picture, a few per frame so the editor never stalls. */
  function paintTiles() {
    const id = ++tileJob;
    const list = [...root.querySelectorAll('.trs__pic')];
    const step = () => {
      if (id !== tileJob || !onScreen()) return;
      const t0 = performance.now();
      while (list.length && performance.now() - t0 < 7) list.shift().__still();
      if (list.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ── Build ────────────────────────────────────────────────── */
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ARROW = { left: '←', right: '→', up: '↑', down: '↓', out: '◎', in: '◉' };
  const DIRNAME = { left: 'Left', right: 'Right', up: 'Up', down: 'Down', out: 'Open', in: 'Close' };

  function settingsFor(j, cur) {
    const tr = { ...cur.d, ...j.next.transIn };
    const wrap = el('div', 'trs__set');
    const rowOf = (label, control, valEl) => { const r = el('div', 'trs__row'); const l = el('label', null, label); if (valEl) l.appendChild(valEl); r.append(l, control); wrap.appendChild(r); return r; };

    if (cur.dirs) {
      const seg = el('div', 'trs__seg');
      for (const d of cur.dirs) {
        const b = el('button', tr.dir === d ? 'is-on' : '', ARROW[d]);
        b.title = DIRNAME[d]; b.dataset.dir = d; b.setAttribute('aria-label', DIRNAME[d]); b.setAttribute('aria-pressed', String(tr.dir === d));
        b.addEventListener('click', () => setting('dir', d, true));
        seg.appendChild(b);
      }
      rowOf(cur.id === 'circle' ? 'Way' : 'Direction', seg);
    }
    const slide = (id, label, key, value, min, max, step, fmt) => {
      const val = el('b', null, fmt(value)); val.id = id + 'Val';
      const rng = el('input', 'rng'); rng.type = 'range'; rng.id = id; rng.min = min; rng.max = max; rng.step = step; rng.value = value;
      rng.setAttribute('aria-label', label);
      let before = value;
      rng.addEventListener('pointerdown', () => { before = target()?.next.transIn?.[key] ?? value; });
      rng.addEventListener('input', () => { val.textContent = fmt(+rng.value); setting(key, +rng.value, false); });
      rng.addEventListener('change', () => setting(key, key === 'dur' ? Math.max(0.1, Math.min(+rng.value, maxDurFor(j.prev, j.next))) : +rng.value, true, before));
      rowOf(label, rng, val);
    };
    const max = maxDurFor(j.prev, j.next);
    slide('transDur', 'Length', 'dur', Math.min(tr.dur ?? DEFAULT_TRANS_DUR, max), 0.1, max.toFixed(2), 0.05, v => v.toFixed(2) + ' s');
    if (cur.amount) slide('transAmt', cur.amount, 'amount', tr.amount ?? 0.5, 0, 1, 0.01, v => Math.round(v * 100) + '%');
    if (cur.ease) {
      const seg = el('div', 'trs__seg trs__seg--words');
      for (const ez of EASES) {
        const b = el('button', (tr.ease || 'smooth') === ez.id ? 'is-on' : '', ez.name);
        b.title = ez.note; b.dataset.ease = ez.id; b.setAttribute('aria-pressed', String((tr.ease || 'smooth') === ez.id));
        b.addEventListener('click', () => setting('ease', ez.id, true));
        seg.appendChild(b);
      }
      rowOf('Feel', seg).classList.add('trs__row--wide');
    }
    if (cur.color) {
      const box = el('div', 'trs__cols');
      for (const c of ['#000000', '#ffffff', '#C6FF3D', '#38bdf8', '#f472b6', '#ff7a18', '#ef4444']) {
        const b = el('button', (tr.color || '').toLowerCase() === c.toLowerCase() ? 'is-on' : ''); b.style.background = c; b.title = c; b.setAttribute('aria-label', 'Colour ' + c);
        b.addEventListener('click', () => setting('color', c, true));
        box.appendChild(b);
      }
      const own = el('input'); own.type = 'color'; own.value = tr.color || '#ffffff'; own.title = 'Any colour';
      let before = tr.color;
      own.addEventListener('pointerdown', () => { before = target()?.next.transIn?.color; });
      own.addEventListener('input', () => setting('color', own.value, false));
      own.addEventListener('change', () => setting('color', own.value, true, before));
      box.appendChild(own);
      rowOf('Colour', box);
    }

    const acts = el('div', 'trs__acts');
    const act = (id, label, title, run) => { const b = el('button', 'trs__act', label); b.id = id; b.title = title; b.addEventListener('click', run); acts.appendChild(b); };
    const SOUND = { glitch: 'glitch', rgb: 'glitch', vhs: 'glitch', punch: 'hit', flash: 'shutter', pixel: 'glitch' }[cur.kind] || 'whoosh';
    if (window.gc?.pads?.has?.(SOUND)) act('transSound', '♪ Add its sound', 'Put a ' + SOUND + ' on the SFX lane at this cut', () => {
      const list = targets();
      cmds.batch('Transition sound', () => { for (const k of list) window.gc.pads.placeNamed(SOUND, Math.max(0, k.t - (SOUND === 'whoosh' ? Math.min(0.2, (k.next.transIn?.dur || 0.4) / 2) : 0)), 'Transition sound'); });
      bus.emit('toast', { msg: `Added a ${SOUND} at ${list.length > 1 ? list.length + ' cuts' : 'the cut'}`, kind: 'ok' });
    });
    const n = junctions(store.doc).length;
    if (n > 1) act('transAll', `Use on all ${n} cuts`, 'Put this transition, with these settings, on every cut', () => {
      const list = junctions(store.doc);
      cmds.batch('Transition on every cut', () => {
        for (const k of list) cmds.setClipProp(k.next.id, 'transIn', { ...tr, dur: Math.min(tr.dur ?? DEFAULT_TRANS_DUR, maxDurFor(k.prev, k.next)) }, { merge: false, label: 'Transition on every cut' });
      });
      comp.render();
      bus.emit('toast', { msg: `${cur.name} on all ${list.length} cuts`, kind: 'ok' });
      rerender();
    });
    act('transRemove', 'Remove', 'Go back to a hard cut', () => apply(null));
    wrap.appendChild(acts);
    return wrap;
  }

  function build() {
    const j = target();
    const cur = j ? pickFor(j.next) : null;
    const many = targets().length;
    const scroll = root.scrollTop;
    const typing = document.activeElement?.id === 'transFind';
    for (const c of root.querySelectorAll('.trs__pic')) c.__stop?.();
    root.innerHTML = '';
    root.appendChild(stage);

    /* Which cut, in words. */
    const head = el('div', 'trs__head');
    const n = junctions(store.doc).length;
    head.append(el('b', null, many > 1 ? `${many} cuts picked` : j ? 'The cut you picked' : 'No cut picked'),
      el('span', null, many > 1 ? 'What you choose goes on all of them.'
        : j ? `${j.prev.name || 'clip'} → ${j.next.name || 'clip'} · ${j.t.toFixed(2)} s`
        : n ? `Click the ⋈ on any of the ${n} cut${n === 1 ? '' : 's'} on your timeline, then pick one here.`
        : 'Put two clips next to each other on a lane and a ⋈ appears where they meet.'));
    root.appendChild(head);

    if (j && cur) root.appendChild(settingsFor(j, cur));

    /* Find one. */
    const bar = el('div', 'trs__bar');
    const find = el('input'); find.id = 'transFind'; find.type = 'search'; find.placeholder = 'Find a transition'; find.value = query; find.spellcheck = false;
    find.addEventListener('input', () => { query = find.value; fill(); });
    find.addEventListener('keydown', (ev) => ev.stopPropagation());
    const chips = el('div', 'trs__chips');
    for (const g of [{ id: 'all', name: 'All' }, { id: 'star', name: '★ Starred' }, ...GROUPS]) {
      const b = el('button', g.id === group ? 'is-on' : '', g.name);
      b.dataset.group = g.id;
      b.addEventListener('click', () => { group = g.id; query = ''; find.value = ''; try { localStorage.setItem('strike.transGroup', group); } catch { /* storage off */ } for (const x of chips.children) x.classList.toggle('is-on', x === b); fill(); });
      chips.appendChild(b);
    }
    bar.append(find, chips);
    root.appendChild(bar);

    const list = el('div', 'trs__list');
    root.appendChild(list);
    function fill() {
      for (const c of list.querySelectorAll('.trs__pic')) c.__stop?.();
      list.innerHTML = '';
      const q = query.trim().toLowerCase();
      let shown = 0;
      for (const g of GROUPS) {
        if (!q && group !== 'all' && group !== 'star' && group !== g.id) continue;
        const picks = TRANSITION_PICKS.filter(p => p.group === g.id && (q || group !== 'star' || isStarred('trans', p.key)) && (!q || (p.name + ' ' + p.blurb + ' ' + g.name).toLowerCase().includes(q)));
        if (!picks.length) continue;
        shown += picks.length;
        if (group === 'all' || group === 'star' || q) list.appendChild(el('h4', 'trs__gh', g.name));
        const grid = el('div', 'trs__grid');
        for (const pick of picks) {
          const b = el('button', 'trs' + (cur?.key === pick.key ? ' is-on' : ''));
          b.dataset.pick = pick.key;
          b.title = pick.blurb;
          const pic = tileCanvas(pick);
          b.append(pic, el('span', 'trs__name', pick.name), starEl('trans', pick.key, pick.name));
          b.addEventListener('click', () => apply(pick));
          const on = () => { pic.__play(); previewPick(pick); };
          b.addEventListener('pointerenter', on);
          b.addEventListener('focus', on);
          const offNow = () => pic.__stop();
          b.addEventListener('pointerleave', offNow);
          b.addEventListener('blur', offNow);
          grid.appendChild(b);
        }
        grid.addEventListener('pointerleave', showCurrent);
        list.appendChild(grid);
      }
      if (!shown) list.appendChild(el('p', 'trs__none', !q && group === 'star' ? 'Nothing starred yet. Point at a transition and click its star.' : `Nothing called “${query}”. Try zoom, glitch or fade.`));
      paintTiles();
    }
    fill();
    root.scrollTop = scroll;
    if (typing) { find.focus(); find.setSelectionRange(find.value.length, find.value.length); }

    ensureFrames(j);
    showCurrent();
  }

  /* ── Opening the tab ──────────────────────────────────────── */
  function open() {
    bus.emit('drawer:show', 'trans');
  }

  bus.on('transitions:open', () => { open(); rerender(); });
  store.on('selection', rerender);
  store.on('doc', rerender);
  store.on('rt', (patch) => { if ('junction' in patch) rerender(); });

  // Coming back to the tab, or stopping playback, is the moment to catch up on
  // anything that was deliberately skipped while it was hidden or rolling.
  const catchUp = () => {
    if (!onScreen()) { preview.stop(); return; }
    ensureFrames(target());
    showCurrent();
    paintTiles();
  };
  document.getElementById('leftTabs')?.addEventListener('click', () => setTimeout(catchUp, 0));
  store.on('rt', (patch) => { if (patch && 'playing' in patch && !patch.playing) catchUp(); });

  build();
  return { refresh: rerender, open, target, preview };
}
