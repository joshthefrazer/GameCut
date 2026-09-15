import { EXPORT_PRESETS, EXPORT_FPS, EXPORT_SCALES } from '../project/presets.js';
import { renderToMp4, exportSupport } from './render-export.js';
import { bus } from '../core/events.js';
import { timecode } from '../core/time.js';
import { unmixableClips } from '../audio/graph.js';
import { assets } from '../media/asset-store.js';
import {
  sourceBitrate, bitrateForPreset, matchSource, clampBitrate, fmtMbps,
  MIN_CUSTOM_BITRATE, MAX_CUSTOM_BITRATE,
} from './quality.js';

/**
 * Export dialog.
 *
 * Deliberately plain: pick where the video is going, press Export, watch a bar.
 * Resolution and bitrate are shown but never asked for — the preset decides,
 * because "which H.264 level do you want" is not a question anyone should have
 * to answer to post a clip.
 */

/**
 * Which presets to offer, and what to call them.
 *
 * Output size always follows the project's own shape, so a preset labelled
 * "Shorts / TikTok" on a 16:9 project would offer a landscape file under a
 * vertical name. Instead the quality tiers are fixed and the destination text
 * is derived from the project — truthful in every orientation, and three
 * choices instead of five.
 */
function choicesFor(store) {
  const vertical = store.doc.height > store.doc.width;
  const square = store.doc.height === store.doc.width;
  const where = vertical ? 'TikTok, Reels and Shorts'
    : square ? 'Instagram and feed posts'
    : 'YouTube and most sites';

  const ids = vertical || square
    ? ['short4k', 'short', 'draft', 'custom']
    : ['yt4k', 'yt1080', 'draft', 'custom'];
  const labels = {
    0: { title: 'Best quality', note: `Sharpest picture for ${where}. Biggest file, slowest to make.` },
    1: { title: 'Recommended', note: `Great for ${where}. This is the one to pick if unsure.` },
    2: { title: 'Quick draft', note: 'Rough version to check your edit. Much faster, lower quality.' },
    3: { title: 'Custom', note: 'Set the quality, size and frame rate yourself.' },
  };
  return ids.map((id, i) => ({ id, ...labels[i] })).filter(x => x.id);
}

const fmtBytes = (n) => n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
const fmtClock = (s) => {
  if (!Number.isFinite(s) || s < 0) return '—';
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
};

export const __paintDoneForTest = (...a) => initExport.__paintDone?.(...a);

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
   * It does survive closing and reopening the dialog, which is the part that
   * would actually annoy anyone.
   */
  let custom = { vBitrate: 0, aBitrate: 320_000, fps: 0, scale: 1 };

  /** Output size for a preset, derived from the project's own aspect. */
  const sizeFor = (p) => {
    const scale = p.custom ? custom.scale : p.scale;
    const w = Math.round(store.doc.width * scale / 2) * 2;
    const h = Math.round(store.doc.height * scale / 2) * 2;
    return { w, h };
  };

  /**
   * Everything the renderer needs, for one preset — the single place the
   * preset's own numbers, the footage's bitrate and the custom controls are
   * reconciled. Both the size estimate and the export itself read this, so
   * what the dialog promises and what it renders cannot drift apart.
   */
  const settingsFor = (p) => {
    const { w, h } = sizeFor(p);
    const src = sourceBitrate(store, assets);
    if (p.custom) {
      return {
        w, h,
        fps: custom.fps || store.doc.fps || 60,
        vBitrate: clampBitrate(custom.vBitrate || bitrateForPreset(p, src)),
        aBitrate: custom.aBitrate,
      };
    }
    return { w, h, fps: p.fps, vBitrate: bitrateForPreset(p, src), aBitrate: p.aBitrate };
  };

  const estimate = (p) => {
    const s = settingsFor(p);
    const secs = Math.max(1, store.rt.duration);
    return ((s.vBitrate + s.aBitrate) * secs) / 8;
  };

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
   */
  function customPanel() {
    const p = EXPORT_PRESETS.find(x => x.id === 'custom');
    const s = settingsFor(p);
    const src = sourceBitrate(store, assets);
    const maxSlider = Math.max(120e6, Math.ceil((src * 1.5) / 10e6) * 10e6);

    return `
      <div class="xp-custom" id="xpCustom" ${chosen === 'custom' ? '' : 'hidden'}>
        <div class="xp-row">
          <label for="xpRate"><b>Quality</b>
            <span>Higher keeps more detail and makes a bigger file.</span></label>
          <div class="xp-rate">
            <input type="range" id="xpRateSlide" min="${MIN_CUSTOM_BITRATE}"
                   max="${maxSlider}" step="500000" value="${s.vBitrate}">
            <span class="xp-num">
              <input type="number" id="xpRate" min="1"
                     max="${Math.round(MAX_CUSTOM_BITRATE / 1e6)}" step="0.5"
                     value="${mbpsText(s.vBitrate)}">
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
            ${[128_000, 192_000, 256_000, 320_000].map(b =>
              `<option value="${b}" ${b === custom.aBitrate ? 'selected' : ''}>${b / 1000} kbps${b === 320_000 ? ' · best' : ''}</option>`).join('')}
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
    if (!list.some(c => c.id === chosen)) chosen = (list[1] || list[0]).id;
    const sup = exportSupport();
    cancelled = false;
    setBusy(false);
    root.hidden = false;
    document.addEventListener('keydown', onKey, true);
    paintChooser(sup);
  }

  /* ── Step 1: pick a destination ───────────────────────────────────── */
  function paintChooser(sup) {
    const dur = Math.max(0, store.rt.duration);
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

        ${!sup.ok ? `<div class="modal__warn">${sup.reason}</div>`
          : sup.audio === false ? `<div class="modal__warn">${sup.reason}</div>` : ''}
        ${(() => {
          // Clips too long to decode into memory play fine in the preview but
          // cannot be mixed into the exported file yet. Say so before the
          // render, not after — silence you only discover on upload is worse
          // than silence you were warned about.
          const silent = unmixableClips(store);
          if (!silent.length) return '';
          const names = silent.slice(0, 3).map(c => c.name).join(', ');
          return `<div class="modal__warn">The exported video will be silent for
            ${silent.length === 1 ? names : names + (silent.length > 3 ? ' and others' : '')}
            — long recordings are played directly rather than held in memory, and
            that audio can't be mixed into the file yet. Shorter music and sound
            clips export normally.</div>`;
        })()}

        <div class="xp-list" id="xpList">
          ${choicesFor(store).map(choice => {
            const p = EXPORT_PRESETS.find(x => x.id === choice.id);
            if (!p) return '';
            const s = settingsFor(p);
            const meta = choice;
            return `<button class="xp ${p.id === chosen ? 'is-on' : ''}" data-preset="${p.id}">
              <span class="xp__radio"></span>
              <span class="xp__text">
                <b>${meta.title}</b>
                <span>${meta.note}</span>
              </span>
              <span class="xp__meta">
                <b>${s.w}×${s.h}</b>
                <span>~${fmtBytes(estimate(p))} · ${s.fps}fps · ${fmtMbps(s.vBitrate)}</span>
              </span>
            </button>`;
          }).join('')}
        </div>

        ${customPanel()}

        <label class="xp-exact">
          <input type="checkbox" id="xpExact">
          <span>
            <b>Frame-exact render (slower)</b>
            <span>Normally the footage is played through, which is about three
            times quicker. The frame used can land up to one source frame from
            the exact moment — invisible, but not identical on every computer.
            Tick this to seek to every frame instead, which is slower and always
            produces the same file.</span>
          </span>
        </label>

        <footer class="modal__foot">
          <span class="modal__hint">Renders frame by frame, so nothing is dropped.</span>
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
    }));
    wireCustom();
    root.querySelector('#xpGo')?.addEventListener('click', run);
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

    const refresh = () => {
      const p = EXPORT_PRESETS.find(x => x.id === 'custom');
      const s = settingsFor(p);
      const tile = root.querySelector('[data-preset="custom"] .xp__meta');
      if (tile) {
        tile.innerHTML = `<b>${s.w}×${s.h}</b>`
          + `<span>~${fmtBytes(estimate(p))} · ${s.fps}fps · ${fmtMbps(s.vBitrate)}</span>`;
      }
      const size = root.querySelector('#xpCustomSize');
      if (size) size.textContent = `~${fmtBytes(estimate(p))}`;
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

  /* ── Step 2: render ───────────────────────────────────────────────── */
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
            <span id="xpDetail">preparing</span>
          </div>
        </div>
        <footer class="modal__foot">
          <span class="modal__hint">You can keep this window open — it will tell you when it's done.</span>
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

  async function run() {
    const preset = EXPORT_PRESETS.find(p => p.id === chosen);
    if (!preset) return;
    // Resolved once, here: the same object the estimate was calculated from.
    const set = settingsFor(preset);
    // Read it before the progress view replaces the form.
    const exact = !!root.querySelector('#xpExact')?.checked;

    playback.pause();
    setBusy(true);
    cancelled = false;
    paintProgress();

    const fill = () => root.querySelector('#xpFill');
    const started = performance.now();

    try {
      const bytes = await renderToMp4({
        store, width: set.w, height: set.h, fps: set.fps,
        vBitrate: set.vBitrate, aBitrate: set.aBitrate,
        frameAccuracy: exact ? 'exact' : 'fast',
        shouldCancel: () => cancelled,
        onProgress: ({ phase, done, total, percent, fps, seeking, note }) => {
          // The encoder can report that it would not take the bitrate asked
          // for. Say so where it will be read, rather than in the console.
          if (phase === 'encoder') {
            if (note) bus.emit('toast', { msg: note, kind: 'warn' });
            return;
          }
          const f = fill(); if (!f) return;
          f.style.width = percent.toFixed(1) + '%';
          root.querySelector('#xpPct').textContent = Math.floor(percent) + '%';
          root.querySelector('#xpPhase').textContent =
            phase === 'video' ? 'Rendering frames' :
            phase === 'audio' ? 'Mixing audio' :
            phase === 'encoding audio' ? 'Encoding audio' : 'Finishing';

          if (phase === 'video' && done > 3) {
            const elapsed = (performance.now() - started) / 1000;
            const left = (elapsed / done) * (total - done);
            const rate = fps ? ` · ${fps.toFixed(1)} fps${seeking ? ' (seeking)' : ''}` : '';
            root.querySelector('#xpDetail').textContent =
              `frame ${done} of ${total}${rate} · about ${fmtClock(left)} left`;
          }
        },
      });

      setBusy(false);
      if (!bytes) { close(); bus.emit('toast', { msg: 'Export cancelled' }); return; }
      await save(bytes, preset);
    } catch (err) {
      setBusy(false);
      console.error('export failed', err);
      paintError(err);
    }
  }

  /* ── Step 3: write it to disk ─────────────────────────────────────── */
  async function save(bytes, preset) {
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = (store.doc.name || 'GameCut').replace(/[^\w\- ]+/g, '').trim() || 'GameCut';
    const suggested = `${safe} ${stamp}.mp4`;

    const api = window.gamecut;
    if (api?.saveAs) {
      const path = await api.saveAs({
        title: 'Save video',
        defaultPath: suggested,
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
      if (!path) { close(); bus.emit('toast', { msg: 'Export finished — not saved' }); return; }
      await api.writeFile(path, bytes);
      paintDone(path, bytes.byteLength);
    } else {
      // No desktop bridge (shouldn't happen in the packaged app).
      paintError(new Error('Could not reach the file system to save.'));
    }
  }

  // The completion screen is only otherwise reachable through a native save
  // dialog, which a test cannot answer. Exposed so the handoff can be checked.
  initExport.__paintDone = (p, size) => paintDone(p, size);

  function paintDone(path, size) {
    const name = String(path).split(/[\\/]/).pop();
    root.innerHTML = `
      <div class="modal__scrim" data-close></div>
      <div class="modal__panel glass modal__panel--ok" role="dialog" aria-modal="true">
        <header class="modal__head">
          <div><b>Export complete</b><span>${fmtBytes(size)}</span></div>
        </header>
        <div class="xp-done">
          <svg viewBox="0 0 24 24" class="xp-tick"><path d="M20 6 9 17l-5-5"/></svg>
          <div>
            <b>${name}</b>
            <span>${String(path)}</span>
          </div>
        </div>
        <footer class="modal__foot">
          <span class="modal__hint">Opens YouTube in your browser with this file ready to drag in.</span>
          <div class="modal__actions">
            <button class="btn btn--ghost" id="xpReveal">Show file</button>
            <button class="btn btn--primary" id="xpYouTube">
              <svg viewBox="0 0 24 24"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
              Upload to YouTube
            </button>
            <button class="btn btn--ghost" data-close>Done</button>
          </div>
        </footer>
      </div>`;
    root.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));

    const api = window.gamecut;
    root.querySelector('#xpReveal')?.addEventListener('click', () => api?.revealFile?.(path));

    /**
     * Open YouTube's own upload page and put the file under the cursor.
     *
     * Deliberately not an account login inside the editor. Uploading through
     * YouTube's API from an app Google has not audited forces every video to
     * private and locks it there, so signing in here would cost the network
     * lockdown and the sign-in flow and still leave you opening YouTube Studio
     * to make anything unlisted or public. Handing the browser the file instead
     * takes one click, keeps the app offline, and leaves the privacy setting,
     * the title and the thumbnail where they are meant to be chosen.
     */
    root.querySelector('#xpYouTube')?.addEventListener('click', async () => {
      const opened = await api?.openTarget?.('youtube-upload');
      // Reveal second: the file manager should end up in front of the browser,
      // because dragging out of it is the next thing that happens.
      await api?.revealFile?.(path);
      bus.emit('toast', {
        msg: opened
          ? 'YouTube is open in your browser — drag the highlighted file onto the page.'
          : 'Could not open your browser. The file is highlighted in Explorer.',
        kind: opened ? 'ok' : 'err',
        ms: 7000,
      });
      close();
    });

    bus.emit('toast', { msg: `Saved ${name}`, kind: 'ok' });
  }

  function paintError(err) {
    root.innerHTML = `
      <div class="modal__scrim" data-close></div>
      <div class="modal__panel glass" role="dialog" aria-modal="true">
        <header class="modal__head"><div><b>Export failed</b><span>Nothing was saved</span></div></header>
        <div class="modal__warn">${String(err?.message || err)}</div>
        <footer class="modal__foot">
          <span class="modal__hint">Try the 720p draft preset — if that works, the resolution was too high for this machine's encoder.</span>
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
