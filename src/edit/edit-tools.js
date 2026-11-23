/**
 * Editing tools for the keyboard (Strike 3.0, Update A).
 *
 *   I / O            mark In / Out at the playhead (the range shows on the ruler)
 *   Alt+X            clear In and Out
 *   Shift+I / Shift+O  jump to In / Out
 *   J / K / L        shuttle: L plays (again = faster), J plays backwards (again = faster), K stops
 *   , / .            one frame back / forward (the arrows still do this too)
 *   Alt+[ / Alt+]    trim the start / end of the clip at the playhead to the playhead
 *   Ctrl+G           go to a time you type (1:23, 83, 1:23.12, 2m5s…)
 *   Palette          Lift (remove In to Out, leave the gap), Extract (remove it and close the gap)
 *
 * Tools, not autopilot: each does exactly one edit you asked for, in one undo step.
 */
import { bus } from '../core/events.js';

const EPS = 1e-4;

export function initEditTools({ store, cmds, history, playback }) {
  const fps = () => store.doc.fps || 30;
  const q = (t) => Math.round(t * fps()) / fps();
  const fmt = (t) => {
    const f = fps();
    const s = Math.max(0, t);
    const m = Math.floor(s / 60), sec = Math.floor(s % 60), fr = Math.round((s - Math.floor(s)) * f);
    return `${m}:${String(sec).padStart(2, '0')}.${String(Math.min(fr, Math.ceil(f) - 1)).padStart(2, '0')}`;
  };
  const say = (msg, extra = {}) => bus.emit('toast', { msg, key: 'edittools', ms: 2600, ...extra });
  const repaint = () => { bus.emit('timeline:repaint'); window.gc?.timeline?.repaint?.(); };

  /* ── In / Out ──────────────────────────────────────────────── */
  const range = () => store.doc.range || null;
  /** Both ends set and the right way round, or null. */
  function fullRange() {
    const r = range();
    if (!r || r.in == null || r.out == null || !(r.out - r.in > EPS)) return null;
    return { in: r.in, out: r.out };
  }
  function setMark(which, t = store.rt.playhead) {
    const v = q(t);
    history.run(which === 'in' ? 'Mark In' : 'Mark Out', (doc) => {
      const r = { ...(doc.range || {}) };
      r[which] = v;
      // Marking In after Out (or Out before In) starts a fresh range from this end.
      if (r.in != null && r.out != null && r.out - r.in <= EPS) {
        if (which === 'in') r.out = null; else r.in = null;
      }
      doc.range = r;
    });
    repaint();
    const fr = fullRange();
    say(fr ? `In ${fmt(fr.in)} → Out ${fmt(fr.out)} (${(fr.out - fr.in).toFixed(2)} s). Export, loop, Lift and Extract can use it.`
           : `${which === 'in' ? 'In' : 'Out'} marked at ${fmt(v)}. Now press ${which === 'in' ? 'O for Out' : 'I for In'}.`);
  }
  function clearMarks() {
    if (!range()) { say('There is no In or Out to clear.'); return; }
    history.run('Clear In / Out', (doc) => { delete doc.range; });
    repaint();
    say('In and Out cleared.');
  }
  function goMark(which) {
    const r = range();
    if (r?.[which] == null) { say(`No ${which === 'in' ? 'In' : 'Out'} mark yet. Press ${which === 'in' ? 'I' : 'O'} to set one.`); return; }
    playback.pause(); playback.seek(r[which]);
  }

  /**
   * Remove what lies between In and Out on every unlocked lane.
   * `close`: Extract (everything after moves up). Otherwise Lift (a gap is left).
   */
  function removeRange(close) {
    const r = fullRange();
    if (!r) { say('Set an In (I) and an Out (O) first, around the part to take out.'); return; }
    const span = r.out - r.in;
    let removed = 0, locked = 0;
    cmds.batch(close ? 'Extract In to Out' : 'Lift In to Out', () => {
      cmds.splitAt(r.in, []);
      cmds.splitAt(r.out, []);
      history.run(close ? 'Extract' : 'Lift', (doc) => {
        for (const track of doc.tracks) {
          if (track.locked) { if (track.clips.some(c => c.start < r.out - EPS && c.start + c.duration > r.in + EPS)) locked++; continue; }
          const keep = [];
          for (const c of track.clips) {
            const inside = c.start >= r.in - EPS && c.start + c.duration <= r.out + EPS;
            if (inside && !c.locked) { removed++; continue; }
            if (close && c.start >= r.out - EPS) c.start = q(c.start - span);
            keep.push(c);
          }
          track.clips = keep;
        }
        if (close) {
          // Markers inside what was taken out go with it; later ones move up with the footage.
          doc.markers = (doc.markers || []).filter(m => !(m.t > r.in + EPS && m.t < r.out - EPS));
          for (const m of doc.markers) if (m.t >= r.out - EPS) m.t = q(m.t - span);
          doc.range = { in: r.in, out: null };
        }
      });
    });
    store.select([]);
    if (close) playback.seek(r.in);
    repaint();
    say((close ? `Took out ${span.toFixed(2)} s and closed the gap` : `Took out ${span.toFixed(2)} s, leaving a gap`)
      + (removed ? '' : ' (there was nothing in it)') + (locked ? ` · ${locked} locked lane${locked === 1 ? '' : 's'} left alone` : ''),
      { action: { label: 'Undo', run: () => history.undo() }, ms: 4200 });
  }

  /* ── Trim to the playhead ──────────────────────────────────── */
  /** The clips to trim: the selected ones under the playhead, else every clip under it on unlocked lanes. */
  function underPlayhead() {
    const t = store.rt.playhead;
    const sel = new Set(store.rt.selection);
    const out = [];
    for (const track of store.doc.tracks) {
      if (track.locked) continue;
      for (const c of track.clips) {
        if (c.locked) continue;
        if (c.start < t - EPS && c.start + c.duration > t + EPS) out.push(c);
      }
    }
    const picked = out.filter(c => sel.has(c.id));
    return picked.length ? picked : out;
  }
  function trimToPlayhead(edge) {
    const list = underPlayhead();
    if (!list.length) { say('Put the playhead inside a clip first.'); return; }
    const t = q(store.rt.playhead);
    cmds.batch(edge === 'in' ? 'Trim start to playhead' : 'Trim end to playhead', () => {
      for (const c of list) cmds.trimClip(c.id, edge, t, false);
    });
    repaint();
    say(`${edge === 'in' ? 'Start' : 'End'} of ${list.length === 1 ? (list[0].name || 'the clip') : list.length + ' clips'} trimmed to the playhead`,
      { action: { label: 'Undo', run: () => history.undo() } });
  }

  /* ── Slip: change what plays inside a clip, the clip stays put ── */
  function slip(frames) {
    const list = store.selectedClips.filter(({ clip, track }) => !track.locked && !clip.locked && clip.inPoint != null
      && (clip.type === 'video' || clip.type === 'audio'));
    if (!list.length) { say('Select a video or sound clip first. Alt+, and Alt+. slide what plays inside it.'); return; }
    const assetsApi = window.gc?.assets;
    let moved = 0, stuck = 0;
    for (const { clip } of list) {
      const sp = clip.speed || 1;
      const srcDur = assetsApi?.get?.(clip.assetId)?.duration;
      const max = Number.isFinite(srcDur) ? Math.max(0, srcDur - clip.duration * sp) : Infinity;
      const next = Math.min(max, Math.max(0, (clip.inPoint || 0) + (frames / fps()) * sp));
      if (Math.abs(next - (clip.inPoint || 0)) < 1e-6) { stuck++; continue; }
      cmds.setClipProp(clip.id, 'inPoint', +next.toFixed(6), { merge: true, label: 'Slip' });
      moved++;
    }
    window.gc?.comp?.render?.();
    if (!moved && stuck) say('That is as far as the recording goes.');
  }

  /* ── Shuttle: J / K / L ────────────────────────────────────── */
  let rate = 0, raf = 0, last = 0, chip = null;
  // The shuttle's own exact position: the playhead snaps to whole frames, so adding a
  // small step to it each screen refresh could round back to the same frame forever
  // (J at 1× in a 30 fps project on a 60 Hz screen never moved).
  let pos = 0, own = false;
  const showChip = () => {
    chip ||= (() => {
      const host = document.getElementById('previewViewport') || document.getElementById('previewPanel') || document.body;
      const el = document.createElement('div');
      el.className = 'shuttle';
      el.id = 'shuttleChip';
      el.setAttribute('aria-live', 'polite');
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(el);
      return el;
    })();
    chip.textContent = rate === 0 ? '' : `${rate > 0 ? '▶▶' : '◀◀'} ${Math.abs(rate)}×`;
    chip.classList.toggle('is-on', rate !== 0 && !(rate === 1 && store.rt.playing));
  };
  function stopShuttle() {
    cancelAnimationFrame(raf); raf = 0;
    rate = 0;
    showChip();
  }
  function runShuttle() {
    // Faster than normal, or backwards: the picture moves and the sound stays quiet.
    playback.pause();
    cancelAnimationFrame(raf);
    last = performance.now();
    pos = store.rt.playhead;
    const tick = (now) => {
      if (!rate) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      pos += dt * rate;
      own = true;
      try {
        if (pos <= 0 || pos >= store.rt.duration) { playback.seek(Math.max(0, Math.min(store.rt.duration, pos))); own = false; stopShuttle(); return; }
        // Only ask for a new picture when the frame actually changes.
        if (Math.abs(q(pos) - store.rt.playhead) > 1e-6) playback.seek(pos, { fromUser: false });
      } finally { own = false; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    showChip();
  }
  function shuttle(dir) {
    if (dir === 0) { stopShuttle(); playback.pause(); return; }
    if (dir > 0) {
      if (rate <= 0 && !store.rt.playing) { stopShuttle(); rate = 1; playback.play(); showChip(); return; }
      rate = Math.min(8, Math.max(1, rate) * 2);
    } else {
      rate = rate >= 0 ? -1 : Math.max(-8, rate * 2);
    }
    runShuttle();
  }
  // Anything else that starts or stops playback ends the shuttle.
  store.on?.('rt', () => {
    if (rate === 1 && !store.rt.playing) { rate = 0; showChip(); }
    // Play pressed (button or Space) during a fast or backwards shuttle: normal play wins.
    if (rate !== 0 && rate !== 1 && store.rt.playing) stopShuttle();
  });
  // Dragging the playhead, a click on the ruler, Home / End… during a shuttle stops it.
  store.on?.('playhead', () => { if (rate !== 0 && rate !== 1 && !own) stopShuttle(); });

  /* ── Go to a time ──────────────────────────────────────────── */
  /** "1:23", "83", "1:23.12" (frames after the dot), "1:02:03", "2m5s", "+2" / "-1.5" (from the playhead). */
  function parseTime(text) {
    const s = String(text || '').trim().toLowerCase().replace(',', '.');
    if (!s) return null;
    const rel = /^[+-]/.test(s) ? (s[0] === '-' ? -1 : 1) : 0;
    const body = rel ? s.slice(1).trim() : s;
    let t = null;
    let m;
    if ((m = body.match(/^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/)) && (m[1] || m[2] || m[3])) {
      t = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    } else if (/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(body)) {
      const [main, frac] = body.split('.');
      const parts = main.split(':').map(Number);
      t = parts.reduce((a, p) => a * 60 + p, 0);
      // After a colon form the digits past the dot are frames (as on the ruler); a plain number is seconds.
      if (frac != null) t += parts.length > 1 ? Math.min(+frac, fps() - 1) / fps() : +('0.' + frac);
    }
    if (t == null || !Number.isFinite(t)) return null;
    return rel ? store.rt.playhead + rel * t : t;
  }
  let gotoEl = null;
  function openGoTo() {
    if (!gotoEl) {
      gotoEl = document.createElement('div');
      gotoEl.className = 'mini';
      gotoEl.id = 'goToTime';
      gotoEl.hidden = true;
      gotoEl.setAttribute('role', 'dialog');
      gotoEl.setAttribute('aria-modal', 'true');
      gotoEl.setAttribute('aria-label', 'Go to a time');
      gotoEl.innerHTML = `<div class="mini__box">
        <b>Go to a time</b>
        <input type="text" id="goToInput" spellcheck="false" autocomplete="off" aria-label="Time">
        <p id="goToNote">Type 1:23, 83 (seconds), 1:23.12 (12 frames in), 2m5s, or +2 / -1.5 to move from here. Enter to go, Esc to close.</p>
      </div>`;
      document.body.appendChild(gotoEl);
      const input = gotoEl.querySelector('input');
      const note = gotoEl.querySelector('#goToNote');
      const close = () => { gotoEl.hidden = true; };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Enter') {
          e.preventDefault();
          const t = parseTime(input.value);
          if (t == null) { note.textContent = 'That is not a time Strike understands. Try 1:23 or 83.'; note.classList.add('mini__err'); return; }
          playback.pause();
          playback.seek(Math.max(0, Math.min(store.rt.duration, t)));
          close();
        }
      });
      gotoEl.addEventListener('pointerdown', (e) => { if (e.target === gotoEl) close(); });
      // Esc closes it wherever the focus went (and before any other Esc handler gets it).
      window.addEventListener('keydown', (e) => {
        if (gotoEl.hidden || e.key !== 'Escape') return;
        e.preventDefault(); e.stopPropagation(); close();
      }, true);
      input.addEventListener('blur', () => setTimeout(() => { if (!gotoEl.contains(document.activeElement)) close(); }, 0));
    }
    const input = gotoEl.querySelector('input');
    const note = gotoEl.querySelector('#goToNote');
    note.classList.remove('mini__err');
    note.textContent = 'Type 1:23, 83 (seconds), 1:23.12 (12 frames in), 2m5s, or +2 / -1.5 to move from here. Enter to go, Esc to close.';
    input.value = fmt(store.rt.playhead);
    gotoEl.hidden = false;
    input.focus(); input.select();
  }

  /* ── Transport: click the time to type one; the In–Out length beside it ── */
  const tc = document.getElementById('tcCurrent');
  if (tc) {
    tc.title = 'Click to go to a time you type (Ctrl+G)';
    tc.style.cursor = 'pointer';
    tc.addEventListener('click', openGoTo);
  }
  const tot = document.getElementById('tcTotal')?.parentElement;
  let chipEl = null;
  if (tot) {
    chipEl = document.createElement('button');
    chipEl.type = 'button';
    chipEl.className = 'tc tc--dim rangechip';
    chipEl.id = 'rangeChip';
    chipEl.hidden = true;
    chipEl.title = 'The part between In and Out (I / O). Click to jump to In; Alt+X clears it.';
    chipEl.addEventListener('click', () => goMark('in'));
    tot.after(chipEl);
  }
  const paintChip = () => {
    if (!chipEl) return;
    const r = range();
    const fr = fullRange();
    chipEl.hidden = !r || (r.in == null && r.out == null);
    if (chipEl.hidden) return;
    chipEl.textContent = fr ? `IN–OUT ${(fr.out - fr.in).toFixed(2)} s` : r.in != null ? `IN ${fmt(r.in)}` : `OUT ${fmt(r.out)}`;
  };
  store.on?.('doc', paintChip);
  store.on?.('history', paintChip);
  paintChip();

  /* ── Palette ───────────────────────────────────────────────── */
  bus.emit('palette:add', [
    { id: 'mark-in', name: 'Mark In at the playhead', sec: 'Edit', key: 'I', run: () => setMark('in') },
    { id: 'mark-out', name: 'Mark Out at the playhead', sec: 'Edit', key: 'O', run: () => setMark('out') },
    { id: 'mark-clear', name: 'Clear In and Out', sec: 'Edit', key: 'Alt+X', run: clearMarks },
    { id: 'go-in', name: 'Go to In', sec: 'Jump', key: 'Shift+I', run: () => goMark('in') },
    { id: 'go-out', name: 'Go to Out', sec: 'Jump', key: 'Shift+O', run: () => goMark('out') },
    { id: 'lift', name: 'Lift: remove In to Out, leave the gap', sec: 'Edit', run: () => removeRange(false) },
    { id: 'extract-range', name: 'Extract: remove In to Out and close the gap', sec: 'Edit', run: () => removeRange(true) },
    { id: 'trim-in', name: 'Trim the start of the clip to the playhead', sec: 'Edit', key: 'Alt+[', run: () => trimToPlayhead('in') },
    { id: 'trim-out', name: 'Trim the end of the clip to the playhead', sec: 'Edit', key: 'Alt+]', run: () => trimToPlayhead('out') },
    { id: 'slip-back', name: 'Slip: show an earlier part of the recording inside the clip', sec: 'Edit', key: 'Alt+,', run: () => slip(-1) },
    { id: 'slip-fwd', name: 'Slip: show a later part of the recording inside the clip', sec: 'Edit', key: 'Alt+.', run: () => slip(1) },
    { id: 'shuttle-fwd', name: 'Play forward (press again to go faster)', sec: 'Playback', key: 'L', run: () => shuttle(1) },
    { id: 'shuttle-back', name: 'Play backwards (press again to go faster)', sec: 'Playback', key: 'J', run: () => shuttle(-1) },
    { id: 'shuttle-stop', name: 'Stop', sec: 'Playback', key: 'K', run: () => shuttle(0) },
    { id: 'frame-back', name: 'One frame back', sec: 'Playback', key: ',', run: () => playback.step(-1) },
    { id: 'frame-fwd', name: 'One frame forward', sec: 'Playback', key: '.', run: () => playback.step(1) },
    { id: 'goto', name: 'Go to a time…', sec: 'Jump', key: 'Ctrl+G', run: openGoTo },
  ]);

  return { setMark, clearMarks, goMark, removeRange, trimToPlayhead, slip, shuttle, stopShuttle, parseTime, openGoTo, fullRange,
    get rate() { return rate; } };
}
