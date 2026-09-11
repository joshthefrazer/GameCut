import { numField, row, group } from '../widgets/numeric-drag.js';
import { fontList, STOCK_FONTS } from '../../media/fonts.js';
import { bus } from '../../core/events.js';
import {
  TEXT_PRESETS, TEXT_ANIMS, TEXT_SWATCHES,
  savedLooks, saveLook, deleteLook, lookFrom,
} from '../../project/text-presets.js';

/**
 * Everything about making text look right.
 *
 * Built around one idea: the first thing you meet is a row of finished looks,
 * not a column of numbers. Click "Neon" and you have neon. Everything that
 * made it neon is underneath, in plain words, if you want to push it — and
 * once you have pushed it, "Save this look" puts it back in the row.
 *
 * The controls are named for what they do to the picture. "Outline", not
 * "stroke width". "Glow", not "shadow blur, centred". Numbers are 0-100
 * because nobody thinks in fractions of the frame's short edge, even though
 * that is what gets stored, because that is what survives a change of
 * resolution.
 */
export function buildTextPanel({ clip, root, store, cmds, comp, rerender }) {
  const s = clip.text;

  /* A live edit repaints immediately; the committed value is what undo sees. */
  const live = (key, v) => { s[key] = v; comp.render(); };
  const set = (key, v, label) =>
    cmds.setClipProp(clip.id, 'text.' + key, v, { merge: false, label: label || 'Text' });

  /* ── The words ─────────────────────────────────────────────── */
  const gW = group('Words');
  const ta = document.createElement('textarea');
  ta.className = 'txt-area';
  ta.value = s.text;
  ta.rows = 3;
  ta.spellcheck = false;
  ta.placeholder = 'Type here. Enter starts a new line.';
  ta.addEventListener('input', () => live('text', ta.value));
  ta.addEventListener('change', () => set('text', ta.value, 'Edit text'));
  // The editor's single-key shortcuts must not fire while typing words.
  ta.addEventListener('keydown', e => e.stopPropagation());
  const wide = document.createElement('div');
  wide.className = 'row row--wide';
  wide.appendChild(ta);
  gW.body.appendChild(wide);
  root.appendChild(gW);

  /* ── Looks ─────────────────────────────────────────────────── */
  const gL = group('Looks');
  const gallery = document.createElement('div');
  gallery.className = 'looks';
  gL.body.appendChild(gallery);

  const applyLook = (style, name) => {
    cmds.setClipProp(clip.id, 'text', { ...s, ...style },
      { merge: false, label: `Look: ${name}` });
    comp.render();
    rerender();
    bus.emit('toast', { msg: `${name} applied — tweak anything below` });
  };

  const paintGallery = () => {
    gallery.innerHTML = '';
    const mine = savedLooks();
    for (const p of [...mine, ...TEXT_PRESETS]) {
      const b = document.createElement('button');
      b.className = 'look';
      b.title = p.note || (p.own ? 'Your saved look' : p.name);
      // A tiny rendering of the look itself, so the button shows what it does.
      const st = { ...s, ...p.style };
      const chip = document.createElement('span');
      chip.className = 'look__chip';
      chip.textContent = 'Aa';
      Object.assign(chip.style, previewStyle(st));
      b.appendChild(chip);
      const cap = document.createElement('span');
      cap.className = 'look__name';
      cap.textContent = p.name;
      b.appendChild(cap);
      b.addEventListener('click', () => applyLook(p.style, p.name));

      if (p.own) {
        const del = document.createElement('i');
        del.className = 'look__x';
        del.textContent = '×';
        del.title = 'Delete this look';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteLook(p.id);
          paintGallery();
        });
        b.appendChild(del);
      }
      gallery.appendChild(b);
    }
  };
  paintGallery();

  const save = document.createElement('button');
  save.className = 'fontdrop';
  save.textContent = 'Save this look';
  save.addEventListener('click', () => {
    const name = prompt('Name this look', 'My look');
    if (!name) return;
    saveLook(name, lookFrom(s));
    paintGallery();
    bus.emit('toast', { msg: `Saved "${name}" — it's in Looks now`, kind: 'ok' });
  });
  const saveRow = document.createElement('div');
  saveRow.className = 'row row--wide';
  saveRow.appendChild(save);
  gL.body.appendChild(saveRow);
  root.appendChild(gL);

  /* ── Entrance ──────────────────────────────────────────────── */
  const gA = group('Entrance');
  const anims = document.createElement('div');
  anims.className = 'chips';
  for (const a of TEXT_ANIMS) {
    const b = document.createElement('button');
    b.className = 'chip-btn' + ((s.anim || 'none') === a.id ? ' is-on' : '');
    b.textContent = a.name;
    b.addEventListener('click', () => { set('anim', a.id, 'Entrance'); comp.render(); rerender(); });
    anims.appendChild(b);
  }
  gA.body.appendChild(row('How it arrives', anims));
  if ((s.anim || 'none') !== 'none') {
    gA.body.appendChild(row('How long',
      numField({ value: s.animDur ?? 0.35, min: 0.05, max: 5, step: .05, decimals: 2, suffix: 's',
        onInput: v => live('animDur', v),
        onCommit: v => set('animDur', v, 'Entrance length') })));
  }
  root.appendChild(gA);

  /* ── Font ──────────────────────────────────────────────────── */
  const gF = group('Font');
  const fs = document.createElement('select');
  fs.className = 'sel';
  const fillFonts = () => {
    fs.innerHTML = '';
    for (const f of fontList()) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = STOCK_FONTS.includes(f) ? f : `${f} (yours)`;
      o.selected = s.font === f;
      fs.appendChild(o);
    }
  };
  fillFonts();
  bus.on('fonts', fillFonts);
  fs.addEventListener('change', () => { set('font', fs.value, 'Font'); comp.render(); });
  gF.body.appendChild(row('Typeface', fs));

  const up = document.createElement('button');
  up.className = 'fontdrop';
  up.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M5 18v2h14v-2"/></svg> Use a font from my computer`;
  up.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.ttf,.otf,.woff,.woff2';
    inp.onchange = async () => {
      const { importFiles } = await import('../../media/importer.js');
      const [a] = await importFiles(inp.files);
      if (a?.family) {
        set('font', a.family, 'Font');
        fillFonts(); fs.value = a.family;
        comp.render();
      }
    };
    inp.click();
  });
  const upRow = document.createElement('div');
  upRow.className = 'row row--wide';
  upRow.appendChild(up);
  gF.body.appendChild(upRow);

  gF.body.appendChild(row('Size', pct('size', 4, 40, 'Size')));

  const weight = document.createElement('select');
  weight.className = 'sel';
  for (const [w, label] of [[300, 'Light'], [400, 'Regular'], [600, 'Medium'],
                            [700, 'Bold'], [800, 'Heavy'], [900, 'Black']]) {
    const o = document.createElement('option');
    o.value = w; o.textContent = label; o.selected = s.weight === w;
    weight.appendChild(o);
  }
  weight.addEventListener('change', () => { set('weight', +weight.value, 'Weight'); comp.render(); });
  gF.body.appendChild(row('Thickness', weight));

  const align = document.createElement('div');
  align.className = 'chips';
  for (const [a, label] of [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]) {
    const b = document.createElement('button');
    b.className = 'chip-btn' + (s.align === a ? ' is-on' : '');
    b.textContent = label;
    b.addEventListener('click', () => { set('align', a, 'Align'); comp.render(); rerender(); });
    align.appendChild(b);
  }
  gF.body.appendChild(row('Lines sit', align));

  gF.body.appendChild(row('Letter gap',
    numField({ value: (s.letterSpacing || 0) * 1000, min: -50, max: 200, step: 1, decimals: 0,
      onInput: v => live('letterSpacing', v / 1000),
      onCommit: v => set('letterSpacing', v / 1000, 'Letter gap') }),
    numField({ label: 'line', value: s.lineHeight ?? 1.12, min: .6, max: 3, step: .02, decimals: 2,
      onInput: v => live('lineHeight', v),
      onCommit: v => set('lineHeight', v, 'Line spacing') })));
  root.appendChild(gF);

  /* ── Colour ────────────────────────────────────────────────── */
  const gC = group('Colour');

  const fillMode = document.createElement('div');
  fillMode.className = 'chips';
  for (const [id, label] of [['solid', 'One colour'], ['gradient', 'Fade between two']]) {
    const b = document.createElement('button');
    b.className = 'chip-btn' + ((s.fill || 'solid') === id ? ' is-on' : '');
    b.textContent = label;
    b.addEventListener('click', () => { set('fill', id, 'Fill'); comp.render(); rerender(); });
    fillMode.appendChild(b);
  }
  gC.body.appendChild(row('Fill', fillMode));

  gC.body.appendChild(swatchRow(s.fill === 'gradient' ? 'From' : 'Colour', 'color'));
  if (s.fill === 'gradient') {
    gC.body.appendChild(swatchRow('To', 'color2'));
    gC.body.appendChild(row('Direction',
      numField({ value: s.gradAngle ?? 90, min: 0, max: 360, step: 5, decimals: 0, suffix: '°',
        onInput: v => live('gradAngle', v),
        onCommit: v => set('gradAngle', v, 'Gradient angle') })));
  }
  root.appendChild(gC);

  /* ── Edges ─────────────────────────────────────────────────── */
  const gE = group('Outline & glow', false);
  gE.body.appendChild(row('Outline', pct('strokeWidth', 0, 12, 'Outline'), colorInput('strokeColor')));
  gE.body.appendChild(row('Glow', pct('glow', 0, 12, 'Glow'), colorInput('glowColor')));
  gE.body.appendChild(row('Shadow', pct('shadow', 0, 12, 'Shadow'), colorInput('shadowColor')));
  gE.body.appendChild(row('Shadow drop',
    numField({ value: (s.shadowY || 0) * 100, min: -20, max: 20, step: .2, decimals: 1,
      onInput: v => live('shadowY', v / 100),
      onCommit: v => set('shadowY', v / 100, 'Shadow drop') })));
  root.appendChild(gE);

  /* ── Plate ─────────────────────────────────────────────────── */
  const gB = group('Background plate', false);
  const bgMode = document.createElement('div');
  bgMode.className = 'chips';
  for (const [id, label] of [['none', 'None'], ['box', 'Box'], ['pill', 'Pill']]) {
    const b = document.createElement('button');
    b.className = 'chip-btn' + ((s.bg || 'none') === id ? ' is-on' : '');
    b.textContent = label;
    b.addEventListener('click', () => { set('bg', id, 'Plate'); comp.render(); rerender(); });
    bgMode.appendChild(b);
  }
  gB.body.appendChild(row('Shape', bgMode));
  if ((s.bg || 'none') !== 'none') {
    gB.body.appendChild(swatchRow('Plate colour', 'bgColor'));
    gB.body.appendChild(row('Padding', pct('bgPad', 0, 12, 'Padding')));
    if (s.bg === 'box') {
      gB.body.appendChild(row('Corner round',
        numField({ value: (s.bgRadius ?? .25) * 100, min: 0, max: 50, step: 1, decimals: 0,
          onInput: v => live('bgRadius', v / 100),
          onCommit: v => set('bgRadius', v / 100, 'Corners') })));
    }
  }
  root.appendChild(gB);

  /* ── Layering ──────────────────────────────────────────────── */
  const gZ = group('Put it behind things', false);
  const help = document.createElement('p');
  help.className = 'insp__help';
  help.innerHTML =
    `Text sits on top of whatever is on the tracks below it. <b>Send down</b>
     moves this text under the track beneath, so footage there covers it.
     <br><br>To get text behind a <b>character</b>: park the playhead on the
     shot, press <b>C</b> and draw a box around the character. That becomes its
     own layer on top — put the text below it and the character covers the
     words. It is a rectangle, so it works best when the background behind the
     character is fairly plain.`;
  gZ.body.appendChild(help);

  const zRow = document.createElement('div');
  zRow.className = 'row row--wide';
  for (const [label, dir] of [['Send down', 1], ['Bring up', -1]]) {
    const b = document.createElement('button');
    b.className = 'fontdrop';
    b.textContent = label;
    b.addEventListener('click', () => {
      const moved = cmds.moveClipLayer(clip.id, dir);
      bus.emit('toast', {
        msg: moved ? `Moved ${dir > 0 ? 'down' : 'up'} a track`
                   : `Already at the ${dir > 0 ? 'bottom' : 'top'}`,
      });
      comp.render();
    });
    zRow.appendChild(b);
  }
  gZ.body.appendChild(zRow);
  root.appendChild(gZ);

  /* ── little builders ───────────────────────────────────────── */

  /**
   * A 0..100 control over a value stored as a fraction of the frame.
   * The stored form is what survives a resolution change; the shown form is
   * what a person can reason about.
   */
  function pct(key, min, max, label) {
    return numField({
      value: (s[key] || 0) * 100, min, max, step: .2, decimals: 1,
      onInput: v => live(key, v / 100),
      onCommit: v => set(key, v / 100, label),
    });
  }

  function colorInput(key) {
    const el = document.createElement('input');
    el.type = 'color';
    el.className = 'swatch';
    // A colour input cannot hold alpha, so show the opaque part of #rrggbbaa.
    el.value = String(s[key] || '#000000').slice(0, 7);
    el.addEventListener('input', () => live(key, el.value));
    el.addEventListener('change', () => set(key, el.value, 'Colour'));
    return el;
  }

  function swatchRow(label, key) {
    const holder = document.createElement('div');
    holder.className = 'swatches';
    for (const c of TEXT_SWATCHES) {
      const b = document.createElement('button');
      b.className = 'sw' + (String(s[key] || '').toLowerCase().startsWith(c) ? ' is-on' : '');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => { set(key, c, 'Colour'); comp.render(); rerender(); });
      holder.appendChild(b);
    }
    holder.appendChild(colorInput(key));
    return row(label, holder);
  }
}

/** CSS that approximates a text style, for the little Aa on a look button. */
function previewStyle(st) {
  const out = {
    // Always a fallback: a look naming a font this machine does not have
    // (Impact is not on Linux, for one) otherwise renders the chip as the
    // browser's default serif and the button looks broken rather than plain.
    fontFamily: `"${st.font}", "Inter", system-ui, sans-serif`,
    fontWeight: st.weight,
    color: st.fill === 'gradient' ? 'transparent' : (st.color || '#fff'),
  };
  if (st.fill === 'gradient') {
    out.backgroundImage = `linear-gradient(${st.gradAngle ?? 90}deg, ${st.color}, ${st.color2})`;
    out.webkitBackgroundClip = 'text';
    out.backgroundClip = 'text';
  }
  if (st.strokeWidth > 0) out.webkitTextStroke = `${Math.min(3, st.strokeWidth * 40)}px ${st.strokeColor}`;
  // Static box-shadow, never a filter: a glow that had to be re-rasterized on
  // every frame is the mistake this project already paid for once.
  if (st.glow > 0) out.textShadow = `0 0 ${Math.min(14, st.glow * 200)}px ${st.glowColor}`;
  if ((st.bg || 'none') !== 'none') {
    out.background = st.bgColor;
    out.borderRadius = st.bg === 'pill' ? '999px' : '5px';
    out.padding = '1px 7px';
    if (st.fill === 'gradient') { out.backgroundImage = 'none'; out.color = st.color; }
  }
  return out;
}
