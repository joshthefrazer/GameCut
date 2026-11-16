/**
 * Hover help.
 *
 * Every control in this app used to explain itself through a native `title`,
 * which is the worst tooltip available: it waits a second, it is one grey line
 * of unstyled text, it truncates, and it cannot say what the button is *for*.
 * An icon-only toolbar with that as its only documentation is a guessing game.
 *
 * So each control gets three short pieces instead — what it is called, what it
 * actually does in plain words, and the key that does the same thing — and the
 * same table feeds the help sheet, so the two can never drift apart.
 */
import { bus } from '../../core/events.js';

/** id → { t: name, d: what it does, k: shortcut } */
export const TIPS = {
  /* Top bar */
  btnUndo:      { t: 'Undo',            d: 'Step back one change. Everything you do is undoable, so try things.', k: 'Ctrl+Z' },
  btnRedo:      { t: 'Redo',            d: 'Put back a change you just undid.', k: 'Ctrl+Shift+Z' },
  btnHome:      { t: 'Projects',        d: 'Save this project and go back to the list of all your projects.' },
  btnImport:    { t: 'Import media',    d: 'Bring video, music or images in from your computer. They land in the Media panel on the left — nothing is copied or moved, Strike just remembers where the files are.', k: 'I' },
  btnExport:    { t: 'Export video',    d: 'Turn the timeline into a finished MP4 you can upload.' },
  saveChip:     { t: 'Save state',      d: 'Whether this project has unsaved changes. Strike saves on its own every half minute and again when you close the window — click here (or Ctrl+S) to save this second.', k: 'Ctrl+S' },
  verChip:      { t: 'Version and updates', d: 'Which version you are running. Click for updates, the log of everything that has changed, and a Check now button. New versions arrive on their own and wait until you install them.' },
  btnHelp:      { t: 'Help',            d: 'What every tool does, and every keyboard shortcut, on one sheet.', k: '?' },
  projName:     { t: 'Project name',    d: 'What this project is called on the projects screen. Type over it any time.' },
  btnSearch:    { t: 'Search everything', d: 'Type a few letters of anything you want to do — split, export, half speed, punch-in — or the words of a clip to jump to it. Every shortcut is listed beside its action.', k: 'Ctrl+K' },
  btnVersions:  { t: 'Version history', d: 'Go back to how this project looked earlier — a snapshot is kept every few minutes and before big automatic edits. Going back is itself undoable.' },
  aspectSeg:    { t: 'Shape of the video', d: '16:9 is YouTube. 9:16 is Shorts, TikTok and Reels. 1:1 and 4:5 are for feed posts. Changing it reframes every clip rather than cropping them.' },

  /* Preview */
  tglGuides:    { t: 'Safe guides',     d: 'Faint boxes showing where phone apps put their own buttons over your video. Keep text inside them.' },
  tglGrid:      { t: 'Thirds grid',     d: 'A 3×3 grid. Putting your subject on a line usually looks better than dead centre.' },
  btnCrop:      { t: 'Crop tool',       d: 'Opens the crop room: the frame on its own, as big as the screen, zoom in as far as you like. Drag a box, or paint the exact shape with a brush \u2014 Keep paints what stays, Remove paints what goes. What you cut becomes its own layer on top that you can move and resize; the original clip is untouched.', k: 'C' },
  tglSnap:      { t: 'Snapping',        d: 'Clips jump to line up with each other, the playhead and the beat grid while you drag. Hold Alt to ignore it for one drag.', k: 'N' },
  previewQuality: { t: 'Preview quality', d: 'How sharp the preview window is while you work. Lower it if playback stutters with long or 4K footage. It has no effect on the exported file.' },
  fpsChip:      { t: 'Preview speed',   d: 'Frames per second the preview is managing right now. If it drops a lot, turn the preview quality down.' },
  btnCompare:   { t: 'Compare',         d: 'Before and after: left of the line is your footage without effects, looks or motion, right of it is the finished picture. Drag the line.' },
  btnFullscreen:{ t: 'Fullscreen',      d: 'Fill the screen with the preview to check your work.', k: 'F' },

  /* Transport */
  btnStart:     { t: 'Go to start',     d: 'Jump the playhead back to 0:00.', k: 'Home' },
  btnPrevFrame: { t: 'Back one frame',  d: 'Move the playhead back a single frame. Hold Shift with the arrow key for a whole second. (Alt + arrow moves the selected clip instead.)', k: '←' },
  btnPlay:      { t: 'Play / pause',    d: 'Play the timeline from the playhead. The button turns red while it is running.', k: 'Space' },
  btnNextFrame: { t: 'Forward one frame', d: 'Move the playhead forward a single frame. Shift + arrow jumps a second.', k: '→' },
  btnEnd:       { t: 'Go to end',       d: 'Jump the playhead to the end of the last clip.', k: 'End' },
  btnLoop:      { t: 'Loop',            d: 'Start over automatically when playback reaches the end — handy for matching a cut to music.', k: 'L' },
  // No key: M is "add a marker", and has been since markers existed. This
  // used to promise M here as well, so pressing it to silence the preview
  // dropped a flag on the ruler instead.
  btnMute:      { t: 'Mute preview',    d: 'Silence the preview only. Your export keeps its audio.' },
  masterVol:    { t: 'Preview volume',  d: 'How loud the preview plays. This does not change the exported file.' },

  /* Timeline tools */
  btnToolSelect:{ t: 'Select tool',     d: 'Click a clip to pick it, drag it to move it, drag an edge to trim it. Dropping a clip onto another slots it in beside it (Ripple on) or puts it on a new layer (Ripple off) — nothing is ever hidden underneath.', k: 'V' },
  btnToolRazor: { t: 'Razor tool',      d: 'Click a clip to cut it exactly there; the yellow line shows where. Shift-click cuts every lane at once.', k: 'B' },
  btnToolHand:  { t: 'Hand tool',       d: 'Drag anywhere on the timeline to look around without touching a clip. The middle mouse button does this with any tool.', k: 'H' },
  btnAddLane:   { t: 'Add a lane',      d: 'Ready-made lanes: Video, Facecam, Text, Voice (cleaned up automatically), Music (dips when someone talks) and SFX. Drag a lane by its dot to reorder it.' },
  btnHistory:   { t: 'History',         d: 'Every change you made, in order. Click one to go back to just after it — later steps stay in the list to redo. Ctrl+H.' },
  btnSettings:  { t: 'Settings',        d: 'Accent colour, compact layout, and hover hints on or off. Ctrl+,' },
  btnSnapshot:  { t: 'Save this frame', d: 'Saves the frame under the playhead as a full-size PNG — for thumbnails. Ctrl+Shift+S.' },
  btnCloseGaps: { t: 'Close gaps',      d: 'Slide every shot on the main lane back so there are no black gaps. Titles riding on a shot move with it, and crops and sound linked to a shot always follow it.' },
  btnTrackSize: { t: 'Lane height',     d: 'Fit lanes (the default) makes every lane as tall as fits, so nothing is cut off. Or pick Small, Medium or Large.' },
  tlOverview:   { t: 'Overview',        d: 'The whole project in one strip. The blue frame is what the timeline shows — drag it to travel, double-click to move the playhead there.' },
  btnSplit:     { t: 'Split',           d: 'Cut the selected clip in two at the playhead. With nothing selected it splits every clip the playhead is over.', k: 'S' },
  btnDelete:    { t: 'Delete',          d: 'Remove whatever is selected from the timeline. The file stays in your Media panel.', k: 'Del' },
  btnDuplicate: { t: 'Duplicate',       d: 'Make a copy of the selection right after it.', k: 'Ctrl+D' },
  btnAddText:   { t: 'Add text',        d: 'Drop a text layer at the playhead. Double-click the words on the preview \u2014 or press Enter with the layer selected \u2014 to type straight onto the picture; the Inspector on the right is for how it looks.', k: 'T' },
  btnMarker:    { t: 'Add marker',      d: 'Pin a coloured flag on the ruler so you can find a moment again later.', k: 'M' },
  btnRipple:    { t: 'Ripple',          d: 'On (the default): deleting a clip, trimming either end of it or changing its speed slides the clips after it on the same track, so no black gap is left behind — and makes room when a clip gets longer. Off: everything else stays exactly where it is. Either way, right-click an empty gap to close it.' },
  btnMagnet:    { t: 'Snap',            d: 'While you drag, clips jump to line up with each other, the playhead, markers and the beat. Hold Alt to ignore it for one drag.', k: 'N' },
  bpmInput:     { t: 'BPM',             d: 'The tempo of your music. Set it and the beat lines match the song. Use Tap if you do not know it.' },
  btnBeatGrid:  { t: 'Beat sync',       d: 'Line your cuts up with the music. Turns on a line for every beat (clips snap to them) and shows the BPM box and the Tap button. Right-click the ruler to say where beat 1 is.', k: 'B' },
  btnTapTempo:  { t: 'Tap tempo',       d: 'Tap this in time with your track four or five times and it works out the BPM for you.' },
  btnZoomFit:   { t: 'Zoom to fit',     d: 'Scale the timeline so the whole project is on screen at once.', k: 'Shift+Z' },
  zoomRange:    { t: 'Zoom',            d: 'How much timeline fits on screen. Ctrl + scroll over the timeline does the same, centred on your pointer. Plain scroll moves up and down the tracks; Shift + scroll moves along the timeline.' },

  /* Panels */
  tabMedia:     { t: 'Media',           d: 'Everything you have imported. Hover a tile and press + , or double-click it, to put it on the timeline at the playhead.' },
  tabText:      { t: 'Text',            d: 'Add text in one click, start from a look, reuse the words you saved, and set up your brand kit (logo, colours, font).' },
  tabFx:        { t: 'Effects',         d: 'Punch-in zoom, shake, flash, glitch, vignette and more. Each is a clip you drop at the playhead; it changes the picture under it and leaves your titles alone.', k: 'Z = zoom' },
  tabTrans:     { t: 'Transitions',     d: 'How one shot becomes the next. Click the ⋈ button on any cut in the timeline, then pick a tile here — Dissolve, Dip to black or a Slide.' },
  tabGfx:       { t: 'Graphics',        d: 'Images that go ON your footage — logos, emotes, cut-outs, screenshots. Pick how it should land (shadow, glow, sticker edge, 3D tilt), then click one to drop it on the picture. Everything about it stays adjustable in the Inspector afterwards.' },
};

const DELAY = 340;

export function initTips(root = document) {
  const el = document.createElement('div');
  el.className = 'tip';
  el.hidden = true;
  document.body.appendChild(el);

  let timer = null, current = null;

  /**
   * The native `title` is taken off, because a browser will happily show its
   * own tooltip on top of this one and there is no way to ask it not to. The
   * text does not just vanish though: it moves to `aria-label`, which is the
   * attribute that actually names a control for a screen reader — an icon-only
   * button with neither is unusable and unlabelled, and that is a real bug,
   * not a styling detail.
   */
  for (const [id, tip] of Object.entries(TIPS)) {
    const node = root.getElementById?.(id) || root.querySelector?.('#' + CSS.escape(id));
    if (!node) continue;
    node.dataset.tip = id;
    if (!node.getAttribute('aria-label')) node.setAttribute('aria-label', tip.k ? `${tip.t} (${tip.k})` : tip.t);
    node.removeAttribute('title');
  }

  function show(node, tip) {
    el.innerHTML = '';
    const h = document.createElement('b');
    h.textContent = tip.t;
    el.appendChild(h);
    if (tip.k) {
      const k = document.createElement('kbd');
      k.textContent = tip.k;
      h.appendChild(k);
    }
    const p = document.createElement('span');
    p.textContent = tip.d;
    el.appendChild(p);

    el.hidden = false;
    el.style.left = '-9999px';
    el.style.top = '0px';

    // Placed after it is measured, and flipped to whichever side has room —
    // a tooltip that runs off the window edge is worse than none.
    const r = node.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const margin = 8;
    let left = r.left + r.width / 2 - b.width / 2;
    left = Math.max(margin, Math.min(window.innerWidth - b.width - margin, left));
    let top = r.bottom + 9;
    if (top + b.height > window.innerHeight - margin) top = r.top - b.height - 9;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(Math.max(margin, top)) + 'px';
    el.classList.add('is-on');
  }

  function hide() {
    clearTimeout(timer);
    timer = null; current = null;
    el.classList.remove('is-on');
    el.hidden = true;
  }

  document.addEventListener('pointerover', (e) => {
    const node = e.target?.closest?.('[data-tip]');
    if (!node || node === current) return;
    hide();
    current = node;
    const tip = TIPS[node.dataset.tip];
    if (!tip) return;
    timer = setTimeout(() => { if (current === node && node.isConnected) show(node, tip); }, DELAY);
  });

  document.addEventListener('pointerout', (e) => {
    if (!current) return;
    if (e.relatedTarget && current.contains(e.relatedTarget)) return;
    hide();
  });

  // Any real interaction dismisses it — a tooltip hanging over the thing you
  // just clicked is in the way.
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
  bus.on('layout', hide);

  return { hide };
}
