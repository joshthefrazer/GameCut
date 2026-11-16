import { assets } from '../media/asset-store.js';
import { ASPECTS } from '../project/presets.js';
import { defaultFx } from '../engine/layers/fx.js';

/**
 * One-click vertical layouts.
 *
 * A landscape gameplay recording becomes a 9:16 short in one step: the game
 * part is cut to fit its part of the tall frame, and the facecam (a corner of
 * the recording) is lifted onto its own layer above it with the crop tool's
 * own machinery — so it stays linked to the footage, follows every later trim
 * and split, and can be dragged and resized like anything else.
 *
 * Every layout is one step of undo, and choosing another replaces the last.
 */

export const LAYOUTS = [
  { id: 'gameCam', name: 'Game + cam', note: 'Cam across the top, the game below', cam: [0, 0.36], game: [0.36, 1], recommended: true },
  { id: 'camTop', name: 'Cam on top', note: 'For talking clips: half and half', cam: [0, 0.5], game: [0.5, 1] },
  { id: 'bubble', name: 'Full game, cam bubble', note: 'Most action on screen', game: [0, 1], bubble: true },
  { id: 'blurFill', name: 'Whole picture, blurred fill', note: 'Nothing cut off the sides', fill: true },
  { id: 'center', name: 'Centre crop', note: 'Just the middle of the screen', game: [0, 1], noCam: true },
];

export const CORNERS = [
  { id: 'tl', name: 'Top left' }, { id: 'tr', name: 'Top right' },
  { id: 'bl', name: 'Bottom left' }, { id: 'br', name: 'Bottom right' },
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** The main lane: the lowest picture lane, where the recording sits. */
export const mainLane = (doc) => [...doc.tracks].reverse().find(t => t.kind === 'video');

/** A crop (0..1 of the source) with the pixel shape `aspect` (w/h), as big as fits, centred on (cx, cy). */
function cropFor(fw, fh, aspect, { cx = 0.5, cy = 0.5, maxW = 1 } = {}) {
  let ch = fh, cw = ch * aspect;
  if (cw > fw * maxW) { cw = fw * maxW; ch = cw / aspect; }
  if (ch > fh) { ch = fh; cw = ch * aspect; }
  const w = cw / fw, h = ch / fh;
  return { x: clamp01(cx - w / 2), y: clamp01(cy - h / 2), w, h };
}

/** A crop tucked into a corner of the source. */
function cornerCrop(fw, fh, aspect, corner, size) {
  const cw = fw * size, ch = Math.min(fh, cw / aspect);
  const w = (ch * aspect) / fw, h = ch / fh;
  return { x: corner[1] === 'r' ? 1 - w : 0, y: corner[0] === 'b' ? 1 - h : 0, w, h };
}

/** The scale that makes a 'contain'-fitted crop exactly `bw` pixels wide on a W×H frame. */
function scaleFor(crop, fw, fh, W, H, bw) {
  const sw = crop.w * fw, sh = crop.h * fh;
  const fit = Math.min(W / sw, H / sh);
  return bw / (sw * fit);
}

/**
 * Apply a layout to every clip on the main lane. Returns how many clips it
 * laid out. `cam` is the corner the facecam is in (or null for none);
 * `camSize` how much of the recording's width the facecam takes.
 */
export function applyLayout({ store, cmds }, id, { cam = 'bl', camSize = 0.28 } = {}) {
  const L = LAYOUTS.find(l => l.id === id);
  const lane = mainLane(store.doc);
  if (!L || !lane) return 0;
  const targets = lane.clips.filter(c => c.type === 'video' || c.type === 'image');
  if (!targets.length) return 0;
  const hasCam = !!cam && !L.noCam;

  let n = 0;
  cmds.batch(`Vertical layout: ${L.name}`, () => {
    const V = ASPECTS['9:16'];
    if (store.doc.width / store.doc.height > 0.6) cmds.setResolution({ width: V.width, height: V.height, aspect: '9:16' });
    const W = store.doc.width, H = store.doc.height;

    // A layout chosen before is replaced, not stacked.
    const ids = new Set(targets.map(c => c.id));
    const old = store.doc.tracks.flatMap(t => t.clips).filter(c => c.layout && ids.has(c.linkTo)).map(c => c.id);
    if (old.length) { store.select(old); cmds.removeSelected({ ripple: false }); }

    for (const clip of targets) {
      const a = assets.get(clip.assetId);
      const fw = a?.width || 1920, fh = a?.height || 1080;
      const set = (path, v) => cmds.setClipProp(clip.id, path, v, { merge: false, label: 'Layout' });

      if (L.fill) {
        // The recording itself becomes the soft backdrop; a whole-frame copy sits on it.
        set('crop', null); set('fit', 'cover'); set('backdrop', 0.45);
        set('transform', { ...clip.transform, x: 0.5, y: 0.5, scale: 1, rotation: 0 });
        const whole = { x: 0, y: 0, w: 1, h: 1 };
        const made = cmds.cropClip(clip.id, { crop: whole, transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 } }, { label: 'Layout' });
        if (made) cmds.setClipProp(made.id, 'layout', true, { merge: false, label: 'Layout' });
        n++;
        continue;
      }

      // The game part.
      const [g0, g1] = L.game;
      const gAspect = W / (H * (g1 - g0));
      const gCrop = cropFor(fw, fh, gAspect);
      set('backdrop', 0);
      set('fit', 'contain');
      set('crop', gCrop);
      set('transform', { ...clip.transform, x: 0.5, y: (g0 + g1) / 2, scale: scaleFor(gCrop, fw, fh, W, H, W), rotation: 0 });

      // The facecam, on its own layer above.
      if (hasCam) {
        let crop, transform, fx = null;
        if (L.bubble) {
          crop = cornerCrop(fw, fh, 1, cam, camSize * 0.8);
          const bw = W * 0.4;
          transform = { x: cam[1] === 'r' ? 0.74 : 0.26, y: 0.16, scale: scaleFor(crop, fw, fh, W, H, bw), rotation: 0 };
          fx = { radius: 0.5, outline: 0.012, outlineColor: '#ffffff' };
        } else {
          const [c0, c1] = L.cam;
          crop = cornerCrop(fw, fh, W / (H * (c1 - c0)), cam, camSize);
          transform = { x: 0.5, y: (c0 + c1) / 2, scale: scaleFor(crop, fw, fh, W, H, W), rotation: 0 };
        }
        const made = cmds.cropClip(clip.id, { crop, transform }, { label: 'Layout' });
        if (made) {
          cmds.setClipProp(made.id, 'layout', true, { merge: false, label: 'Layout' });
          cmds.setClipProp(made.id, 'name', 'Facecam', { merge: false, label: 'Layout' });
          if (fx) cmds.setClipProp(made.id, 'fx', { ...defaultFx(), ...(made.fx || {}), ...fx }, { merge: false, label: 'Layout' });
        }
      }
      n++;
    }
  });
  return n;
}
