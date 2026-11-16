import { EXPORT_PRESETS, EXPORT_FPS, EXPORT_SCALES } from '../project/presets.js';
import {
  renderToMp4, exportSupport, planVideoEncoder, encoderNote,
  audioCapabilities, nearestAudioRate,
} from './render-export.js';
import { bus } from '../core/events.js';
import { timecode } from '../core/time.js';
import { soundReport } from '../audio/graph.js';
import { assets } from '../media/asset-store.js';
import { pendingAudio, onAudioJobs, prioritizeAudio } from '../media/audio-jobs.js';
import { restoreAssetAudio } from '../media/importer.js';
import {
  sourceBitrate, bitrateForPreset, matchSource, clampBitrate, fmtMbps,
  MIN_CUSTOM_BITRATE, MAX_CUSTOM_BITRATE,
} from './quality.js';

/**
 * Export dialog.
 *
 * Deliberately plain: pick where the video is going, press Export, choose where
 * to save it, watch a bar. Resolution and bitrate are shown but never asked
 * for — the preset decides, because "which H.264 level do you want" is not a
 * question anyone should have to answer to post a clip.
 *
 * The order matters, and changed:
 *
 *   1. Everything that would spoil the file is said BEFORE rendering: clips
 *      whose file is offline, sound that can't be included, sound still being
 *      prepared (which is waited for — "Preparing sound… 2 of 3").
 *   2. The save location is asked for BEFORE rendering. It used to be asked
 *      after: cancelling that dialog, or a folder that could not be written,
 *      threw away a finished twenty-minute render.
 *   3. The file is written to disk as it is made (window.gamecut.exportSink),
 *      so it never sits in memory — which is what crashed long exports at 99%.
 */

/**
 * Which presets to offer, and what to call them.
 *
 * Output size always follows the project's own shape, so a preset labelled
 * "Shorts / TikTok" on a 16:9 project would offer a landscape file under a
 * vertical name. Instead the quality tiers are fixed and the destination text
 * is derived from the project — truthful in every orientation, and four
 * choices instead of six.
 */
function shapeOf(store) {
  return store.doc.height > store.doc.width ? 'vertical'
    : store.doc.height === store.doc.width ? 'square' : 'landscape';
}

function choicesFor(store) {
  const shape = shapeOf(store);
  const where = shape === 'vertical' ? 'TikTok, Reels and Shorts'
    : shape === 'square' ? 'Instagram and feed posts'
    : 'YouTube and most sites';

  const ids = shape === 'landscape'
    ? ['yt4k', 'yt1080', 'draft', 'discord', 'custom']
    : ['short4k', 'short', 'draft', 'discord', 'custom'];
  const labels = {
    0: { title: 'Best quality', note: `Sharpest picture for ${where}. Biggest file, slowest to make.` },
    1: { title: 'Recommended', note: `Great for ${where}. Pick this one if you're not sure.` },
    2: { title: 'Quick draft', note: 'A rough copy to check your edit. Much faster, lower quality.' },
    3: { title: 'Small for Discord', note: 'Under 10 MB, so it sends in a chat. Sharpness depends on how long the video is.' },
    4: { title: 'Custom', note: 'Choose the quality, size and frame rate yourself.' },
  };
  return ids.map((id, i) => ({ id, ...labels[i] })).filter(x => x.id);
}

const fmtBytes = (n) => !Number.isFinite(n) ? '—'
  : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
const fmtClock = (s) => {
  if (!Number.isFinite(s) || s < 0) return '—';
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** "a.mp4", "a.mp4 and b.mp4", "a.mp4, b.mp4 and 3 more". */
function names(list) {
  const n = [...new Set(list.map(x => x.asset?.name || x.clip?.name || 'a clip'))];
  if (n.length <= 2) return n.map(esc).join(' and ');
  return `${n.slice(0, 2).map(esc).join(', ')} and ${n.length - 2} more`;
}

/**
 * The last choice made for each project shape.
 *
 * Per shape, because a vertical TikTok and a landscape YouTube video are made
 * with different settings by the same person, often on the same afternoon.
 * Kept on this machine (localStorage) rather than in the project: it is about
 * where videos from this computer go, not about the edit.
 */
const PREF_KEY = 'gamecut.export.v1';
function loadPref(shape) {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}')[shape] || null; } catch { return null; }
}
function savePref(shape, pref) {
  try {
    const all = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    all[shape] = pref;
    localStorage.setItem(PREF_KEY, JSON.stringify(all));
  } catch { /* private window, full storage — a convenience, not a feature */ }
}

export const __paintDoneForTest = (...a) => initExport.__paintDone?.(...a);

/**
 * A stand-in for window.gamecut.exportSink, for tests only.
 *
 * The preload bridge is frozen, so a test cannot put a fake sink on it, and a
 * real one opens a native save dialog nobody can answer. A sink set here wins
 * over the bridge's; nothing in the app sets it.
 */
let sinkOverride = null;
export const __setExportSinkForTest = (sink) => { sinkOverride = sink || null; };

export function initExport({ store, playback }) {
  const root = document.getElementById('exportModal');
  if (!root) return {};

  let chosen = 'yt1080';           // replaced with a shape-appropriate default on open
  let cancelled = false;
  /**
   * True while a render is running.
   *
   * Mirrored onto `store.rt.exporting` as well as kept here, because the export
   * dialog is no longer the only thing that cares: an update that reloaded the
   * editor mid-render would throw away however many minutes of work, so the
   * updater asks before it offers to install anything.
   */
  let busy = false;
  const setBusy = (v) => { busy = v; store.setRT({ exporting: v }); };

  /**
   * What the custom tile is currently set to.
   *
   * Kept on the dialog rather than in the document: it is a preference about
   * this machine and this upload, not a property of the edit, and a project
   * opened on a slower computer should not inherit someone else's 4K120.
   * It survives closing and reopening the dialog, and (per project shape) the
   * app, which is the part that would actually annoy anyone.
   */
  let custom = { vBitrate: 0, aBitrate: 320_000, fps: 0, scale: 1 };
  let exact = false;
  /** Extra versions to make in other shapes, by aspect: '9:16', '1:1', '16:9'. */
  let extras = new Set();

  /** What this machine's audio encoder takes. Asked once, at start-up. */
  let audioCaps = null;
  audioCapabilities().then(c => { audioCaps = c; }).catch(() => {});

  /** Output size for a preset, derived from the project's own aspect. */
  const sizeFor = (p) => {
    const scale = p.custom ? custom.scale : p.scale;
    const w = Math.round(store.doc.width * scale / 2) * 2;
    const h = Math.round(store.doc.height * scale / 2) * 2;
    return { w, h };
  };

  /**
   * Everything the renderer needs, for one preset — the single place the
   * preset's own numbers, the footage's bitrate, the custom controls and what
   * the encoder said it will take are reconciled. Both the size estimate and
   * the export itself read this, so what the dialog promises and what it
   * renders cannot drift apart.
   */
  const plans = new Map();          // planKey -> plan, once the encoder has answered
  const planKey = (s) => `${s.w}x${s.h}@${s.fps}:${s.asked}`;
  const settingsFor = (p) => {
    const { w, h } = sizeFor(p);
    const src = sourceBitrate(store, assets);
    const s = p.custom
      ? { w, h, fps: custom.fps || store.doc.fps || 60,
          asked: clampBitrate(custom.vBitrate || bitrateForPreset(p, src)), aBitrate: custom.aBitrate }
      : { w, h, fps: p.fps, asked: bitrateForPreset(p, src), aBitrate: p.aBitrate };
    if (p.sizeCap) {
      // Whatever fits under the cap for this length (8% kept back for the container).
      const secs = Math.max(1, Number.isFinite(store.rt.duration) ? store.rt.duration : 1);
      s.asked = Math.max(250_000, Math.min(4_000_000, Math.floor((p.sizeCap * 8 * 0.92) / secs - p.aBitrate)));
    }
    const plan = plans.get(planKey(s));
    // The figure shown is what the encoder will actually be configured at.
    s.vBitrate = plan ? plan.bitrate : s.asked;
    s.plan = plan || null;
    s.aBitrate = audioCaps?.bitrates?.length ? nearestAudioRate(audioCaps, s.aBitrate) : s.aBitrate;
    return s;
  };

  const estimate = (p) => {
    const s = settingsFor(p);
    const secs = Math.max(1, Number.isFinite(store.rt.duration) ? store.rt.duration : 0);
    return ((s.vBitrate + s.aBitrate) * secs) / 8;
  };

  /** Ask the encoder about a tile's settings, then repaint that tile. */
  function probe(p) {
    const s = settingsFor(p);
    const key = planKey(s);
    if (plans.has(key)) return;
    planVideoEncoder({ width: s.w, height: s.h, fps: s.fps, bitrate: s.asked }).then((plan) => {
      if (!plan) return;
      plans.set(key, plan);
      if (!root.hidden) { paintTile(p); paintEncoderNote(); }
    }).catch(() => {});
  }

  const tileMeta = (p) => {
    const s = settingsFor(p);
    return `<b>${s.w}×${s.h}</b>`
      + `<span>~${fmtBytes(estimate(p))} · ${s.fps}fps · ${fmtMbps(s.vBitrate)}</span>`;
  };
  function paintTile(p) {
    const meta = root.querySelector(`[data-preset="${p.id}"] .xp__meta`);
    if (meta) meta.innerHTML = tileMeta(p);
    if (p.custom) {
      const size = root.querySelector('#xpCustomSize');
      if (size) size.textContent = `~${fmtBytes(estimate(p))}`;
    }
  }
  /** One sentence under the list when the chosen tile's encoder needs one. */
  function paintEncoderNote() {
    const el = root.querySelector('#xpEncNote');
    if (!el) return;
    const p = EXPORT_PRESETS.find(x => x.id === chosen);
    const s = p && settingsFor(p);
    // A cap on an automatic figure is not news; a cap on a typed one is, and
    // the software path is always worth knowing about.
    const show = !!(s?.plan && (s.plan.path === 'software' || (s.plan.capped && p.custom)));
    el.hidden = !show;
    el.textContent = show ? encoderNote(s.plan, { width: s.w, height: s.h, fps: s.fps }) : '';
  }

  /**
   * The custom controls.
   *
   * A number box AND a slider for the same value, on purpose. The slider is for
   * "a bit more than that", which is how anyone actually chooses a bitrate, and
   * the box is for "my recorder says 82 and I want 82" — which is the whole
   * point of this feature, and something a slider can never quite hit.
   *
   * Rendered whether or not Custom is selected, and simply hidden otherwise, so
   * that picking Custom does not rebuild the list under the pointer.
   *
   * The Sound list only offers bitrates this computer's audio encoder takes
   * (Windows' AAC encoder stops at 192 kbps), so what you pick is what you get.
   */
  function customPanel() {
    const p = EXPORT_PRESETS.find(x => x.id === 'custom');
    const s = settingsFor(p);
    const src = sourceBitrate(store, assets);
    const maxSlider = Math.max(120e6, Math.ceil((src * 1.5) / 10e6) * 10e6);
    const rates = audioCaps?.bitrates?.length ? audioCaps.bitrates : [128_000, 192_000, 256_000, 320_000];
    const best = rates[rates.length - 1];

    return `
      <div class="xp-custom" id="xpCustom" ${chosen === 'custom' ? '' : 'hidden'}>
        <div class="xp-row">
          <label for="xpRate"><b>Quality</b>
            <span>Higher keeps more detail and makes a bigger file.</span></label>
          <div class="xp-rate">
            <input type="range" id="xpRateSlide" min="${MIN_CUSTOM_BITRATE}"
                   max="${maxSlider}" step="500000" value="${s.asked}">
            <span class="xp-num">
              <input type="number" id="xpRate" min="1"
                     max="${Math.round(MAX_CUSTOM_BITRATE / 1e6)}" step="0.5"
                     value="${mbpsText(s.asked)}">
              <i>Mbps</i>
            </span>
          </div>
        </div>

        ${src ? `<div class="xp-row xp-row--match">
          <span class="xp-src">Your footage was recorded at about
            <b>${fmtMbps(src)}</b>.</span>
          <button class="btn btn--ghost btn--sm" id="xpMatch">Match my footage</button>
        </div>` : ''}

        <div class="xp-row xp-row--pair">
          <label for="xpFps"><b>Frame rate</b></label>
          <select id="xpFps">
            ${EXPORT_FPS.map(f => `<option value="${f}" ${f === s.fps ? 'selected' : ''}>${f} fps</option>`).join('')}
          </select>

          <label for="xpScale"><b>Size</b></label>
          <select id="xpScale">
            ${EXPORT_SCALES.map(o => {
              const w = Math.round(store.doc.width * o.scale / 2) * 2;
              const h = Math.round(store.doc.height * o.scale / 2) * 2;
              return `<option value="${o.scale}" ${o.scale === custom.scale ? 'selected' : ''}>${w}×${h} · ${o.label}</option>`;
            }).join('')}
          </select>
        </div>

        <div class="xp-row xp-row--pair">
          <label for="xpARate"><b>Sound</b></label>
          <select id="xpARate">
            ${rates.map(b =>
              `<option value="${b}" ${b === s.aBitrate ? 'selected' : ''}>${b / 1000} kbps${b === best ? ' · best' : ''}</option>`).join('')}
          </select>
          <span class="xp-note" id="xpCustomSize">~${fmtBytes(estimate(p))}</span>
        </div>
      </div>`;
  }

  /**
   * The number for the box: "82", or "8.5" when the half matters.
   *
   * Rounding to whole Mbps here would quietly change the value — the slider
   * steps in halves, so dragging to 8.5 and then blurring the box would commit
   * 9, and there would be no way to type 8.5 back in.
   */
  const mbpsText = (bits) => String(Number(((bits || 0) / 1e6).toFixed(1)));

  function close() {
    if (busy) return;                       // never vanish mid-render
    root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); if (!busy) close(); }
  }

  function open() {
    // Ctrl+E reaches here through the application menu, which does not know a
    // render is running. Without this guard it would clear store.rt.exporting —
    // the one flag stopping the updater reloading the editor mid-export —
    // replace the progress view with the form, un-cancel a render the person
    // had just stopped, and leave Export live for a second, concurrent run.
    if (busy) return;
    const list = choicesFor(store);
    const pref = loadPref(shapeOf(store));
    if (pref) {
      if (list.some(c => c.id === pref.chosen)) chosen = pref.chosen;
      if (pref.custom) custom = { ...custom, ...pref.custom };
      exact = !!pref.exact;
    }
    if (!list.some(c => c.id === chosen)) chosen = (list[1] || list[0]).id;
    const sup = exportSupport();
    cancelled = false;
    setBusy(false);
    root.hidden = false;
    document.addEventListener('keydown', onKey, true);
    paintChooser(sup);
  }

  /** Warnings to show above the tiles — only things that will really happen. */
  function warningsHtml(sup) {
    const out = [];
    if (!sup.ok || sup.audio === false) out.push(esc(sup.reason));
    const r = soundReport(store);
    const one = (list, a, b) => (list.length === 1 ? a : b);
    if (r.offline.length) {
      out.push(`<b>${one(r.offline, 'A file is', `${r.offline.length} files are`)} missing:</b>
        ${names(r.offline)} ${one(r.offline, 'was', 'were')} moved or deleted. Those clips will
        be black and silent in the video. Put ${one(r.offline, 'the file', 'the files')} back
        where ${one(r.offline, 'it was', 'they were')} and reopen the project to fix it.`);
    }
    if (r.stream.length) {
      out.push(`The video will have <b>no sound from ${names(r.stream)}</b> — Strike can play
        ${one(r.stream, 'that file\'s', 'those files\'')} sound but can't put it into a video.
        Converting to MP4 fixes this (for OBS .mkv files: File → Remux Recordings).`);
    }
    if (r.unreadable.length) {
      out.push(`The video will have <b>no sound from ${names(r.unreadable)}</b> — this
        computer can't read ${one(r.unreadable, 'its', 'their')} sound format. Converting to
        MP4 (H.264 + AAC) or MP3 fixes this.`);
    }
    if (r.pending.length) {
      out.push(`Sound is still being prepared for ${names(r.pending)}. Export will wait for
        it — usually only a few seconds.`);
    }
    return out.map(w => `<div class="modal__warn">${w}</div>`).join('');
  }

  /* ── Step 1: pick a destination ───────────────────────────────────── */
  function paintChooser(sup) {
    const dur = Number.isFinite(store.rt.duration) ? Math.max(0, store.rt.duration) : 0;
    const clips = store.doc.tracks.reduce((n, t) => n + t.clips.length, 0);

    root.innerHTML = `
      <div class="modal__scrim" data-close></div>
      <div class="modal__panel glass" role="dialog" aria-modal="true" aria-label="Export video">
        <header class="modal__head">
          <div>
            <b>Export video</b>
            <span>${timecode(dur, store.doc.fps)} · ${clips} clip${clips === 1 ? '' : 's'} · ${store.doc.width}×${store.doc.height}</span>
          </div>
          <button class="tbtn" data-close title="Close">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>

        ${clips === 0 ? `<div class="empty"><b>Nothing to export</b>
          <span>Add some media to the timeline first.</span></div>` : `

        <div class="xp-warns" id="xpWarns">${warningsHtml(sup)}</div>

        <div class="xp-list" id="xpList">
          ${choicesFor(store).map(choice => {
            const p = EXPORT_PRESETS.find(x => x.id === choice.id);
            if (!p) return '';
            return `<button class="xp ${p.id === chosen ? 'is-on' : ''}" data-preset="${p.id}">
              <span class="xp__radio"></span>
              <span class="xp__text">
                <b>${choice.title}</b>
                <span>${choice.note}</span>
              </span>
              <span class="xp__meta">${tileMeta(p)}</span>
            </button>`;
          }).join('')}
        </div>

        <div class="modal__warn xp-encnote" id="xpEncNote" hidden></div>

        ${customPanel()}

        <div class="xp-extra" id="xpExtras">
          <b>Also make</b>
          ${extraTargets().map(t => `<label class="xp-extra__opt"><input type="checkbox" data-extra="${t.ar}" ${extras.has(t.ar) ? 'checked' : ''}>
            <span><b>${t.name}</b><span>${t.w}×${t.h} · saved next to the main file</span></span></label>`).join('')}
        </div>

        <details class="xp-adv" id="xpAdvanced" ${exact ? 'open' : ''}>
          <summary>Advanced</summary>
          <label class="xp-exact">
            <input type="checkbox" id="xpExact" ${exact ? 'checked' : ''}>
            <span>
              <b>Exact frames (slower)</b>
              <span>Normally Strike plays your footage through while it renders,
              which is about three times quicker — a frame can land a tiny fraction
              of a second off, which you won't see. Tick this to make every frame
              exact instead. Only worth it if you need the same file on every
              computer.</span>
            </span>
          </label>
        </details>

        <footer class="modal__foot">
          <span class="modal__hint">You'll choose where to save it next.</span>
          <div class="modal__actions">
            <button class="btn btn--ghost" data-close>Cancel</button>
            <button class="btn btn--primary" id="xpGo" ${sup.ok ? '' : 'disabled'}>
              <svg viewBox="0 0 24 24"><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 19h16"/></svg>
              Export
            </button>
          </div>
        </footer>`}
      </div>`;

    root.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
    root.querySelectorAll('[data-preset]').forEach(el => el.addEventListener('click', () => {
      chosen = el.dataset.preset;
      root.querySelectorAll('.xp').forEach(n => n.classList.toggle('is-on', n === el));
      const panel = root.querySelector('#xpCustom');
      if (panel) panel.hidden = chosen !== 'custom';
      paintEncoderNote();
    }));
    root.querySelector('#xpExact')?.addEventListener('change', (e) => { exact = e.target.checked; });
    root.querySelectorAll('[data-extra]').forEach(el => el.addEventListener('change', () => {
      if (el.checked) extras.add(el.dataset.extra); else extras.delete(el.dataset.extra);
    }));
    wireCustom();
    root.querySelector('#xpGo')?.addEventListener('click', run);

    // Ask the encoder what each tile will really get; the tiles update when
    // it answers. Cheap, cached, and never blocks the dialog.
    for (const c of choicesFor(store)) {
      const p = EXPORT_PRESETS.find(x => x.id === c.id);
      if (p) probe(p);
    }
    paintEncoderNote();

    // The sound section can change while the dialog is open (a decode
    // finishing); keep the warnings true without rebuilding the tiles.
    const offJobs = onAudioJobs(() => {
      const w = root.querySelector('#xpWarns');
      if (!w || root.hidden) { offJobs(); return; }
      w.innerHTML = warningsHtml(sup);
    });
  }

  /**
   * Keep the custom controls, the tile above them and the size estimate honest.
   *
   * Only the tile's own text is rewritten, never the list — repainting the
   * whole chooser on every slider step would take the slider out from under the
   * pointer mid-drag, which is the same bug the keyframe strip had.
   */
  function wireCustom() {
    const slide = root.querySelector('#xpRateSlide');
    const num = root.querySelector('#xpRate');
    if (!slide || !num) return;
    const p = EXPORT_PRESETS.find(x => x.id === 'custom');

    let probeTimer = 0;
    const refresh = () => {
      paintTile(p);
      paintEncoderNote();
      clearTimeout(probeTimer);
      probeTimer = setTimeout(() => probe(p), 250);
    };

    const setRate = (bits, { slider = true, box = true } = {}) => {
      custom.vBitrate = clampBitrate(bits);
      // Write back to whichever control did NOT originate the change, so
      // typing "82" is not immediately rounded to the slider's nearest step.
      if (slider) slide.value = String(Math.min(Number(slide.max), custom.vBitrate));
      if (box) num.value = mbpsText(custom.vBitrate);
      refresh();
    };

    slide.addEventListener('input', () => setRate(Number(slide.value), { slider: false }));
    num.addEventListener('input', () => {
      // Mid-typing the box can be empty or "8" on the way to "80"; don't fight
      // the person by clamping every keystroke. Only commit a real number.
      const m = Number(num.value);
      if (!Number.isFinite(m) || m <= 0) return;
      setRate(m * 1e6, { box: false });
    });
    num.addEventListener('change', () => {
      // Same rule as while typing: an empty box (select-all + Delete, or a
      // paste the number input rejected) is not a request for 1 Mbps. Put the
      // last committed figure back rather than acting on nothing.
      const m = Number(num.value);
      if (!Number.isFinite(m) || m <= 0) { num.value = mbpsText(custom.vBitrate); return; }
      setRate(m * 1e6);
    });

    root.querySelector('#xpMatch')?.addEventListener('click', () => {
      // matchSource, not bitrateForPreset: the latter treats the custom tier's
      // placeholder 30 Mbps as a floor, which would set 30 for 8 Mbps footage
      // while the sentence beside the button says 8. Scaled by the size the
      // person actually chose, not the preset's placeholder.
      setRate(matchSource(sourceBitrate(store, assets), custom.scale));
    });

    root.querySelector('#xpFps')?.addEventListener('change', (e) => {
      custom.fps = Number(e.target.value) || 60; refresh();
    });
    root.querySelector('#xpScale')?.addEventListener('change', (e) => {
      custom.scale = Number(e.target.value) || 1; refresh();
    });
    root.querySelector('#xpARate')?.addEventListener('change', (e) => {
      custom.aBitrate = Number(e.target.value) || 320_000; refresh();
    });
  }

  /* ── Step 1½: wait for sound that is still being prepared ─────────── */

  /**
   * Resolves true when no clip on the timeline has sound pending, false if the
   * person chose to stop (Cancel). "Export without it" resolves true at once.
   */
  function waitForSound() {
    const pendingIds = () => soundReport(store).pending.map(x => x.asset.id);
    if (!pendingIds().length) return Promise.resolve(true);
    // A clip can look "still coming" with nothing actually preparing it (an
    // asset nobody queued). Waiting on that never ends, so start it here.
    const queued = new Set(pendingAudio().map(j => j.id));
    for (const id of pendingIds()) if (!queued.has(id)) restoreAssetAudio(assets.get(id));
    // Only these clips are in the video: do them before anything else queued.
    prioritizeAudio(pendingIds());
    const total = pendingIds().length;
    return new Promise((resolve) => {
      root.innerHTML = `
        <div class="modal__scrim"></div>
        <div class="modal__panel glass" role="dialog" aria-modal="true" aria-label="Preparing sound">
          <header class="modal__head">
            <div><b>Preparing sound…</b><span id="xpSoundCount">1 of ${total}</span></div>
          </header>
          <div class="xp-progress">
            <div class="xp-bar"><i id="xpSoundFill" style="width:0%"></i></div>
            <div class="xp-stats"><span id="xpSoundName">Reading the sound from your clips</span></div>
          </div>
          <footer class="modal__foot">
            <span class="modal__hint">Your export starts as soon as this is done.</span>
            <div class="modal__actions">
              <button class="btn btn--ghost" id="xpSoundStop">Cancel</button>
              <button class="btn btn--ghost" id="xpSoundSkip">Export without it</button>
            </div>
          </footer>
        </div>`;
      let offJobs = null, offAssets = null, settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true; offJobs?.(); offAssets?.(); resolve(v);
      };
      const check = () => {
        const left = pendingIds();
        const jobs = pendingAudio(left);
        const cur = jobs.find(j => j.started) || jobs[0];
        const done = total - left.length;
        const frac = (done + (cur?.progress || 0)) / total;
        const count = root.querySelector('#xpSoundCount');
        if (count) count.textContent = `${Math.min(total, done + 1)} of ${total}`;
        const fill = root.querySelector('#xpSoundFill');
        if (fill) fill.style.width = `${(frac * 100).toFixed(1)}%`;
        const name = root.querySelector('#xpSoundName');
        if (name && cur) name.textContent = `${cur.name} · ${Math.round((cur.progress || 0) * 100)}%`;
        if (!left.length) finish(true);
      };
      root.querySelector('#xpSoundStop').addEventListener('click', () => finish(false));
      root.querySelector('#xpSoundSkip').addEventListener('click', () => finish(true));
      offJobs = onAudioJobs(check);
      offAssets = assets.on('change', check);
      check();
    });
  }

  /* ── Step 2: where to save, then render straight into it ─────────── */
  function paintProgress() {
    root.innerHTML = `
      <div class="modal__scrim"></div>
      <div class="modal__panel glass" role="dialog" aria-modal="true" aria-label="Exporting">
        <header class="modal__head">
          <div><b>Exporting…</b><span id="xpPhase">Starting</span></div>
        </header>
        <div class="xp-progress">
          <div class="xp-bar"><i id="xpFill" style="width:0%"></i></div>
          <div class="xp-stats">
            <b id="xpPct">0%</b>
            <span id="xpDetail">getting ready</span>
          </div>
        </div>
        <footer class="modal__foot">
          <span class="modal__hint">You can leave this open — it will tell you when it's done.</span>
          <div class="modal__actions">
            <button class="btn btn--ghost" id="xpCancel">Cancel</button>
          </div>
        </footer>
      </div>`;
    root.querySelector('#xpCancel').addEventListener('click', () => {
      cancelled = true;
      root.querySelector('#xpPhase').textContent = 'Stopping…';
    });
  }

  /**
   * The other shapes this edit can go out in, sized to match the main
   * export's sharpness (same short edge). Landscape footage in a tall or
   * square version is fitted over a blurred copy of itself, never cropped to
   * a sliver of the middle.
   */
  function extraTargets() {
    const shape = shapeOf(store);
    const p = EXPORT_PRESETS.find(x => x.id === chosen) || EXPORT_PRESETS[0];
    const { w, h } = sizeFor(p);
    const short = Math.min(w, h);
    const even = (n) => Math.round(n / 2) * 2;
    const all = [
      { ar: '9:16', name: 'Vertical — TikTok, Shorts, Reels', suffix: 'TikTok', w: even(short), h: even(short * 16 / 9) },
      { ar: '1:1', name: 'Square — feed posts', suffix: 'Square', w: even(short), h: even(short) },
      { ar: '16:9', name: 'Landscape — YouTube', suffix: 'YouTube', w: even(short * 16 / 9), h: even(short) },
    ];
    const mine = shape === 'vertical' ? '9:16' : shape === 'square' ? '1:1' : '16:9';
    return all.filter(t => t.ar !== mine && (t.ar !== store.doc.aspect));
  }

  /** The edit, re-shaped for another aspect — a view of the store, not a copy of it. */
  function shapedStore(t) {
    const doc = structuredClone(store.doc);
    doc.width = t.w; doc.height = t.h; doc.aspect = t.ar;
    const portraitOrSquare = t.h >= t.w;
    for (const tr of doc.tracks) for (const c of tr.clips) {
      if (c.type !== 'video' && c.type !== 'image') continue;
      const a = assets.get(c.assetId);
      const wide = a && a.width > a.height * 1.2;
      if (portraitOrSquare && wide && (c.fit || 'cover') === 'cover' && !c.crop && !c.keys?.['transform.x']) c.fit = 'blur';
    }
    const shadow = Object.create(store);
    shadow.doc = doc;
    return shadow;
  }

  function suggestedName() {
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = (store.doc.name || 'Strike').replace(/[^\w\- ]+/g, '').trim() || 'Strike';
    return `${safe} ${stamp}.mp4`;
  }

  /**
   * Open the destination file.
   *
   * window.gamecut.exportSink when the desktop bridge has it: the native save
   * dialog, then a `.partial` file written as the render goes, renamed into
   * place at the end. Without it (an older bridge), the old route — ask for
   * the path now, hold the file in memory, write it at the end — still in the
   * same save-first order.
   */
  async function openDestination() {
    const api = window.gamecut;
    const xs = sinkOverride || api?.exportSink;
    if (xs?.open) {
      const d = await xs.open({ suggestedName: suggestedName(), title: 'Save video' });
      if (!d) return null;
      return {
        path: d.path,
        sink: { write: (chunk, position) => xs.write(d.token, chunk, position) },
        finish: async () => {
          let r;
          try { r = await xs.close(d.token); } catch (e) { throw saveError(e); }
          if (!r?.ok) throw saveError(r?.reason || 'The video could not be saved.');
          // The chosen name was in use (open in a player, being synced): the
          // main process saved it beside it instead of losing the render.
          return { path: r.path || d.path, bytes: r.bytes, renamed: !!(r.path && r.path !== d.path), wanted: d.path };
        },
        abort: () => Promise.resolve().then(() => xs.abort(d.token)).catch(() => {}),
      };
    }
    if (api?.saveAs) {
      const path = await api.saveAs({
        title: 'Save video', defaultPath: suggestedName(),
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
      if (!path) return null;
      return {
        path, sink: null,
        finish: async (bytes) => {
          try { await api.writeFile(path, bytes); } catch (e) { throw saveError(e); }
          return { path, bytes: bytes.byteLength };
        },
        abort: async () => {},
      };
    }
    throw saveError('Strike could not reach the file system to save.');
  }

  async function run() {
    const preset = EXPORT_PRESETS.find(p => p.id === chosen);
    if (!preset) return;
    // Resolved once, here: the same object the estimate was calculated from.
    const set = settingsFor(preset);
    savePref(shapeOf(store), { chosen, custom, exact });

    playback.pause();
    setBusy(true);
    cancelled = false;

    // Sound first: an export started while a clip's sound was still being
    // read used to come out with no audio stream at all, and no warning.
    if (!(await waitForSound())) { setBusy(false); paintChooser(exportSupport()); return; }

    let dest = null;
    try {
      dest = await openDestination();
    } catch (err) {
      setBusy(false);
      paintError(saveError(err));
      return;
    }
    if (!dest) {
      // Nothing was rendered, so nothing is lost: back to the choices.
      setBusy(false);
      paintChooser(exportSupport());
      bus.emit('toast', { msg: 'Export cancelled — nothing was saved' });
      return;
    }

    paintProgress();
    const fill = () => root.querySelector('#xpFill');
    const started = performance.now();
    let encoder = null;
    let warnings = [];

    try {
      const result = await renderToMp4({
        store, width: set.w, height: set.h, fps: set.fps,
        vBitrate: set.asked, aBitrate: set.aBitrate,
        frameAccuracy: exact ? 'exact' : 'fast',
        sink: dest.sink,
        shouldCancel: () => cancelled,
        onProgress: (e) => {
          const { phase, done, total, percent, fps, seeking } = e;
          if (phase === 'encoder') {
            if (e.codec) {
              encoder = e;
              // Said where it will be read, and only when it is real: the
              // software path (size can't be controlled), or a typed figure
              // the encoder could not take.
              const show = e.path === 'software' || (e.capped && preset.custom);
              if (show && e.note) bus.emit('toast', { msg: e.note, kind: 'warn', ms: 9000 });
            }
            return;
          }
          if (phase === 'done') { warnings = e.warnings || []; return; }
          const f = fill(); if (!f) return;
          f.style.width = percent.toFixed(1) + '%';
          root.querySelector('#xpPct').textContent = Math.floor(percent) + '%';
          root.querySelector('#xpPhase').textContent =
            phase === 'video' ? 'Making the video' :
            phase === 'encoding audio' ? 'Finishing the sound' : 'Getting ready';

          if (phase === 'video' && done > 3) {
            const elapsed = (performance.now() - started) / 1000;
            const left = (elapsed / done) * (total - done);
            const rate = fps ? ` · ${fps.toFixed(1)} frames a second${seeking ? ' (catching up)' : ''}` : '';
            // Which parts are on the graphics card, so a slow export says why.
            const how = e.gpuEncode === undefined ? '' : ` · ${e.gpuEncode ? 'graphics card' : 'processor (slower)'} encoding`
              + (e.fastDecode ? `, ${e.gpuDecode ? 'graphics card' : 'processor'} decoding` : ', player decoding (slower)');
            root.querySelector('#xpDetail').textContent =
              `frame ${done} of ${total}${rate} · about ${fmtClock(left)} left${how}`;
          }
        },
      });

      if (!result) {
        await dest.abort();
        setBusy(false);
        close();
        bus.emit('toast', { msg: 'Export cancelled — nothing was saved' });
        return;
      }
      const phase = root.querySelector('#xpPhase');
      if (phase) phase.textContent = 'Saving';
      const saved = await dest.finish(result instanceof Uint8Array ? result : null);
      if (saved.renamed) {
        const base = (p) => String(p).split(/[\\/]/).pop();
        warnings = [...warnings, `"${base(saved.wanted)}" was open in another program, so Strike saved the video as "${base(saved.path)}" instead.`];
      }

      // The other shapes, one after another, saved beside the first file.
      const more = [];
      const xs = sinkOverride || window.gamecut?.exportSink;
      const targets = extraTargets().filter(t => extras.has(t.ar));
      for (let i = 0; i < targets.length && !cancelled && xs?.openBeside; i++) {
        const t = targets[i];
        const d = await xs.openBeside({ beside: saved.path, suffix: t.suffix });
        if (!d) break;
        const ph = root.querySelector('#xpPhase');
        if (ph) ph.textContent = `Making the ${t.suffix} version (${i + 1} of ${targets.length})`;
        try {
          const r = await renderToMp4({
            store: shapedStore(t), width: t.w, height: t.h, fps: set.fps,
            vBitrate: Math.round(set.asked * (t.w * t.h) / (set.w * set.h)), aBitrate: set.aBitrate,
            frameAccuracy: exact ? 'exact' : 'fast',
            sink: { write: (chunk, position) => xs.write(d.token, chunk, position) },
            shouldCancel: () => cancelled,
            onProgress: (e) => {
              if (typeof e.percent !== 'number') return;
              const f = fill(); if (f) f.style.width = e.percent.toFixed(1) + '%';
              const pc = root.querySelector('#xpPct'); if (pc) pc.textContent = Math.floor(e.percent) + '%';
            },
          });
          if (!r) { await xs.abort(d.token); break; }
          const c = await xs.close(d.token);
          if (c?.ok) more.push({ path: c.path || d.path, name: t.suffix });
        } catch (e) {
          await xs.abort?.(d.token);
          bus.emit('toast', { msg: `The ${t.suffix} version could not be made: ${e.message || e}`, kind: 'err', ms: 8000 });
        }
      }
      setBusy(false);
      paintDone(saved.path, saved.bytes ?? result.bytes ?? result.byteLength, { encoder, warnings, more });
    } catch (err) {
      await dest.abort();
      setBusy(false);
      console.warn('export failed', err);
      paintError(err);
    }
  }

  // The completion screen is only otherwise reachable through a native save
  // dialog, which a test cannot answer. Exposed so the handoff can be checked.
  initExport.__paintDone = (p, size, info) => paintDone(p, size, info);

  function paintDone(path, size, { encoder = null, warnings = [], more = [] } = {}) {
    const name = String(path).split(/[\\/]/).pop();
    const vertical = shapeOf(store) === 'vertical';
    const real = encoder
      ? `${fmtMbps(encoder.bitrate)} video${encoder.audioBitrate
        ? ` · ${encoder.audioBitrate / 1000} kbps ${esc(encoder.audioCodec || '')} sound` : ''}`
      : '';
    const upload = '<svg viewBox="0 0 24 24"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/>'
      + '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';
    root.innerHTML = `
      <div class="modal__scrim" data-close></div>
      <div class="modal__panel glass modal__panel--ok" role="dialog" aria-modal="true">
        <header class="modal__head">
          <div><b>Export complete</b><span id="xpDoneInfo">${fmtBytes(size)}${real ? ` · ${real}` : ''}</span></div>
        </header>
        ${warnings.map(w => `<div class="modal__warn">${esc(w)}</div>`).join('')}
        <div class="xp-done">
          <svg viewBox="0 0 24 24" class="xp-tick"><path d="M20 6 9 17l-5-5"/></svg>
          <div>
            <b>${esc(name)}</b>
            <span>${esc(String(path))}</span>
          </div>
        </div>
        ${more.map(m => `<div class="xp-done xp-done--more">
          <svg viewBox="0 0 24 24" class="xp-tick"><path d="M20 6 9 17l-5-5"/></svg>
          <div><b>${esc(String(m.path).split(/[\\/]/).pop())}</b><span>${esc(m.name)} version, beside it</span></div>
        </div>`).join('')}
        <footer class="modal__foot">
          <span class="modal__hint">Opens ${vertical ? 'TikTok' : 'YouTube'} in your browser with this file ready to drag in.</span>
          <div class="modal__actions">
            <button class="btn btn--ghost" id="xpReveal">Show file</button>
            ${vertical ? `<button class="btn btn--primary" id="xpTikTok">${upload} Upload to TikTok</button>` : ''}
            <button class="btn ${vertical ? 'btn--ghost' : 'btn--primary'}" id="xpYouTube">
              ${vertical ? 'YouTube Shorts' : `${upload} Upload to YouTube`}
            </button>
            <button class="btn btn--ghost" data-close>Done</button>
          </div>
        </footer>
      </div>`;
    root.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));

    const api = window.gamecut;
    root.querySelector('#xpReveal')?.addEventListener('click', () => api?.revealFile?.(path));

    /**
     * Open the site's own upload page and put the file under the cursor.
     *
     * Deliberately not an account login inside the editor. Uploading through
     * YouTube's API from an app Google has not audited forces every video to
     * private and locks it there, so signing in here would cost the network
     * lockdown and the sign-in flow and still leave you opening YouTube Studio
     * to make anything unlisted or public. Handing the browser the file instead
     * takes one click, keeps the app offline, and leaves the privacy setting,
     * the title and the thumbnail where they are meant to be chosen. TikTok is
     * the same, for the same reasons. The page names a KEY, never a URL — the
     * main process owns the list (see electron-main.cjs).
     */
    const handoff = (key, site) => async () => {
      const opened = await api?.openTarget?.(key);
      // Reveal second: the file manager should end up in front of the browser,
      // because dragging out of it is the next thing that happens.
      await api?.revealFile?.(path);
      bus.emit('toast', {
        msg: opened
          ? `${site} is open in your browser — drag the highlighted file onto the page.`
          : 'Could not open your browser. The file is highlighted in Explorer.',
        kind: opened ? 'ok' : 'err',
        ms: 7000,
      });
      close();
    };
    root.querySelector('#xpYouTube')?.addEventListener('click', handoff('youtube-upload', 'YouTube'));
    root.querySelector('#xpTikTok')?.addEventListener('click', handoff('tiktok-upload', 'TikTok'));

    bus.emit('toast', { msg: `Saved ${name}`, kind: 'ok' });
  }

  /**
   * A failure, with a hint that fits the failure.
   *
   * The old screen said "Try the 720p draft preset — the resolution was too
   * high" for everything, including a folder that could not be written to,
   * which sent people round in circles lowering a resolution that had nothing
   * to do with it.
   */
  function paintError(err) {
    const kind = err?.kind;
    const hint = kind === 'save'
      ? 'Your edit is fine — the video just couldn\'t be written there. Pick another folder '
        + '(your Videos folder always works), close the file if another program has it open, '
        + 'or free up some disk space, then press Back and export again.'
      : kind === 'encoder'
        ? 'Try a smaller size or a lower frame rate (Custom), or the Quick draft.'
        : 'Press Back to try again.';
    root.innerHTML = `
      <div class="modal__scrim" data-close></div>
      <div class="modal__panel glass" role="dialog" aria-modal="true">
        <header class="modal__head"><div><b>${kind === 'save' ? 'Couldn\'t save the video' : 'Export failed'}</b>
          <span>Nothing was saved</span></div></header>
        <div class="modal__warn" id="xpErr">${esc(String(err?.message || err))}</div>
        <footer class="modal__foot">
          <span class="modal__hint" id="xpErrHint">${hint}</span>
          <div class="modal__actions">
            <button class="btn btn--ghost" data-close>Close</button>
            <button class="btn btn--primary" id="xpRetry">Back</button>
          </div>
        </footer>
      </div>`;
    root.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
    root.querySelector('#xpRetry').addEventListener('click', () => paintChooser(exportSupport()));
  }

  document.getElementById('btnExport')?.addEventListener('click', open);
  return { open, close };
}

/** A saving problem, worded for a person and marked so the hint fits. */
function saveError(e) {
  if (e?.kind === 'save') return e;
  const msg = String(e?.message || e || 'The video could not be saved.')
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const err = new Error(msg);
  err.kind = 'save';
  return err;
}
