import { EXPORT_PRESETS } from '../project/presets.js';
import { renderToMp4, exportSupport } from './render-export.js';
import { bus } from '../core/events.js';
import { timecode } from '../core/time.js';
import { unmixableClips } from '../audio/graph.js';

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

  const ids = vertical || square ? ['short4k', 'short', 'draft'] : ['yt4k', 'yt1080', 'draft'];
  const labels = {
    0: { title: 'Best quality', note: `Sharpest picture for ${where}. Biggest file, slowest to make.` },
    1: { title: 'Recommended', note: `Great for ${where}. This is the one to pick if unsure.` },
    2: { title: 'Quick draft', note: 'Rough version to check your edit. Much faster, lower quality.' },
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

  /** Output size for a preset, derived from the project's own aspect. */
  const sizeFor = (p) => {
    const w = Math.round(store.doc.width * p.scale / 2) * 2;
    const h = Math.round(store.doc.height * p.scale / 2) * 2;
    return { w, h };
  };

  const estimate = (p) => {
    const secs = Math.max(1, store.rt.duration);
    return ((p.vBitrate + p.aBitrate) * secs) / 8;
  };

  function close() {
    if (busy) return;                       // never vanish mid-render
    root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); if (!busy) close(); }
  }

  function open() {
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
            const { w, h } = sizeFor(p);
            const meta = choice;
            return `<button class="xp ${p.id === chosen ? 'is-on' : ''}" data-preset="${p.id}">
              <span class="xp__radio"></span>
              <span class="xp__text">
                <b>${meta.title}</b>
                <span>${meta.note}</span>
              </span>
              <span class="xp__meta">
                <b>${w}×${h}</b>
                <span>~${fmtBytes(estimate(p))} · ${p.fps}fps</span>
              </span>
            </button>`;
          }).join('')}
        </div>

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
    }));
    root.querySelector('#xpGo')?.addEventListener('click', run);
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
    const { w, h } = sizeFor(preset);
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
        store, width: w, height: h, fps: preset.fps,
        vBitrate: preset.vBitrate, aBitrate: preset.aBitrate,
        frameAccuracy: exact ? 'exact' : 'fast',
        shouldCancel: () => cancelled,
        onProgress: ({ phase, done, total, percent, fps, seeking }) => {
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
