import { bus } from '../core/events.js';
import { trackCrop } from './tracker.js';

/**
 * Run the tracker on a crop layer and store its path as one undoable step.
 * Resolves { ok, reason }.
 */
export async function followCrop({ store, cmds, comp }, clipId, at = store.rt.playhead) {
  const find = () => store.doc.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
  const clip = find();
  if (!clip?.crop) return { ok: false, reason: 'Pick a cropped layer first.' };
  const key = 'follow' + clipId;
  let shown = -1;
  bus.emit('toast', { msg: `Following “${clip.name}” through the clip…`, key, ms: 60000 });
  const path = await trackCrop(clip, {
    at,
    onProgress: (p) => {
      const pc = Math.floor(p * 10) * 10;
      if (pc !== shown && pc < 100) { shown = pc; bus.emit('toast', { msg: `Following “${clip.name}”… ${pc}%`, key, ms: 60000 }); }
    },
  });
  if (!find()) return { ok: false, reason: 'The layer was removed while it was being followed.' };
  cmds.setClipProp(clipId, 'crop.path', path, { merge: false, label: 'Follow it as it moves' });
  comp?.render?.();
  bus.emit('toast', { msg: `“${clip.name}” now follows what is inside it, start to end — Ctrl+Z to stop`, kind: 'ok', key, ms: 5000 });
  return { ok: true };
}
