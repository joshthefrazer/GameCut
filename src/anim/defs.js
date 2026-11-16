import { ease, phase, rr, text, burst, ring, shine, rgba, ink, lerp, clamp01, rng, FONT_DISPLAY, FONT_UI, FONT_MONO } from './kit.js';

/**
 * Strike's animation library.
 *
 * Each animation is made to be customised, not keyframed: a few words, a
 * couple of colours, and how long it stays. It draws into a box 1000 units
 * wide and `h` tall (h in the same units), and comes with its own sound.
 *
 *   id, name, cat, note       what it is, where it lives in the library
 *   h                          box height (width is always 1000)
 *   size                       box width as a share of the short edge of the frame
 *   place                      where it lands: { x, y } (0..1 of the frame)
 *   dur                        how long a new one lasts (s)
 *   sound                      built-in sound (assets/sfx/<sound>.wav), and when it plays (soundAt)
 *   params                     what the Customize panel offers
 *   draw(ctx, P, v)            P = phase + clock, v = the chosen values
 */
export const CATS = [
  { id: 'popups', name: 'Pop-ups' },
  { id: 'counters', name: 'Counters and timers' },
  { id: 'titles', name: 'Titles and chapters' },
  { id: 'callouts', name: 'Callouts' },
  { id: 'chat', name: 'Chat and overlays' },
  { id: 'social', name: 'Subscribe and follow' },
];

import { C, txt, col, num, tog, popIn } from './params.js';
import { MORE } from './defs-more.js';

const BASE = [
  /* ── Pop-ups ───────────────────────────────────────────── */
  {
    id: 'killCounter', name: 'Kill counter', cat: 'popups', note: 'Counts up each time you add another',
    h: 260, size: 0.42, place: { x: 0.2, y: 0.16 }, dur: 1.8, sound: 'hit',
    params: [txt('label', 'Words', 'KILL'), num('count', 'Count', 1, 0, 99), tog('showCount', 'Show the count', true), col('color', 'Tag colour', C.ember), col('ink', 'Text colour', C.white)],
    draw(ctx, P, v) {
      ctx.save();
      popIn(ctx, P, 500, 130, { from: 1.8, rot: -0.35 });
      ctx.translate(500, 130); ctx.rotate(-0.07); ctx.translate(-500, -130);
      const label = String(v.label || '') + (v.showCount ? `  ×${v.count}` : '');
      ctx.font = `900 120px ${FONT_DISPLAY}`;
      const w = Math.min(960, ctx.measureText(label).width + 110);
      ctx.fillStyle = rgba('#000000', 0.35); rr(ctx, 500 - w / 2 + 10, 30 + 22, w, 180, 34); ctx.fill();
      ctx.fillStyle = v.color; rr(ctx, 500 - w / 2, 30, w, 180, 34); ctx.fill();
      shine(ctx, 500 - w / 2, 30, w, 180, (P.t - 0.15) / 0.5);
      text(ctx, label, 500, 122, { size: 120, color: v.ink, maxW: w - 80 });
      ctx.restore();
      burst(ctx, 500, 130, (P.t - 0.05) / 0.5, { color: v.color, r0: 120, r1: 480, n: 12, w: 14 });
    },
  },
  {
    id: 'headshot', name: 'Headshot', cat: 'popups', note: 'Crosshair snaps on, word stamps in',
    h: 520, size: 0.42, place: { x: 0.5, y: 0.45 }, dur: 1.6, sound: 'hit',
    params: [txt('label', 'Words', 'HEADSHOT'), col('color', 'Colour', C.ember), col('ink', 'Text colour', C.white)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), out = 1 - P.pout;
      ctx.save(); ctx.globalAlpha *= out;
      const r = lerp(260, 130, k);
      ctx.strokeStyle = v.color; ctx.lineWidth = 16; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(500, 200, r, 0, Math.PI * 2); ctx.stroke();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.beginPath(); ctx.moveTo(500 + dx * (r - 50), 200 + dy * (r - 50)); ctx.lineTo(500 + dx * (r + 60), 200 + dy * (r + 60)); ctx.stroke();
      }
      ctx.fillStyle = v.color; ctx.beginPath(); ctx.arc(500, 200, 14 * k, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ring(ctx, 500, 200, (P.t - 0.25) / 0.5, { color: v.color, r0: 130, r1: 420, w: 12 });
      ctx.save(); ctx.globalAlpha *= out * clamp01((P.t - 0.18) / 0.12);
      const s = lerp(1.6, 1, ease.slam((P.t - 0.18) / 0.3));
      ctx.translate(500, 450); ctx.scale(s, s); ctx.translate(-500, -450);
      text(ctx, v.label, 500, 450, { size: 110, color: v.ink, stroke: '#06080F', strokeW: 10, maxW: 980, spacing: 0.04 });
      ctx.restore();
    },
  },
  {
    id: 'aceSlam', name: 'Ace slam', cat: 'popups', note: 'Huge word slams in with a shockwave',
    h: 420, size: 0.6, place: { x: 0.5, y: 0.42 }, dur: 2.2, sound: 'boom',
    params: [txt('label', 'Words', 'ACE'), col('color', 'Fill', C.volt), col('glow', 'Glow', C.ember), tog('shake', 'Shake on impact', true)],
    draw(ctx, P, v) {
      const k = ease.slam(P.pin);
      ctx.save();
      if (v.shake && P.t > 0.25 && P.t < 0.55) { const R = rng(Math.floor(P.t * 60)); ctx.translate((R() - 0.5) * 24, (R() - 0.5) * 24); }
      ctx.globalAlpha *= clamp01(P.pin * 4) * (1 - P.pout);
      const s = lerp(3.2, 1, k) * (1 + ease.in(P.pout) * 0.4);
      ctx.translate(500, 210); ctx.scale(s, s); ctx.translate(-500, -210);
      text(ctx, v.label, 500, 215, { size: 300, color: v.color, stroke: '#06080F', strokeW: 16, glow: v.glow, glowR: 60, maxW: 980, italic: false });
      ctx.restore();
      ring(ctx, 500, 210, (P.t - 0.22) / 0.6, { color: v.glow, r0: 120, r1: 640, w: 24 });
      burst(ctx, 500, 210, (P.t - 0.2) / 0.6, { color: v.color, r0: 220, r1: 620, n: 18, w: 16, seed: 9 });
    },
  },
  {
    id: 'victory', name: 'Victory banner', cat: 'popups', note: 'Gold banner with light rays',
    h: 380, size: 0.62, place: { x: 0.5, y: 0.3 }, dur: 2.6, sound: 'levelup',
    params: [txt('label', 'Words', 'VICTORY'), txt('sub', 'Small line', 'ROUND 13'), col('color', 'Banner', C.gold), col('ink', 'Text', '#1A1203')],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), out = 1 - ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= out;
      ctx.save(); ctx.translate(500, 190); ctx.rotate(P.t * 0.4);
      for (let i = 0; i < 12; i++) { ctx.rotate(Math.PI / 6); ctx.fillStyle = rgba(v.color, 0.16 * k); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-60, -620); ctx.lineTo(60, -620); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      const w = lerp(0, 940, k);
      ctx.fillStyle = v.color; rr(ctx, 500 - w / 2, 110, w, 170, 24); ctx.fill();
      ctx.fillStyle = rgba('#000000', 0.18); ctx.fillRect(500 - w / 2, 250, w, 30);
      shine(ctx, 500 - w / 2, 110, w, 170, (P.t - 0.4) / 0.6);
      ctx.globalAlpha *= clamp01((P.t - 0.2) / 0.2);
      text(ctx, v.label, 500, 198, { size: 120, color: v.ink, maxW: Math.max(10, w - 80), spacing: 0.06 });
      text(ctx, v.sub, 500, 330, { size: 46, font: FONT_UI, weight: 800, color: v.color, spacing: 0.2 });
      ctx.restore();
    },
  },
  {
    id: 'levelUp', name: 'Level up', cat: 'popups', note: 'Arrow rises, sparkles burst',
    h: 420, size: 0.45, place: { x: 0.5, y: 0.4 }, dur: 2, sound: 'levelup',
    params: [txt('label', 'Words', 'LEVEL UP'), num('level', 'Level', 25, 1, 999), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      const k = ease.back(P.pin), out = 1 - P.pout;
      ctx.save(); ctx.globalAlpha *= out;
      const y = lerp(260, 120, k);
      ctx.fillStyle = v.color;
      ctx.beginPath(); ctx.moveTo(500, y - 100); ctx.lineTo(600, y); ctx.lineTo(545, y); ctx.lineTo(545, y + 90); ctx.lineTo(455, y + 90); ctx.lineTo(455, y); ctx.lineTo(400, y); ctx.closePath(); ctx.fill();
      ctx.globalAlpha *= clamp01((P.t - 0.15) / 0.2);
      text(ctx, v.label, 500, 300, { size: 104, color: '#fff', stroke: '#06080F', strokeW: 10, maxW: 960 });
      text(ctx, String(v.level), 500, 390, { size: 64, font: FONT_MONO, weight: 700, color: v.color });
      ctx.restore();
      burst(ctx, 500, 160, (P.t - 0.2) / 0.7, { color: v.color, r0: 80, r1: 460, n: 16, w: 10, seed: 5 });
    },
  },
  {
    id: 'countdown', name: '3 · 2 · 1 · GO', cat: 'counters', note: 'Counts down, then GO',
    h: 560, size: 0.4, place: { x: 0.5, y: 0.45 }, dur: 3.4, sound: 'beep', soundEvery: 0.8,
    durFor: (v) => Math.max(1, Math.round(v.from || 3)) * 0.8 + 1,
    sounds: (v) => { const n = Math.max(1, Math.round(v.from || 3)); return [...Array.from({ length: n }, (_, i) => ({ sound: 'beep', at: +(i * 0.8).toFixed(2) })), { sound: 'go', at: +(n * 0.8).toFixed(2) }]; },
    params: [num('from', 'Count from', 3, 1, 9), txt('go', 'Last word', 'GO!'), col('color', 'Colour', C.volt)],
    draw(ctx, P, v) {
      const from = Math.max(1, Math.round(v.from || 3)), step = 0.8;
      const i = Math.floor(P.t / step), lt = P.t - i * step;
      const label = i < from ? String(from - i) : v.go;
      const k = ease.back(lt / 0.25), fade = i < from ? 1 - clamp01((lt - 0.55) / 0.25) : 1 - P.pout;
      ctx.save(); ctx.globalAlpha *= fade;
      ctx.strokeStyle = rgba(v.color, 0.35); ctx.lineWidth = 18;
      ctx.beginPath(); ctx.arc(500, 280, 230, 0, Math.PI * 2); ctx.stroke();
      if (i < from) { ctx.strokeStyle = v.color; ctx.beginPath(); ctx.arc(500, 280, 230, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(lt / step)); ctx.stroke(); }
      ctx.translate(500, 280); ctx.scale(lerp(1.8, 1, k), lerp(1.8, 1, k)); ctx.translate(-500, -280);
      text(ctx, label, 500, 290, { size: i < from ? 280 : 200, color: i < from ? '#fff' : v.color, stroke: '#06080F', strokeW: 12, maxW: 900 });
      ctx.restore();
    },
  },
  {
    id: 'clutchTimer', name: 'Clutch timer', cat: 'counters', note: 'Seconds tick down in a ring',
    h: 440, size: 0.28, place: { x: 0.86, y: 0.22 }, dur: 3.2, sound: 'tick', soundEvery: 1,
    durFor: (v) => Math.max(1, Math.min(60, v.from || 3)) + 0.6,
    sounds: (v, dur) => Array.from({ length: Math.max(1, Math.min(60, Math.ceil(v.from || 3))) }, (_, i) => ({ sound: 'tick', at: +(0.4 + i).toFixed(2) })).filter(s => s.at < dur),
    params: [num('from', 'Start at (seconds)', 3, 1, 60), txt('label', 'Small word', 'CLUTCH'), col('color', 'Colour', C.ember)],
    draw(ctx, P, v) {
      const from = Math.max(1, v.from || 3), left = Math.max(0, from - P.hold);
      const k = ease.back(P.pin);
      ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 3) * (1 - P.pout);
      ctx.translate(500, 230); ctx.scale(k, k); ctx.translate(-500, -230);
      ctx.fillStyle = 'rgba(6,8,15,.82)'; ctx.beginPath(); ctx.arc(500, 230, 200, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(v.color, 0.3); ctx.lineWidth = 22; ctx.beginPath(); ctx.arc(500, 230, 200, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = v.color; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(500, 230, 200, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (left / from)); ctx.stroke();
      const sec = Math.ceil(left - 1e-6);
      const pulse = 1 + 0.12 * Math.max(0, 1 - ((from - left) % 1) / 0.2);
      ctx.translate(500, 215); ctx.scale(pulse, pulse); ctx.translate(-500, -215);
      text(ctx, `0:${String(sec).padStart(2, '0')}`, 500, 215, { size: 120, font: FONT_MONO, weight: 700, color: '#fff' });
      text(ctx, v.label, 500, 320, { size: 40, font: FONT_UI, weight: 800, color: v.color, spacing: 0.2 });
      ctx.restore();
    },
  },
  {
    id: 'healthBar', name: 'Boss health bar', cat: 'counters', note: 'A bar drains as the fight goes',
    h: 200, size: 0.8, place: { x: 0.5, y: 0.1 }, dur: 3, sound: 'hit',
    params: [txt('label', 'Name', 'FINAL BOSS'), num('fromPct', 'Starts at %', 100, 1, 100), num('toPct', 'Ends at %', 8, 0, 100), col('color', 'Bar colour', C.ember)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin);
      ctx.save(); ctx.globalAlpha *= k * (1 - P.pout);
      text(ctx, v.label, 30, 50, { size: 54, font: FONT_DISPLAY, weight: 800, color: '#fff', align: 'left', stroke: '#06080F', strokeW: 6, maxW: 900 });
      const pct = lerp(v.fromPct, v.toPct, ease.inOut(clamp01((P.t - 0.4) / Math.max(0.2, P.dur - 1)))) / 100;
      ctx.fillStyle = 'rgba(6,8,15,.85)'; rr(ctx, 20, 100, 960, 70, 14); ctx.fill();
      ctx.fillStyle = rgba(v.color, 0.35); rr(ctx, 30, 110, 940 * Math.min(1, pct + 0.06), 50, 10); ctx.fill();
      ctx.fillStyle = v.color; rr(ctx, 30, 110, 940 * pct, 50, 10); ctx.fill();
      text(ctx, `${Math.round(pct * 100)}%`, 960, 50, { size: 40, font: FONT_MONO, weight: 700, color: v.color, align: 'right' });
      ctx.restore();
    },
  },
  {
    id: 'statCard', name: 'Stat card', cat: 'counters', note: 'Your numbers slide in, row by row',
    h: 560, size: 0.38, place: { x: 0.2, y: 0.5 }, dur: 3.2, sound: 'whoosh',
    params: [txt('title', 'Title', 'MATCH STATS'), txt('r1', 'Row 1', 'Kills  21'), txt('r2', 'Row 2', 'K/D  2.4'), txt('r3', 'Row 3', 'Headshots  58%'), col('color', 'Accent', C.volt)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin);
      ctx.save(); ctx.globalAlpha *= k * (1 - P.pout);
      ctx.translate(lerp(-300, 0, k), 0);
      ctx.fillStyle = 'rgba(6,8,15,.88)'; rr(ctx, 20, 20, 960, 520, 40); ctx.fill();
      ctx.fillStyle = v.color; rr(ctx, 20, 20, 18, 520, 9); ctx.fill();
      text(ctx, v.title, 80, 110, { size: 60, font: FONT_DISPLAY, weight: 800, color: v.color, align: 'left', maxW: 860 });
      [v.r1, v.r2, v.r3].forEach((r, i) => {
        const a = ease.out((P.t - 0.25 - i * 0.15) / 0.3);
        if (a <= 0) return;
        ctx.save(); ctx.globalAlpha *= a; ctx.translate(lerp(60, 0, a), 0);
        const [name, ...rest] = String(r || '').split(/\s{2,}/);
        text(ctx, name, 80, 230 + i * 110, { size: 54, font: FONT_UI, weight: 600, color: '#C9D3EA', align: 'left' });
        text(ctx, rest.join(' '), 920, 230 + i * 110, { size: 62, font: FONT_MONO, weight: 700, color: '#fff', align: 'right' });
        ctx.restore();
      });
      ctx.restore();
    },
  },

  /* ── Titles ────────────────────────────────────────────── */
  {
    id: 'chapter', name: 'Chapter card', cat: 'titles', note: 'Chapter number and a title wipe in',
    h: 360, size: 0.7, place: { x: 0.5, y: 0.5 }, dur: 2.6, sound: 'whoosh',
    params: [txt('kicker', 'Small line', 'CHAPTER 2'), txt('title', 'Title', 'THE COMEBACK'), col('color', 'Accent', C.volt)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), out = 1 - ease.in(P.pout);
      ctx.save(); ctx.globalAlpha *= out;
      ctx.fillStyle = v.color; ctx.fillRect(500 - 260 * k, 110, 520 * k, 8);
      text(ctx, v.kicker, 500, 70, { size: 48, font: FONT_UI, weight: 800, color: v.color, spacing: 0.3 });
      ctx.save(); ctx.beginPath(); ctx.rect(0, 140, 1000 * ease.out((P.t - 0.15) / 0.5), 220); ctx.clip();
      text(ctx, v.title, 500, 240, { size: 120, color: '#fff', maxW: 980, stroke: '#06080F', strokeW: 6 });
      ctx.restore();
      ctx.restore();
    },
  },
  {
    id: 'glitchTitle', name: 'Glitch title', cat: 'titles', note: 'Colour-split jitter, then locks in',
    h: 300, size: 0.66, place: { x: 0.5, y: 0.5 }, dur: 2, sound: 'glitch',
    params: [txt('label', 'Words', 'GLITCHED'), col('color', 'Colour', C.white)],
    draw(ctx, P, v) {
      const jitter = P.t < 0.45 || P.pout > 0 ? 1 : 0;
      const R = rng(Math.floor(P.t * 30) + 1);
      ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 2) * (1 - P.pout);
      const o = jitter ? 14 : 0;
      ctx.globalCompositeOperation = 'lighter';
      text(ctx, v.label, 500 - o + (R() - 0.5) * 30 * jitter, 150, { size: 170, color: '#FF2D55', maxW: 960 });
      text(ctx, v.label, 500 + o + (R() - 0.5) * 30 * jitter, 150, { size: 170, color: '#22D3EE', maxW: 960 });
      ctx.globalCompositeOperation = 'source-over';
      text(ctx, v.label, 500, 150, { size: 170, color: v.color, maxW: 960 });
      if (jitter) for (let i = 0; i < 4; i++) { ctx.fillStyle = 'rgba(6,8,15,.85)'; ctx.fillRect(0, R() * 300, 1000, 8 + R() * 14); }
      ctx.restore();
    },
  },
  {
    id: 'lowerThird', name: 'Name tag', cat: 'titles', note: 'Your name and handle, lower third',
    h: 260, size: 0.55, place: { x: 0.3, y: 0.82 }, dur: 3.5, sound: 'whoosh',
    params: [txt('name', 'Name', 'YOUR NAME'), txt('handle', 'Handle', '@yourchannel'), col('color', 'Accent', C.blue), col('ink', 'Name colour', C.white)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), out = ease.in(P.pout);
      ctx.save();
      const w = 980 * k * (1 - out);
      ctx.fillStyle = v.color; rr(ctx, 10, 40, 26, 180, 8); ctx.fill();
      ctx.fillStyle = 'rgba(6,8,15,.88)'; rr(ctx, 50, 40, Math.max(0, w - 40), 180, 18); ctx.fill();
      ctx.beginPath(); ctx.rect(50, 0, Math.max(0, w - 40), 260); ctx.clip();
      ctx.globalAlpha *= clamp01((P.t - 0.15) / 0.2) * (1 - out);
      text(ctx, v.name, 90, 108, { size: 78, color: v.ink, align: 'left', maxW: 860 });
      text(ctx, v.handle, 92, 182, { size: 46, font: FONT_UI, weight: 600, color: v.color, align: 'left', maxW: 860 });
      ctx.restore();
    },
  },
  {
    id: 'bigWords', name: 'Big words', cat: 'titles', note: 'Each word punches in on its own',
    h: 360, size: 0.75, place: { x: 0.5, y: 0.5 }, dur: 2.4, sound: 'pop', soundEvery: 0.22,
    durFor: (v) => Math.max(2.4, String(v.label || '').split(/\s+/).filter(Boolean).length * 0.22 + 1.6),
    sounds: (v) => String(v.label || '').split(/\s+/).filter(Boolean).slice(0, 12).map((_, i) => ({ sound: 'pop', at: +(i * 0.22).toFixed(2) })),
    params: [txt('label', 'Words', 'NO WAY BRO'), col('color', 'Colour', C.white), col('pop', 'Last word colour', C.volt)],
    draw(ctx, P, v) {
      const words = String(v.label || '').split(/\s+/).filter(Boolean);
      ctx.save(); ctx.globalAlpha *= 1 - P.pout;
      ctx.font = `900 130px ${FONT_DISPLAY}`;
      const gap = 40, ws = words.map(w => ctx.measureText(w).width);
      const total = ws.reduce((a, b) => a + b, 0) + gap * (words.length - 1);
      const sc = Math.min(1, 960 / Math.max(1, total));
      let x = 500 - total * sc / 2;
      words.forEach((w, i) => {
        const a = (P.t - i * 0.22) / 0.22;
        if (a > 0) {
          const s = lerp(1.9, 1, ease.back(a)) * sc;
          const cx = x + ws[i] * sc / 2;
          ctx.save(); ctx.globalAlpha *= clamp01(a * 2);
          ctx.translate(cx, 180); ctx.scale(s, s);
          text(ctx, w, 0, 0, { size: 130, color: i === words.length - 1 ? v.pop : v.color, stroke: '#06080F', strokeW: 9 });
          ctx.restore();
        }
        x += (ws[i] + gap) * sc;
      });
      ctx.restore();
    },
  },

  /* ── Callouts ─────────────────────────────────────────── */
  {
    id: 'lookHere', name: 'Look here arrow', cat: 'callouts', note: 'An arrow draws itself to the spot',
    h: 520, size: 0.4, place: { x: 0.6, y: 0.5 }, dur: 2.4, sound: 'whoosh',
    params: [txt('label', 'Words', 'LOOK!'), col('color', 'Colour', C.volt), tog('flip', 'Point the other way', false)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin * 1.2), out = 1 - P.pout;
      ctx.save(); ctx.globalAlpha *= out;
      if (v.flip) { ctx.translate(1000, 0); ctx.scale(-1, 1); }
      ctx.strokeStyle = v.color; ctx.lineWidth = 26; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const pts = []; for (let i = 0; i <= 40; i++) { const u = i / 40; pts.push([lerp(120, 820, u), 420 - Math.sin(u * Math.PI * 0.9) * 300 + u * 40]); }
      const n = Math.max(1, Math.floor(pts.length * k));
      ctx.beginPath(); pts.slice(0, n).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
      if (k >= 0.98) { const [x, y] = pts[pts.length - 1]; ctx.beginPath(); ctx.moveTo(x - 90, y - 50); ctx.lineTo(x, y); ctx.lineTo(x - 30, y - 100); ctx.stroke(); }
      if (v.flip) { ctx.translate(1000, 0); ctx.scale(-1, 1); }
      ctx.globalAlpha *= clamp01((P.t - 0.2) / 0.2);
      text(ctx, v.label, v.flip ? 760 : 240, 420, { size: 96, color: '#fff', stroke: '#06080F', strokeW: 9, maxW: 460 });
      ctx.restore();
    },
  },
  {
    id: 'spotlight', name: 'Spotlight', cat: 'callouts', note: 'Darkens everything except one spot',
    h: 562, size: 1.78, place: { x: 0.5, y: 0.5 }, dur: 2.5, sound: 'whoosh', full: true,
    params: [num('sx', 'Spot left–right %', 50, 0, 100), num('sy', 'Spot up–down %', 50, 0, 100), num('radius', 'Spot size', 18, 4, 60), num('dark', 'Darkness %', 75, 10, 95)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin), out = 1 - ease.in(P.pout);
      const cx = v.sx * 10, cy = (v.sy / 100) * (P.bh || 562), r = lerp(900, v.radius * 10, k);
      ctx.save(); ctx.globalAlpha *= out;
      const g = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.15);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${v.dark / 100})`);
      ctx.fillStyle = g; ctx.fillRect(-2000, -2000, 5000, 5000);
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    },
  },
  {
    id: 'circleIt', name: 'Circle it', cat: 'callouts', note: 'A hand-drawn circle around something',
    h: 620, size: 0.36, place: { x: 0.5, y: 0.5 }, dur: 2.2, sound: 'scratch',
    params: [col('color', 'Colour', C.ember), num('thick', 'Thickness', 22, 6, 50)],
    draw(ctx, P, v) {
      const k = ease.inOut(P.pin * 1.1);
      ctx.save(); ctx.globalAlpha *= 1 - P.pout;
      ctx.strokeStyle = v.color; ctx.lineWidth = v.thick; ctx.lineCap = 'round';
      ctx.beginPath();
      const steps = 70, n = Math.floor(steps * k);
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI * 0.6 + (i / steps) * Math.PI * 2.15;
        const r = 380 + Math.sin(i * 0.35) * 14 + i * 0.6;
        const x = 500 + Math.cos(a) * r, y = 310 + Math.sin(a) * r * 0.66;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    },
  },

  /* ── Chat ─────────────────────────────────────────────── */
  {
    id: 'chatMessage', name: 'Chat message', cat: 'chat', note: 'A Discord-style message pops in',
    h: 300, size: 0.62, place: { x: 0.3, y: 0.78 }, dur: 3, sound: 'ping',
    params: [txt('name', 'Name', 'teammate'), txt('message', 'Message', 'bro is actually cracked 💀'), col('color', 'Name colour', '#F47FFF'), col('avatar', 'Avatar colour', C.discord)],
    draw(ctx, P, v) {
      const k = ease.back(P.pin);
      ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 3) * (1 - P.pout);
      ctx.translate(0, lerp(80, 0, k));
      ctx.fillStyle = 'rgba(49,51,56,.96)'; rr(ctx, 20, 30, 960, 240, 36); ctx.fill();
      ctx.fillStyle = v.avatar; ctx.beginPath(); ctx.arc(130, 150, 70, 0, Math.PI * 2); ctx.fill();
      text(ctx, String(v.name || '?').slice(0, 1).toUpperCase(), 130, 152, { size: 70, font: FONT_UI, weight: 800, color: '#fff' });
      text(ctx, v.name, 240, 110, { size: 52, font: FONT_UI, weight: 700, color: v.color, align: 'left', maxW: 500 });
      text(ctx, 'Today at 21:14', 240 + Math.min(500, 40 + 27 * String(v.name || '').length), 112, { size: 32, font: FONT_UI, weight: 500, color: '#949BA4', align: 'left' });
      text(ctx, v.message, 240, 190, { size: 50, font: FONT_UI, weight: 500, color: '#DBDEE1', align: 'left', maxW: 710 });
      ctx.restore();
    },
  },
  {
    id: 'killFeed', name: 'Kill feed line', cat: 'chat', note: 'Player ⟶ player, like a game feed',
    h: 140, size: 0.6, place: { x: 0.78, y: 0.12 }, dur: 2.8, sound: 'click',
    params: [txt('left', 'You', 'YOU'), txt('right', 'Them', 'enemy_42'), col('color', 'Your colour', C.volt), col('enemy', 'Their colour', C.ember)],
    draw(ctx, P, v) {
      const k = ease.out(P.pin);
      ctx.save(); ctx.globalAlpha *= k * (1 - P.pout);
      ctx.translate(lerp(200, 0, k), 0);
      ctx.fillStyle = 'rgba(6,8,15,.82)'; rr(ctx, 20, 20, 960, 100, 16); ctx.fill();
      text(ctx, v.left, 60, 72, { size: 50, font: FONT_UI, weight: 800, color: v.color, align: 'left', maxW: 340 });
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(430, 70); ctx.lineTo(560, 70); ctx.moveTo(530, 50); ctx.lineTo(560, 70); ctx.lineTo(530, 90); ctx.stroke();
      text(ctx, v.right, 940, 72, { size: 50, font: FONT_UI, weight: 800, color: v.enemy, align: 'right', maxW: 340 });
      ctx.restore();
    },
  },

  /* ── Social ───────────────────────────────────────────── */
  {
    id: 'subscribe', name: 'Subscribe click', cat: 'social', note: 'A cursor clicks Subscribe and the bell',
    h: 300, size: 0.55, place: { x: 0.5, y: 0.82 }, dur: 3.2, sound: 'click', soundAt: 0.9,
    params: [txt('label', 'Button', 'SUBSCRIBE'), txt('done', 'After the click', 'SUBSCRIBED'), col('color', 'Button colour', '#FF0033')],
    draw(ctx, P, v) {
      const k = ease.back(P.pin), clicked = P.t > 0.95;
      ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 3) * (1 - P.pout);
      ctx.translate(500, 150); ctx.scale(k * (P.t > 0.9 && P.t < 1.05 ? 0.94 : 1), k); ctx.translate(-500, -150);
      ctx.fillStyle = clicked ? '#3F3F46' : v.color; rr(ctx, 90, 60, 640, 180, 90); ctx.fill();
      text(ctx, clicked ? v.done : v.label, 410, 152, { size: 64, font: FONT_UI, weight: 800, color: '#fff', maxW: 560 });
      ctx.fillStyle = '#3F3F46'; ctx.beginPath(); ctx.arc(840, 150, 90, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.translate(840, 150); ctx.rotate(P.t > 1.6 ? Math.sin((P.t - 1.6) * 30) * 0.3 * Math.max(0, 1 - (P.t - 1.6) / 0.6) : 0);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(-36, 26); ctx.quadraticCurveTo(-36, -40, 0, -44); ctx.quadraticCurveTo(36, -40, 36, 26); ctx.closePath(); ctx.fill();
      ctx.fillRect(-46, 22, 92, 10); ctx.beginPath(); ctx.arc(0, 42, 12, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      const cur = P.t < 0.9 ? [lerp(980, 420, ease.inOut(P.t / 0.9)), lerp(300, 170, ease.inOut(P.t / 0.9))] : P.t < 1.5 ? [lerp(420, 860, ease.inOut((P.t - 0.9) / 0.6)), 170] : [860, 170];
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(cur[0], cur[1]); ctx.lineTo(cur[0], cur[1] + 90); ctx.lineTo(cur[0] + 24, cur[1] + 68); ctx.lineTo(cur[0] + 44, cur[1] + 108); ctx.lineTo(cur[0] + 58, cur[1] + 100); ctx.lineTo(cur[0] + 38, cur[1] + 62); ctx.lineTo(cur[0] + 68, cur[1] + 60); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    },
  },
  {
    id: 'follow', name: 'Follow for more', cat: 'social', note: 'A pill that bounces for attention',
    h: 240, size: 0.5, place: { x: 0.5, y: 0.75 }, dur: 3, sound: 'pop',
    params: [txt('label', 'Words', 'FOLLOW FOR MORE'), col('color', 'Pill colour', C.volt)],
    draw(ctx, P, v) {
      const k = ease.back(P.pin);
      const bounce = Math.abs(Math.sin(P.hold * 5)) * 22 * Math.max(0, 1 - P.hold / 2.5);
      ctx.save(); ctx.globalAlpha *= clamp01(P.pin * 3) * (1 - P.pout);
      ctx.translate(500, 120 - bounce); ctx.scale(k, k); ctx.translate(-500, -120);
      ctx.font = `900 72px ${FONT_DISPLAY}`;
      const w = Math.min(980, ctx.measureText(v.label).width + 200);
      ctx.fillStyle = v.color; rr(ctx, 500 - w / 2, 40, w, 160, 80); ctx.fill();
      text(ctx, v.label, 500 + 30, 122, { size: 72, color: ink(v.color), maxW: w - 180 });
      ctx.strokeStyle = ink(v.color); ctx.lineWidth = 14; ctx.lineCap = 'round';
      const ax = 500 - w / 2 + 70;
      ctx.beginPath(); ctx.moveTo(ax, 95); ctx.lineTo(ax, 150); ctx.moveTo(ax - 22, 128); ctx.lineTo(ax, 150); ctx.lineTo(ax + 22, 128); ctx.stroke();
      ctx.restore();
    },
  },
];

export const ANIMATIONS = [...BASE, ...MORE];

export const animById = (id) => ANIMATIONS.find(a => a.id === id) || null;

/** The values an animation is drawn with: its defaults, overridden by the clip's. */
export function valuesFor(def, p = {}) {
  const v = {};
  for (const prm of def.params) v[prm.key] = p[prm.key] ?? prm.def;
  return v;
}

/** Draw one animation into its own 1000-wide box, at `t` seconds into a `dur`-long clip. */
export function drawAnim(ctx, def, t, dur, values, inDur, outDur, bh = def.h) {
  const P = phase(t, dur, inDur ?? def.inDur ?? 0.4, outDur ?? def.outDur ?? 0.3);
  P.bh = bh;
  def.draw(ctx, P, values);
}
