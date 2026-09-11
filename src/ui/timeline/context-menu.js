/**
 * Right-click menu for the timeline.
 *
 * Everything in here is already possible some other way — a key, a toolbar
 * button, a field in the Inspector. That is the point: the menu is the route
 * you can find without knowing where anything is. Right-clicking the thing you
 * want to change and reading a list of what can be done to it is how people
 * expect software to answer "what are my options here", and it costs nothing to
 * offer, because every entry calls the same command the rest of the app does.
 */
import { bus } from '../../core/events.js';
import { TRANSITION_PICKS, DEFAULT_TRANS_DUR, pickFor, outgoingFor } from '../../engine/transitions.js';

const SPEEDS = [
  { v: 0.25, n: '0.25× — quarter speed' },
  { v: 0.5,  n: '0.5× — slow motion' },
  { v: 1,    n: '1× — normal' },
  { v: 1.5,  n: '1.5×' },
  { v: 2,    n: '2× — double speed' },
  { v: 4,    n: '4×' },
  { v: 16,   n: '16× — timelapse' },
];

export function initContextMenu({ store, cmds, playback }) {
  let menu = null;

  const close = () => { menu?.remove(); menu = null; };
  window.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target)) close();
  }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
  window.addEventListener('blur', close);
  bus.on('layout', close);

  /**
   * Build and place the menu.
   *
   * `items` is a flat list; an item with `sub` opens a second panel beside it.
   * Anything with `on` is clickable, anything with `sep` is a rule.
   */
  function show(x, y, items) {
    close();
    menu = document.createElement('div');
    menu.className = 'ctx';
    menu.appendChild(panel(items));
    document.body.appendChild(menu);

    const b = menu.firstChild.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - b.width - 8);
    const top = Math.min(y, window.innerHeight - b.height - 8);
    menu.style.left = Math.max(6, left) + 'px';
    menu.style.top = Math.max(6, top) + 'px';
    // Submenus open to the right by default; near the window edge they have to
    // open the other way or they are half off-screen and unreachable.
    if (left + b.width + 230 > window.innerWidth) menu.classList.add('ctx--flipL');
    return menu;
  }

  function panel(items) {
    const p = document.createElement('div');
    p.className = 'ctx__panel';
    for (const it of items) {
      if (it.sep) { p.appendChild(Object.assign(document.createElement('i'), { className: 'ctx__sep' })); continue; }
      if (it.head) {
        const h = document.createElement('div');
        h.className = 'ctx__head';
        h.textContent = it.head;
        p.appendChild(h);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'ctx__item' + (it.sub ? ' ctx__item--sub' : '') + (it.on_ ? ' is-on' : '');
      b.disabled = !!it.disabled;
      b.innerHTML = `<span></span>`;
      b.firstChild.textContent = it.label;
      if (it.key) {
        const k = document.createElement('kbd');
        k.textContent = it.key;
        b.appendChild(k);
      }
      if (it.sub) {
        const flyout = panel(it.sub);
        flyout.classList.add('ctx__flyout');
        const wrap = document.createElement('div');
        wrap.className = 'ctx__wrap';
        wrap.append(b, flyout);
        p.appendChild(wrap);
        continue;
      }
      b.addEventListener('click', () => { close(); it.on?.(); });
      p.appendChild(b);
    }
    return p;
  }

  /* ── The menu for a clip ──────────────────────────────────── */
  function forClip(clip, track, x, y) {
    // Right-clicking something outside the selection acts on that thing —
    // silently operating on a different clip than the one under the pointer is
    // the classic way this feature goes wrong.
    if (!store.rt.selection.includes(clip.id)) store.select([clip.id]);
    const many = store.rt.selection.length > 1;
    const visual = clip.type === 'video' || clip.type === 'image';
    const timed = clip.type !== 'text' && clip.type !== 'shape';

    const items = [
      { head: many ? `${store.rt.selection.length} clips` : (clip.name || clip.type) },
      { label: 'Split at the playhead', key: 'S',
        on: () => cmds.splitAt(store.rt.playhead, store.rt.selection) },
      { label: 'Duplicate', key: 'Ctrl+D', on: () => cmds.duplicateSelected() },
      { label: 'Delete', key: 'Del', on: () => cmds.removeSelected() },
      { sep: true },
      { label: 'Play from here',
        on: () => { playback.seek(clip.start); playback.play(); } },
    ];

    if (visual) {
      items.push({ sep: true });
      // Only offered when there is actually a cut here. A transition on a clip
      // with nothing before it has nothing to transition FROM, and offering it
      // anyway is how a menu teaches someone the wrong thing.
      const cut = outgoingFor(track, clip);
      const cur = pickFor(clip);
      items.push({
        label: cut ? 'Transition on the cut before this' : 'Transition (no cut before this clip)',
        disabled: !cut,
        sub: cut ? [
          ...TRANSITION_PICKS.map(pick => ({
            label: pick.name,
            on_: cur?.key === pick.key,
            on: () => {
              cmds.setClipProp(clip.id, 'transIn', {
                kind: pick.kind,
                dur: clip.transIn?.dur ?? DEFAULT_TRANS_DUR,
                dir: pick.dir || 'left',
              }, { merge: false, label: 'Transition' });
              store.setRT({ junction: clip.id });
              bus.emit('inspector:refresh');
            },
          })),
          { sep: true },
          { label: 'No transition — hard cut',
            on_: !cur,
            on: () => {
              cmds.setClipProp(clip.id, 'transIn', null, { merge: false, label: 'Transition' });
              bus.emit('inspector:refresh');
            } },
          { label: 'Open the Transitions panel…',
            on: () => { store.setRT({ junction: clip.id }); bus.emit('transitions:open', { clipId: clip.id }); } },
        ] : undefined,
      });
      items.push({ label: 'Crop out a piece…', key: 'C', on: () => bus.emit('crop:start') });
    }

    if (clip.type === 'video') {
      items.push({
        label: clip.silent ? 'Audio already taken out' : 'Take the audio out onto its own track',
        disabled: !!clip.silent,
        on: () => {
          const r = cmds.extractAudio(clip.id);
          if (r?.ok) {
            bus.emit('toast', {
              msg: `Audio moved to ${r.track.name} — drag it, fade it or cut it on its own now.`,
              kind: 'ok', ms: 4600,
            });
          } else if (r?.reason) {
            bus.emit('toast', { msg: r.reason, kind: 'err' });
          }
        },
      });
    }

    if (timed) {
      items.push({
        label: 'Speed',
        sub: SPEEDS.map(s => ({
          label: s.n,
          on_: Math.abs((clip.speed || 1) - s.v) < 1e-6,
          on: () => { cmds.setClipSpeed(clip.id, s.v); bus.emit('inspector:refresh'); },
        })),
      });
    }

    items.push({ sep: true });
    if (visual || clip.type === 'text' || clip.type === 'shape') {
      items.push({ label: 'Move up a layer', on: () => cmds.moveClipLayer(clip.id, -1) });
      items.push({ label: 'Move down a layer', on: () => cmds.moveClipLayer(clip.id, 1) });
    }
    items.push({
      label: clip.locked ? 'Unlock this clip' : 'Lock this clip',
      on: () => cmds.setClipProp(clip.id, 'locked', !clip.locked, { merge: false, label: 'Lock clip' }),
    });
    show(x, y, items);
  }

  /* ── The menu for empty space ─────────────────────────────── */
  function forLane(track, t, x, y) {
    show(x, y, [
      { head: track ? track.name : 'Timeline' },
      { label: 'Add a text layer here', key: 'T', on: () => cmds.addTextClip(t, track?.id) },
      { label: 'Add a marker here', key: 'M', on: () => cmds.addMarker(t) },
      { sep: true },
      { label: 'Import media…', key: 'I', on: () => document.getElementById('filePicker').click() },
      { label: 'Select every clip', key: 'Ctrl+A',
        on: () => store.select(store.doc.tracks.flatMap(tr => tr.clips.map(c => c.id))) },
    ]);
  }

  /* ── The menu for a cut ───────────────────────────────────── */
  function forJunction(j, x, y) {
    const cur = pickFor(j.next);
    const items = [
      { head: `Cut · ${j.prev.name || 'clip'} → ${j.next.name || 'clip'}` },
      ...TRANSITION_PICKS.map(pick => ({
        label: pick.name,
        on_: cur?.key === pick.key,
        on: () => {
          cmds.setClipProp(j.next.id, 'transIn', {
            kind: pick.kind,
            dur: j.next.transIn?.dur ?? DEFAULT_TRANS_DUR,
            dir: pick.dir || 'left',
          }, { merge: false, label: 'Transition' });
          bus.emit('inspector:refresh');
        },
      })),
      { sep: true },
      { label: 'No transition — hard cut', on_: !cur,
        on: () => {
          cmds.setClipProp(j.next.id, 'transIn', null, { merge: false, label: 'Transition' });
          bus.emit('inspector:refresh');
        } },
      { label: 'Open the Transitions panel…',
        on: () => bus.emit('transitions:open', { clipId: j.next.id }) },
    ];
    show(x, y, items);
  }

  /* ── The menu for the ruler ───────────────────────────────── */
  function forRuler(t, x, y) {
    const near = cmds.markerNear(t, Math.max(0.15, 8 / store.pxPerSec));
    const items = [
      { head: 'Ruler' },
      { label: 'Add a marker here', key: 'M', on: () => cmds.addMarker(t) },
    ];
    if (near) {
      items.push({
        label: near.label ? `Remove marker "${near.label}"` : 'Remove this marker',
        on: () => cmds.removeMarker(near.id),
      });
    }
    if (store.doc.markers.length) {
      items.push({ label: `Clear all markers (${store.doc.markers.length})`, on: () => cmds.clearMarkers() });
    }
    items.push({ sep: true });
    items.push({ label: 'Set beat 1 here', on: () => {
      store.doc.beatOffset = t;
      store.docChanged('beat offset');
      bus.emit('toast', { msg: 'Beat 1 is now here — the beat grid lines up from this point.' });
    } });
    show(x, y, items);
  }

  return { forClip, forLane, forRuler, forJunction, close };
}
