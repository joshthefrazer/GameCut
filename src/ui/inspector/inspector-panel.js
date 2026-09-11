import { numField, row, group } from '../widgets/numeric-drag.js';
import { getDeep } from '../../core/commands.js';
import { evalProp } from '../../engine/keyframes.js';
import { CLIP_COLORS } from '../../core/schema.js';
import { bus, raf } from '../../core/events.js';
import { ASPECTS } from '../../project/presets.js';
import { buildTextPanel } from './text-panel.js';
import { DEFAULT_TRANS_DUR, outgoingFor, pickFor, maxDurFor } from '../../engine/transitions.js';

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
    audioRoot.innerHTML = `<div class="empty"><b>No clip selected</b><span>Select an audio clip to mix it.</span></div>`;
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
    if (clip.type !== 'text' && clip.type !== 'shape')
      gT.body.appendChild(row('Speed',
        // setClipSpeed, not setClipProp: the clip has to get shorter as it gets
        // faster, and the duration field above has to show the new length.
        numField({ value: clip.speed, min: .1, max: 64, step: .01, decimals: 2, suffix: '×',
          onCommit: (v) => { cmds.setClipSpeed(clip.id, v); rerender(); } })));
    gT.body.appendChild(row('Fade',
      numField({ label: 'in', value: clip.fadeIn, min: 0, step: .01, decimals: 2,
        onCommit: v => cmds.setClipProp(clip.id, 'fadeIn', v, { label: 'Fade in' }) }),
      numField({ label: 'out', value: clip.fadeOut, min: 0, step: .01, decimals: 2,
        onCommit: v => cmds.setClipProp(clip.id, 'fadeOut', v, { label: 'Fade out' }) })));
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
    if (clip.crop) buildCrop(clip);
    if (clip.type === 'text') buildText(clip);
    if (clip.type === 'shape') buildShape(clip);
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

    if (clip.crop.shape) {
      const note = document.createElement('p');
      note.className = 'insp__help';
      note.textContent = 'This piece is masked to a shape you drew, so only what '
        + 'you traced is painted. The numbers above are the box around that shape.';
      g.body.appendChild(note);

      const drop = document.createElement('button');
      drop.className = 'fontdrop';
      drop.textContent = 'Go back to a plain rectangle';
      drop.addEventListener('click', () => {
        const { shape, ...rest } = clip.crop;
        void shape;
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
  function buildAudio(clip, track) {
    if (track.kind !== 'audio') {
      audioRoot.innerHTML = `<div class="empty"><b>${clip.name}</b><span>This is not an audio clip. Select a music or SFX clip to mix it.</span></div>`;
      return;
    }
    audioRoot.innerHTML = '';
    const g = group('Mix');
    g.body.appendChild(row('Clip gain',
      numField({ value: clip.volume, min: 0, max: 2, step: .01, decimals: 2,
        onCommit: v => cmds.setClipProp(clip.id, 'volume', v, { label: 'Clip gain' }) })));
    g.body.appendChild(row('Track gain',
      numField({ value: track.volume, min: 0, max: 2, step: .01, decimals: 2,
        onCommit: v => { track.volume = v; store.docChanged('track gain'); } })));
    audioRoot.appendChild(g);

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
  void playback; void getDeep;

  build();
  return { rerender };
}
