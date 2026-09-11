import { timecode } from '../../core/time.js';

export function initTransport({ store, playback, audio }) {
  const $ = (id) => document.getElementById(id);
  const tcCur = $('tcCurrent'), tcTot = $('tcTotal');
  const playBtn = $('btnPlay');
  const icoPlay = playBtn.querySelector('.ico-play');
  const icoPause = playBtn.querySelector('.ico-pause');
  const stateEl = $('playState');
  const stateLabel = stateEl?.querySelector('.playstate__label');

  const paint = () => {
    tcCur.textContent = timecode(store.rt.playhead, store.doc.fps);
    tcTot.textContent = timecode(store.rt.duration, store.doc.fps);
  };

  /**
   * Single place the transport's playing/paused appearance is decided.
   *
   * These are <svg> elements, and `hidden` is an IDL property of HTMLElement —
   * SVGElement does not implement it. `svg.hidden = true` therefore sets a
   * meaningless JS expando: the attribute never changes, the CSS `[hidden]`
   * rule never matches, and the icon never swaps (while reading `.hidden` back
   * still returns true, which is a very convincing way to fool a test).
   * toggleAttribute works on any Element.
   */
  const paintPlayState = () => {
    const on = !!store.rt.playing;
    icoPlay.toggleAttribute('hidden', on);
    icoPause.toggleAttribute('hidden', !on);
    playBtn.setAttribute('aria-pressed', String(on));
    // aria-label rather than title: the hover help owns tooltips now, and two
    // tooltips on one button is worse than either alone. This is still the
    // control's accessible name, and it still says which way it is pointing.
    playBtn.setAttribute('aria-label', on ? 'Pause (Space)' : 'Play (Space)');
    if (stateEl) stateEl.dataset.playing = String(on);
    if (stateLabel) stateLabel.textContent = on ? 'Playing' : 'Paused';
  };

  playBtn.addEventListener('click', () => playback.toggle());
  $('btnPrevFrame').addEventListener('click', () => playback.step(-1));
  $('btnNextFrame').addEventListener('click', () => playback.step(1));
  $('btnStart').addEventListener('click', () => { playback.pause(); playback.seek(0); });
  $('btnEnd').addEventListener('click', () => { playback.pause(); playback.seek(store.rt.duration); });

  $('btnLoop').addEventListener('click', (e) => {
    store.rt.loop = !store.rt.loop;
    e.currentTarget.classList.toggle('is-active', store.rt.loop);
  });

  $('btnMute').addEventListener('click', (e) => {
    store.rt.muted = !store.rt.muted;
    e.currentTarget.classList.toggle('is-active', store.rt.muted);
    audio.setVolume(store.rt.volume, store.rt.muted);
  });

  const vol = $('masterVol');
  const paintVol = () => vol.style.setProperty('--fill', vol.value + '%');
  vol.addEventListener('input', () => {
    store.rt.volume = vol.value / 100;
    audio.setVolume(store.rt.volume, store.rt.muted);
    paintVol();
  });
  paintVol();

  store.on('rt', (patch) => { if ('playing' in patch) paintPlayState(); });
  store.on('playhead', paint);
  store.on('doc', paint);
  paint();
  paintPlayState();

  return { paint, paintPlayState };
}
