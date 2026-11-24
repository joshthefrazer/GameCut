import { bus } from '../../core/events.js';
import { makeClip } from '../../core/schema.js';
import { snapFrame } from '../../core/time.js';
import { assets } from '../../media/asset-store.js';
import { playSound, singleSoundAsset } from '../../anim/sfx.js';

/**
 * Sound pads: twelve sounds on twelve keys.
 *
 * Click a pad and its sound goes in at the playhead. Or press "Play and
 * record": the video plays, and every key you hit drops its sound exactly
 * where you hit it — a whole take of hits, whooshes and air horns is one
 * step of undo. While recording, the pad keys belong to the pads (S does not
 * split); Esc, Space or the button stops.
 */

export const PADS = [
  { key: 'q', sound: 'whoosh', name: 'Whoosh' },
  { key: 'w', sound: 'hit', name: 'Bass hit' },
  { key: 'e', sound: 'boom', name: 'Boom' },
  { key: 'r', sound: 'scratch', name: 'Record scratch' },
  { key: 'a', sound: 'ding', name: 'Ding' },
  { key: 's', sound: 'tick', name: 'Hitmarker' },
  { key: 'd', sound: 'cheer', name: 'Crowd cheer' },
  { key: 'f', sound: 'rewind', name: 'Rewind' },
  { key: 'z', sound: 'glitch', name: 'Glitch' },
  { key: 'x', sound: 'shutter', name: 'Camera click' },
  { key: 'c', sound: 'riser', name: 'Riser' },
  { key: 'v', sound: 'airhorn', name: 'Air horn' },
];

const PREF = 'strike.pads';
const prefs = () => { try { return { volume: 0.8, snap: false, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { volume: 0.8, snap: false }; } };

export function initPads({ store, cmds, playback }) {
  const root = document.getElementById('padsRoot');
  if (!root) return {};
  let opt = prefs();
  const saveOpt = () => { try { localStorage.setItem(PREF, JSON.stringify(opt)); } catch { /* private */ } };
  let recording = null;          // { hits: [{ pad, t }] }
  let lengths = {};              // sound name -> seconds (assets/sfx/index.json)
  fetch('./assets/sfx/index.json').then(r => r.json()).then(j => { lengths = j; }).catch(() => {});

  root.innerHTML = `
    <p class="pads__lead">Click a pad to drop its sound at the playhead — or record: play your clip and hit the keys.</p>
    <div class="pads__grid">${PADS.map((p, i) => `
      <button class="pad" data-pad="${i}" title="${p.name} (${p.key.toUpperCase()} while recording)">
        <kbd>${p.key.toUpperCase()}</kbd><b>${p.name}</b><i class="pad__flash"></i></button>`).join('')}</div>
    <button class="btn btn--primary pads__rec" id="btnPadRec"><i class="pads__dot"></i><span>Play and record pads</span></button>
    <div class="pads__take" id="padTake" hidden></div>
    <label class="pads__opt"><input type="checkbox" id="padSnap" ${opt.snap ? 'checked' : ''}> Snap to the beat <span>(when the project has one)</span></label>
    <label class="pads__opt pads__opt--vol">Pad volume <input type="range" id="padVol" min="0.1" max="1.5" step="0.05" value="${opt.volume}"><output>${Math.round(opt.volume * 100)}%</output></label>`;

  const take = root.querySelector('#padTake');
  const recBtn = root.querySelector('#btnPadRec');

  const flash = (i) => {
    const b = root.querySelector(`[data-pad="${i}"]`);
    if (!b) return;
    b.classList.remove('is-hit'); void b.offsetWidth; b.classList.add('is-hit');
  };

  /** Where a hit lands: on the frame, or on the nearest beat when snapping. */
  const landAt = (t) => {
    const d = store.doc;
    if (opt.snap && d.bpm > 0) {
      const p = 60 / d.bpm, off = d.beatOffset || 0;
      t = off + Math.round((t - off) / p) * p;
    }
    return snapFrame(Math.max(0, t), d.fps);
  };

  function sfxLane() {
    return store.doc.tracks.find(t => t.kind === 'audio' && /sfx/i.test(t.name) && !t.locked) || cmds.addLane('sfx');
  }

  /** Put hits on the SFX lane, as one step of undo. */
  function place(hits, label) {
    if (!hits.length) return [];
    const made = [];
    cmds.batch(label, () => {
      const lane = sfxLane();
      for (const h of hits) {
        const pad = PADS[h.pad];
        const assetId = singleSoundAsset(pad.sound, pad.name);
        const dur = Math.max(0.1, lengths[pad.sound] || assets.get(assetId)?.duration || 1);
        const clip = makeClip('audio', { name: pad.name, assetId, start: landAt(h.t), duration: dur, sourceDuration: dur, volume: opt.volume });
        const c = cmds.addClip(lane.id, clip, { select: false, label: pad.name });
        if (c) made.push(c);
      }
    });
    return made;
  }

  function hit(i, { live = false } = {}) {
    const pad = PADS[i];
    flash(i);
    playSound(pad.sound, opt.volume).catch(() => {});
    if (recording) {
      recording.hits.push({ pad: i, t: store.rt.playhead });
      take.hidden = false;
      take.innerHTML = `<b>Recording</b> ${recording.hits.slice(-6).map(h => `<span>${PADS[h.pad].name}</span>`).join('')}`;
      return null;
    }
    if (live) return null;
    const c = place([{ pad: i, t: store.rt.playhead }], `Pad: ${pad.name}`);
    return c[0] || null;
  }

  function startRec() {
    if (recording) return stopRec();
    recording = { hits: [] };
    recBtn.classList.add('is-rec');
    recBtn.querySelector('span').textContent = 'Stop (Esc)';
    take.hidden = false;
    take.innerHTML = '<b>Recording</b> hit Q W E R · A S D F · Z X C V';
    if (!store.rt.playing) playback.play();
  }
  function stopRec() {
    if (!recording) return [];
    const hits = recording.hits;
    recording = null;
    recBtn.classList.remove('is-rec');
    recBtn.querySelector('span').textContent = 'Play and record pads';
    if (store.rt.playing) playback.pause();
    const made = place(hits, `Sound pads: ${hits.length} sound${hits.length === 1 ? '' : 's'}`);
    take.hidden = !made.length;
    take.innerHTML = made.length ? `<b>${made.length} sound${made.length === 1 ? '' : 's'} added</b> One Ctrl+Z takes the whole take back.` : '';
    if (made.length) bus.emit('toast', { msg: `Added ${made.length} sound${made.length === 1 ? '' : 's'} from the pads`, kind: 'ok', action: { label: 'Undo', run: () => cmds.undo() } });
    return made;
  }

  root.querySelector('.pads__grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pad]');
    if (b) hit(+b.dataset.pad);
  });
  recBtn.addEventListener('click', startRec);
  root.querySelector('#padSnap').addEventListener('change', (e) => { opt.snap = e.target.checked; saveOpt(); });
  root.querySelector('#padVol').addEventListener('input', (e) => {
    opt.volume = +e.target.value; saveOpt();
    root.querySelector('.pads__opt--vol output').textContent = `${Math.round(opt.volume * 100)}%`;
  });

  // While recording, the pad keys are the pads.
  window.addEventListener('keydown', (e) => {
    if (!recording || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'escape' || k === ' ') { e.preventDefault(); e.stopPropagation(); stopRec(); return; }
    const i = PADS.findIndex(p => p.key === k);
    if (i < 0 || e.repeat) return;
    e.preventDefault(); e.stopPropagation();
    hit(i);
  }, true);
  // Playback reaching the end stops the take too.
  store.on('rt', () => { if (recording && !store.rt.playing && recording.hits.length) stopRec(); });

  bus.emit('palette:add', [{ id: 'pads', name: 'Sound pads: hit keys to drop sounds while it plays', sec: 'Sound', run: () => bus.emit('drawer:show', 'pads') }]);
  return { hit, startRec, stopRec, get recording() { return !!recording; }, place,
    /** One sound by name ("whoosh") at a time, as one undo step. Empty if there is no such pad. */
    placeNamed(sound, t, label) { const i = PADS.findIndex(p => p.sound === sound); return i < 0 ? [] : place([{ pad: i, t }], label); },
    has: (sound) => PADS.some(p => p.sound === sound) };
}
