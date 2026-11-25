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
import { freezeFrame } from '../../edit/freeze-frame.js';
import { QUICK_PICKS, TRANSITION_PICKS, freshTransition, pickFor, outgoingFor } from '../../engine/transitions.js';
import { askText } from '../widgets/ask.js';
import { assets } from '../../media/asset-store.js';
import { starred } from '../stars.js';
import { MARK_COLORS } from '../markers-panel.js';
import { LANE_PRESETS } from '../../core/commands.js';

/** Colour labels for clips and lanes. */
export const LABELS = [
  { c: '#ef4444', n: 'Red' }, { c: '#f97316', n: 'Orange' }, { c: '#eab308', n: 'Yellow' },
  { c: '#22c55e', n: 'Green' }, { c: '#06b6d4', n: 'Cyan' }, { c: '#3b82f6', n: 'Blue' },
  { c: '#a855f7', n: 'Purple' }, { c: '#ec4899', n: 'Pink' },
];

const SPEEDS = [
  { v: 0.25, n: '0.25× — quarter speed' },
  { v: 0.5,  n: '0.5× — slow motion' },
  { v: 1,    n: '1× — normal' },
  { v: 1.5,  n: '1.5×' },
  { v: 2,    n: '2× — double speed' },
  { v: 4,    n: '4×' },
  { v: 16,   n: '16× — timelapse' },
];

/** What you starred first, then the usual ones. */
const quickPicks = () => { const s = starred('trans').map(k => TRANSITION_PICKS.find(p => p.key === k)).filter(Boolean); return [...s, ...QUICK_PICKS.filter(p => !s.includes(p))].slice(0, 12); };

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
      if (it.dot) {
        const d = document.createElement('i');
        d.className = 'ctx__dot';
        d.style.background = it.dot;
        b.prepend(d);
      }
      if (it.pic) { const p = document.createElement('img'); p.className = 'ctx__pic'; p.src = it.pic; p.alt = ''; b.prepend(p); }
      if (it.id) b.dataset.item = it.id;
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

    /**
     * A clip that is locked — or on a locked track — gets a menu that says so
     * and offers the way out, instead of a Delete and a Speed that the lock is
     * supposed to forbid.
     */
    if (clip.locked || track.locked) {
      const items = [
        { head: `${clip.name || clip.type} · locked` },
        { label: 'Play from here', on: () => { playback.seek(clip.start); playback.play(); } },
        { sep: true },
      ];
      if (track.locked) {
        items.push({ label: `Unlock the track "${track.name}"`,
          on: () => cmds.setTrackFlag(track.id, 'locked', false) });
      }
      if (clip.locked) {
        items.push({ label: 'Unlock this clip',
          on: () => cmds.setClipProp(clip.id, 'locked', false, { merge: false, label: 'Lock clip' }) });
      }
      show(x, y, items);
      return;
    }
    const many = store.rt.selection.length > 1;
    const visual = clip.type === 'video' || clip.type === 'image';
    const timed = clip.type !== 'text' && clip.type !== 'shape';

    const items = [
      { head: many ? `${store.rt.selection.length} clips` : (clip.name || clip.type) },
      { label: 'Split at the playhead', key: 'S',
        on: () => cmds.splitAt(store.rt.playhead, store.rt.selection) },
      { label: 'Duplicate', key: 'Ctrl+D', on: () => cmds.duplicateSelected() },
      { label: 'Delete', key: 'Del', on: () => cmds.removeSelected() },
      { label: 'Delete and close the gap', key: 'Shift+Del', id: 'rippleDelete', on: () => cmds.removeSelected({ ripple: true }) },
      { sep: true },
      { label: 'Rename…', id: 'rename', disabled: many, on: () => renameClip(clip) },
      { label: 'Colour label', id: 'label', sub: [
        ...LABELS.map(l => ({ label: l.n, dot: l.c, id: 'label-' + l.n.toLowerCase(), on_: clip.label === l.c,
          on: () => cmds.labelClips(store.rt.selection.includes(clip.id) ? store.rt.selection : [clip.id], l.c) })),
        { sep: true },
        { label: 'No label', id: 'label-none', on: () => cmds.labelClips(store.rt.selection.includes(clip.id) ? store.rt.selection : [clip.id], null) },
      ] },
      { label: 'Select this and everything after it', id: 'selectFrom', on: () => cmds.selectFrom(clip.id) },
      { sep: true },
      { label: 'Play from here',
        on: () => { playback.seek(clip.start); playback.play(); } },
      { sep: true },
      { label: 'Copy look', key: 'Ctrl+Alt+C', on: () => cmds.copyLook(clip.id) },
    ];
    if (cmds.copiedLook) {
      items.push({ label: many ? `Paste look onto ${store.rt.selection.length} clips` : 'Paste look', key: 'Ctrl+Alt+V',
        on: () => cmds.pasteLook(store.rt.selection.includes(clip.id) ? store.rt.selection : [clip.id]) });
    }

    if (cmds.copiedLook) items.push({ label: 'Paste parts of a look…', key: 'Ctrl+Alt+Shift+V', id: 'pasteParts', on: () => bus.emit('look:parts') });
    if (!many && (visual || clip.type === 'audio')) {
      const others = assets.all().filter(a => a.kind === clip.type && !a.missing && !a.bundled && a.id !== clip.assetId).slice(-12).reverse();
      items.push({ label: others.length ? 'Replace footage, keep the edit' : 'Replace footage (import another first)', id: 'replace', disabled: !others.length,
        sub: others.length ? others.map(a => ({ label: a.name, pic: a.thumb || (a.kind === 'image' ? a.url : ''), id: 'replace-' + a.id, on: () => {
          const r = cmds.replaceMedia(clip.id, a.id);
          bus.emit('toast', r.ok ? { msg: r.shorter ? `Now ${a.name}. It is shorter, so the clip is too.` : `Now ${a.name}`, kind: 'ok', action: { label: 'Undo', run: () => cmds.undo() } } : { msg: r.reason, kind: 'err' });
          bus.emit('assets'); bus.emit('inspector:refresh');
        } })) : undefined });
    }

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
          ...quickPicks().map(pick => ({
            label: pick.name,
            on_: cur?.key === pick.key,
            on: () => {
              cmds.setClipProp(clip.id, 'transIn', freshTransition(pick.kind, clip.transIn), { merge: false, label: 'Transition' });
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
          { label: 'All transitions…',
            on: () => { store.setRT({ junction: clip.id }); bus.emit('transitions:open', { clipId: clip.id }); } },
        ] : undefined,
      });
      items.push({ label: 'Crop out a piece…', key: 'C', on: () => bus.emit('crop:start') });
    }
    if (clip.type === 'video' && !many) {
      // Pause the picture on the frame under the playhead (or the clip's first
      // frame if the playhead is somewhere else), then carry on.
      const ph = store.rt.playhead;
      const at = ph >= clip.start && ph < clip.start + clip.duration ? ph : clip.start;
      items.push({
        label: 'Freeze frame (pause the video here)',
        sub: [1, 2, 3, 5].map(n => ({
          label: `Pause for ${n} second${n === 1 ? '' : 's'}`,
          key: n === 2 ? 'Shift+F' : undefined,
          on: () => freezeFrame({ store, cmds, t: at, hold: n }),
        })),
      });
    }

    if ((clip.type === 'video' || clip.type === 'image')
        && Math.abs((clip.speed || 1) - 1) > 1e-3) {
      const has = !!cmds.badgeOf?.(clip.id);
      items.push({
        label: has ? 'Remove the speed badge' : `Show a ${cmds.speedLabel(clip.speed)} badge`,
        on: () => {
          if (has) cmds.removeSpeedBadge(clip.id);
          else cmds.addSpeedBadge(clip.id);
          bus.emit('inspector:refresh');
        },
      });
    }

    if (clip.type === 'text') {
      items.push({
        label: 'Type on the picture',
        key: 'Enter',
        on: () => { store.select([clip.id]); bus.emit('text:edit', { clipId: clip.id }); },
      });
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
    const items = [{ head: track ? track.name : 'Timeline' }];
    /**
     * Right-clicking the hole between two clips is the natural way to ask for
     * it to go away, so that comes first when there is one.
     */
    const gap = track && !track.locked ? cmds.gapAt(track.id, t) : null;
    if (gap) {
      items.push({
        label: `Close this gap (${gap.dur < 10 ? gap.dur.toFixed(1) : Math.round(gap.dur)}s)`,
        on: () => cmds.closeGap(track.id, t),
      });
      items.push({ sep: true });
    }
    // Only where a title can actually show. On a sound lane this used to make
    // a text clip on the audio track, which nothing ever draws.
    if (!track || track.kind !== 'audio') {
      items.push({ label: 'Add a text layer here', key: 'T',
        on: () => cmds.addTextClip(t, track?.kind === 'text' ? track.id : null) });
    }
    items.push({ label: 'Add a marker here', key: 'M', on: () => cmds.addMarker(t) });
    items.push({ sep: true });
    items.push({ label: 'Import media…', key: 'Ctrl+I', on: () => document.getElementById('filePicker').click() });
    items.push({ label: 'Select every clip', key: 'Ctrl+A', on: () => store.select(cmds.selectableIds()) });
    show(x, y, items);
  }

  async function renameClip(clip) {
    const v = await askText({ title: 'Rename clip', label: 'A name you will recognise on the timeline', value: clip.name || '', ok: 'Rename', maxLength: 80 });
    if (v) cmds.renameClip(clip.id, v);
  }
  async function renameTrack(track) {
    const v = await askText({ title: 'Rename lane', value: track.name || '', ok: 'Rename', maxLength: 40 });
    if (v) cmds.renameTrack(track.id, v);
  }

  /** The ready-made lanes, as menu items. */
  // The Zoom lane preset is kept so older projects that have one still read well; it is not offered in the menu.
  const MENU_PRESETS = () => Object.entries(LANE_PRESETS).filter(([, p]) => !p.patch?.zoomLane);
  const laneItems = (aboveId = null) => MENU_PRESETS().map(([k, p]) => ({
    label: `${p.name} — ${p.note}`, id: 'lane-' + k,
    on: () => {
      const t = cmds.addLane(k, aboveId);
      if (t) {
        bus.emit('timeline:reveal', { trackId: t.id });
        bus.emit('toast', { msg: `Added a ${p.name} lane — ${p.note.toLowerCase()}`, kind: 'ok', key: 'lane' });
      }
    },
  }));
  function forAddLane(x, y, kind = null) {
    const all = laneItems();
    const keys = MENU_PRESETS().map(([k]) => k);
    const pick = kind ? all.filter((_, i) => LANE_PRESETS[keys[i]].kind === kind) : all;
    show(x, y, [{ head: kind ? `Add a ${kind === 'audio' ? 'sound' : kind} lane` : 'Add a lane' }, ...pick]);
  }

  /* ── The menu for a track header ──────────────────────────── */
  function forTrack(track, x, y) {
    const same = store.doc.tracks.filter(t => t.kind === track.kind);
    const pos = same.indexOf(track);
    const items = [
      { head: `${track.name} · ${track.kind} track` },
      { label: 'Rename…', id: 'renameLane', on: () => renameTrack(track) },
      { label: 'Lane colour', id: 'laneColour', sub: [
        ...LABELS.map(l => ({ label: l.n, dot: l.c, id: 'lanecol-' + l.n.toLowerCase(), on_: track.color === l.c, on: () => cmds.setTrackColor(track.id, l.c) })),
        { sep: true },
        { label: 'No colour', id: 'lanecol-none', on: () => cmds.setTrackColor(track.id, null) },
      ] },
      { label: track.kind === 'audio' ? 'Move up' : 'Move up (in front)', id: 'laneUp', disabled: pos <= 0, on: () => cmds.moveTrack(track.id, -1) },
      { label: track.kind === 'audio' ? 'Move down' : 'Move down (behind)', id: 'laneDown', disabled: pos >= same.length - 1, on: () => cmds.moveTrack(track.id, 1) },
      { label: 'Duplicate this lane', id: 'laneDup', on: () => { const t = cmds.duplicateTrack(track.id); if (t) bus.emit('toast', { msg: `Made "${t.name}"`, kind: 'ok', key: 'lane' }); } },
      { label: 'Add a lane', id: 'laneAdd', sub: laneItems() },
      { sep: true },
      ...(track.kind === 'audio' ? [
        { label: track.voice ? 'Voice clean-up: on' : 'Voice clean-up: off', id: 'laneVoice', on_: !!track.voice,
          on: () => cmds.setTrackFlag(track.id, 'voice', !track.voice) },
        { label: track.duck?.on ? 'Dip under talking: on' : 'Dip under talking: off', id: 'laneDuck', on_: !!track.duck?.on,
          on: () => cmds.setTrackFlag(track.id, 'duck', { on: !track.duck?.on, depth: track.duck?.depth ?? 0.7 }) },
        { sep: true },
      ] : []),
      { label: track.locked ? 'Unlock this track' : 'Lock this track',
        on: () => cmds.setTrackFlag(track.id, 'locked', !track.locked) },
      { sep: true },
      { label: track.clips.length
          ? `Delete this track and its ${track.clips.length} clip${track.clips.length === 1 ? '' : 's'}…`
          : 'Delete this track',
        disabled: store.doc.tracks.length <= 1,
        on: () => deleteTrack(track, x, y) },
    ];
    show(x, y, items);
  }

  /**
   * Delete a track, asking first if there is anything on it.
   *
   * An empty lane just goes (with Undo on the toast). One with clips on it asks
   * — in a menu at the same spot rather than a system dialog, so the answer is
   * where your pointer already is.
   */
  function deleteTrack(track, x, y, confirmed = false) {
    const n = track.clips.length;
    if (store.doc.tracks.length <= 1) {
      bus.emit('toast', { msg: 'A project needs at least one track.' });
      return;
    }
    if (n && !confirmed) {
      show(x, y, [
        { head: `Delete "${track.name}"?` },
        { label: `Delete it, and the ${n} clip${n === 1 ? '' : 's'} on it`,
          on: () => deleteTrack(track, x, y, true) },
        { label: 'Keep it', on: () => {} },
      ]);
      menu?.classList.add('ctx--confirm');
      return;
    }
    if (cmds.removeTrack(track.id)) {
      bus.emit('toast', {
        msg: `Deleted the track "${track.name}"`, key: 'edit', ms: 4500,
        action: { label: 'Undo', run: () => cmds.undo() },
      });
    }
  }

  /* ── The menu for a cut ───────────────────────────────────── */
  function forJunction(j, x, y) {
    const cur = pickFor(j.next);
    const items = [
      { head: `Cut · ${j.prev.name || 'clip'} → ${j.next.name || 'clip'}` },
      ...quickPicks().map(pick => ({
        label: pick.name,
        on_: cur?.key === pick.key,
        on: () => {
          cmds.setClipProp(j.next.id, 'transIn', freshTransition(pick.kind, j.next.transIn), { merge: false, label: 'Transition' });
          bus.emit('inspector:refresh');
        },
      })),
      { sep: true },
      { label: 'No transition — hard cut', on_: !cur,
        on: () => {
          cmds.setClipProp(j.next.id, 'transIn', null, { merge: false, label: 'Transition' });
          bus.emit('inspector:refresh');
        } },
      { label: 'All transitions…',
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
      items.push({ label: near.label ? 'Change its note…' : 'Add a note…', id: 'mkNote', on: async () => { const v = await askText({ title: 'Marker note', value: near.label || '', ok: 'Save', maxLength: 60 }); if (v != null) cmds.setMarker(near.id, { label: v }); } });
      items.push({ label: 'Colour', sub: MARK_COLORS.map((c, i) => ({ label: ['Amber', 'Red', 'Green', 'Blue', 'Purple', 'Pink', 'White'][i], dot: c, on_: near.color === c, on: () => cmds.setMarker(near.id, { color: c }) })) });
      items.push({
        label: near.label ? `Remove marker "${near.label}"` : 'Remove this marker',
        on: () => cmds.removeMarker(near.id),
      });
    }
    items.push({ label: 'Markers list…', key: 'Shift+M', on: () => bus.emit('markers:open') });
    if (store.doc.markers.length) {
      items.push({ label: `Clear all markers (${store.doc.markers.length})`, on: () => cmds.clearMarkers() });
    }
    // In and Out, right where you clicked (I / O do the same at the playhead).
    const tools = window.gc?.editTools;
    if (tools) {
      items.push({ sep: true });
      items.push({ label: 'Mark In here', key: 'I', on: () => tools.setMark('in', t) });
      items.push({ label: 'Mark Out here', key: 'O', on: () => tools.setMark('out', t) });
      const r = store.doc.range;
      if (r && (r.in != null || r.out != null)) {
        if (tools.fullRange()) {
          items.push({ label: 'Lift In to Out (leave the gap)', on: () => tools.removeRange(false) });
          items.push({ label: 'Extract In to Out (close the gap)', on: () => tools.removeRange(true) });
        }
        items.push({ label: 'Clear In and Out', key: 'Alt+X', on: () => tools.clearMarks() });
      }
    }
    items.push({ sep: true });
    items.push({ label: 'Set beat 1 here', on: () => {
      store.doc.beatOffset = t;
      store.docChanged('beat offset');
      bus.emit('toast', { msg: 'Beat 1 is now here — the beat grid lines up from this point.' });
    } });
    show(x, y, items);
  }

  bus.on('lanes:add', ({ x, y } = {}) => forAddLane(x ?? window.innerWidth / 2, y ?? window.innerHeight / 2));
  return { forClip, forLane, forRuler, forJunction, forTrack, forAddLane, deleteTrack, close, show };
}
