import { numField, row, group } from '../widgets/numeric-drag.js';
import { slider, toggleBtn } from '../widgets/slider.js';
import { assets } from '../../media/asset-store.js';
import { getDeep } from '../../core/commands.js';
import { evalProp } from '../../engine/keyframes.js';
import { CLIP_COLORS } from '../../core/schema.js';
import { bus, raf } from '../../core/events.js';
import { ASPECTS } from '../../project/presets.js';
import { buildTextPanel } from './text-panel.js';
import { DEFAULT_TRANS_DUR, outgoingFor, pickFor, maxDurFor } from '../../engine/transitions.js';
import { defaultFx } from '../../engine/layers/fx.js';
import { GFX_LOOKS } from '../graphics/looks.js';
import { MOTIONS, MOTION_PATHS } from '../graphics/motion.js';
import { buildKeysStrip } from './keys-strip.js';

const KF_ICON = `<svg viewBox="0 0 24 24"><path d="M12 3 21 12 12 21 3 12z"/></svg>`;

export function initInspector({ store, cmds, comp, playback }) {
  const root = document.getElementById('inspectorRoot');
  const audioRoot = document.getElementById('audioRoot');
  let live = [];   // [{path, el}] refreshed as the playhead moves

  const rerender = raf(build);

  function build() {
    const sel = store.selectedClips;
    live = [];
    root.innerHTML = '';
    if (sel.length !== 1) return buildProject(sel.length);
    buildClip(sel[0].clip, sel[0].track);
    buildAudio(sel[0].clip, sel[0].track);
  }

  /* ── Nothing selected → project settings ──────────────────── */
  function buildProject(n) {
    audioRoot.dataset.clip = '';
    audioRoot.innerHTML = `<div class="empty"><b>No clip selected</b><span>Select a video or music clip to mix it.</span></div>`;
    if (n > 1) {
      root.innerHTML = `<div class="empty"><b>${n} clips selected</b>
        <span>Nudge with the arrow keys, split with S, or drag on the timeline. Select one clip to edit its properties.</span></div>`;
      return;
    }
    const g = group('Project');
    const doc = store.doc;
    const ar = document.createElement('select');
    ar.className = 'sel';
    for (const [k, p] of Object.entries(ASPECTS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = `${k} — ${p.width}×${p.height}`;
      o.selected = doc.aspect === k;
      ar.appendChild(o);
    }
    ar.addEventListener('change', () => {
      // The top-bar pills re-derive themselves from the document, so there is
      // nothing to toggle here.
      cmds.setResolution(ASPECTS[ar.value]);
      comp.resize();
    });
    g.body.appendChild(row('Aspect', ar));

    const fps = document.createElement('select');
    fps.className = 'sel';
    for (const f of [24, 30, 50, 60, 120]) {
      const o = document.createElement('option');
      o.value = f; o.textContent = f + ' fps'; o.selected = doc.fps === f;
      fps.appendChild(o);
    }
    fps.addEventListener('change', () => cmds.setResolution({ fps: +fps.value }));
    g.body.appendChild(row('Frame rate', fps));

    const bg = document.createElement('input');
    bg.type = 'color'; bg.className = 'swatch'; bg.value = doc.bg || '#000000';
    bg.addEventListener('input', () => { doc.bg = bg.value; comp.render(); });
    g.body.appendChild(row('Background', bg));

    g.body.appendChild(row('BPM', numField({
      value: doc.bpm, min: 40, max: 300, step: .25, decimals: 1,
      onCommit: v => cmds.setBPM(v),
    })));

    root.appendChild(g);

    const tip = document.createElement('div');
    tip.className = 'empty';
    tip.innerHTML = `<b>Nothing selected</b><span>Drop media on the timeline, or press T for a text layer.</span>`;
    root.appendChild(tip);
  }

  /* ── Clip inspector ───────────────────────────────────────── */
  function buildClip(clip, track) {
    const head = document.createElement('div');
    head.className = 'insp__head';
    head.innerHTML = `<i class="insp__swatch" style="--c:${(CLIP_COLORS[clip.type] || CLIP_COLORS.video)[0]}"></i>
      <div class="insp__title"><b>${clip.name || clip.type}</b>
        <span>${clip.type} · ${track.name}</span></div>`;
    root.appendChild(head);

    /* Timing */
    const gT = group('Timing');
    gT.body.appendChild(row('Start',
      numField({ value: clip.start, min: 0, step: .01, decimals: 2, suffix: 's',
        onInput: v => { clip.start = v; comp.render(); store.emit('rt', {}); },
        onCommit: v => cmds.setClipProp(clip.id, 'start', v, { label: 'Set start' }) })));
    gT.body.appendChild(row('Duration',
      numField({ value: clip.duration, min: 1 / store.doc.fps, step: .01, decimals: 2, suffix: 's',
        onCommit: v => cmds.setClipProp(clip.id, 'duration', v, { label: 'Set duration' }) })));
    if (clip.type !== 'text' && clip.type !== 'shape') {
      gT.body.appendChild(row('Speed',
        // setClipSpeed, not setClipProp: the clip has to get shorter as it gets
        // faster, and the duration field above has to show the new length.
        numField({ value: clip.speed, min: .1, max: 64, step: .01, decimals: 2, suffix: '×',
          onCommit: (v) => { cmds.setClipSpeed(clip.id, v); rerender(); } })));
    }
    gT.body.appendChild(row('Fade',
      numField({ label: 'in', value: clip.fadeIn, min: 0, step: .01, decimals: 2,
        onCommit: v => cmds.setClipProp(clip.id, 'fadeIn', v, { label: 'Fade in' }) }),
      numField({ label: 'out', value: clip.fadeOut, min: 0, step: .01, decimals: 2,
        onCommit: v => cmds.setClipProp(clip.id, 'fadeOut', v, { label: 'Fade out' }) })));
    // Last in the group: it is an extra, not one of the numbers that describe
    // the clip, and putting it between Speed and Fade broke the run of fields.
    if (clip.type !== 'text' && clip.type !== 'shape') buildBadge(clip, gT);
    root.appendChild(gT);

    /* Transform */
    if (track.kind !== 'audio') {
      const gX = group('Transform');
      gX.body.appendChild(kfRow(clip, 'Position', 'transform.x', 'transform.y'));
      gX.body.appendChild(kfRow(clip, 'Scale', 'transform.scale'));
      gX.body.appendChild(kfRow(clip, 'Rotation', 'transform.rotation'));
      gX.body.appendChild(kfRow(clip, 'Opacity', 'transform.opacity'));

      const reset = document.createElement('button');
      reset.className = 'fontdrop';
      reset.textContent = 'Reset transform';
      reset.addEventListener('click', () => {
        cmds.setClipProp(clip.id, 'transform',
          { ...clip.transform, x: .5, y: .5, scale: 1, rotation: 0, opacity: 1 },
          { merge: false, label: 'Reset transform' });
        rerender();
      });
      gX.body.appendChild(reset);
      root.appendChild(gX);
    }

    if (clip.type === 'video' || clip.type === 'image') buildTransition(clip, track);
    if (clip.type === 'video' || clip.type === 'image') buildLook(clip);
    if (track.kind !== 'audio') buildMotion(clip);
    if (clip.crop) buildCrop(clip);
    if (clip.type === 'text') buildText(clip);
    if (clip.type === 'shape') buildShape(clip);
  }

  /**
   * The "2×" badge.
   *
   * Optional and off by default: most clips that are sped up do not need to
   * announce it, and a badge that appeared by itself would be one more thing to
   * delete. It only offers itself once a clip is actually running at something
   * other than normal speed, because that is the only moment the idea makes
   * sense.
   */
  function buildBadge(clip, g) {
    const badge = cmds.badgeOf?.(clip.id);
    const sped = Math.abs((clip.speed || 1) - 1) > 1e-3;
    if (!sped && !badge) return;

    const b = document.createElement('button');
    b.className = 'fontdrop';
    b.id = 'btnSpeedBadge';
    b.textContent = badge
      ? 'Remove the speed badge'
      : `Show a ${cmds.speedLabel(clip.speed)} badge on the picture`;
    b.addEventListener('click', () => {
      if (badge) cmds.removeSpeedBadge(clip.id);
      else {
        const r = cmds.addSpeedBadge(clip.id);
        if (r?.ok) bus.emit('toast', {
          msg: 'Badge added — drag it anywhere on the picture, or restyle it like any other text.',
          ms: 4800,
        });
      }
      rerender();
      comp.render();
    });
    g.body.appendChild(b);

    if (badge) {
      const note = document.createElement('p');
      note.className = 'insp__help';
      note.textContent = 'It follows this clip: change the speed and the badge '
        + 'rewrites itself. Select it on the timeline to move or restyle it.';
      g.body.appendChild(note);
    }
  }

  /**
   * How this clip arrives after the cut before it.
   *
   * The Inspector says what is set and sends you where it is chosen. The
   * picking happens in the Transitions panel, where the options are pictures of
   * themselves — four names in a row of chips is the version of this feature
   * that nobody found. Duplicating the picker here would give two places to
   * change one thing and two chances for them to disagree.
   */
  function buildTransition(clip, track) {
    const cut = outgoingFor(track, clip);
    if (!cut && !clip.transIn) return;

    const g = group('Transition in');
    const pick = pickFor(clip);

    const line = document.createElement('p');
    line.className = 'insp__help';
    if (!cut) {
      line.innerHTML = 'Nothing is cut to this clip on this track, so a transition '
        + 'here has nothing to come from. Put another clip directly before it.';
      g.body.appendChild(line);
      root.appendChild(g);
      return;
    }
    line.textContent = pick
      ? `${pick.name} — ${pick.blurb}`
      : 'A hard cut. Pick something else in the Transitions panel on the left.';
    g.body.appendChild(line);

    if (pick) {
      g.body.appendChild(row('Length',
        numField({ value: clip.transIn.dur ?? DEFAULT_TRANS_DUR,
          min: 0.1, max: maxDurFor(cut, clip), step: .05, decimals: 2, suffix: 's',
          onInput: v => { clip.transIn.dur = v; comp.render(); },
          onCommit: v => cmds.setClipProp(clip.id, 'transIn',
            { ...clip.transIn, dur: v }, { merge: false, label: 'Transition length' }) })));
    }

    const open = document.createElement('button');
    open.className = 'fontdrop';
    open.id = 'inspOpenTransitions';
    open.textContent = pick ? 'Change it in the Transitions panel' : 'Choose a transition…';
    open.addEventListener('click', () => {
      store.setRT({ junction: clip.id });
      bus.emit('transitions:open', { clipId: clip.id });
    });
    g.body.appendChild(open);
    root.appendChild(g);
  }

  /* ── Movement ──────────────────────────────────────────────── */

  /**
   * Movement, with nothing hidden behind it.
   *
   * Each preset writes ordinary keyframes onto the clip and the strip below
   * shows those very keyframes — so the moment a preset is nearly right, the
   * thing you need to adjust is already on screen. There is no "preset mode" to
   * leave and no animation the editor knows about that you cannot see.
   */
  function buildMotion(clip) {
    const animated = Object.keys(clip.keys || {}).some(p => (clip.keys[p] || []).length);
    // Open by default. A graphic that has not been animated yet is exactly the
    // one whose owner is looking for these, and a collapsed group is a group
    // nobody finds.
    void animated;
    const g = group('Movement', true);

    const chips = document.createElement('div');
    chips.className = 'looks looks--motion';
    for (const m of MOTIONS) {
      const b = document.createElement('button');
      b.className = 'chip-btn';
      b.dataset.motion = m.id;
      b.textContent = m.name;
      b.title = m.note;
      b.addEventListener('click', () => {
        const tracks = m.build(clip) || {};
        cmds.setKeyTracks(clip.id, tracks,
          { clear: MOTION_PATHS, label: `Movement: ${m.name}` });
        // Park inside the move so the result is on screen rather than described.
        if (Object.keys(tracks).length) {
          playback?.pause?.();
          playback?.seek?.(clip.start + Math.min(clip.duration * 0.5, 0.35));
        }
        comp.render();
        rerender();
      });
      chips.appendChild(b);
    }
    g.body.appendChild(chips);

    const help = document.createElement('p');
    help.className = 'insp__help';
    help.textContent = 'Every one of these is made of plain keyframes. Pick the '
      + 'closest and then drag the diamonds below \u2014 there is nothing else going on '
      + 'underneath.';
    g.body.appendChild(help);

    buildKeysStrip({ clip, store, cmds, comp, playback, rerender, mount: g.body });
    root.appendChild(g);
  }

  /* ── Look: what surrounds the picture ──────────────────────── */

  /** Effects are only written when something is actually set. */
  const ensureFx = (clip) => (clip.fx ||= defaultFx());

  /**
   * A slider bound to one number inside `fx`.
   *
   * Straight onto the object while dragging so the preview keeps up, through
   * the command on release so there is one undo step for the whole drag rather
   * than one per pixel of travel.
   */
  function fxSlide(clip, label, key, opts = {}) {
    const {
      min = 0, max = 1, step = 0.005, reset = 0,
      format = (v) => `${Math.round((v / (max || 1)) * 100)}%`,
      tip = '',
    } = opts;
    // Where the value was before this gesture, so undo has a real "before".
    let before = (clip.fx?.[key]) ?? defaultFx()[key];
    const el = slider({
      value: before, min, max, step, reset, format,
      onStart: () => { before = (clip.fx?.[key]) ?? defaultFx()[key]; },
      onInput: (v) => { ensureFx(clip)[key] = v; comp.render(); },
      onCommit: (v) => {
        // Put it back for the instant the command runs: it clones the document
        // to remember the "before", and the fader has already been writing the
        // "after" straight onto it the whole way down.
        ensureFx(clip)[key] = before;
        cmds.setClipProp(clip.id, `fx.${key}`, v, { merge: false, label });
        comp.render();
      },
    });
    if (tip) el.title = tip;
    return el;
  }

  /** A colour well bound to one string inside `fx`. */
  function fxColour(clip, key, label) {
    const i = document.createElement('input');
    i.type = 'color';
    i.className = 'swatch';
    let before = (clip.fx?.[key]) || defaultFx()[key] || '#ffffff';
    i.value = before;
    i.addEventListener('pointerdown', () => { before = (clip.fx?.[key]) || defaultFx()[key] || '#ffffff'; });
    i.addEventListener('input', () => { ensureFx(clip)[key] = i.value; comp.render(); });
    i.addEventListener('change', () => {
      ensureFx(clip)[key] = before;          // see fxSlide: give undo a "before"
      cmds.setClipProp(clip.id, `fx.${key}`, i.value, { merge: false, label });
      comp.render();
    });
    return i;
  }

  /**
   * Which preset, if any, this clip currently matches.
   *
   * Compared on the numbers rather than on a stored id, so a look stays lit
   * until you actually change something — and stops being lit the moment you
   * do, which is the honest answer to "is this still the Sticker look".
   */
  function currentLook(clip) {
    const fx = clip.fx;
    const same = (a, b) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      for (const k of Object.keys(defaultFx())) {
        const x = a[k] ?? defaultFx()[k], y = b[k] ?? defaultFx()[k];
        if (typeof x === 'number' ? Math.abs(x - y) > 1e-4 : x !== y) return false;
      }
      return true;
    };
    for (const l of GFX_LOOKS) {
      if (l.fx == null && (!fx || same(fx, defaultFx()))) return l.id;
      if (l.fx && same(fx, l.fx)) return l.id;
    }
    return null;
  }

  function buildLook(clip) {
    const g = group('Look', true);
    const now = currentLook(clip);

    /* The same seven looks as the Graphics tab, so picking one there and
       recognising it here is the same act. */
    const chips = document.createElement('div');
    chips.className = 'looks';
    for (const l of GFX_LOOKS) {
      const b = document.createElement('button');
      b.className = 'gfxlook' + (l.id === now ? ' is-on' : '');
      b.dataset.look = l.id;
      b.title = l.note;
      b.innerHTML = `<span class="gfxlook__art">${l.art}</span><span class="gfxlook__name"></span>`;
      b.querySelector('.gfxlook__name').textContent = l.name;
      b.addEventListener('click', () => {
        cmds.setClipProp(clip.id, 'fx', l.fx ? { ...l.fx } : null,
          { merge: false, label: `Look: ${l.name}` });
        comp.render();
        rerender();
      });
      chips.appendChild(b);
    }
    g.body.appendChild(chips);

    g.body.appendChild(row('Corners', fxSlide(clip, 'Corner rounding', 'radius',
      { max: 0.5, step: 0.005, tip: 'Round the corners of the layer. All the way round makes a circle.' })));

    /* Glow and shadow are separate on purpose — see the text renderer for the
       same argument. One "blur" control forces you to choose between a soft
       drop shadow and a coloured halo, and you end up with neither. */
    g.body.appendChild(row('Glow',
      fxSlide(clip, 'Glow', 'glow', { max: 0.4, step: 0.004, tip: 'Coloured light behind the layer, following its shape.' }),
      fxColour(clip, 'glowColor', 'Glow colour')));
    if ((clip.fx?.glow || 0) > 0) {
      g.body.appendChild(row('Strength', fxSlide(clip, 'Glow strength', 'glowStrength',
        { max: 2, step: 0.02, reset: 1, format: (v) => v.toFixed(1) + '\u00d7' })));
    }

    g.body.appendChild(row('Shadow',
      fxSlide(clip, 'Shadow', 'shadow', { max: 0.35, step: 0.004, tip: 'Lifts the layer off the footage underneath it.' }),
      fxColour(clip, 'shadowColor', 'Shadow colour')));
    if ((clip.fx?.shadow || 0) > 0) {
      g.body.appendChild(row('Drop', fxSlide(clip, 'Shadow offset', 'shadowY',
        { min: -0.2, max: 0.2, step: 0.002, reset: 0.03,
          format: (v) => (v * 100).toFixed(0) })));
    }

    g.body.appendChild(row('Outline',
      fxSlide(clip, 'Outline', 'outline', { max: 0.08, step: 0.001, tip: 'A sticker edge that follows the shape of a cut-out.' }),
      fxColour(clip, 'outlineColor', 'Outline colour')));

    g.body.appendChild(row('Tint',
      fxSlide(clip, 'Tint', 'tintAmount', { max: 1, step: 0.01, tip: 'Wash the layer in a colour.' }),
      fxColour(clip, 'tint', 'Tint colour')));

    root.appendChild(g);

    /* ── 3D ───────────────────────────────────────────────── */
    const g3 = group('Turn it in space', !!(clip.fx?.tiltX || clip.fx?.tiltY || clip.fx?.depth));
    const note = document.createElement('p');
    note.className = 'insp__help';
    note.textContent = 'Tilt the layer as if it were a physical card standing in '
      + 'the scene. Thickness adds a slab underneath, which is what makes it read '
      + 'as an object rather than a skewed picture.';
    g3.body.appendChild(note);
    g3.body.appendChild(row('Turn', fxSlide(clip, 'Turn sideways', 'tiltY',
      { min: -45, max: 45, step: 0.5, reset: 0, format: (v) => v.toFixed(0) + '\u00b0' })));
    g3.body.appendChild(row('Lean', fxSlide(clip, 'Lean back', 'tiltX',
      { min: -45, max: 45, step: 0.5, reset: 0, format: (v) => v.toFixed(0) + '\u00b0' })));
    g3.body.appendChild(row('Thickness', fxSlide(clip, 'Thickness', 'depth',
      { max: 0.3, step: 0.004 })));
    root.appendChild(g3);

    if (clip.fx) {
      const off = document.createElement('button');
      off.className = 'fontdrop';
      off.id = 'btnClearFx';
      off.textContent = 'Take all the effects off';
      off.addEventListener('click', () => {
        cmds.setClipProp(clip.id, 'fx', null, { merge: false, label: 'Clear effects' });
        comp.render();
        rerender();
      });
      g3.body.appendChild(off);
    }
  }

  /**
   * Fine adjustment of a cropped region.
   *
   * The rectangle is drawn on the picture, which is the right way to place it;
   * these are for the last two percent — nudging an edge so a counter is not
   * clipped, or matching two crops to exactly the same size. Shown as
   * percentages of the source frame because that is what the numbers mean, and
   * a pixel figure would be a lie the moment the footage resolution changed.
   */
  function buildCrop(clip) {
    const g = group('Crop');
    const set = (key, v) => {
      cmds.setClipProp(clip.id, 'crop',
        { ...clip.crop, [key]: Math.max(0, Math.min(1, v / 100)) },
        { merge: false, label: 'Adjust crop' });
      comp.render();
    };
    const pct = (key, label) => numField({
      label, value: (clip.crop[key] || 0) * 100, min: 0, max: 100, step: .5,
      decimals: 1, suffix: '%', onCommit: v => set(key, v),
    });

    g.body.appendChild(row('Position', pct('x', 'X'), pct('y', 'Y')));
    g.body.appendChild(row('Size', pct('w', 'W'), pct('h', 'H')));

    if (clip.crop.shape || clip.crop.mask) {
      const note = document.createElement('p');
      note.className = 'insp__help';
      note.textContent = clip.crop.mask
        ? 'This piece is cut to the shape you painted, so only what you brushed '
          + 'is shown. The numbers above are the box around that shape.'
        : 'This piece is masked to a shape you drew, so only what you traced is '
          + 'painted. The numbers above are the box around that shape.';
      g.body.appendChild(note);

      const redo = document.createElement('button');
      redo.className = 'fontdrop';
      redo.textContent = 'Paint it again…';
      redo.addEventListener('click', () => bus.emit('crop:start'));
      g.body.appendChild(redo);

      const drop = document.createElement('button');
      drop.className = 'fontdrop';
      drop.textContent = 'Go back to a plain rectangle';
      drop.addEventListener('click', () => {
        const { shape, mask, ...rest } = clip.crop;
        void shape; void mask;
        cmds.setClipProp(clip.id, 'crop', rest, { merge: false, label: 'Drop crop shape' });
        comp.render();
        rerender();
      });
      g.body.appendChild(drop);
    }

    const off = document.createElement('button');
    off.className = 'fontdrop';
    off.textContent = 'Remove crop (show whole frame)';
    off.addEventListener('click', () => {
      cmds.setClipProp(clip.id, 'crop', null, { merge: false, label: 'Remove crop' });
      comp.render();
      rerender();
    });
    g.body.appendChild(off);
    root.appendChild(g);
  }

  /** A property row with numeric fields and a keyframe stopwatch. */
  function kfRow(clip, label, ...paths) {
    const r = document.createElement('div');
    r.className = 'row row--kf';
    const l = document.createElement('label');
    l.textContent = label;
    r.appendChild(l);

    const holder = document.createElement('div');
    holder.className = paths.length > 1 ? 'row__pair' : '';
    for (const path of paths) {
      const isAngle = path.endsWith('rotation');
      const isPct = path.endsWith('opacity');
      const f = numField({
        label: paths.length > 1 ? path.split('.').pop().toUpperCase() : '',
        value: displayVal(clip, path),
        step: isAngle ? .5 : isPct ? .005 : .002,
        decimals: isAngle ? 1 : isPct ? 2 : 3,
        min: isPct ? 0 : -Infinity, max: isPct ? 1 : Infinity,
        onInput: (v) => { writeProp(clip, path, v); },
        onCommit: (v) => commitProp(clip, path, v),
      });
      live.push({ clip, path, el: f });
      holder.appendChild(f);
    }
    r.appendChild(holder);

    const kf = document.createElement('button');
    kf.className = 'kf' + (paths.some(p => clip.keys?.[p]) ? ' is-on' : '');
    kf.innerHTML = KF_ICON;
    kf.title = 'Toggle keyframes';
    kf.addEventListener('click', () => {
      for (const p of paths) cmds.toggleKeyTrack(clip.id, p);
      rerender();
    });
    r.appendChild(kf);
    return r;
  }

  const displayVal = (clip, path) => evalProp(clip, path, store.rt.playhead);

  function writeProp(clip, path, v) {
    const keys = clip.keys?.[path];
    if (keys) return;                       // keyed props commit as keyframes
    const parts = path.split('.');
    const last = parts.pop();
    parts.reduce((o, k) => o[k], clip)[last] = v;
    comp.render();
  }

  function commitProp(clip, path, v) {
    if (clip.keys?.[path]) cmds.setKeyAt(clip.id, path, store.rt.playhead, v);
    else cmds.setClipProp(clip.id, path, v, { label: 'Adjust ' + path.split('.').pop() });
    comp.render();
  }

  /* ── Text ─────────────────────────────────────────────────── */
  function buildText(clip) {
    buildTextPanel({ clip, root, store, cmds, comp, rerender });
  }

  function buildShape(clip) {
    const g = group('Shape');
    const fill = document.createElement('input');
    fill.type = 'color'; fill.className = 'swatch';
    fill.value = Array.isArray(clip.shape.fill) ? clip.shape.fill[0] : (clip.shape.fill || '#2563eb').slice(0, 7);
    fill.addEventListener('input', () => { clip.shape.fill = fill.value; comp.render(); });
    fill.addEventListener('change', () =>
      cmds.setClipProp(clip.id, 'shape.fill', fill.value, { merge: false, label: 'Shape fill' }));
    g.body.appendChild(row('Fill', fill));
    g.body.appendChild(kfRow(clip, 'Width', 'transform.w'));
    g.body.appendChild(kfRow(clip, 'Height', 'transform.h'));
    root.appendChild(g);
  }

  /* ── Audio tab ────────────────────────────────────────────── */

  /**
   * Does this clip make a sound?
   *
   * A video carries its soundtrack like any other audio, and for a year this
   * panel pretended otherwise — it checked what *track* the clip sat on, so the
   * volume of a gameplay recording could not be changed at all. The question
   * that matters is whether the asset has audio, not where the clip was dropped.
   */
  function hasSound(clip) {
    if (clip.type !== 'video' && clip.type !== 'audio') return false;
    if (clip.silent) return false;
    const a = assets.get(clip.assetId);
    return !!(a && (a.peaks?.buffer || a.streamAudio));
  }

  /** Push a level change into the running mix so you can hear the fader move. */
  const liveMix = (clip) => { try { playback?.audio?.liveGain(clip); } catch {} };

  /** Fades are ramps booked against the old level; rebuild them on release. */
  function resettle(clip) {
    if (!store.rt.playing) return;
    if (clip.fadeIn || clip.fadeOut) playback?.audio?.start(store.rt.playhead);
  }

  function buildAudio(clip, track) {
    audioRoot.innerHTML = '';
    // Which clip these controls are wired to. The panel is rebuilt on a frame,
    // so for a moment after a new selection it still shows the old one's
    // controls — harmless to a person, fatal to a test that clicks them.
    audioRoot.dataset.clip = clip.id;

    if (!hasSound(clip)) {
      const why = clip.silent
        ? 'Another clip is carrying this one’s sound — select that one to mix it.'
        : clip.type === 'text' || clip.type === 'shape' || clip.type === 'image'
          ? 'This layer is picture only. Select a video or a music clip to mix it.'
          : 'This file has no soundtrack.';
      audioRoot.innerHTML = `<div class="empty"><b>${clip.name || clip.type}</b><span>${why}</span></div>`;
      return;
    }

    const g = group('Mix');

    /* Mute. First, because it is the one people reach for in a hurry. */
    const mute = toggleBtn({
      label: clip.muted ? 'Muted' : 'Mute',
      on: !!clip.muted,
      title: 'Silence this clip without changing its level',
      onChange: (on) => {
        mute.textContent = on ? 'Muted' : 'Mute';
        cmds.setClipProp(clip.id, 'muted', on, { merge: false, label: on ? 'Mute clip' : 'Unmute clip' });
        liveMix(clip);
        vol.classList.toggle('is-off', on);
      },
    });
    g.body.appendChild(row('Sound', mute));

    /* Level. 0–200%: above 100 is genuinely useful on quiet game capture, and
       stopping at 100 sends people off to re-record instead. */
    let volBefore = clip.volume ?? 1;
    const vol = slider({
      value: volBefore, min: 0, max: 2, step: .01, reset: 1,
      format: (v) => `${Math.round(v * 100)}%`,
      onStart: () => { volBefore = clip.volume ?? 1; },
      onInput: (v) => { clip.volume = v; liveMix(clip); },
      onCommit: (v) => {
        clip.volume = volBefore;             // so undo has somewhere to go back to
        cmds.setClipProp(clip.id, 'volume', v, { label: 'Clip volume' });
        resettle(clip);
      },
    });
    vol.classList.toggle('is-off', !!clip.muted);
    vol.title = 'Drag to set the level. Double-click for 100%. Hold Shift for fine control.';
    g.body.appendChild(row('Volume', vol));

    /* Fades live here as well as in Timing. They are an audio idea first, and
       a person mixing a clip should not have to go and find another tab. */
    g.body.appendChild(row('Fade',
      numField({ label: 'in', value: clip.fadeIn, min: 0, max: 30, step: .01, decimals: 2, suffix: 's',
        onCommit: v => { cmds.setClipProp(clip.id, 'fadeIn', v, { label: 'Fade in' }); resettle(clip); } }),
      numField({ label: 'out', value: clip.fadeOut, min: 0, max: 30, step: .01, decimals: 2, suffix: 's',
        onCommit: v => { cmds.setClipProp(clip.id, 'fadeOut', v, { label: 'Fade out' }); resettle(clip); } })));

    audioRoot.appendChild(g);

    /* Track level — the same fader, one level up. */
    const gt = group(`Track — ${track.name}`);
    const tmute = toggleBtn({
      label: track.muted ? 'Muted' : 'Mute',
      on: !!track.muted,
      title: 'Silence every clip on this track',
      onChange: (on) => {
        tmute.textContent = on ? 'Muted' : 'Mute';
        track.muted = on;
        store.docChanged(on ? 'mute track' : 'unmute track');
        if (store.rt.playing) playback?.audio?.start(store.rt.playhead);
      },
    });
    gt.body.appendChild(row('Whole track', tmute));
    gt.body.appendChild(row('Volume', slider({
      value: track.volume ?? 1, min: 0, max: 2, step: .01, reset: 1,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { track.volume = v; liveMix(clip); },
      onCommit: () => { store.docChanged('track volume'); resettle(clip); },
    })));
    audioRoot.appendChild(gt);

    /* A video's soundtrack is often wanted on its own lane — to duck it under
       music, or to keep it when the picture is replaced. */
    if (clip.type === 'video') {
      const gx = group('Soundtrack');
      const note = document.createElement('p');
      note.className = 'insp__help';
      note.textContent = 'Put this video’s sound on its own audio track, so it can be '
        + 'moved, trimmed and mixed on its own. The picture stays where it is.';
      const btn = document.createElement('button');
      btn.className = 'fontdrop';
      btn.textContent = 'Take the audio out onto its own track';
      btn.addEventListener('click', () => { cmds.extractAudio(clip.id); rerender(); });
      gx.body.append(note, btn);
      audioRoot.appendChild(gx);
    }

    if (track.kind !== 'audio') return;

    const gs = group('Beat sync');
    const snapBtn = document.createElement('button');
    snapBtn.className = 'fontdrop';
    snapBtn.textContent = 'Snap clip start to nearest beat';
    snapBtn.addEventListener('click', () => {
      const step = 60 / store.doc.bpm;
      const t = Math.round((clip.start - store.doc.beatOffset) / step) * step + store.doc.beatOffset;
      cmds.setClipProp(clip.id, 'start', Math.max(0, t), { merge: false, label: 'Snap to beat' });
    });
    const setOffset = document.createElement('button');
    setOffset.className = 'fontdrop';
    setOffset.textContent = 'Set beat 1 at playhead';
    setOffset.addEventListener('click', () => {
      store.doc.beatOffset = store.rt.playhead;
      store.docChanged('beat offset');
    });
    gs.body.append(snapBtn, setOffset);
    audioRoot.appendChild(gs);
  }

  /* ── Live value refresh while scrubbing keyed properties ──── */
  store.on('playhead', () => {
    for (const { clip, path, el } of live) {
      if (clip.keys?.[path]) el.setValue(evalProp(clip, path, store.rt.playhead));
    }
  });

  store.on('selection', rerender);
  store.on('doc', rerender);
  bus.on('inspector:refresh', rerender);
  void getDeep;

  build();
  return { rerender };
}
