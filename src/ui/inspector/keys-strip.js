import { evalProp, EASINGS } from '../../engine/keyframes.js';

/**
 * The keyframe strip.
 *
 * One row per animated property, each a miniature of the clip's own length with
 * a diamond at every key. This is the part that makes "advanced" and "easy to
 * use for anyone" not contradict each other: the presets write ordinary
 * keyframes, and this shows you the very same keyframes, so the first time you
 * want something slightly different you are already looking at the thing you
 * need to drag.
 *
 * Deliberately small. A full graph editor with bezier handles is a better tool
 * for someone who already knows what a bezier handle is, and a worse one for
 * everybody else; the easing of each key is a menu instead, which covers the
 * same ground in words people already have.
 *
 *   click a diamond      put the playhead on it
 *   drag a diamond       move it in time
 *   double-click         delete it
 *   click empty track    add a key there, at whatever the value is then
 *   right-click a key    choose how it eases
 */

const LABELS = {
  'transform.x': 'Across',
  'transform.y': 'Down',
  'transform.scale': 'Size',
  'transform.rotation': 'Turn',
  'transform.opacity': 'Fade',
  'transform.w': 'Width',
  'transform.h': 'Height',
  'text.size': 'Text size',
};

const EASE_NAMES = {
  linear: 'Steady',
  ease: 'Soft both ends',
  in: 'Slow start',
  out: 'Slow finish',
  inout: 'Slow both ends',
  hold: 'Snap (no blend)',
  back: 'Overshoot',
};

export function buildKeysStrip({ clip, store, cmds, comp, playback, rerender, mount }) {
  const paths = Object.keys(clip.keys || {}).filter(p => (clip.keys[p] || []).length);
  const wrap = document.createElement('div');
  wrap.className = 'keys';
  wrap.id = 'keysStrip';

  if (!paths.length) {
    const p = document.createElement('p');
    p.className = 'insp__help';
    p.textContent = 'No keyframes on this layer yet. Pick a movement above, or '
      + 'press the diamond next to any property to start animating it by hand.';
    wrap.appendChild(p);
    mount.appendChild(wrap);
    return wrap;
  }

  /* A shared ruler line so every row reads against the same clip length. */
  const head = document.createElement('div');
  head.className = 'keys__head';
  head.innerHTML = `<span>Keyframes</span><b></b>`;
  head.querySelector('b').textContent = `${clip.duration.toFixed(2)}s`;
  wrap.appendChild(head);

  for (const path of paths) {
    wrap.appendChild(buildRow(path));
  }

  const clearAll = document.createElement('button');
  clearAll.className = 'fontdrop';
  clearAll.id = 'btnClearKeys';
  clearAll.textContent = 'Remove all the movement';
  clearAll.addEventListener('click', () => {
    cmds.setKeyTracks(clip.id, {}, { clear: paths, label: 'Remove movement' });
    comp.render();
    rerender();
  });
  wrap.appendChild(clearAll);

  mount.appendChild(wrap);
  return wrap;

  /* ── One property ───────────────────────────────────────── */
  function buildRow(path) {
    const row = document.createElement('div');
    row.className = 'keys__row';
    row.dataset.path = path;

    const label = document.createElement('span');
    label.className = 'keys__name';
    label.textContent = LABELS[path] || path.split('.').pop();
    label.title = path;
    row.appendChild(label);

    const track = document.createElement('div');
    track.className = 'keys__track';
    track.tabIndex = 0;
    row.appendChild(track);

    const kill = document.createElement('button');
    kill.className = 'keys__x';
    kill.title = `Stop animating ${label.textContent.toLowerCase()}`;
    kill.textContent = '×';
    kill.addEventListener('click', () => {
      cmds.setKeyTracks(clip.id, {}, { clear: [path], label: 'Stop animating' });
      comp.render();
      rerender();
    });
    row.appendChild(kill);

    paintRow(track, path);

    /* Adding: a click on bare track. The value comes from wherever the property
       already is at that moment, so a new key never jolts the animation. */
    track.addEventListener('pointerdown', (e) => {
      if (e.target !== track) return;
      const local = localAt(track, e.clientX);
      const at = clip.start + local;
      cmds.setKeyAt(clip.id, path, at, evalProp(clip, path, at));
      comp.render();
      rerender();
    });

    return row;
  }

  function localAt(track, clientX) {
    const r = track.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1)));
    return +(p * clip.duration).toFixed(4);
  }

  function paintRow(track, path) {
    track.innerHTML = '';
    const list = clip.keys[path] || [];
    const dur = Math.max(1e-3, clip.duration);

    /* Where the playhead is, if it is inside this clip. */
    const head = store.rt.playhead - clip.start;
    if (head >= 0 && head <= dur) {
      const ph = document.createElement('i');
      ph.className = 'keys__ph';
      ph.style.left = (head / dur * 100) + '%';
      track.appendChild(ph);
    }

    for (const k of list) {
      const d = document.createElement('button');
      d.className = 'keys__k';
      d.style.left = (k.t / dur * 100) + '%';
      d.dataset.t = String(k.t);
      d.title = `${(k.t).toFixed(2)}s · ${EASE_NAMES[k.e] || k.e}`
        + ' — drag to move, double-click to delete, right-click for easing';
      track.appendChild(d);

      d.addEventListener('dblclick', (e) => {
        e.preventDefault(); e.stopPropagation();
        cmds.removeKeyAt(clip.id, path, k.t);
        comp.render();
        rerender();
      });

      d.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        easingMenu(e, path, k);
      });

      /**
       * Dragging a diamond.
       *
       * The key is moved by hand during the drag and only put through a command
       * on release. Going through the command on every pointermove looks
       * obviously right and is fatal: each one is a document change, the
       * Inspector rebuilds itself on the next frame, and this very button —
       * along with its pointer capture and these listeners — is thrown away
       * about one frame into the gesture. The diamond would move four pixels
       * and stop dead.
       *
       * Restoring the original time before committing gives history a correct
       * "before", so one Ctrl+Z undoes the whole drag.
       */
      d.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        d.setPointerCapture(e.pointerId);
        const startT = k.t;
        let at = k.t;
        let moved = false;

        const move = (ev) => {
          const to = localAt(track, ev.clientX);
          if (Math.abs(to - at) < 1e-4) return;
          moved = true;
          at = Math.max(0, Math.min(clip.duration, to));
          k.t = at;
          list.sort((a, b) => a.t - b.t);
          d.style.left = (at / dur * 100) + '%';
          comp.render();
        };
        const up = () => {
          d.removeEventListener('pointermove', move);
          d.removeEventListener('pointerup', up);
          d.removeEventListener('pointercancel', up);
          if (moved) {
            k.t = startT;
            list.sort((a, b) => a.t - b.t);
            cmds.moveKeyTo(clip.id, path, startT, at);
            comp.render();
            rerender();
          } else {
            // A plain click parks the playhead on the key, which is what you
            // want before changing its value in the field above — and parking
            // means stopping, not jumping backwards and carrying on.
            playback?.pause?.();
            playback?.seek?.(clip.start + k.t);
          }
        };
        d.addEventListener('pointermove', move);
        d.addEventListener('pointerup', up);
        // Without this a cancelled gesture leaves `move` bound, and since
        // pointermove fires on plain hover the key would then follow the
        // cursor with no button held down.
        d.addEventListener('pointercancel', up);
      });
    }
  }

  /** A tiny menu of easings, because "ease-in-out" is not a phrase anyone uses. */
  function easingMenu(e, path, k) {
    document.getElementById('easeMenu')?.remove();
    const m = document.createElement('div');
    m.className = 'ease';
    m.id = 'easeMenu';
    for (const id of Object.keys(EASINGS)) {
      const b = document.createElement('button');
      b.className = 'ease__item' + (k.e === id ? ' is-on' : '');
      b.textContent = EASE_NAMES[id] || id;
      b.addEventListener('click', () => {
        cmds.setKeyEasing(clip.id, path, k.t, id);
        m.dispatchEvent(new Event('gc:close'));
        comp.render();
        rerender();
      });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(e.clientX, window.innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(e.clientY, window.innerHeight - r.height - 8) + 'px';
    const away = (ev) => {
      if (m.contains(ev.target)) return;
      close();
    };
    const close = () => {
      m.remove();
      window.removeEventListener('pointerdown', away, true);
    };
    // Every exit goes through `close`, including choosing an item — otherwise
    // each right-click leaves a capture-phase listener armed on the window.
    m.addEventListener('gc:close', close);
    setTimeout(() => window.addEventListener('pointerdown', away, true), 0);
  }
}
