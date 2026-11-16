import { numField, row, group } from '../widgets/numeric-drag.js';
import { slider, toggleBtn } from '../widgets/slider.js';
import { ANIMATIONS, animById, valuesFor } from '../../anim/defs.js';
import { liveThumb } from '../anim/thumbs.js';

/**
 * Customize: everything about an animation clip, in words.
 *
 * A live preview at the top plays the animation with the values being typed,
 * then the animation's own settings (words, colours, numbers), how fast it
 * arrives and leaves, and its sound. Swapping for another animation keeps the
 * place and timing.
 */
export function buildAnimPanel({ clip, root, store, cmds, comp, rerender }) {
  const def = animById(clip.anim?.id);
  if (!def) {
    root.innerHTML = '<div class="empty"><b>Unknown animation</b><span>This project uses an animation this version of Strike does not have.</span></div>';
    return;
  }
  const values = valuesFor(def, clip.anim.p);

  const head = document.createElement('div');
  head.className = 'acust__head';
  head.innerHTML = `<canvas class="acust__cv"></canvas>
    <div class="acust__name"><b>${def.name}</b><select class="sel acust__swap" title="Swap for another animation (keeps place and timing)"></select></div>`;
  root.appendChild(head);
  const thumb = liveThumb(head.querySelector('canvas'), def, { always: true, p: { ...clip.anim.p } });
  const swap = head.querySelector('select');
  for (const a of ANIMATIONS) {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = a.name; o.selected = a.id === def.id;
    swap.appendChild(o);
  }
  swap.addEventListener('change', () => {
    cmds.swapAnimation(clip.id, swap.value);
    comp.render(); rerender();
  });

  const preview = (key, v) => thumb.set({ ...(clip.anim.p || {}), [key]: v });
  /*
   * While a field is being typed in or a colour dragged, the picture shows it
   * straight away but the project is only changed once, when you are done —
   * with what it was put back first, so that one change is one undo step.
   */
  let before = null;
  const live = (key, v) => {
    before ||= clip.anim.p || {};
    clip.anim.p = { ...before, [key]: v };
    thumb.set({ ...clip.anim.p });
    comp.render();
  };
  const commit = (key, v) => {
    if (before) { clip.anim.p = before; before = null; }
    cmds.setAnimParam(clip.id, key, v, { merge: false });
    comp.render();
  };

  /* Words, colours, numbers */
  const g = group('Customize');
  for (const prm of def.params) {
    const cur = values[prm.key];
    if (prm.type === 'text') {
      const inp = document.createElement('input');
      inp.className = 'field acust__txt';
      inp.dataset.k = prm.key;
      inp.value = cur;
      inp.spellcheck = false;
      inp.addEventListener('input', () => live(prm.key, inp.value));
      inp.addEventListener('change', () => commit(prm.key, inp.value));
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
      g.body.appendChild(row(prm.label, inp));
    } else if (prm.type === 'color') {
      const inp = document.createElement('input');
      inp.type = 'color'; inp.className = 'swatch'; inp.dataset.k = prm.key;
      inp.value = String(cur).slice(0, 7);
      inp.addEventListener('input', () => live(prm.key, inp.value));
      inp.addEventListener('change', () => commit(prm.key, inp.value));
      g.body.appendChild(row(prm.label, inp));
    } else if (prm.type === 'number') {
      g.body.appendChild(row(prm.label, numField({
        value: Number(cur), min: prm.min, max: prm.max, step: prm.step || 1, decimals: (prm.step || 1) < 1 ? 2 : 0,
        onInput: (v) => preview(prm.key, v),
        onCommit: (v) => { cmds.setAnimParam(clip.id, prm.key, v); comp.render(); },
      })));
    } else if (prm.type === 'toggle') {
      g.body.appendChild(row(prm.label, toggleBtn({
        label: cur ? 'On' : 'Off', on: !!cur,
        onChange: (on) => { cmds.setAnimParam(clip.id, prm.key, on, { merge: false }); comp.render(); rerender(); },
      })));
    }
  }
  root.appendChild(g);

  /* Arrive / leave */
  const gt = group('Speed');
  const inD = clip.anim.inDur ?? def.inDur ?? 0.4, outD = clip.anim.outDur ?? def.outDur ?? 0.3;
  gt.body.appendChild(row('Arrives over', numField({ value: inD, min: 0.05, max: 3, step: 0.05, decimals: 2, suffix: 's',
    onCommit: (v) => { cmds.setClipProp(clip.id, 'anim.inDur', v, { label: 'Arrive speed' }); comp.render(); } })));
  gt.body.appendChild(row('Leaves over', numField({ value: outD, min: 0.05, max: 3, step: 0.05, decimals: 2, suffix: 's',
    onCommit: (v) => { cmds.setClipProp(clip.id, 'anim.outDur', v, { label: 'Leave speed' }); comp.render(); } })));
  const reset = document.createElement('button');
  reset.className = 'fontdrop';
  reset.textContent = 'Back to how it came';
  reset.title = 'Undo every change made under Customize';
  reset.addEventListener('click', () => { cmds.resetAnimation(clip.id); comp.render(); rerender(); });
  gt.body.appendChild(reset);
  root.appendChild(gt);

  /* Sound */
  if (def.sound) {
    const gs = group('Sound');
    gs.body.appendChild(row('Sound', toggleBtn({
      label: clip.soundOff ? 'Off' : 'On', on: !clip.soundOff,
      title: 'The sound that comes with this animation',
      onChange: (on) => { cmds.setAnimSound(clip.id, on); rerender(); },
    })));
    if (!clip.soundOff) {
      gs.body.appendChild(row('Loudness', slider({
        value: clip.volume ?? 1, min: 0, max: 2, reset: 1,
        onCommit: (v) => cmds.setClipProp(clip.id, 'volume', v, { label: 'Sound loudness' }),
      })));
    }
    root.appendChild(gs);
  }
}
