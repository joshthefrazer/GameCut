import { ease, lerp, clamp01 } from './kit.js';

/** Shared by every animation definition. */
export const C = { volt: '#C6FF3D', blue: '#3B5BFF', ember: '#FF5A3C', void: '#06080F', white: '#FFFFFF', gold: '#FBBF24', pink: '#EC4899', cyan: '#22D3EE', purple: '#8B5CF6', discord: '#5865F2' };

export const txt = (key, label, def) => ({ key, label, type: 'text', def });
export const col = (key, label, def) => ({ key, label, type: 'color', def });
export const num = (key, label, def, min, max, step = 1) => ({ key, label, type: 'number', def, min, max, step });
export const tog = (key, label, def) => ({ key, label, type: 'toggle', def });

/** Scale-in that overshoots, the standard arrival. */
export function popIn(ctx, P, cx, cy, { from = 0.3, rot = 0 } = {}) {
  const s = lerp(from, 1, ease.back(P.pin)) * (1 - ease.in(P.pout) * 0.85);
  ctx.translate(cx, cy);
  ctx.rotate(rot * (1 - ease.out(P.pin)));
  ctx.scale(s, s);
  ctx.translate(-cx, -cy);
  ctx.globalAlpha *= clamp01(P.pin * 3) * (1 - P.pout);
}

