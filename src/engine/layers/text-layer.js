import { fontShorthand } from '../../media/fonts.js';
import { evalProp } from '../keyframes.js';
import { clamp01, easeOut, rad, REST, move, loopMove, combine } from '../motion.js';

/**
 * Canvas2D text renderer.
 *
 * Paint order is stroke, then fill, so an outline never eats the glyph
 * interior. Glow and shadow are separate passes for the same reason: a glow is
 * centred and coloured, a shadow is offset and dark, and drawing them together
 * makes a smear rather than either.
 *
 * Type is sized against the frame's SHORT edge, so a title composed at 1080p
 * lands identically at 4K and keeps its optical size when the project is
 * reframed 16:9 -> 9:16, instead of ballooning past the safe area.
 *
 * ── Motion ──────────────────────────────────────────────────────
 * Text can move three ways, all named rather than keyframed so each is one
 * click to change or remove:
 *   in    how it arrives (`anim`, over `animDur`)
 *   out   how it leaves, over the last `animOutDur` of the clip
 *   loop  what it does the whole time it is on screen
 * The first two can run on the whole block, word by word, or letter by letter
 * (`animUnit`), spread out by `animSpread`. Hand keyframes still layer on top.
 */
export const shortEdge = (W, H) => Math.min(W, H);

/**
 * How long a clip's arrival takes in all, once words or letters are staggered.
 * The editor reads this to park the playhead somewhere the text has settled.
 */
export function entranceSpan(clip) {
  const s = clip.text || {};
  if (!s.anim || s.anim === 'none') return 0;
  const dur = Math.max(0.05, s.animDur || 0.35);
  return dur + ((s.animUnit && s.animUnit !== 'all') ? (s.animSpread ?? 0.35) * dur * 2 : 0);
}

export function measureText(ctx, clip, W, H, t = clip.start) {
  const s = clip.text;
  const px = Math.max(4, evalProp(clip, 'text.size', t) * shortEdge(W, H));
  ctx.font = fontShorthand(s, px);
  const maxW = Math.max(0.05, clip.transform.w) * W;
  /* The whole text is measured, always. Typed text used to measure only what
     had been typed so far, which re-centred and re-wrapped the line with every
     letter — the words jumped about as they arrived. */
  const lines = wrap(ctx, String(s.text ?? ''), maxW, s.letterSpacing * px);
  const lineH = px * (s.lineHeight || 1.15);
  let widest = 0;
  for (const l of lines) widest = Math.max(widest, lineWidth(ctx, l, s.letterSpacing * px));
  return { px, lines, lineH, width: widest, height: lineH * lines.length };
}

/**
 * Break the text into the pieces that move on their own.
 *
 * `letter` gives one piece per letter, `word` one per word. Every piece keeps
 * the position its letters have in the whole block, measured the same way the
 * block is drawn, so a flying word lands exactly where the still word would.
 * Spaces take room and are counted (the typewriter types them) but are never
 * pieces themselves.
 */
function layout(ctx, m, s, unit, wordGap = 0) {
  const sp = (s.letterSpacing || 0) * m.px;
  const top = -m.height / 2 + m.lineH / 2;
  const pieces = [], glyphs = [];
  let n = 0;

  m.lines.forEach((line, li) => {
    const cy = top + li * m.lineH;
    const gaps = wordGap ? (line.match(/ /g) || []).length : 0;
    const lw = lineWidth(ctx, line, sp) + gaps * wordGap;
    const left = alignOffset(s.align, m, lw) - lw / 2;
    let prefix = '', acc = 0, spaces = 0;
    const row = Array.from(line).map((ch) => {
      const w = ctx.measureText(ch).width;
      // Kerned position from the real prefix when there is no letter gap; summed otherwise.
      const x = (sp ? acc : ctx.measureText(prefix).width) + spaces * wordGap;
      if (ch === ' ') spaces++;
      prefix += ch; acc += w + sp;
      const g = { ch, x: left + x, w, cy, gi: glyphs.length };
      glyphs.push(g);
      return g;
    });

    if (unit === 'word') {
      let cur = null;
      for (const g of row) {
        if (g.ch === ' ') { cur = null; continue; }
        if (!cur) { cur = { chars: [], idx: n++, cy }; pieces.push(cur); }
        cur.chars.push(g);
      }
    } else {
      for (const g of row) if (g.ch !== ' ') pieces.push({ chars: [g], idx: n++, cy });
    }
  });

  for (const p of pieces) {
    const a = p.chars[0], b = p.chars[p.chars.length - 1];
    p.cx = (a.x + b.x + b.w) / 2;
    p.w = b.x + b.w - a.x;
  }
  return { pieces, glyphs, count: n };
}

export function drawTextClip(ctx, clip, W, H, t, alpha) {
  const s = clip.text;
  if (!s) return;
  const m = measureText(ctx, clip, W, H, t);
  const S = shortEdge(W, H);

  const x = evalProp(clip, 'transform.x', t) * W;
  const y = evalProp(clip, 'transform.y', t) * H;
  const scale = evalProp(clip, 'transform.scale', t);
  const rot = evalProp(clip, 'transform.rotation', t) * Math.PI / 180;

  const inKind = s.anim || 'none';
  const outKind = s.animOut || 'none';
  const loopKind = s.animLoop || 'none';
  const unit = s.animUnit === 'word' || s.animUnit === 'letter' ? s.animUnit : 'all';
  const typing = inKind === 'type' || outKind === 'type';
  const inDur = Math.max(0.05, s.animDur || 0.35);
  const outDur = Math.max(0.05, s.animOutDur || 0.35);
  const spread = clamp01(s.animSpread ?? 0.35);
  const end = clip.start + clip.duration;
  const tt = Math.max(0, t - clip.start);

  const gIn = inKind === 'none' ? 1 : clamp01((t - clip.start) / inDur);
  const gOut = outKind === 'none' ? 1 : clamp01((end - t) / outDur);

  /* Auto-captions: each word knows when it is said (seconds into the clip),
     and the one being said right now lights up and pops. */
  const spoken = Array.isArray(s.words) && s.words.length > 0 && !typing;
  const live = spoken ? s.words.findIndex(w => tt >= w.s && tt < w.e) : -1;
  /* Keywords ("kill", "clutch", numbers…) marked by the captioner: bigger and coloured. */
  const keys = spoken && Array.isArray(s.keys) && s.keys.length ? new Set(s.keys) : null;
  /* Caption animation for the words as they are said (see WORD_ANIMS), and
     styles you gave single words (colour, size, emoji, shake). */
  const wordAnim = spoken ? (s.wordAnim || 'none') : 'none';
  const wstyle = spoken && s.wordStyle && typeof s.wordStyle === 'object' ? s.wordStyle : null;
  const perPiece = unit !== 'all' || typing || spoken;
  // Spoken captions get a little more room between words: the said word pops
  // and keywords are coloured, and a thick outline eats into a plain space.
  const lay = perPiece ? layout(ctx, m, s, typing ? 'letter' : spoken ? 'word' : unit, spoken ? (s.wordGap ?? 0.14) * m.px : 0) : null;

  /** What the block, or one piece of it, is doing right now. */
  const motionOf = (idx, count, whole) => {
    let mv = { ...REST };
    const seed = idx * 13 + 1;
    const w = whole ? m.width : (lay?.pieces[idx]?.w ?? m.width);
    if (inKind !== 'none' && inKind !== 'type') {
      const step = count > 1 ? (spread * 2 * inDur) / (count - 1) : 0;
      const p = clamp01((t - clip.start - idx * step) / inDur);
      if (p < 1) mv = combine(mv, move(inKind, p, m.lineH, w, seed));
    }
    if (outKind !== 'none' && outKind !== 'type') {
      const step = count > 1 ? (spread * 2 * outDur) / (count - 1) : 0;
      const p = clamp01((end - t - (count - 1 - idx) * step) / outDur);
      if (p < 1) mv = combine(mv, move(outKind, p, m.lineH, w, seed + 5));
    }
    if (loopKind !== 'none') mv = combine(mv, loopMove(loopKind, tt, perPiece && !whole ? idx : 0, m.lineH));
    return mv;
  };

  /* One move for the whole block, plate included — or none, when the pieces carry their own. */
  const group = perPiece ? { ...REST } : motionOf(0, 1, true);
  let plateA = 1;
  if (perPiece) {
    plateA = (inKind === 'none' ? 1 : easeOut(gIn)) * (outKind === 'none' ? 1 : easeOut(gOut));
    if (loopKind === 'flicker') plateA *= loopMove('flicker', tt, 0, m.lineH).a;
  }

  alpha *= group.a;
  if (alpha <= 0.002) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x + group.dx, y + group.dy);
  ctx.rotate(rot + rad(group.rot));
  ctx.scale(scale * group.s * group.sx, scale * group.s);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  if (!perPiece && group.wipe < 1) {           // a wipe uncovers the block left to right
    ctx.beginPath();
    ctx.rect(-m.width / 2 - m.px, -m.height / 2 - m.px, (m.width + m.px * 2) * group.wipe, m.height + m.px * 2);
    ctx.clip();
  }

  /* ── Plate ─────────────────────────────────────────────────── */
  const bg = plateKind(s);
  if (bg !== 'none' && m.lines.some(l => l.length) && plateA > 0.002) {
    const pad = (s.bgPad || 0) * S;
    const bw = m.width + pad * 2;
    const bh = m.height + pad * 1.4;
    const r = bg === 'pill' ? bh / 2 : Math.min(bh / 2, (s.bgRadius ?? 0.25) * bh);
    ctx.save();
    ctx.globalAlpha = alpha * plateA;
    ctx.fillStyle = s.bgColor || '#000000cc';
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, r);
    ctx.fill();
    ctx.restore();
  }

  const top = -m.height / 2 + m.lineH / 2;
  const sp = (s.letterSpacing || 0) * m.px;
  const strokeW = evalProp(clip, 'text.strokeWidth', t) * m.px;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const typed = typing ? typedCount(clip, t, lay, inKind, outKind, inDur, outDur, end) : Infinity;

  /**
   * Run `fn(str, x, y, info)` once for everything on screen.
   *
   * With no pieces that is the lines, drawn whole. With pieces it is each in
   * turn, wrapped in its own move — so glow, shadow, outline and fill all
   * follow a flying letter without any of them knowing it is flying.
   */
  const paint = (fn, onPiece = null) => {
    if (!lay) {
      m.lines.forEach((line, i) => fn(line, alignOffset(s.align, m, lineWidth(ctx, line, sp)), top + i * m.lineH, null));
      return;
    }
    for (const piece of lay.pieces) {
      if (typing && piece.chars[0].gi >= typed) continue;
      let mv = motionOf(piece.idx, Math.max(1, lay.count), false);
      if (wordAnim !== 'none') mv = wordMove(wordAnim, mv, s.words[piece.idx], tt, m.lineH);
      if (piece.idx === live && wordAnim !== 'karaoke') mv = { ...mv, s: mv.s * (s.hiPop ?? 1.12) };
      if (keys && keys.has(piece.idx)) mv = { ...mv, s: mv.s * (s.keyPop ?? 1) };
      const ws = wstyle?.[piece.idx];
      if (ws) {
        if (ws.scale && ws.scale !== 1) mv = { ...mv, s: mv.s * ws.scale };
        // Shake: while the word is being said and a moment after.
        if (ws.shake) {
          const w = s.words[piece.idx];
          if (w && tt >= w.s - 0.02 && tt < w.e + 0.35) {
            const k = m.lineH * 0.07;
            mv = { ...mv, dx: mv.dx + Math.sin(tt * 91 + piece.idx) * k, dy: mv.dy + Math.cos(tt * 77 + piece.idx * 3) * k, rot: mv.rot + Math.sin(tt * 63) * 4 };
          }
        }
      }
      if (mv.a * alpha <= 0.002) continue;
      ctx.save();
      ctx.globalAlpha = alpha * mv.a;
      ctx.translate(piece.cx + mv.dx, piece.cy + mv.dy);
      ctx.rotate(rad(mv.rot));
      ctx.scale(mv.s * mv.sx, mv.s);
      if (mv.wipe < 1) {
        ctx.beginPath();
        ctx.rect(-piece.w / 2 - m.px * 0.2, -m.lineH, (piece.w + m.px * 0.4) * mv.wipe, m.lineH * 2);
        ctx.clip();
      }
      for (const g of piece.chars) {
        if (typing && g.gi >= typed) continue;
        fn(g.ch, g.x + g.w / 2 - piece.cx, 0, { piece, mv });
      }
      onPiece?.(piece, mv);
      ctx.restore();
    }
  };

  const drawOne = (str, gx, gy, mode, info) => {
    if (info) {
      ctx.textAlign = 'center';
      mode === 'fill' ? ctx.fillText(str, gx, gy) : ctx.strokeText(str, gx, gy);
    } else {
      drawLine(ctx, str, gx, gy, sp, mode);
    }
  };

  /* ── Highlight box: a plate behind the word being said, sliding
     from the word before to this one in a few frames. ─────────── */
  if (spoken && lay && live >= 0 && s.hiBox) {
    const cur = lay.pieces[live], prev = lay.pieces[live - 1];
    const w0 = s.words[live];
    const k = prev ? easeOut(clamp01((tt - w0.s) / 0.09)) : 1;
    const bx = prev ? prev.cx + (cur.cx - prev.cx) * k : cur.cx;
    const by = prev ? prev.cy + (cur.cy - prev.cy) * k : cur.cy;
    const bw = (prev ? prev.w + (cur.w - prev.w) * k : cur.w) * (s.hiPop ?? 1) + m.px * 0.36;
    const bh = m.lineH * 0.92;
    ctx.save();
    ctx.fillStyle = s.hiBox;
    roundRect(ctx, bx - bw / 2, by - bh / 2, bw, bh, bh * 0.22);
    ctx.fill();
    ctx.restore();
  }

  /* ── Glow ──────────────────────────────────────────────────────
     Its own pass, drawn beneath everything. Canvas shadows are cheap
     but weak, so the pass is repeated to build the intensity a neon
     caption needs without a blur filter anywhere near the frame. */
  const glow = evalProp(clip, 'text.glow', t);
  if (glow > 0) {
    ctx.save();
    ctx.shadowColor = s.glowColor || '#38bdf8';
    ctx.shadowBlur = glow * S;
    ctx.fillStyle = s.glowColor || '#38bdf8';
    for (let pass = 0; pass < 3; pass++) paint((str, gx, gy, info) => drawOne(str, gx, gy, 'fill', info));
    ctx.restore();
  }

  /* ── Shadow, carried by the stroke or the fill, never both ─── */
  const shadow = evalProp(clip, 'text.shadow', t);
  if (shadow > 0) {
    ctx.shadowColor = s.shadowColor || '#000';
    ctx.shadowBlur = shadow * S;
    ctx.shadowOffsetX = (s.shadowX || 0) * S;
    ctx.shadowOffsetY = (s.shadowY || 0) * S;
  }

  if (strokeW > 0) {
    ctx.lineWidth = strokeW * 2;         // half sits inside the glyph
    ctx.strokeStyle = s.strokeColor || '#000';
    paint((str, gx, gy, info) => drawOne(str, gx, gy, 'stroke', info));
    ctx.shadowBlur = 0;                  // the outline already cast it
    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  }

  const baseFill = fillStyle(ctx, s, m);
  const rainbow = loopKind === 'rainbow' && s.fill !== 'gradient';
  ctx.fillStyle = rainbow && !lay ? `hsl(${(tt * 120) % 360} 90% 62%)` : baseFill;
  const hi = s.hiColor || '#facc15';
  paint((str, gx, gy, info) => {
    const own = info && wstyle?.[info.piece.idx]?.color;
    const idx = info?.piece.idx;
    if (own) ctx.fillStyle = own;
    else if (info && keys && keys.has(idx) && (s.keyWins || idx !== live)) ctx.fillStyle = s.keyColor || hi;
    // Karaoke: words already said stay lit; the word being said fills left to right (below).
    else if (info && wordAnim === 'karaoke' && s.words[idx] && tt >= s.words[idx].e) ctx.fillStyle = hi;
    else if (info && idx === live && wordAnim !== 'karaoke') ctx.fillStyle = hi;
    else if (info && spoken && !rainbow && s.fill !== 'gradient') ctx.fillStyle = baseFill;
    else if (info && rainbow) ctx.fillStyle = `hsl(${info.mv.hue ?? 0} 90% 62%)`;
    else if (info && s.fill === 'gradient') ctx.fillStyle = gradientAt(ctx, s, m, info.piece.cx, info.piece.cy);
    drawOne(str, gx, gy, 'fill', info);
    if (info && !own && wordAnim === 'karaoke' && idx === live) {
      const w = s.words[idx];
      const p = clamp01((tt - w.s) / Math.max(0.05, w.e - w.s));
      const pw = info.piece.w;
      ctx.save();
      ctx.beginPath();
      // In the piece's own space: its left edge is at -w/2. This char sits at gx.
      ctx.rect(-pw / 2 - m.px * 0.1, -m.lineH, (pw + m.px * 0.2) * p, m.lineH * 2);
      ctx.clip();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = hi;
      drawOne(str, gx, gy, 'fill', info);
      ctx.restore();
    }
  }, (piece) => {
    // An emoji you put on a word sits just above it and moves with it.
    const e = wstyle?.[piece.idx]?.emoji;
    if (!e) return;
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.globalAlpha = Math.min(1, ctx.globalAlpha);
    ctx.font = `${Math.round(m.px * 0.95)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.fillText(e, 0, -m.lineH * 0.88);
    ctx.restore();
  });

  /* ── Typewriter cursor ─────────────────────────────────────────
     Blinks while the typing is happening and for a moment after, so a
     typed line reads as typed rather than as a slow fade. */
  if (typing && lay && s.typeCursor !== false) {
    const typingNow = (inKind === 'type' && gIn < 1) || (outKind === 'type' && gOut < 1);
    const lingering = inKind === 'type' && gIn >= 1 && tt < inDur + 0.8;
    if ((typingNow || lingering) && Math.floor(tt * 2.5) % 2 === 0) {
      const idx = Math.min(typed, lay.glyphs.length);
      const prev = lay.glyphs[idx - 1], next = lay.glyphs[idx];
      const cx = prev ? prev.x + prev.w : (next ? next.x : 0);
      const cy = prev ? prev.cy : (next ? next.cy : top);
      ctx.save();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = typeof baseFill === 'string' ? baseFill : (s.color || '#fff');
      ctx.fillRect(cx + m.px * 0.04, cy - m.lineH * 0.38, Math.max(2, m.px * 0.07), m.lineH * 0.76);
      ctx.restore();
    }
  }

  ctx.restore();
}

/* ── Caption animations: what each word does as it is said ───────
   Only for captions (text with word timings). Picked from tiles in the
   caption editor; the look's own colours still apply. */
export const WORD_ANIMS = [
  { id: 'none',    name: 'Highlight',  note: 'All the words show; the one being said lights up and pops' },
  { id: 'karaoke', name: 'Karaoke',    note: 'Colour sweeps through each word as it is said, and stays' },
  { id: 'bounce',  name: 'Bounce in',  note: 'Each word drops in with a bounce the moment it is said' },
  { id: 'rise',    name: 'Rise up',    note: 'Each word slides up and fades in as it is said' },
  { id: 'reveal',  name: 'Word by word', note: 'Each word appears exactly when it is said, no movement' },
  { id: 'punch',   name: 'Punch',      note: 'Each word slams in big and settles' },
];

/** The move for one word at clip time `tt`, given when it is said. */
function wordMove(kind, mv, w, tt, lineH) {
  if (!w) return mv;
  const since = tt - w.s;
  if (since < 0) return { ...mv, a: 0 };            // not said yet: not there
  if (kind === 'karaoke') return mv;
  if (kind === 'reveal') return mv;
  if (kind === 'bounce') {
    const d = 0.32;
    if (since >= d) return mv;
    const p = since / d;
    // A drop that overshoots and settles.
    const y = (1 - p) * (1 - p) * Math.cos(p * Math.PI * 2.5);
    return { ...mv, dy: mv.dy - y * lineH * 0.55, a: mv.a * Math.min(1, p * 4) };
  }
  if (kind === 'rise') {
    const d = 0.22;
    if (since >= d) return mv;
    const p = easeOut(since / d);
    return { ...mv, dy: mv.dy + (1 - p) * lineH * 0.45, a: mv.a * p };
  }
  if (kind === 'punch') {
    const d = 0.2;
    if (since >= d) return mv;
    const p = easeOut(since / d);
    return { ...mv, s: mv.s * (1.8 - 0.8 * p), a: mv.a * Math.min(1, since / 0.05) };
  }
  return mv;
}

/* ── helpers ──────────────────────────────────────────────────── */

/** How many characters of a typed line are showing — spaces count, they take a keystroke too. */
function typedCount(clip, t, lay, inKind, outKind, inDur, outDur, end) {
  const total = lay.glyphs.length;
  let n = total;
  if (inKind === 'type') n = Math.min(n, Math.ceil(total * clamp01((t - clip.start) / inDur)));
  if (outKind === 'type') n = Math.min(n, Math.ceil(total * clamp01((end - t) / outDur)));
  return n;
}

/**
 * Older clips said "no plate" by giving bgColor a fully transparent value.
 * Projects made before `bg` existed still have to open correctly, so the
 * absence of the field is read from the colour the way it used to be.
 */
function plateKind(s) {
  if (s.bg) return s.bg;
  const c = String(s.bgColor || '');
  return /^#[0-9a-f]{6}00$/i.test(c) || !c ? 'none' : 'box';
}

/** The gradient across the text's own box; `ox, oy` shift it for a piece that has moved its origin. */
function gradientAt(ctx, s, m, ox = 0, oy = 0) {
  const a = ((s.gradAngle ?? 90) * Math.PI) / 180;
  // Span the gradient across the text's own box, so it looks the same whatever
  // the words are — not across the whole frame, where short text gets a sliver.
  const r = Math.max(m.width, m.height) / 2;
  const g = ctx.createLinearGradient(
    -Math.cos(a) * r - ox, -Math.sin(a) * r - oy, Math.cos(a) * r - ox, Math.sin(a) * r - oy);
  g.addColorStop(0, s.color || '#ffffff');
  g.addColorStop(1, s.color2 || '#38bdf8');
  return g;
}

function fillStyle(ctx, s, m) {
  return s.fill !== 'gradient' ? (s.color || '#fff') : gradientAt(ctx, s, m);
}

function alignOffset(align, m, w) {
  if (align === 'left')  return -m.width / 2 + w / 2;
  if (align === 'right') return  m.width / 2 - w / 2;
  return 0;
}

function lineWidth(ctx, str, spacing) {
  if (!spacing) return ctx.measureText(str).width;
  let w = 0;
  for (const ch of str) w += ctx.measureText(ch).width + spacing;
  return w - spacing;
}

function drawLine(ctx, str, cx, cy, spacing, mode) {
  if (!spacing) { mode === 'fill' ? ctx.fillText(str, cx, cy) : ctx.strokeText(str, cx, cy); return; }
  let x = cx - lineWidth(ctx, str, spacing) / 2;
  ctx.textAlign = 'left';
  for (const ch of str) {
    mode === 'fill' ? ctx.fillText(ch, x, cy) : ctx.strokeText(ch, x, cy);
    x += ctx.measureText(ch).width + spacing;
  }
  ctx.textAlign = 'center';
}

function wrap(ctx, text, maxW, spacing) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (lineWidth(ctx, test, spacing) > maxW && line) { out.push(line); line = w; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
