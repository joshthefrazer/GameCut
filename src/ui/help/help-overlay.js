/**
 * The help sheet.
 *
 * One place that answers "what does this button do" and "what is the key for
 * that", written in the words someone editing a Minecraft clip would use rather
 * than the words an NLE manual would. It is searchable because a list this long
 * is only useful if you can get to your line of it in two seconds.
 *
 * The tool descriptions come from the same table the hover tips use, so there
 * is no second copy to fall out of date.
 */
import { TIPS } from './tips.js';

/** Plain-language walkthrough, shown first because it is what a new user needs. */
const STEPS = [
  ['Bring your footage in',
   'Click Import (or press Ctrl+I) and pick your recordings, music and images. They appear in the Media panel on the left. Strike only remembers where the files are — it never copies or moves them, so your recordings folder stays exactly as it was.'],
  ['Put it on the timeline',
   'The first recording you import goes straight onto the timeline (and a song onto the music lane). After that, hover a tile in the Media panel and click the +, double-click it, or drag it where you want it. Videos go on the main video track; pictures land on a layer above the footage so they are never hidden under it.'],
  ['Cut it down',
   'Move the playhead to where you want a cut (the arrow keys step one frame) and press S. Drag the ends of a clip to trim it. Select the piece you do not want and press Delete — Ripple is on to start with, so the clips after it slide back and no gap is left. Pressed something by mistake? Every edit shows an Undo button for a few seconds.'],
  ['Make it look right',
   'Select a clip and use the Inspector on the right: position, scale, speed, fades. Press T for a text layer. Press C to open the crop room — a big, zoomable view of the frame where you can drag a box or paint the exact shape you want with a brush.'],
  ['Join your shots',
   'Where two clips meet on a track, a small ⋈ button appears on the join. Click it, then pick a tile in the Transitions panel on the left — Dissolve, Dip to black, or a Slide. The transition sits across the cut, half either side, and you can set how long it takes.'],
  ['Export it',
   'Click Export, choose a size and quality, and Strike writes an MP4. Your footage never leaves your computer — the editor has no network access at all.'],
  ['Keep it up to date',
   'The version number in the top bar is a button. New versions download quietly in the background and wait there until you install them, and the same panel keeps the log of everything that has ever changed. The only thing Strike ever fetches is that one small file; nothing about your projects is ever sent anywhere.'],
];

const GROUPS = [
  { title: 'Top bar',  ids: ['btnSearch', 'btnImport', 'btnExport', 'btnUndo', 'btnRedo', 'btnHistory', 'saveChip', 'btnVersions', 'btnHome', 'btnSettings', 'projName', 'verChip'] },
  { title: 'Preview',  ids: ['btnCrop', 'tglGuides', 'tglGrid', 'tglSnap', 'btnCompare', 'aspectSeg', 'previewQuality', 'fpsChip', 'btnSnapshot', 'btnFullscreen'] },
  { title: 'Playing',  ids: ['btnPlay', 'btnStart', 'btnEnd', 'btnPrevFrame', 'btnNextFrame', 'btnLoop', 'btnMute', 'masterVol'] },
  { title: 'Timeline', ids: ['btnToolSelect', 'btnToolRazor', 'btnToolHand', 'btnSplit', 'btnDelete', 'btnDuplicate', 'btnAddText', 'btnMarker', 'btnAddLane', 'btnRipple', 'btnMagnet', 'btnCloseGaps', 'btnTrackSize', 'btnZoomFit', 'zoomRange', 'tlOverview'] },
  { title: 'Music',    ids: ['btnBeatGrid', 'bpmInput', 'btnTapTempo'] },
  { title: 'Panels',   ids: ['tabMedia', 'tabText', 'tabGfx', 'tabTrans', 'tabFx'] },
];

const KEYS = [
  ['Space', 'Play / pause'],
  ['← →', 'Playhead one frame back / forward'],
  ['Shift + ← →', 'Playhead one second back / forward'],
  ['Alt + ← →', 'Move the selected clips a frame (add Shift for a second)'],
  ['Home / End', 'Jump to the start / the end'],
  ['↑ / ↓', 'Jump to the previous / next cut'],
  ['Shift + Delete', 'Delete and close the gap'],
  ['Ctrl + H', 'History: go back to any step'],
  ['Ctrl + Shift + S', 'Save this frame as a picture'],
  ['Ctrl + ,', 'Settings'],
  ['S', 'Split at the playhead'],
  ['T', 'Add a text layer'],
  ['C', 'Crop tool'],
  ['Shift + C', 'Caption editor: fix words, colour or enlarge a word, add an emoji, split and join lines'],
  ['Shift + F', 'Freeze frame: pause the video on this frame for 2 seconds'],
  ['Z', 'Punch-in zoom at the playhead'],
  ['Ctrl + K', 'Find any action, clip or media by typing'],
  ['Enter', 'Type on a selected title, right on the picture'],
  ['M', 'Add a marker'],
  ['[ / ]', 'Jump to the previous / next marker'],
  ['Ctrl + I', 'Import media'],
  ['I / O', 'Mark In / Out at the playhead (export, loop, Lift and Extract can use it)'],
  ['Shift + I / O', 'Jump to In / Out'],
  ['Alt + X', 'Clear In and Out'],
  ['J / K / L', 'Play backwards / stop / play forwards (press J or L again to go faster)'],
  [', / .', 'One frame back / forward'],
  ['Alt + [ / ]', 'Trim the start / end of the clip at the playhead to the playhead'],
  ['Alt + , / .', 'Slip: show an earlier / later part of the recording inside the selected clip (Shift: 10 frames)'],
  ['Ctrl + G', 'Go to a time you type (1:23, 83, 2m5s, +2)'],
  ['N', 'Snap on / off'],
  ['V / B / H', 'Select tool / Razor tool / Hand tool'],
  ['Shift + B', 'Beat sync on / off'],
  ['Shift + L', 'Loop on / off (loops In to Out when both are set)'],
  ['F', 'Fullscreen preview'],
  ['Delete', 'Remove what is selected'],
  ['Esc', 'Deselect everything / close this sheet / leave the crop room'],
  ['Ctrl + S', 'Save the project now'],
  ['Ctrl + Z', 'Undo'],
  ['Ctrl + Shift + Z', 'Redo'],
  ['Ctrl + D', 'Duplicate'],
  ['Ctrl + Alt + C / V', 'Copy a clip’s look / paste it onto the selected clips'],
  ['Ctrl + A', 'Select every clip'],
  ['Ctrl + Alt + Shift + V', 'Paste only some parts of a look'],
  ['Shift + M', 'Markers list: notes, colours, jump'],
  ['Alt + 1 to 9', 'Switch workspace'],
  ['Scroll', 'Up and down the tracks (along the timeline when they all fit)'],
  ['Shift + scroll', 'Along the timeline'],
  ['Ctrl + scroll', 'Zoom the timeline under the pointer'],
  ['Shift + Z', 'Zoom to fit the whole project'],
  ['Alt + drag', 'Move a clip without snapping'],
  ['Shift + drag', 'Keep a clip on its own track'],
  ['Right-click a clip', 'Everything you can do to it, in one menu'],
  ['Right-click a gap', 'Close the gap'],
  ['Right-click a track name', 'Delete the track'],
];

export function initHelp() {
  const el = document.createElement('div');
  el.className = 'help';
  el.id = 'helpSheet';
  el.hidden = true;
  el.innerHTML = `
    <div class="help__card" role="dialog" aria-modal="true" aria-label="Strike help">
      <header class="help__top">
        <b>How Strike works</b>
        <input class="help__find" id="helpFind" type="search" placeholder="Search — try &quot;crop&quot; or &quot;beat&quot;" spellcheck="false">
        <button class="help__x" id="helpClose" aria-label="Close help">✕</button>
      </header>
      <div class="help__body" id="helpBody"></div>
    </div>`;
  document.body.appendChild(el);

  const body = el.querySelector('#helpBody');
  const find = el.querySelector('#helpFind');

  /* ── Build once; searching hides rows rather than rebuilding ── */
  const sec = (title, cls = '') => {
    const s = document.createElement('section');
    s.className = 'help__sec ' + cls;
    s.innerHTML = `<h3>${title}</h3>`;
    body.appendChild(s);
    return s;
  };

  const start = sec('Start here', 'help__sec--steps');
  STEPS.forEach(([h, d], i) => {
    const r = document.createElement('div');
    r.className = 'help__step';
    r.innerHTML = `<i>${i + 1}</i><div><b></b><span></span></div>`;
    r.querySelector('b').textContent = h;
    r.querySelector('span').textContent = d;
    start.appendChild(r);
  });

  for (const g of GROUPS) {
    const s = sec(g.title);
    for (const id of g.ids) {
      const tip = TIPS[id];
      if (!tip) continue;
      const r = document.createElement('div');
      r.className = 'help__row';
      const h = document.createElement('b');
      h.textContent = tip.t;
      if (tip.k) {
        const k = document.createElement('kbd');
        k.textContent = tip.k;
        h.appendChild(k);
      }
      const p = document.createElement('span');
      p.textContent = tip.d;
      r.append(h, p);
      s.appendChild(r);
    }
  }

  const ks = sec('Every keyboard shortcut', 'help__sec--keys');
  for (const [k, d] of KEYS) {
    const r = document.createElement('div');
    r.className = 'help__row help__row--key';
    const b = document.createElement('kbd');
    b.textContent = k;
    const p = document.createElement('span');
    p.textContent = d;
    r.append(b, p);
    ks.appendChild(r);
  }

  const none = document.createElement('p');
  none.className = 'help__none';
  none.textContent = 'Nothing matches that.';
  none.hidden = true;
  body.appendChild(none);

  /* ── Search ───────────────────────────────────────────────── */
  find.addEventListener('input', () => {
    const q = find.value.trim().toLowerCase();
    let hits = 0;
    for (const s of body.querySelectorAll('.help__sec')) {
      let shown = 0;
      for (const r of s.querySelectorAll('.help__row, .help__step')) {
        const on = !q || r.textContent.toLowerCase().includes(q);
        r.hidden = !on;
        if (on) shown++;
      }
      s.hidden = shown === 0;
      hits += shown;
    }
    none.hidden = hits > 0;
  });
  find.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { find.value = ''; find.dispatchEvent(new Event('input')); close(); }
  });

  /* ── Open / close ─────────────────────────────────────────── */
  function open() {
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-on'));
    find.value = '';
    find.dispatchEvent(new Event('input'));
    body.scrollTop = 0;
    setTimeout(() => find.focus(), 60);
  }
  function close() {
    el.classList.remove('is-on');
    setTimeout(() => { el.hidden = true; }, 180);
  }
  const toggle = () => (el.hidden ? open() : close());

  /**
   * Esc closes the sheet whatever has focus.
   *
   * It used to listen only on the search box, so after one click anywhere on
   * the sheet (scrolling it, selecting a line) Esc did nothing here — and went
   * on to the editor underneath instead, deselecting clips you could not see.
   * Captured on the window, and stopped, so it is the sheet's key alone.
   */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el.hidden || !el.classList.contains('is-on')) return;
    e.preventDefault();
    e.stopPropagation();
    find.value = '';
    find.dispatchEvent(new Event('input'));
    close();
  }, true);

  el.querySelector('#helpClose').addEventListener('click', close);
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  document.getElementById('btnHelp')?.addEventListener('click', toggle);
  document.getElementById('homeHelp')?.addEventListener('click', toggle);

  return { open, close, toggle, el };
}
