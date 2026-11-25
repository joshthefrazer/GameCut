import { numField, row, group } from '../widgets/numeric-drag.js';
import { getDeep } from '../../core/commands.js';
import { CLIP_COLORS } from '../../core/schema.js';
import { bus } from '../../core/events.js';

/**
 * Several clips picked: the settings they share. Setting one sets it on all of
 * them, as one undo. "Mixed" says they differ now.
 */
const COL = { video: 'var(--clip-video)', image: 'var(--clip-video)', audio: 'var(--clip-audio)', text: 'var(--clip-text)' };
const NAME = { video: ['video', 'videos'], image: ['picture', 'pictures'], audio: ['sound', 'sounds'], text: ['text layer', 'text layers'], shape: ['shape', 'shapes'], effect: ['effect', 'effects'], anim: ['animation', 'animations'] };

export function buildMulti({ root, store, cmds, comp, rerender }) {
  const sel = store.selectedClips.filter(s => !s.track.locked && !s.clip.locked);
  const head = document.createElement('div');
  head.className = 'mult';
  const kinds = {};
  for (const { clip } of sel) kinds[clip.type] = (kinds[clip.type] || 0) + 1;
  const stack = document.createElement('div'); stack.className = 'mult__stack';
  sel.slice(0, 4).forEach(({ clip }) => { const i = document.createElement('i'); i.style.background = COL[clip.type] || (CLIP_COLORS[clip.type] || CLIP_COLORS.video)[0]; stack.appendChild(i); });
  const t = document.createElement('div');
  const b = document.createElement('b'); b.textContent = `${store.rt.selection.length} clips`;
  const s = document.createElement('span'); s.textContent = Object.entries(kinds).map(([k, n]) => `${n} ${(NAME[k] || [k, k])[n === 1 ? 0 : 1]}`).join(', ') || 'All of them are locked';
  t.append(b, s); head.append(stack, t); root.appendChild(head);
  if (!sel.length) return;

  const same = (list, get) => { const v = list.map(get); return v.every(x => Math.abs(x - v[0]) < 1e-6) ? v[0] : null; };
  /** One number on every clip that has it. `set` writes one clip. */
  function field(g, label, list, get, set, o) {
    if (list.length < 2) return;
    const v = same(list, get), k = o.show || 1;
    const before = new Map();
    const num = numField({ label: v === null ? 'mixed' : '', value: (v ?? get(list[0])) * k, min: o.min * k, max: o.max * k, step: o.step, decimals: o.decimals ?? 0, suffix: o.suffix || '',
      onInput: o.live ? (x) => { for (const c of list) { if (!before.has(c.id)) before.set(c.id, get(c)); o.live(c, x / k); } comp.render(); } : undefined,
      onCommit: (x) => {
        if (o.live) for (const c of list) if (before.has(c.id)) o.live(c, before.get(c.id));
        before.clear();
        cmds.batch(`${label} on ${list.length} clips`, () => { for (const c of list) set(c, x / k); });
        comp.render(); rerender();
      } });
    num.dataset.multi = label;
    if (v === null) num.classList.add('is-mixed');
    g.body.appendChild(row(list.length === sel.length ? label : `${label} (${list.length})`, num));
  }
  const prop = (path, label) => (c, v) => cmds.setClipProp(c.id, path, v, { merge: false, label });
  const clips = sel.map(x => x.clip);
  const seen = sel.filter(x => x.track.kind !== 'audio' && x.clip.type !== 'effect').map(x => x.clip);
  const noKey = (p) => seen.filter(c => !(c.keys?.[p] || []).length);
  const heard = clips.filter(c => (c.type === 'video' && !c.silent) || c.type === 'audio');
  const media = clips.filter(c => c.type === 'video' || c.type === 'audio');
  const tr = (path) => ({ get: (c) => getDeep(c, path) ?? (path.endsWith('rotation') ? 0 : 1), live: (c, v) => { c.transform[path.split('.')[1]] = v; } });

  if (seen.length > 1) {
    const g = group('Picture');
    for (const [label, path, o] of [['Opacity', 'transform.opacity', { min: 0, max: 1, show: 100, step: 1, suffix: '%' }], ['Scale', 'transform.scale', { min: 0.02, max: 10, show: 100, step: 1, suffix: '%' }], ['Rotation', 'transform.rotation', { min: -360, max: 360, step: 1, suffix: '°' }]]) {
      const x = tr(path); field(g, label, noKey(path), x.get, prop(path, label), { ...o, live: x.live });
    }
    if (g.body.children.length) root.appendChild(g);
  }
  if (heard.length > 1) {
    const g = group('Sound');
    field(g, 'Volume', heard, c => c.volume ?? 1, prop('volume', 'Volume'), { min: 0, max: 2, show: 100, step: 1, suffix: '%', live: (c, v) => { c.volume = v; } });
    const m = document.createElement('button'); m.className = 'fontdrop'; m.id = 'multiMute';
    const on = heard.every(c => c.muted); m.textContent = on ? 'Unmute them all' : 'Mute them all';
    m.addEventListener('click', () => { cmds.batch(on ? 'Unmute clips' : 'Mute clips', () => { for (const c of heard) cmds.setClipProp(c.id, 'muted', !on, { merge: false, label: 'Mute clip' }); }); rerender(); });
    g.body.appendChild(m); root.appendChild(g);
  }
  const g = group('Timing');
  field(g, 'Speed', media, c => c.speed || 1, (c, v) => cmds.setClipSpeed(c.id, v), { min: 0.1, max: 64, step: 0.01, decimals: 2, suffix: '×' });
  field(g, 'Fade in', clips.filter(c => c.type !== 'effect'), c => c.fadeIn || 0, prop('fadeIn', 'Fade in'), { min: 0, max: 30, step: 0.01, decimals: 2, suffix: 's' });
  field(g, 'Fade out', clips.filter(c => c.type !== 'effect'), c => c.fadeOut || 0, prop('fadeOut', 'Fade out'), { min: 0, max: 30, step: 0.01, decimals: 2, suffix: 's' });
  if (g.body.children.length) root.appendChild(g);
  const texts = clips.filter(c => c.type === 'text');
  if (texts.length > 1) {
    const gt = group('Text');
    field(gt, 'Size', texts, c => c.text?.size || 0, prop('text.size', 'Text size'), { min: 1, max: 600, step: 1, decimals: 0, live: (c, v) => { c.text.size = v; } });
    root.appendChild(gt);
  }
  const ga = group('All of them');
  const btn = (label, id, run) => { const x = document.createElement('button'); x.className = 'fontdrop'; x.id = id; x.textContent = label; x.addEventListener('click', run); ga.body.appendChild(x); };
  if (cmds.copiedLook) btn('Paste parts of a look…', 'multiPaste', () => bus.emit('look:parts'));
  btn('Duplicate', 'multiDup', () => cmds.duplicateSelected());
  root.appendChild(ga);
}
