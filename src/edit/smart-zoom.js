import { findHighlights } from './analysis.js';
import { makeClip, trackById } from '../core/schema.js';
import { snapFrame } from '../core/time.js';
import { soundAssetFor } from '../anim/sfx.js';

/**
 * Smart Zoom: punch in on the moments that matter.
 *
 * The moments come from two places — the loud ones in the game sound (a shot,
 * a shout; see analysis.js) and anything you have already marked as a kill
 * with an animation (a kill counter, a headshot, an ACE). Each one kept
 * becomes a zoom effect clip on a lane of its own, the "Zoom" lane, so they
 * can be moved, stretched and deleted like any clip, and taken out in one go.
 */

const KILL_ANIMS = { killCounter: 'Kill counter', headshot: 'Headshot', aceSlam: 'ACE', killFeed: 'Kill feed', victory: 'Victory', multiKill: 'Multi-kill', noScope: 'No scope', eliminated: 'Eliminated', clutch1v: 'Clutch' };

export const ZOOM_STYLES = [
  { id: 'smooth', name: 'Smooth', note: 'Glides in, holds, glides out' },
  { id: 'snap', name: 'Snap', note: 'Jumps in on the frame, eases out' },
  { id: 'bounce', name: 'Bounce', note: 'Overshoots and settles' },
  { id: 'impact', name: 'Impact shake', note: 'Snaps in with a hit of shake' },
];

/** Zoom factor (1.35×) ↔ effect amount (0..1), as the zoom effect draws it: 1 + amount × 0.9. */
export const factorToAmount = (f) => Math.max(0.02, Math.min(1, (f - 1) / 0.9));
export const amountToFactor = (a) => 1 + a * 0.9;

/** The moments worth zooming on, earliest first: { t, why, strength 0..1 }. */
export function zoomMoments(store, { max = 14 } = {}) {
  const out = [];
  for (const t of store.doc.tracks) for (const c of t.clips) {
    if (c.type === 'anim' && KILL_ANIMS[c.anim?.id] && !out.some(o => Math.abs(o.t - c.start) < 1)) out.push({ t: c.start, why: KILL_ANIMS[c.anim.id], strength: 1, src: 'anim' });
  }
  const hl = findHighlights(store, { max, gap: 1.6 });
  const top = Math.max(1e-4, ...hl.map(h => h.score));
  for (const h of hl) {
    if (out.some(o => Math.abs(o.t - h.t) < 1)) continue;
    const s = h.score / top;
    out.push({ t: h.t, why: s > 0.75 ? 'Loudest moment' : s > 0.45 ? 'Loud hit' : 'Sudden sound', strength: s, src: 'sound' });
  }
  // Moments already zoomed on are not offered again.
  const zooms = store.doc.tracks.flatMap(t => t.clips).filter(c => c.type === 'effect' && c.effect?.kind === 'zoom');
  return out.filter(m => !zooms.some(z => m.t >= z.start - 0.3 && m.t <= z.start + z.duration))
    .sort((a, b) => a.t - b.t).slice(0, max);
}

/** How long a zoom lasts and where it starts, so the punch lands ON the moment. */
function span(style, t) {
  const lead = style === 'smooth' ? 0.22 : 0.06;
  const dur = style === 'smooth' ? 1.4 : style === 'bounce' ? 1.2 : 1.0;
  return { start: Math.max(0, t - lead), dur };
}

/**
 * Put zooms in, one step of undo for all of them. Returns how many went in.
 * `x, y` is where it zooms to (0..1 of the frame; the crosshair is the
 * middle). `whoosh` adds the whoosh sound on an SFX lane just before each.
 */
export function addZooms({ store, cmds }, moments, { style = 'smooth', factor = 1.35, whoosh = false, x = 0.5, y = 0.5 } = {}) {
  if (!moments.length) return 0;
  const fps = store.doc.fps;
  const q = (t) => snapFrame(Math.max(0, t), fps);
  let n = 0;
  cmds.batch(`Smart Zoom: ${moments.length} zoom${moments.length === 1 ? '' : 's'}`, () => {
    let lane = store.doc.tracks.find(t => t.kind === 'video' && t.zoomLane && !t.locked);
    if (!lane) {
      const top = store.doc.tracks.find(t => t.kind === 'video');
      lane = cmds.addLane('zoom', top?.id || null);
    }
    let sfx = null;
    const whooshId = whoosh ? soundAssetFor({ name: 'Whoosh', sound: 'whoosh' }, {}, 1) : null;
    if (whooshId) {
      sfx = store.doc.tracks.find(t => t.kind === 'audio' && /sfx/i.test(t.name) && !t.locked) || cmds.addLane('sfx');
    }
    const list = [...moments].sort((a, b) => a.t - b.t);
    list.forEach((m, i) => {
      const { start } = span(style, m.t);
      let { dur } = span(style, m.t);
      // Moments close together share the lane: each zoom ends before the next begins.
      const next = list[i + 1] ? span(style, list[i + 1].t).start : Infinity;
      dur = Math.max(0.35, Math.min(dur, next - start - 1 / fps));
      const clip = makeClip('effect', {
        name: `Zoom · ${m.why}`, start: q(start), duration: q(dur),
        effect: { kind: 'zoom', amount: factorToAmount(factor), x, y, style },
      });
      const made = cmds.addClip(lane.id, clip, { select: false, label: 'Zoom' });
      if (made) n++;
      if (whooshId && sfx) {
        const w = makeClip('audio', { name: 'Whoosh', assetId: whooshId, start: q(m.t - 0.45), duration: 0.7, sourceDuration: 0.7, volume: 0.8 });
        cmds.addClip(trackById(store.doc, sfx.id)?.id || sfx.id, w, { select: false, label: 'Whoosh' });
      }
    });
  });
  return n;
}

/** Take every Smart Zoom out (the zoom lane's clips), one step of undo. */
export function clearZooms({ store, cmds }) {
  const ids = store.doc.tracks.filter(t => t.zoomLane).flatMap(t => t.clips.map(c => c.id));
  if (!ids.length) return 0;
  store.select(ids);
  cmds.removeSelected({ ripple: false });
  return ids.length;
}
