/**
 * "Stick to it": put a ring, an arrow, a name tag, a blur or a spotlight on
 * something you tracked with "Follow it as it moves", and it moves with it.
 *
 * Each is an ordinary layer (a shape or a title) you can restyle, trim, fade
 * or delete like any other; what makes it follow is `clip.stick`
 * (src/engine/layers/stick.js). Unstick leaves it where it is right now.
 */
import { bus } from '../core/events.js';
import { makeClip } from '../core/schema.js';
import { brandTextStyle } from '../project/brand.js';

export const STICKERS = [
  { id: 'ring',  name: 'Ring',      note: 'A glowing ring round it' },
  { id: 'arrow', name: 'Arrow',     note: 'A bouncing arrow pointing at it' },
  { id: 'name',  name: 'Name tag',  note: 'A name above it (double-click the text to type)' },
  { id: 'spot',  name: 'Spotlight', note: 'Everything else goes dark' },
  { id: 'hide',  name: 'Hide it',   note: 'Pixelate it (a face, a name, a screen)' },
];

export function initStickTo({ store, cmds, history }) {
  const find = (id) => { for (const t of store.doc.tracks) { const c = t.clips.find(x => x.id === id); if (c) return { clip: c, track: t }; } return {}; };
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#C6FF3D';

  /** A free text lane for this stretch: from the top for pointers, from the bottom for darkening / hiding. */
  function laneFor(start, dur, low) {
    const end = start + dur;
    const lanes = store.doc.tracks.filter(t => t.kind === 'text' && !t.locked);
    const free = (t) => !t.clips.some(c => c.start < end && c.start + c.duration > start);
    if (low) {
      // Under every title and pointer: the very bottom text lane, or a new one right above the
      // footage. (Any other lane, or a new one on top, would darken the arrow along with the rest.)
      const bottom = [...store.doc.tracks].reverse().find(t => t.kind === 'text');
      if (bottom && !bottom.locked && free(bottom)) return bottom;
      const firstVideo = store.doc.tracks.find(t => t.kind === 'video');
      return cmds.addTrack('text', firstVideo?.id || null, { name: 'Tracked (under)' });
    }
    for (const t of lanes) if (free(t)) return t;
    return cmds.addTrack('text', null, { name: 'Tracked' });
  }

  /** Put one of STICKERS on the followed crop layer `cropId`. Returns the new clip. */
  function add(kind, cropId) {
    const { clip: crop } = find(cropId);
    if (!crop?.crop) { bus.emit('toast', { msg: 'Pick a crop layer first (crop something, then Follow it as it moves).' }); return null; }
    if (!crop.crop.path?.length) bus.emit('toast', { msg: 'This crop is not following anything yet, so it will sit still. Press "Follow it as it moves" first to make it move with the thing.', ms: 5200 });
    const start = crop.start, duration = crop.duration;
    let clip;
    if (kind === 'name') {
      clip = makeClip('text', { name: 'Name tag', start, duration });
      Object.assign(clip.text, brandTextStyle(), {
        text: 'PLAYER', font: clip.text.font || 'Inter', weight: 900, size: 0.038, fill: 'solid', color: '#ffffff',
        strokeWidth: 0, glow: 0, shadow: 0.01, shadowColor: '#000000', shadowY: 0.004,
        bg: 'pill', bgColor: '#06080Fe0', bgPad: 0.016, bgRadius: 0.5, anim: 'pop', animDur: 0.25,
      });
      clip.stick = { to: cropId, anchor: 'above', fit: false, pad: 1.2, gap: 0.035 };
    } else {
      const shape = {
        ring: { kind: 'ring', fill: accent(), stroke: 0.008 },
        arrow: { kind: 'arrow', fill: '#facc15' },
        spot: { kind: 'spot', dark: 0.72, soft: 0.45 },
        hide: { kind: 'hide', blocks: 9, round: true },
      }[kind];
      if (!shape) return null;
      clip = makeClip('shape', { name: STICKERS.find(s => s.id === kind).name, start, duration, shape });
      clip.stick = { to: cropId, fit: true, pad: { ring: 1.35, arrow: 1.1, spot: 1.5, hide: 1.15 }[kind] };
    }
    let made = null;
    cmds.batch(`Stick ${STICKERS.find(s => s.id === kind).name.toLowerCase()} to it`, () => {
      const lane = laneFor(start, duration, kind === 'spot' || kind === 'hide');
      made = cmds.addClip(lane.id, clip, { select: true, label: 'Stick to it' });
    });
    window.gc?.comp?.render?.();
    bus.emit('toast', { msg: `${STICKERS.find(s => s.id === kind).name} added: it moves with “${crop.name || 'the tracked thing'}”. Ctrl+Z to take it off.`, kind: 'ok', ms: 4200 });
    return made;
  }

  /** Stop following: the layer stays exactly where it is at the playhead. */
  function unstick(clipId) {
    const { clip } = find(clipId);
    if (!clip?.stick) return;
    const here = window.gc?.comp?.stuck?.(clip, store.rt.playhead) || clip;
    history.run('Unstick', (doc) => {
      for (const t of doc.tracks) {
        const c = t.clips.find(x => x.id === clipId);
        if (!c) continue;
        c.transform = { ...c.transform, x: here.transform.x, y: here.transform.y, ...(c.stick.fit ? { w: here.transform.w, h: here.transform.h } : {}) };
        delete c.stick;
      }
    });
  }

  /** Nudge where it sits relative to the tracked thing (fractions of the frame). */
  function nudge(clipId, dx, dy) {
    const { clip } = find(clipId);
    if (!clip?.stick) return;
    cmds.setClipProp(clipId, 'stick', { ...clip.stick, dx: (clip.stick.dx || 0) + dx, dy: (clip.stick.dy || 0) + dy }, { merge: true, label: 'Nudge' });
  }

  return { add, unstick, nudge, STICKERS };
}
