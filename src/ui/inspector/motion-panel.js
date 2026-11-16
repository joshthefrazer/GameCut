import { TEXT_IN, TEXT_OUT, TEXT_LOOPS, TEXT_UNITS } from '../../project/text-presets.js';
import { defaultMotion } from '../../engine/motion.js';
import { group, numField, row } from '../widgets/numeric-drag.js';

/**
 * The Motion tab: how a clip arrives, what it does while it is on screen, and
 * how it leaves — for text, footage, stills, logos and shapes alike.
 *
 * After Effects makes this a keyframe graph. Here it is three rows of tiles
 * that each show their move, a bar that shows the clip's life (arrive · on
 * screen · leave) with edges you drag to change how long each part takes, and
 * a row of one-click combos. Hovering a tile plays that move ON YOUR CLIP in
 * the preview, so you see what you are choosing before you choose it; clicking
 * keeps it. Every choice is one undo step.
 *
 * Text keeps its motion in `clip.text` (it can also move word by word or
 * letter by letter); everything else in `clip.motion`. Same five fields.
 */
const VISUAL_IN = TEXT_IN.filter(m => m.id !== 'type');
const VISUAL_OUT = TEXT_OUT.filter(m => m.id !== 'type');
const VISUAL_LOOPS = TEXT_LOOPS.filter(m => m.id !== 'wave');

export const COMBOS = [
  { id: 'popfade',  name: 'Pop & fade',    m: { anim: 'pop',    animOut: 'fade',   animLoop: 'none' } },
  { id: 'slam',     name: 'Slam it',       m: { anim: 'slam',   animOut: 'fade',   animLoop: 'none' } },
  { id: 'through',  name: 'Slide through', m: { anim: 'slideL', animOut: 'slideR', animLoop: 'none' } },
  { id: 'glitch',   name: 'Glitch in & out', m: { anim: 'glitch', animOut: 'glitch', animLoop: 'none' } },
  { id: 'bounce',   name: 'Drop & float',  m: { anim: 'drop',   animOut: 'fade',   animLoop: 'float' } },
  { id: 'hype',     name: 'Hype',          m: { anim: 'pop',    animOut: 'pop',    animLoop: 'pulse' } },
  { id: 'type',     name: 'Typewriter',    m: { anim: 'type',   animOut: 'type',   animLoop: 'none' }, text: true },
  { id: 'still',    name: 'No motion',     m: { anim: 'none',   animOut: 'none',   animLoop: 'none' } },
];

let current = null;

export function buildMotionPanel({ clip, root, store, cmds, comp, playback, rerender }) {
  current?.stop();
  const isText = clip.type === 'text';
  const M = () => (isText ? clip.text : (clip.motion || defaultMotion()));
  const m = M();
  const ins = isText ? TEXT_IN : VISUAL_IN;
  const outs = isText ? TEXT_OUT : VISUAL_OUT;
  const loops = isText ? TEXT_LOOPS : VISUAL_LOOPS;
  const inDur = () => M().animDur ?? (isText ? 0.35 : 0.5);
  const outDur = () => M().animOutDur ?? (isText ? 0.35 : 0.5);

  /** One undoable change to the motion fields. */
  const commit = (patch, label) => {
    if (isText) cmds.setClipProp(clip.id, 'text', { ...clip.text, ...patch }, { merge: false, label });
    else cmds.setClipProp(clip.id, 'motion', { ...defaultMotion(), ...(clip.motion || {}), ...patch }, { merge: false, label });
    comp.render();
    rerender();
  };

  /* ── The bar: arrive · on screen · leave ─────────────────────── */
  const gBar = group('This clip’s motion');
  const bar = document.createElement('div');
  bar.className = 'mbar';
  bar.id = 'motionBar';
  const segIn = document.createElement('div'); segIn.className = 'mbar__seg mbar__seg--in';
  const segHold = document.createElement('div'); segHold.className = 'mbar__seg mbar__seg--hold';
  const segOut = document.createElement('div'); segOut.className = 'mbar__seg mbar__seg--out';
  const hIn = document.createElement('i'); hIn.className = 'mbar__grip'; hIn.title = 'Drag to change how long it takes to arrive';
  const hOut = document.createElement('i'); hOut.className = 'mbar__grip'; hOut.title = 'Drag to change how long it takes to leave';
  bar.append(segIn, hIn, segHold, hOut, segOut);
  const nameOf = (list, id) => list.find(x => x.id === (id || 'none'))?.name || 'None';
  const paintBar = () => {
    const mm = M();
    const D = Math.max(0.1, clip.duration);
    const a = (mm.anim || 'none') !== 'none' ? Math.min(inDur(), D * 0.48) : 0;
    const o = (mm.animOut || 'none') !== 'none' ? Math.min(outDur(), D * 0.48) : 0;
    segIn.style.flexBasis = (a / D * 100) + '%';
    segOut.style.flexBasis = (o / D * 100) + '%';
    segIn.textContent = a ? nameOf(ins, mm.anim) : '';
    segOut.textContent = o ? nameOf(outs, mm.animOut) : '';
    segHold.textContent = (mm.animLoop || 'none') !== 'none' ? `${nameOf(loops, mm.animLoop)} while on screen` : 'On screen';
    hIn.hidden = !a; hOut.hidden = !o;
  };
  paintBar();
  const grip = (handle, key, sign) => handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const r = bar.getBoundingClientRect();
    const D = Math.max(0.1, clip.duration);
    const start = key === 'animDur' ? inDur() : outDur();
    const x0 = e.clientX;
    let v = start;
    const move = (ev) => {
      v = Math.max(0.05, Math.min(D * 0.48, start + sign * ((ev.clientX - x0) / r.width) * D));
      v = Math.round(v * 20) / 20;
      M()[key] = v;
      if (!isText && !clip.motion) clip.motion = { ...defaultMotion(), [key]: v };
      paintBar(); paintDur();
      comp.render();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      M()[key] = start;                            // so undo has a real "before"
      commit({ [key]: v }, key === 'animDur' ? 'Arrival length' : 'Exit length');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  grip(hIn, 'animDur', 1);
  grip(hOut, 'animOutDur', -1);
  gBar.body.appendChild(bar);

  // Lengths as numbers too, for anyone who would rather type.
  const durRow = document.createElement('div');
  durRow.className = 'mdur';
  const paintDur = () => {
    durRow.querySelector('[data-k="in"]')?.replaceChildren(document.createTextNode(`${inDur().toFixed(2)} s`));
    durRow.querySelector('[data-k="out"]')?.replaceChildren(document.createTextNode(`${outDur().toFixed(2)} s`));
  };
  const stepper = (label, key, k) => {
    const w = document.createElement('div');
    w.className = 'mdur__item';
    w.innerHTML = `<span>${label}</span><button class="mdur__b" data-d="-1" aria-label="${label} shorter">−</button><b data-k="${k}"></b><button class="mdur__b" data-d="1" aria-label="${label} longer">+</button>`;
    w.addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]');
      if (!b) return;
      const cur = key === 'animDur' ? inDur() : outDur();
      const v = Math.max(0.05, Math.min(5, Math.round((cur + 0.05 * +b.dataset.d) * 100) / 100));
      commit({ [key]: v }, key === 'animDur' ? 'Arrival length' : 'Exit length');
    });
    return w;
  };
  durRow.append(stepper('Arrive takes', 'animDur', 'in'), stepper('Leave takes', 'animOutDur', 'out'));
  gBar.body.appendChild(durRow);
  paintDur();

  const play = document.createElement('button');
  play.className = 'fontdrop';
  play.id = 'motionPlay';
  play.textContent = '▶  Play this clip from the start';
  play.addEventListener('click', () => {
    if (!playback) return;
    playback.pause?.();
    playback.seek?.(clip.start);
    playback.play?.();
  });
  gBar.body.appendChild(play);
  root.appendChild(gBar);

  /* ── One-click combos ──────────────────────────────────────── */
  const gC = group('One-click combos');
  const combos = document.createElement('div');
  combos.className = 'mcombos';
  for (const c of COMBOS) {
    if (c.text && !isText) continue;
    const b = document.createElement('button');
    b.className = 'chip-btn';
    b.dataset.combo = c.id;
    b.textContent = c.name;
    const cur = M();
    if ((cur.anim || 'none') === c.m.anim && (cur.animOut || 'none') === c.m.animOut && (cur.animLoop || 'none') === c.m.animLoop) b.classList.add('is-on');
    b.addEventListener('mouseenter', () => preview.start({ ...c.m }, 'all'));
    b.addEventListener('mouseleave', () => preview.stop());
    b.addEventListener('click', () => { preview.stop(); commit({ ...c.m }, `Motion: ${c.name}`); });
    combos.appendChild(b);
  }
  gC.body.appendChild(combos);
  root.appendChild(gC);

  /* ── Tiles ─────────────────────────────────────────────────── */
  const tiles = (title, list, key, phase) => {
    const g = group(title);
    const grid = document.createElement('div');
    grid.className = 'mtiles';
    grid.dataset.phase = phase;
    const cur = M()[key] || 'none';
    for (const it of list) {
      const b = document.createElement('button');
      b.className = 'mtile' + (cur === it.id ? ' is-on' : '');
      b.dataset.k = it.id;
      b.dataset.key = key;
      b.title = it.name;
      b.innerHTML = `<span class="mtile__stage"><span class="mtile__obj">${isText ? 'Aa' : ''}</span></span><span class="mtile__name">${it.name}</span>`;
      b.addEventListener('mouseenter', () => preview.start({ [key]: it.id }, phase));
      b.addEventListener('mouseleave', () => preview.stop());
      b.addEventListener('click', () => {
        preview.stop();
        commit({ [key]: it.id }, `${phase === 'in' ? 'Arrives' : phase === 'out' ? 'Leaves' : 'While on screen'}: ${it.name}`);
      });
      grid.appendChild(b);
    }
    g.body.appendChild(grid);
    root.appendChild(g);
  };
  tiles('1 · How it arrives', ins, 'anim', 'in');
  tiles('2 · How it leaves', outs, 'animOut', 'out');
  tiles('3 · While it is on screen', loops, 'animLoop', 'loop');

  /* ── Text: what moves as one piece ─────────────────────────── */
  if (isText) {
    const s = clip.text;
    const g = group('Text moves as');
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const u of TEXT_UNITS) {
      const b = document.createElement('button');
      b.className = 'chip-btn' + ((s.animUnit || 'all') === u.id ? ' is-on' : '');
      b.dataset.unit = u.id;
      b.textContent = u.name;
      b.addEventListener('mouseenter', () => preview.start({ animUnit: u.id }, 'in'));
      b.addEventListener('mouseleave', () => preview.stop());
      b.addEventListener('click', () => { preview.stop(); commit({ animUnit: u.id }, 'Motion unit'); });
      chips.appendChild(b);
    }
    g.body.appendChild(chips);
    if ((s.animUnit || 'all') !== 'all') {
      g.body.appendChild(row('Spread',
        numField({ value: Math.round((s.animSpread ?? 0.35) * 100), min: 0, max: 100, step: 1, decimals: 0, suffix: '%',
          onInput: v => { s.animSpread = v / 100; comp.render(); },
          onCommit: v => commit({ animSpread: v / 100 }, 'Spread') })));
    }
    if ((s.anim || 'none') === 'type' || (s.animOut || 'none') === 'type') {
      const cur = document.createElement('div');
      cur.className = 'chips';
      for (const [on, label] of [[true, 'Show cursor'], [false, 'No cursor']]) {
        const b = document.createElement('button');
        b.className = 'chip-btn' + ((s.typeCursor !== false) === on ? ' is-on' : '');
        b.textContent = label;
        b.addEventListener('click', () => commit({ typeCursor: on }, 'Cursor'));
        cur.appendChild(b);
      }
      g.body.appendChild(cur);
    }
    root.appendChild(g);
  }

  /* ── Live preview on the picture ───────────────────────────────
   * Plays the move on the real clip at the panel's own clock, in a loop,
   * while the pointer is over a tile. Nothing is written to the project. */
  const preview = (() => {
    let raf = 0, t0 = 0, phase = 'in', patch = null;
    const span = () => {
      const D = clip.duration;
      const mm = { ...M(), ...patch };
      const a = Math.min(mm.animDur ?? inDur(), D * 0.5);
      const o = Math.min(mm.animOutDur ?? outDur(), D * 0.5);
      if (phase === 'in') return [clip.start, clip.start + a + 0.5];
      if (phase === 'out') return [clip.start + D - o - 0.5, clip.start + D - 0.001];
      if (phase === 'all') return [clip.start, clip.start + Math.min(D, a + o + 1.4) - 0.001];
      return [clip.start, clip.start + D];
    };
    const tick = () => {
      // Playing takes the picture back: the preview never runs over playback.
      if (store.rt.playing || !root.isConnected) { stop(); return; }
      const [a, b] = span();
      const len = Math.max(0.2, b - a);
      const el = (performance.now() - t0) / 1000;
      let t;
      if (phase === 'all') {
        // Arrive, a beat on screen, then leave — squeezed into one loop.
        const D = clip.duration, mm = { ...M(), ...patch };
        const ai = Math.min(mm.animDur ?? inDur(), D * 0.5), ao = Math.min(mm.animOutDur ?? outDur(), D * 0.5);
        const cyc = ai + ao + 1.4;
        const k = el % cyc;
        t = k < ai + 0.7 ? clip.start + k : clip.start + D - (cyc - k);
      } else {
        t = a + (el % (len + 0.35));
        if (t > b) t = b;
      }
      comp.motionPreview = { clipId: clip.id, patch, t };
      comp.render(store.rt.playhead, false);
      raf = requestAnimationFrame(tick);
    };
    function stop() {
      cancelAnimationFrame(raf); raf = 0;
      if (comp.motionPreview) { comp.motionPreview = null; comp.render(store.rt.playhead, false); }
    }
    return {
      start(p, ph) {
        if (store.rt.playing) return;
        patch = p; phase = ph; t0 = performance.now();
        // The clip has to be on screen to be seen moving.
        const ph0 = store.rt.playhead;
        if (ph0 < clip.start || ph0 >= clip.start + clip.duration) playback?.seek?.(clip.start + clip.duration / 2);
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      },
      stop,
    };
  })();
  // A panel rebuilt mid-hover must not leave the picture stuck in a preview.
  current = { stop: () => preview.stop() };
  return current;
}
