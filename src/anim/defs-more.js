import { ease, rr, text, burst, ring, shine, rgba, ink, lerp, clamp01, rng, FONT_DISPLAY, FONT_UI, FONT_MONO } from './kit.js';
import { C, txt, col, num, tog, popIn } from './params.js';

/**
 * The second half of the library (see defs.js for how an animation is
 * described). Same 1000-wide box, same phase clock, same rules: a few words
 * and colours to change, and a sound that comes with it.
 */

const fade = (P) => clamp01(P.pin * 3) * (1 - ease.in(P.pout));

/** A slanted plate, the fighting-game look. */
function plate(ctx, x, y, w, h, skew, fill) {
  ctx.beginPath();
  ctx.moveTo(x + skew, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - skew, y + h); ctx.lineTo(x, y + h);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
}

/** A five-point star. */
function star(ctx, cx, cy, r, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5 - Math.PI / 2, rad = i % 2 ? r * 0.45 : r;
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
}

/** Typed-out text: how much of `str` shows `t` seconds in at `cps` characters a second. */
const typed = (str, t, cps = 22) => String(str).slice(0, Math.max(0, Math.floor(t * cps)));

/** A simple thumbs-up, drawn (no fonts or emoji needed). */
function thumb(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ctx.fillStyle = color;
  rr(ctx, -40, -6, 22, 52, 6); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-14, -6); ctx.lineTo(-2, -44); ctx.quadraticCurveTo(4, -56, 14, -50); ctx.quadraticCurveTo(22, -44, 16, -22);
  ctx.lineTo(42, -22); ctx.quadraticCurveTo(54, -20, 50, -6); ctx.lineTo(44, 36); ctx.quadraticCurveTo(40, 46, 28, 46); ctx.lineTo(-14, 46);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

export const MORE = [
  /* ── Pop-ups ───────────────────────────────────────────── */
  {
    id: 'multiKill', name: 'Double kill', cat: 'popups', note: 'A slanted plate slams in with the streak',
    h: 280, size: 0.5, place: { x: 0.5, y: 0.28 }, dur: 1.8, sound: 'hit',
    params: [txt('label', 'Words', 'DOUBLE KILL'), txt('badge', 'Badge', '×2'), col('color', 'Plate colour', C.ember), col('ink', 'Text colour', C.white)],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      const dx = lerp(-1200, 0, ease.slam(P.pin)) + ease.in(P.pout) * 1200;
      ctx.translate(dx, 0);
      for (let i = 0; i < 5; i++) {
        const len = 260 * (1 - clamp01((P.t - 0.15) / 0.4));
        if (len > 2) { ctx.fillStyle = rgba(v.color, 0.5); ctx.fillRect(40 - len - i * 30, 70 + i * 34, len, 8); }
      }
      plate(ctx, 60, 60, 760, 160, 50, v.color);
      shine(ctx, 60, 60, 760, 160, (P.t - 0.25) / 0.5);
      text(ctx, v.label, 435, 145, { size: 104, italic: true, color: v.ink, maxW: 640 });
      ctx.restore();
      if (P.t > 0.3) {
        ctx.save(); ctx.globalAlpha *= fade(P);
        const s = lerp(2.2, 1, ease.back((P.t - 0.3) / 0.25));
        ctx.translate(880, 140); ctx.rotate(0.12); ctx.scale(s, s);
        ctx.fillStyle = C.white; rr(ctx, -80, -62, 160, 124, 24); ctx.fill();
        text(ctx, v.badge, 0, 6, { size: 82, color: v.color, maxW: 140 });
        ctx.restore();
      }
    },
  },
  {
    id: 'noScope', name: 'No scope', cat: 'popups', note: 'A scope spins in and snaps on the words',
    h: 460, size: 0.42, place: { x: 0.5, y: 0.45 }, dur: 1.8, sound: 'hit', soundAt: 0.3,
    params: [txt('label', 'Words', 'NO SCOPE'), col('color', 'Scope colour', C.white), col('pop', 'Word colour', C.volt)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin * 0.9), out = 1 - ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= out;
      ctx.translate(500, 190); ctx.rotate((1 - k) * 2.4); ctx.scale(lerp(1.8, 1, k), lerp(1.8, 1, k));
      ctx.strokeStyle = v.color; ctx.lineWidth = 10;
      ctx.beginPath(); ctx.arc(0, 0, 150, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 6;
      for (const [a, b] of [[[-210, 0], [-40, 0]], [[40, 0], [210, 0]], [[0, -210], [0, -40]], [[0, 40], [0, 210]]]) {
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      }
      for (let i = -3; i <= 3; i++) if (i) { ctx.beginPath(); ctx.moveTo(i * 30, -10); ctx.lineTo(i * 30, 10); ctx.stroke(); }
      ctx.restore();
      if (P.t > 0.3) {
        const s = lerp(1.7, 1, ease.back((P.t - 0.3) / 0.22));
        ctx.save(); ctx.globalAlpha *= out;
        ctx.translate(500, 400); ctx.scale(s, s);
        text(ctx, v.label, 0, 0, { size: 96, color: v.pop, stroke: C.void, strokeW: 10, maxW: 900 });
        ctx.restore();
        ring(ctx, 500, 190, (P.t - 0.3) / 0.5, { r0: 60, r1: 420, color: v.pop, w: 12 });
      }
    },
  },
  {
    id: 'clutch1v', name: '1 v X clutch', cat: 'popups', note: 'The odds, stamped one character at a time',
    h: 380, size: 0.48, place: { x: 0.5, y: 0.4 }, dur: 2.2, sound: 'boom', soundAt: 0.25,
    params: [num('enemies', 'Against how many', 4, 2, 9), txt('label', 'Under it', 'CLUTCH'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      const chars = ['1', 'v', String(Math.round(v.enemies || 4))];
      ctx.save(); ctx.globalAlpha *= 1 - ease.in(P.pout);
      chars.forEach((ch, i) => {
        const a = (P.t - i * 0.12) / 0.2;
        if (a <= 0) return;
        const s = lerp(2.4, 1, ease.slam(a));
        ctx.save(); ctx.translate(250 + i * 250, 160); ctx.scale(s, s);
        text(ctx, ch, 0, 0, { size: i === 1 ? 150 : 260, color: i === 1 ? C.white : v.color, stroke: C.void, strokeW: 14, italic: true });
        ctx.restore();
      });
      if (P.t > 0.42) {
        const w = 640 * ease.out((P.t - 0.42) / 0.3);
        ctx.fillStyle = C.void; rr(ctx, 500 - w / 2, 290, w, 70, 12); ctx.fill();
        ctx.save(); ctx.beginPath(); ctx.rect(500 - w / 2, 290, w, 70); ctx.clip();
        text(ctx, v.label, 500, 327, { size: 50, color: v.color, spacing: 0.4, font: FONT_UI, weight: 900 });
        ctx.restore();
      }
      ctx.restore();
    },
  },
  {
    id: 'rankUp', name: 'Rank up', cat: 'popups', note: 'A shield badge flips in with your new rank',
    h: 580, size: 0.38, place: { x: 0.5, y: 0.45 }, dur: 2.6, sound: 'levelup',
    params: [txt('rank', 'Rank', 'DIAMOND'), txt('label', 'Above it', 'RANK UP'), col('color', 'Badge colour', C.cyan)],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      const flip = Math.cos((1 - ease.out(P.pin)) * Math.PI * 1.5);
      ctx.translate(500, 270); ctx.scale(Math.max(0.02, Math.abs(flip)), 1);
      const g = ctx.createLinearGradient(0, -170, 0, 170);
      g.addColorStop(0, v.color); g.addColorStop(1, rgba(v.color, 0.55));
      ctx.beginPath();
      ctx.moveTo(0, -180); ctx.lineTo(150, -120); ctx.lineTo(140, 40); ctx.quadraticCurveTo(110, 130, 0, 190); ctx.quadraticCurveTo(-110, 130, -140, 40); ctx.lineTo(-150, -120);
      ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = 12; ctx.strokeStyle = C.white; ctx.stroke();
      ctx.strokeStyle = C.void; ctx.lineWidth = 22; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-70, -40 + i * 50); ctx.lineTo(0, -80 + i * 50); ctx.lineTo(70, -40 + i * 50); ctx.stroke(); }
      ctx.restore();
      shine(ctx, 350, 90, 300, 380, (P.t - 0.55) / 0.5);
      if (P.t > 0.35) {
        ctx.save(); ctx.globalAlpha *= fade(P) * clamp01((P.t - 0.35) / 0.2);
        text(ctx, v.label, 500, 34, { size: 44, font: FONT_UI, weight: 900, color: C.white, spacing: 0.3 });
        text(ctx, v.rank, 500, 515, { size: 84, color: v.color, stroke: C.void, strokeW: 9, maxW: 900 });
        ctx.restore();
      }
    },
  },
  {
    id: 'achievement', name: 'Achievement unlocked', cat: 'popups', note: 'A trophy pops, then the pill opens',
    h: 200, size: 0.6, place: { x: 0.5, y: 0.85 }, dur: 3.2, sound: 'ding',
    params: [txt('label', 'Top line', 'Achievement unlocked'), txt('name', 'Name', 'Ace on the last round'), col('color', 'Colour', C.gold)],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      const k = ease.back(P.pin * 1.4), open = ease.out((P.t - 0.35) / 0.4);
      const w = lerp(180, 960, clamp01(open)), x = 500 - w / 2;
      ctx.fillStyle = 'rgba(12,14,22,.92)'; rr(ctx, x, 10, w, 180, 90); ctx.fill();
      ctx.save(); ctx.translate(x + 90, 100); ctx.scale(k, k);
      ctx.fillStyle = v.color; ctx.beginPath(); ctx.arc(0, 0, 70, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.void;
      ctx.beginPath(); ctx.moveTo(-28, -30); ctx.lineTo(28, -30); ctx.lineTo(22, 4); ctx.quadraticCurveTo(0, 18, -22, 4); ctx.closePath(); ctx.fill();
      ctx.fillRect(-5, 10, 10, 16); ctx.fillRect(-18, 26, 36, 8);
      ctx.restore();
      if (open > 0.3) {
        ctx.save(); ctx.beginPath(); ctx.rect(x, 10, w, 180); ctx.clip();
        ctx.globalAlpha *= clamp01((open - 0.3) / 0.4);
        text(ctx, v.label, x + 200, 70, { size: 38, font: FONT_UI, weight: 600, color: rgba('#ffffff', 0.7), align: 'left', maxW: w - 240 });
        text(ctx, v.name, x + 200, 128, { size: 50, font: FONT_UI, weight: 800, color: '#fff', align: 'left', maxW: w - 240 });
        ctx.restore();
      }
      ctx.restore();
    },
  },
  {
    id: 'xpGain', name: '+XP', cat: 'popups', note: 'Points float up and fade',
    h: 300, size: 0.3, place: { x: 0.72, y: 0.4 }, dur: 1.6, sound: 'ping',
    params: [txt('label', 'Words', '+250 XP'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      const rise = ease.out(P.t / P.dur) * 140;
      ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 4) * (1 - ease.in(P.pout));
      const s = lerp(0.4, 1, ease.back(P.pin));
      ctx.translate(500, 200 - rise); ctx.scale(s, s);
      text(ctx, v.label, 0, 0, { size: 150, color: v.color, stroke: C.void, strokeW: 12, glow: v.color, glowR: 30, maxW: 950 });
      ctx.restore();
      ctx.save(); ctx.globalAlpha *= 1 - P.pout;
      const R = rng(7);
      for (let i = 0; i < 6; i++) {
        const a = clamp01((P.t - 0.1 - i * 0.05) / 0.7);
        if (a <= 0 || a >= 1) continue;
        ctx.fillStyle = v.color; ctx.globalAlpha = (1 - a) * (1 - P.pout);
        star(ctx, 150 + R() * 700, 240 - a * 200 - R() * 40, 18 * (1 - a) + 6); ctx.fill();
      }
      ctx.restore();
    },
  },
  {
    id: 'damageNumbers', name: 'Damage numbers', cat: 'popups', note: 'Hits pop up one after another, the last one huge',
    h: 520, size: 0.4, place: { x: 0.55, y: 0.4 }, dur: 2, sound: 'pop', soundEvery: 0.18,
    sounds: (v) => String(v.hits || '').split(/\s+/).filter(Boolean).slice(0, 8).map((_, i) => ({ sound: i === String(v.hits).split(/\s+/).filter(Boolean).length - 1 ? 'hit' : 'pop', at: +(i * 0.18).toFixed(2) })),
    params: [txt('hits', 'Numbers (spaces between)', '24 31 27 142'), col('color', 'Colour', C.white), col('crit', 'Last one', C.ember)],
    draw(ctx, P, v) {
      const hits = String(v.hits || '').split(/\s+/).filter(Boolean).slice(0, 8);
      const R = rng(11);
      ctx.save(); ctx.globalAlpha *= 1 - ease.in(P.pout);
      hits.forEach((h, i) => {
        const x = 220 + R() * 560, y = 180 + R() * 220;
        const a = (P.t - i * 0.18);
        if (a <= 0) return;
        const last = i === hits.length - 1;
        const s = lerp(last ? 2 : 1.6, 1, ease.back(a / 0.18)) * (last ? 1.7 : 1);
        ctx.save(); ctx.globalAlpha *= last ? 1 : clamp01(1.6 - a);
        ctx.translate(last ? 500 : x, (last ? 260 : y) - (last ? 0 : a * 90)); ctx.scale(s, s);
        text(ctx, h, 0, 0, { size: 90, color: last ? v.crit : v.color, stroke: C.void, strokeW: 9, italic: true });
        ctx.restore();
      });
      ctx.restore();
    },
  },
  {
    id: 'eliminated', name: 'Eliminated', cat: 'popups', note: 'A red band cuts across with the word',
    h: 360, size: 0.9, place: { x: 0.5, y: 0.5 }, dur: 2.2, sound: 'boom',
    params: [txt('label', 'Word', 'ELIMINATED'), txt('sub', 'Under it', 'by you'), col('color', 'Band colour', '#E11D48')],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), out = 1 - ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= out;
      const bw = 1000 * k;
      ctx.fillStyle = rgba(v.color, 0.9); ctx.fillRect(500 - bw / 2, 110, bw, 140);
      ctx.fillStyle = rgba('#000000', 0.35); ctx.fillRect(500 - bw / 2, 250, bw, 10);
      const sp = lerp(0.6, 0.12, ease.out((P.t - 0.1) / 0.6));
      text(ctx, v.label, 500, 182, { size: 104, color: '#fff', spacing: sp, maxW: 940 });
      if (P.t > 0.5) text(ctx, v.sub, 500, 300, { size: 38, font: FONT_UI, weight: 700, color: rgba('#ffffff', clamp01((P.t - 0.5) / 0.3) * 0.9) });
      ctx.restore();
    },
  },
  {
    id: 'gg', name: 'GG', cat: 'popups', note: 'Two big letters and spinning stars',
    h: 440, size: 0.36, place: { x: 0.5, y: 0.45 }, dur: 2.2, sound: 'ding',
    params: [txt('label', 'Words', 'GG'), col('color', 'Colour', C.volt), col('star', 'Stars', C.gold)],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + P.t * 1.4, r = lerp(40, 330, ease.out(P.pin));
        ctx.fillStyle = v.star; star(ctx, 500 + Math.cos(a) * r, 220 + Math.sin(a) * r * 0.55, 30, P.t * 3); ctx.fill();
      }
      ctx.save(); popIn(ctx, P, 500, 220, { from: 2.4, rot: 0.3 });
      text(ctx, v.label, 500, 230, { size: 300, color: v.color, stroke: C.void, strokeW: 18, italic: true, maxW: 900 });
      ctx.restore();
      ctx.restore();
    },
  },
  {
    id: 'objective', name: 'Objective complete', cat: 'popups', note: 'A tick draws itself, the banner slides out',
    h: 260, size: 0.6, place: { x: 0.5, y: 0.22 }, dur: 2.8, sound: 'ding',
    params: [txt('label', 'Words', 'OBJECTIVE COMPLETE'), txt('sub', 'Under it', 'Bomb defused'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      const open = ease.out((P.t - 0.35) / 0.45);
      ctx.fillStyle = 'rgba(8,10,18,.88)'; rr(ctx, 80, 40, 120 + 760 * clamp01(open), 180, 22); ctx.fill();
      ctx.strokeStyle = v.color; ctx.lineWidth = 12; ctx.beginPath(); ctx.arc(140, 130, 58, 0, Math.PI * 2 * clamp01(P.pin * 1.2)); ctx.stroke();
      const tk = clamp01((P.t - 0.2) / 0.25);
      ctx.lineWidth = 14; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(112, 130);
      if (tk > 0) ctx.lineTo(112 + 20 * Math.min(1, tk * 2), 130 + 22 * Math.min(1, tk * 2));
      if (tk > 0.5) ctx.lineTo(132 + 38 * (tk - 0.5) * 2, 152 - 52 * (tk - 0.5) * 2);
      ctx.stroke();
      if (open > 0.2) {
        ctx.save(); ctx.beginPath(); ctx.rect(200, 40, 760 * open, 180); ctx.clip();
        text(ctx, v.label, 230, 108, { size: 54, color: '#fff', align: 'left', maxW: 680 });
        text(ctx, v.sub, 230, 168, { size: 36, font: FONT_UI, weight: 600, color: v.color, align: 'left', maxW: 680 });
        ctx.restore();
      }
      ctx.restore();
    },
  },
  {
    id: 'hitMarker', name: 'Hit marker', cat: 'popups', note: 'The little X that says it landed',
    h: 1000, size: 0.14, place: { x: 0.5, y: 0.5 }, dur: 0.5, sound: 'tick', inDur: 0.05, outDur: 0.25,
    params: [col('color', 'Colour', C.white), tog('crit', 'Red (a kill)', false)],
    draw(ctx, P, v) {
      const s = lerp(1.4, 1, ease.out(P.pin * 2));
      ctx.save(); ctx.globalAlpha *= 1 - P.pout;
      ctx.translate(500, 500); ctx.scale(s, s);
      ctx.strokeStyle = v.crit ? '#EF4444' : v.color; ctx.lineWidth = 70; ctx.lineCap = 'square';
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        ctx.beginPath(); ctx.moveTo(dx * 140, dy * 140); ctx.lineTo(dx * 380, dy * 380); ctx.stroke();
      }
      ctx.restore();
    },
  },

  /* ── Counters and timers ───────────────────────────────── */
  {
    id: 'killStreak', name: 'Kill streak', cat: 'counters', note: 'Bars light up one by one',
    h: 240, size: 0.55, place: { x: 0.5, y: 0.14 }, dur: 2.6, sound: 'tick', soundEvery: 0.12,
    sounds: (v) => [...Array.from({ length: Math.max(1, Math.min(10, Math.round(v.count || 5))) }, (_, i) => ({ sound: 'tick', at: +(0.3 + i * 0.12).toFixed(2) })), { sound: 'hit', at: +(0.3 + Math.max(1, Math.min(10, Math.round(v.count || 5))) * 0.12).toFixed(2) }],
    params: [txt('label', 'Words', 'KILLSTREAK'), num('count', 'How many', 5, 1, 10), col('color', 'Colour', C.ember)],
    draw(ctx, P, v) {
      const n = Math.max(1, Math.min(10, Math.round(v.count || 5)));
      ctx.save(); popIn(ctx, P, 500, 120, { from: 0.6 });
      ctx.fillStyle = 'rgba(8,10,18,.9)'; rr(ctx, 30, 30, 940, 180, 26); ctx.fill();
      text(ctx, v.label, 70, 82, { size: 40, font: FONT_UI, weight: 900, color: '#fff', align: 'left', spacing: 0.15 });
      const lit = Math.floor((P.t - 0.3) / 0.12) + 1;
      for (let i = 0; i < n; i++) {
        const on = i < lit, w = (700 - (n - 1) * 12) / n, x = 70 + i * (w + 12);
        ctx.fillStyle = on ? v.color : 'rgba(255,255,255,.12)';
        rr(ctx, x, 120, w, 56, 10); ctx.fill();
      }
      const done = lit > n;
      ctx.save(); ctx.translate(880, 120);
      if (done) { const s = lerp(1.6, 1, ease.back((P.t - 0.3 - n * 0.12) / 0.2)); ctx.scale(s, s); }
      text(ctx, String(Math.min(n, Math.max(0, lit))), 0, 6, { size: 130, color: done ? v.color : '#fff' });
      ctx.restore();
      ctx.restore();
    },
  },
  {
    id: 'scoreboard', name: 'Scoreboard', cat: 'counters', note: 'Two teams, and the score ticks over',
    h: 200, size: 0.6, place: { x: 0.5, y: 0.09 }, dur: 3, sound: 'ping', soundAt: 1,
    params: [txt('a', 'Left team', 'BLUE'), num('sa', 'Left score', 12, 0, 99), txt('b', 'Right team', 'RED'), num('sb', 'Right score', 9, 0, 99), tog('tick', 'Left scores during it', true), col('ca', 'Left colour', C.blue), col('cb', 'Right colour', C.ember)],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      ctx.translate(0, lerp(-200, 0, ease.out(P.pin)));
      plate(ctx, 30, 30, 400, 140, 30, v.ca); plate(ctx, 570, 30, 400, 140, 30, v.cb);
      ctx.fillStyle = C.void; rr(ctx, 350, 20, 300, 160, 20); ctx.fill();
      text(ctx, v.a, 200, 100, { size: 52, color: '#fff', maxW: 260 });
      text(ctx, v.b, 800, 100, { size: 52, color: '#fff', maxW: 260 });
      const ticked = v.tick && P.t > 1;
      const sa = Math.round(v.sa) + (ticked ? 1 : 0);
      const bump = ticked ? 1 + 0.35 * Math.max(0, 1 - (P.t - 1) / 0.3) : 1;
      ctx.save(); ctx.translate(425, 100); ctx.scale(bump, bump);
      text(ctx, String(sa), 0, 4, { size: 64, font: FONT_MONO, weight: 700, color: ticked && P.t < 1.5 ? C.volt : '#fff' });
      ctx.restore();
      text(ctx, '–', 500, 100, { size: 50, font: FONT_MONO, color: rgba('#ffffff', 0.5) });
      text(ctx, String(Math.round(v.sb)), 575, 104, { size: 64, font: FONT_MONO, weight: 700, color: '#fff' });
      ctx.restore();
    },
  },
  {
    id: 'speedrun', name: 'Speedrun timer', cat: 'counters', note: 'A running clock with a split',
    h: 210, size: 0.42, place: { x: 0.84, y: 0.1 }, dur: 4, sound: 'beep', soundAt: 0.3,
    params: [txt('label', 'Category', 'ANY%'), num('start', 'Starts at (seconds)', 42, 0, 3599), txt('split', 'Split name', 'Boss'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      const tt = (Number(v.start) || 0) + P.hold;
      const m = Math.floor(tt / 60), s = tt - m * 60;
      ctx.save(); ctx.globalAlpha *= fade(P);
      ctx.fillStyle = 'rgba(6,8,15,.88)'; rr(ctx, 30, 20, 940, 170, 20); ctx.fill();
      text(ctx, v.label, 70, 62, { size: 30, font: FONT_UI, weight: 800, color: rgba('#ffffff', 0.6), align: 'left', spacing: 0.15 });
      text(ctx, `${m}:${s.toFixed(2).padStart(5, '0')}`, 930, 118, { size: 110, font: FONT_MONO, weight: 700, color: v.color, align: 'right', glow: v.color, glowR: 18 });
      text(ctx, v.split, 70, 140, { size: 34, font: FONT_UI, weight: 700, color: '#fff', align: 'left' });
      text(ctx, '−1.24', 70, 172, { size: 26, font: FONT_MONO, weight: 700, color: C.volt, align: 'left' });
      ctx.restore();
    },
  },
  {
    id: 'coins', name: 'Coin counter', cat: 'counters', note: 'A spinning coin and a number that rolls up',
    h: 200, size: 0.4, place: { x: 0.8, y: 0.1 }, dur: 2.4, sound: 'ding', soundAt: 1.3,
    params: [num('to', 'Counts to', 1000, 1, 999999), txt('unit', 'After the number', ''), col('color', 'Coin colour', C.gold)],
    draw(ctx, P, v) {
      ctx.save(); popIn(ctx, P, 500, 100, { from: 0.5 });
      ctx.fillStyle = 'rgba(6,8,15,.82)'; rr(ctx, 40, 25, 920, 150, 75); ctx.fill();
      const sx = Math.cos(P.t * 7);
      ctx.save(); ctx.translate(130, 100); ctx.scale(Math.max(0.08, Math.abs(sx)), 1);
      ctx.fillStyle = v.color; ctx.beginPath(); ctx.arc(0, 0, 58, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba('#000000', 0.25); ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(0, 0, 42, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      const n = Math.round(Number(v.to || 0) * ease.out(clamp01((P.t - 0.2) / 1.1)));
      text(ctx, n.toLocaleString('en-US') + (v.unit ? ' ' + v.unit : ''), 230, 104, { size: 88, font: FONT_MONO, weight: 700, color: '#fff', align: 'left', maxW: 700 });
      ctx.restore();
    },
  },
  {
    id: 'loading', name: 'Loading bar', cat: 'counters', note: 'Fills to 100% with a percentage',
    h: 200, size: 0.6, place: { x: 0.5, y: 0.8 }, dur: 3, sound: 'ding', soundAt: 2.2,
    params: [txt('label', 'Words', 'LOADING SKILL...'), col('color', 'Bar colour', C.volt)],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      const p = clamp01(Math.pow(clamp01((P.t - 0.2) / 2), 0.8));
      text(ctx, p >= 1 ? 'DONE' : v.label, 50, 50, { size: 44, font: FONT_MONO, weight: 700, color: '#fff', align: 'left', maxW: 700 });
      text(ctx, `${Math.round(p * 100)}%`, 950, 50, { size: 44, font: FONT_MONO, weight: 700, color: v.color, align: 'right' });
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 8; rr(ctx, 46, 100, 908, 80, 12); ctx.stroke();
      ctx.fillStyle = v.color; rr(ctx, 62, 116, 876 * p, 48, 6); ctx.fill();
      ctx.restore();
    },
  },

  /* ── Titles and chapters ───────────────────────────────── */
  {
    id: 'letterbox', name: 'Cinematic bars', cat: 'titles', note: 'Black bars close in, a title sits low',
    h: 562, size: 1.78, place: { x: 0.5, y: 0.5 }, dur: 3.5, sound: 'riser', full: true, inDur: 0.6, outDur: 0.6,
    params: [txt('title', 'Title', 'THE FINAL ROUND'), txt('sub', 'Under it', 'Ranked · Season 4'), num('bars', 'Bar size %', 12, 4, 25)],
    draw(ctx, P, v) {
      const bh = P.bh || 562, b = bh * (v.bars / 100) * ease.inOut(P.pin) * (1 - ease.inOut(P.pout));
      ctx.fillStyle = '#000'; ctx.fillRect(-100, -100, 1200, b + 100); ctx.fillRect(-100, bh - b, 1200, b + 200);
      const a = clamp01((P.t - 0.5) / 0.5) * (1 - P.pout);
      if (a > 0) {
        ctx.save(); ctx.globalAlpha *= a;
        text(ctx, v.title, 500, bh - b - 70, { size: 54, color: '#fff', spacing: lerp(0.4, 0.15, ease.out(a)), maxW: 900 });
        text(ctx, v.sub, 500, bh - b - 26, { size: 22, font: FONT_UI, weight: 600, color: rgba('#ffffff', 0.7), spacing: 0.2 });
        ctx.restore();
      }
    },
  },
  {
    id: 'typewriter', name: 'Terminal type', cat: 'titles', note: 'Words type out with a blinking cursor',
    h: 240, size: 0.7, place: { x: 0.5, y: 0.5 }, dur: 3.2, sound: 'click', soundEvery: 0.12,
    sounds: (v) => Array.from({ length: Math.min(20, String(v.label || '').length) }, (_, i) => ({ sound: 'click', at: +(0.25 + i * (1 / 22) * 1.2).toFixed(2) })).filter((_, i) => i % 2 === 0),
    params: [txt('label', 'Words', 'installing aim.exe ...'), col('color', 'Text colour', C.volt)],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      ctx.fillStyle = 'rgba(4,6,10,.9)'; rr(ctx, 20, 20, 960, 200, 18); ctx.fill();
      for (const [i, c] of [[0, '#FF5F57'], [1, '#FEBC2E'], [2, '#28C840']]) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(60 + i * 34, 52, 10, 0, Math.PI * 2); ctx.fill(); }
      const s = typed(v.label, Math.max(0, P.t - 0.25), 18);
      ctx.font = `700 52px ${FONT_MONO}`;
      const w = ctx.measureText('> ' + s).width;
      text(ctx, '> ' + s, 60, 140, { size: 52, font: FONT_MONO, weight: 700, color: v.color, align: 'left', maxW: 860 });
      if (Math.floor(P.t * 2.5) % 2 === 0) { ctx.fillStyle = v.color; ctx.fillRect(Math.min(920, 64 + w), 112, 26, 56); }
      ctx.restore();
    },
  },
  {
    id: 'neon', name: 'Neon sign', cat: 'titles', note: 'Flickers on like a real tube',
    h: 300, size: 0.66, place: { x: 0.5, y: 0.45 }, dur: 3, sound: 'glitch', soundAt: 0.1,
    params: [txt('label', 'Words', 'GAME ON'), col('color', 'Colour', C.pink)],
    draw(ctx, P, v) {
      const flick = [0.1, 0.16, 0.24, 0.3, 0.42].some(f => Math.abs(P.t - f) < 0.03) ? 0.15 : 1;
      const on = P.t < 0.08 ? 0 : flick;
      ctx.save(); ctx.globalAlpha *= on * (1 - ease.in(P.pout));
      ctx.lineJoin = 'round';
      ctx.font = `900 150px ${FONT_DISPLAY}`;
      const w = Math.min(880, ctx.measureText(v.label).width + 120);
      ctx.strokeStyle = v.color; ctx.lineWidth = 10; ctx.shadowColor = v.color; ctx.shadowBlur = 40;
      rr(ctx, 500 - w / 2, 40, w, 220, 50); ctx.stroke();
      ctx.shadowBlur = 0;
      text(ctx, v.label, 500, 158, { size: 140, color: '#fff', glow: v.color, glowR: 50, maxW: w - 80 });
      ctx.restore();
    },
  },
  {
    id: 'splitTitle', name: 'Split title', cat: 'titles', note: 'Two words slide in from opposite sides',
    h: 380, size: 0.75, place: { x: 0.5, y: 0.5 }, dur: 2.6, sound: 'whoosh',
    params: [txt('top', 'Top word', 'BEST'), txt('bottom', 'Bottom word', 'MOMENTS'), col('color', 'Bottom colour', C.volt), col('bar', 'Bar colour', C.ember)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), o = ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= 1 - o;
      text(ctx, v.top, lerp(-500, 500, k) - o * 900, 110, { size: 140, color: '#fff', italic: true, maxW: 900 });
      text(ctx, v.bottom, lerp(1500, 500, k) + o * 900, 280, { size: 140, color: v.color, italic: true, maxW: 900 });
      const bw = 900 * ease.out((P.t - 0.2) / 0.4);
      ctx.fillStyle = v.bar; ctx.fillRect(500 - bw / 2, 186, bw, 12);
      ctx.restore();
    },
  },
  {
    id: 'episode', name: 'Episode card', cat: 'titles', note: 'Episode number, title and a line under it',
    h: 360, size: 0.62, place: { x: 0.3, y: 0.7 }, dur: 3.4, sound: 'whoosh',
    params: [txt('ep', 'Episode', 'EP. 12'), txt('title', 'Title', 'Road to Radiant'), txt('sub', 'Small line', 'Day 41 · solo queue'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin);
      ctx.save(); ctx.globalAlpha *= fade(P);
      ctx.translate(lerp(-120, 0, k), 0);
      ctx.font = `800 40px ${FONT_UI}`;
      const pw = ctx.measureText(v.ep).width + 50;
      ctx.fillStyle = v.color; rr(ctx, 40, 40, pw, 70, 35); ctx.fill();
      text(ctx, v.ep, 40 + pw / 2, 76, { size: 40, font: FONT_UI, weight: 800, color: ink(v.color) });
      text(ctx, v.title, 40, 190, { size: 96, color: '#fff', align: 'left', stroke: C.void, strokeW: 6, maxW: 940 });
      ctx.fillStyle = v.color; ctx.fillRect(40, 250, 300 * ease.out((P.t - 0.3) / 0.5), 8);
      text(ctx, v.sub, 40, 305, { size: 36, font: FONT_UI, weight: 600, color: rgba('#ffffff', 0.8), align: 'left', maxW: 900 });
      ctx.restore();
    },
  },
  {
    id: 'versus', name: 'Versus', cat: 'titles', note: 'Two names, a diagonal split and VS',
    h: 440, size: 0.9, place: { x: 0.5, y: 0.5 }, dur: 2.8, sound: 'boom', soundAt: 0.35,
    params: [txt('a', 'Left', 'PLAYER ONE'), txt('b', 'Right', 'PLAYER TWO'), col('ca', 'Left colour', C.blue), col('cb', 'Right colour', C.ember)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), o = ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= 1 - o;
      ctx.save(); ctx.translate(lerp(-600, 0, k), 0);
      ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(560, 40); ctx.lineTo(460, 400); ctx.lineTo(0, 400); ctx.closePath(); ctx.fillStyle = v.ca; ctx.fill();
      text(ctx, v.a, 200, 220, { size: 64, color: '#fff', maxW: 330, italic: true });
      ctx.restore();
      ctx.save(); ctx.translate(lerp(600, 0, k), 0);
      ctx.beginPath(); ctx.moveTo(560, 40); ctx.lineTo(1000, 40); ctx.lineTo(1000, 400); ctx.lineTo(460, 400); ctx.closePath(); ctx.fillStyle = v.cb; ctx.fill();
      text(ctx, v.b, 810, 220, { size: 64, color: '#fff', maxW: 330, italic: true });
      ctx.restore();
      if (P.t > 0.35) {
        const s = lerp(3, 1, ease.slam((P.t - 0.35) / 0.25));
        ctx.save(); ctx.translate(510, 220); ctx.scale(s, s);
        text(ctx, 'VS', 0, 0, { size: 120, color: C.volt, stroke: C.void, strokeW: 14, italic: true });
        ctx.restore();
      }
      ctx.restore();
    },
  },
  {
    id: 'bossIntro', name: 'Boss intro', cat: 'titles', note: 'A stripe tears across with a name and a title',
    h: 400, size: 0.9, place: { x: 0.5, y: 0.5 }, dur: 3, sound: 'boom',
    params: [txt('name', 'Name', 'THE WARDEN'), txt('title', 'Title', 'Keeper of the vault'), col('color', 'Stripe colour', C.ember)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), o = ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= 1 - o;
      ctx.save(); ctx.translate(500, 200); ctx.rotate(-0.08); ctx.translate(-500, -200);
      const w = 1300 * k;
      ctx.fillStyle = v.color; ctx.fillRect(500 - w / 2, 120, w, 150);
      ctx.fillStyle = '#000'; ctx.fillRect(500 - w / 2, 270, w, 22);
      text(ctx, v.name, 500 + (1 - k) * 200, 200, { size: 120, color: '#fff', stroke: C.void, strokeW: 10, maxW: 940, italic: true });
      ctx.restore();
      if (P.t > 0.45) text(ctx, v.title.toUpperCase(), 500, 345, { size: 34, font: FONT_UI, weight: 800, color: '#fff', spacing: 0.3 * (1 - ease.out((P.t - 0.45) / 0.5)) + 0.12 });
      ctx.restore();
    },
  },

  /* ── Callouts ──────────────────────────────────────────── */
  {
    id: 'arrow', name: 'Big arrow', cat: 'callouts', note: 'Points at something and bobs',
    h: 600, size: 0.3, place: { x: 0.65, y: 0.4 }, dur: 2.4, sound: 'pop',
    params: [num('angle', 'Points (degrees, 0 = right)', 135, 0, 359), txt('label', 'Words', 'HERE'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      const bob = Math.sin(P.hold * 8) * 26;
      ctx.save(); popIn(ctx, P, 500, 300, { from: 0.2 });
      ctx.translate(500, 260); ctx.rotate((Number(v.angle) || 0) * Math.PI / 180); ctx.translate(bob, 0);
      ctx.fillStyle = v.color; ctx.strokeStyle = C.void; ctx.lineWidth = 14; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(-200, -48); ctx.lineTo(40, -48); ctx.lineTo(40, -120); ctx.lineTo(220, 0); ctx.lineTo(40, 120); ctx.lineTo(40, 48); ctx.lineTo(-200, 48); ctx.closePath();
      ctx.stroke(); ctx.fill();
      ctx.restore();
      if (v.label) { ctx.save(); ctx.globalAlpha *= fade(P); text(ctx, v.label, 500, 530, { size: 90, color: v.color, stroke: C.void, strokeW: 10, maxW: 900 }); ctx.restore(); }
    },
  },
  {
    id: 'target', name: 'Target lock', cat: 'callouts', note: 'Corner brackets close in on something',
    h: 700, size: 0.38, place: { x: 0.5, y: 0.5 }, dur: 2.4, sound: 'beep', soundAt: 0.35,
    params: [txt('label', 'Tag', 'TARGET'), col('color', 'Colour', C.ember)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), g = lerp(220, 0, k);
      ctx.save(); ctx.globalAlpha *= fade(P);
      ctx.strokeStyle = v.color; ctx.lineWidth = 18; ctx.lineCap = 'square';
      const L = 120, x0 = 120 - g, y0 = 120 - g, x1 = 880 + g, y1 = 600 + g;
      for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
        ctx.beginPath(); ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y); ctx.stroke();
      }
      if (P.t > 0.35) {
        const blink = Math.floor(P.t * 6) % 2 || P.t > 0.9;
        if (blink) {
          ctx.font = `800 50px ${FONT_UI}`;
          const w = ctx.measureText(v.label).width + 40;
          ctx.fillStyle = v.color; ctx.fillRect(120, 30, w, 70);
          text(ctx, v.label, 140 + w / 2 - 20, 67, { size: 50, font: FONT_UI, weight: 800, color: ink(v.color) });
        }
      }
      ctx.restore();
    },
  },
  {
    id: 'underline', name: 'Scribble underline', cat: 'callouts', note: 'A marker swoosh draws itself',
    h: 200, size: 0.5, place: { x: 0.5, y: 0.6 }, dur: 2, sound: 'scratch',
    params: [col('color', 'Colour', C.volt), num('width', 'Thickness', 22, 6, 50)],
    draw(ctx, P, v) {
      const k = ease.out(clamp01(P.t / 0.5));
      ctx.save(); ctx.globalAlpha *= 1 - ease.in(P.pout);
      ctx.strokeStyle = v.color; ctx.lineWidth = v.width; ctx.lineCap = 'round';
      ctx.beginPath();
      const N = 60;
      for (let i = 0; i <= N * k; i++) {
        const x = 40 + (i / N) * 920, y = 110 + Math.sin(i / N * Math.PI * 1.2) * 18 - (i / N) * 30;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      if (k > 0.9) {
        ctx.beginPath(); ctx.moveTo(900, 70); ctx.quadraticCurveTo(500, 150, 160, 150 - 20 * ease.out((P.t - 0.45) / 0.3)); ctx.lineWidth = v.width * 0.6;
        ctx.globalAlpha *= clamp01((P.t - 0.45) / 0.15); ctx.stroke();
      }
      ctx.restore();
    },
  },
  {
    id: 'waitForIt', name: 'Wait for it', cat: 'callouts', note: 'Builds suspense with bouncing dots',
    h: 200, size: 0.55, place: { x: 0.5, y: 0.82 }, dur: 3, sound: 'riser',
    params: [txt('label', 'Words', 'WAIT FOR IT'), col('color', 'Colour', C.white)],
    draw(ctx, P, v) {
      ctx.save(); popIn(ctx, P, 500, 100, { from: 0.6 });
      ctx.fillStyle = 'rgba(6,8,15,.8)'; rr(ctx, 60, 30, 880, 140, 70); ctx.fill();
      ctx.font = `900 64px ${FONT_DISPLAY}`;
      const w = Math.min(600, ctx.measureText(v.label).width);
      text(ctx, v.label, 470 - 40, 104, { size: 64, color: v.color, maxW: 600 });
      for (let i = 0; i < 3; i++) {
        const y = 104 - Math.max(0, Math.sin(P.t * 7 - i * 0.7)) * 22;
        ctx.fillStyle = v.color; ctx.beginPath(); ctx.arc(470 + w / 2 - 10 + i * 34, y + 14, 10, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    },
  },
  {
    id: 'replay', name: 'Replay', cat: 'callouts', note: 'A blinking REC dot and a running clock',
    h: 160, size: 0.4, place: { x: 0.2, y: 0.08 }, dur: 3, sound: 'beep',
    params: [txt('label', 'Words', 'REPLAY'), col('color', 'Dot colour', '#EF4444')],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= fade(P);
      ctx.fillStyle = 'rgba(0,0,0,.55)'; rr(ctx, 20, 20, 960, 120, 16); ctx.fill();
      if (Math.floor(P.t * 2) % 2 === 0) { ctx.fillStyle = v.color; ctx.beginPath(); ctx.arc(90, 80, 28, 0, Math.PI * 2); ctx.fill(); }
      text(ctx, v.label, 150, 82, { size: 70, color: '#fff', align: 'left', maxW: 480 });
      const tt = P.t;
      text(ctx, `00:00:${String(Math.floor(tt)).padStart(2, '0')}:${String(Math.floor((tt % 1) * 30)).padStart(2, '0')}`, 950, 84, { size: 46, font: FONT_MONO, weight: 700, color: '#fff', align: 'right' });
      ctx.restore();
    },
  },
  {
    id: 'slowMo', name: 'Slow-mo badge', cat: 'callouts', note: 'Shows the speed, pulsing slowly',
    h: 220, size: 0.36, place: { x: 0.82, y: 0.88 }, dur: 3, sound: 'whoosh',
    params: [txt('speed', 'Speed', '0.25×'), txt('label', 'Words', 'SLOW-MO'), col('color', 'Colour', C.cyan)],
    draw(ctx, P, v) {
      const pulse = 1 + Math.sin(P.hold * 3) * 0.04;
      ctx.save(); popIn(ctx, P, 500, 110, { from: 0.4 });
      ctx.translate(500, 110); ctx.scale(pulse, pulse); ctx.translate(-500, -110);
      ctx.fillStyle = 'rgba(6,8,15,.85)'; rr(ctx, 60, 30, 880, 160, 30); ctx.fill();
      ctx.strokeStyle = v.color; ctx.lineWidth = 6; rr(ctx, 60, 30, 880, 160, 30); ctx.stroke();
      text(ctx, v.speed, 290, 112, { size: 96, font: FONT_MONO, weight: 700, color: v.color, maxW: 380 });
      text(ctx, v.label, 700, 112, { size: 60, color: '#fff', maxW: 400 });
      ctx.restore();
    },
  },
  {
    id: 'questions', name: '???', cat: 'callouts', note: 'Three question marks pop in, confused',
    h: 400, size: 0.32, place: { x: 0.7, y: 0.3 }, dur: 2, sound: 'pop', soundEvery: 0.15,
    sounds: () => [0, 0.15, 0.3].map(at => ({ sound: 'pop', at })),
    params: [col('color', 'Colour', C.gold), txt('mark', 'Mark', '?')],
    draw(ctx, P, v) {
      ctx.save(); ctx.globalAlpha *= 1 - ease.in(P.pout);
      [[260, 250, -0.35, 0.8], [500, 190, 0, 1.15], [740, 250, 0.35, 0.8]].forEach(([x, y, r, s], i) => {
        const a = (P.t - i * 0.15) / 0.22;
        if (a <= 0) return;
        const wob = Math.sin(P.hold * 6 + i) * 0.1;
        ctx.save(); ctx.translate(x, y); ctx.rotate(r + wob); ctx.scale(s * ease.back(a), s * ease.back(a));
        text(ctx, v.mark, 0, 0, { size: 260, color: v.color, stroke: C.void, strokeW: 14 });
        ctx.restore();
      });
      ctx.restore();
    },
  },
  {
    id: 'lowHealth', name: 'Low health', cat: 'callouts', note: 'The edges pulse red, like a heartbeat',
    h: 562, size: 1.78, place: { x: 0.5, y: 0.5 }, dur: 3, sound: 'hit', soundEvery: 0.85, full: true, inDur: 0.3, outDur: 0.5,
    params: [col('color', 'Colour', '#DC2626'), num('strength', 'Strength %', 70, 10, 100), txt('label', 'Words (optional)', 'LOW HP')],
    draw(ctx, P, v) {
      const bh = P.bh || 562;
      const beat = Math.pow(Math.max(0, Math.sin(P.t * Math.PI / 0.85)), 6);
      const a = (0.45 + 0.55 * beat) * (v.strength / 100) * clamp01(P.pin * 2) * (1 - P.pout);
      const g = ctx.createRadialGradient(500, bh / 2, Math.min(500, bh) * 0.45, 500, bh / 2, Math.hypot(500, bh / 2) * 1.05);
      g.addColorStop(0, rgba(v.color, 0)); g.addColorStop(1, rgba(v.color, a));
      ctx.fillStyle = g; ctx.fillRect(0, 0, 1000, bh);
      if (v.label) {
        ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 2) * (1 - P.pout) * (0.6 + 0.4 * beat);
        text(ctx, v.label, 500, bh - 60, { size: 48, color: v.color, stroke: '#000', strokeW: 6, spacing: 0.2 });
        ctx.restore();
      }
    },
  },

  /* ── Chat and overlays ─────────────────────────────────── */
  {
    id: 'donation', name: 'Donation alert', cat: 'chat', note: 'A name, an amount and a message',
    h: 340, size: 0.55, place: { x: 0.5, y: 0.25 }, dur: 4, sound: 'ding',
    params: [txt('name', 'Name', 'xXsniperXx'), txt('amount', 'Amount', '$5.00'), txt('msg', 'Message', 'that flick was insane'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      ctx.save(); popIn(ctx, P, 500, 170, { from: 0.5 });
      ctx.fillStyle = 'rgba(10,12,20,.94)'; rr(ctx, 40, 30, 920, 280, 28); ctx.fill();
      ctx.fillStyle = v.color; rr(ctx, 40, 30, 920, 12, 6); ctx.fill();
      ctx.font = `800 54px ${FONT_UI}`;
      const rest = ` donated ${v.amount}`;
      const nw = ctx.measureText(v.name).width, rw = ctx.measureText(rest).width;
      const sc = Math.min(1, 860 / (nw + rw)), x0 = 500 - (nw + rw) * sc / 2;
      text(ctx, v.name, x0, 120, { size: 54 * sc, font: FONT_UI, weight: 800, color: v.color, align: 'left' });
      text(ctx, rest, x0 + nw * sc, 120, { size: 54 * sc, font: FONT_UI, weight: 800, color: '#fff', align: 'left' });
      text(ctx, typed(v.msg, Math.max(0, P.t - 0.5), 30), 500, 215, { size: 44, font: FONT_UI, weight: 500, color: rgba('#ffffff', 0.85), maxW: 860 });
      ctx.restore();
      burst(ctx, 500, 170, (P.t - 0.1) / 0.6, { color: v.color, r0: 300, r1: 620, n: 16, w: 10 });
    },
  },
  {
    id: 'poll', name: 'Poll', cat: 'chat', note: 'A question and two bars that fill',
    h: 440, size: 0.55, place: { x: 0.5, y: 0.5 }, dur: 4, sound: 'pop',
    params: [txt('q', 'Question', 'Was that a clutch?'), txt('a', 'Option 1', 'Yes'), num('pa', 'Option 1 %', 82, 0, 100), txt('b', 'Option 2', 'Luck'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      ctx.save(); popIn(ctx, P, 500, 220, { from: 0.6 });
      ctx.fillStyle = 'rgba(10,12,20,.94)'; rr(ctx, 30, 20, 940, 400, 28); ctx.fill();
      text(ctx, v.q, 500, 90, { size: 54, font: FONT_UI, weight: 800, color: '#fff', maxW: 860 });
      const fill = ease.out(clamp01((P.t - 0.5) / 1));
      const pa = clamp01((Number(v.pa) || 0) / 100);
      [[v.a, pa, v.color, 170], [v.b, 1 - pa, 'rgba(255,255,255,.35)', 290]].forEach(([label, p, c, y]) => {
        ctx.fillStyle = 'rgba(255,255,255,.08)'; rr(ctx, 70, y, 860, 90, 18); ctx.fill();
        ctx.fillStyle = c; rr(ctx, 70, y, Math.max(36, 860 * p * fill), 90, 18); ctx.fill();
        text(ctx, label, 100, y + 46, { size: 42, font: FONT_UI, weight: 800, color: p > 0.2 && c !== 'rgba(255,255,255,.35)' ? ink(v.color) : '#fff', align: 'left', maxW: 600 });
        text(ctx, `${Math.round(p * 100 * fill)}%`, 900, y + 46, { size: 42, font: FONT_MONO, weight: 700, color: '#fff', align: 'right' });
      });
      ctx.restore();
    },
  },
  {
    id: 'newFollower', name: 'New follower', cat: 'chat', note: 'Slides in from the side with a name',
    h: 200, size: 0.5, place: { x: 0.75, y: 0.15 }, dur: 3.2, sound: 'ping',
    params: [txt('label', 'Top line', 'NEW FOLLOWER'), txt('name', 'Name', 'pixel_queen'), col('color', 'Colour', C.purple)],
    draw(ctx, P, v) {
      const k = ease.back(P.pin), o = ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 3) * (1 - o);
      ctx.translate(lerp(900, 0, k) + o * 900, 0);
      ctx.fillStyle = 'rgba(10,12,20,.94)'; rr(ctx, 40, 20, 920, 160, 24); ctx.fill();
      ctx.fillStyle = v.color; rr(ctx, 40, 20, 160, 160, 24); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(120, 78, 28, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(120, 148, 50, 32, 0, Math.PI, 0); ctx.fill();
      text(ctx, v.label, 240, 68, { size: 36, font: FONT_UI, weight: 900, color: v.color, align: 'left', spacing: 0.15 });
      text(ctx, v.name, 240, 128, { size: 60, font: FONT_UI, weight: 800, color: '#fff', align: 'left', maxW: 690 });
      ctx.restore();
    },
  },
  {
    id: 'comment', name: 'Comment', cat: 'chat', note: 'A comment card with likes',
    h: 300, size: 0.62, place: { x: 0.5, y: 0.75 }, dur: 3.5, sound: 'pop',
    params: [txt('name', 'Name', '@clutchgod'), txt('when', 'When', '2 hours ago'), txt('msg', 'Comment', 'bro played like he had wallhacks'), num('likes', 'Likes', 1200, 0, 999999), col('color', 'Avatar colour', C.blue)],
    draw(ctx, P, v) {
      ctx.save(); popIn(ctx, P, 500, 150, { from: 0.7 });
      ctx.fillStyle = '#fff'; rr(ctx, 30, 20, 940, 260, 26); ctx.fill();
      ctx.fillStyle = v.color; ctx.beginPath(); ctx.arc(110, 100, 46, 0, Math.PI * 2); ctx.fill();
      text(ctx, String(v.name || '?').replace('@', '').slice(0, 1).toUpperCase(), 110, 102, { size: 50, font: FONT_UI, weight: 800, color: '#fff' });
      ctx.font = `700 34px ${FONT_UI}`;
      const nw = ctx.measureText(v.name).width;
      text(ctx, v.name, 180, 76, { size: 34, font: FONT_UI, weight: 700, color: '#0F0F0F', align: 'left' });
      text(ctx, v.when, 196 + nw, 76, { size: 30, font: FONT_UI, weight: 500, color: '#606060', align: 'left' });
      text(ctx, v.msg, 180, 140, { size: 40, font: FONT_UI, weight: 500, color: '#0F0F0F', align: 'left', maxW: 760 });
      thumb(ctx, 200, 222, 0.5, '#0F0F0F');
      const n = Math.round((Number(v.likes) || 0) * ease.out(clamp01((P.t - 0.4) / 1)));
      text(ctx, n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n), 240, 224, { size: 32, font: FONT_UI, weight: 600, color: '#606060', align: 'left' });
      ctx.restore();
    },
  },
  {
    id: 'phoneNotif', name: 'Phone notification', cat: 'chat', note: 'A banner drops down from the top',
    h: 220, size: 0.6, place: { x: 0.5, y: 0.1 }, dur: 3.2, sound: 'ping',
    params: [txt('app', 'App', 'Messages'), txt('from', 'From', 'Mum'), txt('msg', 'Message', 'dinner is ready. NOW.'), col('color', 'Icon colour', '#34C759')],
    draw(ctx, P, v) {
      const k = ease.back(P.pin), o = ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 3) * (1 - o);
      ctx.translate(0, lerp(-240, 0, k) - o * 240);
      ctx.fillStyle = 'rgba(245,245,247,.97)'; rr(ctx, 30, 20, 940, 180, 40); ctx.fill();
      ctx.fillStyle = v.color; rr(ctx, 60, 50, 80, 80, 20); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(100, 88, 26, 20, 0, 0, Math.PI * 2); ctx.fill();
      text(ctx, String(v.app).toUpperCase(), 170, 62, { size: 26, font: FONT_UI, weight: 600, color: '#6E6E73', align: 'left', spacing: 0.05 });
      text(ctx, 'now', 940, 62, { size: 26, font: FONT_UI, weight: 500, color: '#6E6E73', align: 'right' });
      text(ctx, v.from, 170, 108, { size: 38, font: FONT_UI, weight: 700, color: '#000', align: 'left', maxW: 740 });
      text(ctx, v.msg, 170, 156, { size: 36, font: FONT_UI, weight: 400, color: '#1C1C1E', align: 'left', maxW: 740 });
      ctx.restore();
    },
  },

  /* ── Subscribe and follow ──────────────────────────────── */
  {
    id: 'like', name: 'Like button', cat: 'social', note: 'A thumbs-up gets clicked and the count jumps',
    h: 240, size: 0.4, place: { x: 0.5, y: 0.8 }, dur: 2.8, sound: 'click', soundAt: 0.8,
    params: [num('likes', 'Likes before', 999, 0, 999999), txt('label', 'Words', 'LIKE'), col('color', 'Colour', C.blue)],
    draw(ctx, P, v) {
      const clicked = P.t > 0.8;
      ctx.save(); popIn(ctx, P, 500, 120, { from: 0.5 });
      ctx.fillStyle = clicked ? v.color : 'rgba(255,255,255,.95)'; rr(ctx, 80, 40, 840, 160, 80); ctx.fill();
      const bump = clicked ? 1 + 0.3 * Math.max(0, 1 - (P.t - 0.8) / 0.25) : 1;
      thumb(ctx, 220, 115, 1.3 * bump, clicked ? '#fff' : '#0F0F0F');
      const n = (Number(v.likes) || 0) + (clicked ? 1 : 0);
      const fmt = n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);
      text(ctx, `${v.label}  ${fmt}`, 580, 122, { size: 64, font: FONT_UI, weight: 800, color: clicked ? '#fff' : '#0F0F0F', maxW: 560 });
      ctx.restore();
      burst(ctx, 220, 120, (P.t - 0.8) / 0.5, { color: v.color, r0: 70, r1: 200, n: 10, w: 10 });
    },
  },
  {
    id: 'partTwo', name: 'Part 2', cat: 'social', note: 'A pill with an arrow that keeps going',
    h: 220, size: 0.42, place: { x: 0.5, y: 0.85 }, dur: 3, sound: 'pop',
    params: [txt('label', 'Words', 'PART 2'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      ctx.save(); popIn(ctx, P, 500, 110, { from: 0.5 });
      ctx.fillStyle = v.color; rr(ctx, 100, 30, 800, 160, 80); ctx.fill();
      text(ctx, v.label, 430, 114, { size: 90, color: ink(v.color), maxW: 520 });
      const dx = (P.hold * 120) % 60;
      ctx.strokeStyle = ink(v.color); ctx.lineWidth = 16; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 0; i < 2; i++) {
        const x = 730 + i * 50 + dx;
        ctx.globalAlpha = (1 - dx / 60 * (i ? 1 : 0)) * fade(P);
        ctx.beginPath(); ctx.moveTo(x, 75); ctx.lineTo(x + 40, 110); ctx.lineTo(x, 145); ctx.stroke();
      }
      ctx.restore();
    },
  },
  {
    id: 'commentFor', name: 'Comment for…', cat: 'social', note: '"Comment GG for part 2" — the word highlighted',
    h: 260, size: 0.66, place: { x: 0.5, y: 0.82 }, dur: 3.4, sound: 'pop',
    params: [txt('before', 'Before', 'COMMENT'), txt('word', 'The word', 'GG'), txt('after', 'After', 'FOR PART 2'), col('color', 'Highlight', C.volt)],
    draw(ctx, P, v) {
      ctx.save(); popIn(ctx, P, 500, 130, { from: 0.6 });
      ctx.fillStyle = 'rgba(6,8,15,.9)'; rr(ctx, 20, 30, 960, 200, 30); ctx.fill();
      ctx.font = `900 64px ${FONT_DISPLAY}`;
      const parts = [v.before, `"${v.word}"`, v.after].filter(Boolean);
      const ws = parts.map(p => ctx.measureText(p).width), gap = 28;
      const total = ws.reduce((a, b) => a + b, 0) + gap * (parts.length - 1), sc = Math.min(1, 880 / total);
      let x = 500 - total * sc / 2;
      parts.forEach((p, i) => {
        const hl = p === `"${v.word}"`;
        if (hl) {
          const a = ease.out((P.t - 0.4) / 0.3);
          ctx.fillStyle = v.color; ctx.fillRect(x - 8, 92, (ws[i] * sc + 16) * a, 80);
        }
        text(ctx, p, x + ws[i] * sc / 2, 134, { size: 64 * sc, color: hl ? ink(v.color) : '#fff' });
        x += (ws[i] + gap) * sc;
      });
      ctx.restore();
    },
  },
  {
    id: 'sendThis', name: 'Send this to…', cat: 'social', note: 'A paper plane flies off with a name',
    h: 260, size: 0.6, place: { x: 0.5, y: 0.8 }, dur: 3.2, sound: 'whoosh', soundAt: 0.9,
    params: [txt('label', 'Words', 'SEND THIS TO'), txt('name', 'Who', 'your duo'), col('color', 'Colour', C.cyan)],
    draw(ctx, P, v) {
      ctx.save(); popIn(ctx, P, 500, 130, { from: 0.6 });
      ctx.fillStyle = 'rgba(6,8,15,.9)'; rr(ctx, 30, 30, 940, 200, 100); ctx.fill();
      text(ctx, v.label, 420, 100, { size: 52, color: '#fff', maxW: 660 });
      text(ctx, v.name, 420, 168, { size: 52, color: v.color, maxW: 660 });
      const fly = ease.in(clamp01((P.t - 0.9) / 0.8));
      ctx.save(); ctx.translate(840 + fly * 300, 130 - fly * 160); ctx.rotate(-0.4 - fly * 0.3);
      ctx.fillStyle = v.color;
      ctx.beginPath(); ctx.moveTo(-60, 10); ctx.lineTo(70, -40); ctx.lineTo(-10, 50); ctx.lineTo(-10, 20); ctx.closePath(); ctx.fill();
      ctx.fillStyle = rgba(v.color, 0.6); ctx.beginPath(); ctx.moveTo(-10, 20); ctx.lineTo(70, -40); ctx.lineTo(-10, 50); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.restore();
    },
  },
  {
    id: 'linkInBio', name: 'Link in bio', cat: 'social', note: 'Points down, gently bouncing',
    h: 240, size: 0.42, place: { x: 0.5, y: 0.86 }, dur: 3, sound: 'pop',
    params: [txt('label', 'Words', 'LINK IN BIO'), col('color', 'Colour', C.white)],
    draw(ctx, P, v) {
      const bounce = Math.abs(Math.sin(P.hold * 4)) * 18;
      ctx.save(); popIn(ctx, P, 500, 110, { from: 0.5 });
      ctx.fillStyle = v.color; rr(ctx, 120, 20, 760, 140, 70); ctx.fill();
      ctx.strokeStyle = ink(v.color); ctx.lineWidth = 12; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(225, 78, 22, Math.PI * 0.25, Math.PI * 1.75); ctx.stroke();
      ctx.beginPath(); ctx.arc(255, 102, 22, Math.PI * 1.25, Math.PI * 0.75); ctx.stroke();
      text(ctx, v.label, 545, 92, { size: 66, color: ink(v.color), maxW: 540 });
      ctx.fillStyle = v.color;
      ctx.beginPath(); ctx.moveTo(470, 180 + bounce); ctx.lineTo(530, 180 + bounce); ctx.lineTo(500, 225 + bounce); ctx.closePath(); ctx.fill();
      ctx.restore();
    },
  },
];
