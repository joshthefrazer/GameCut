import { assets } from './asset-store.js';

/**
 * Sound that is still being prepared — one file at a time, and in the open.
 *
 * ── Why a queue ──────────────────────────────────────────────
 * Importing five clips used to start five decodes at once. Each one holds its
 * compressed bytes and its decoded sound in memory while it works, so five
 * long recordings together were the memory spike, and every one of them
 * finished later than it would have alone. One at a time, in import order,
 * the first clip has sound almost immediately and the rest follow.
 *
 * ── Why a registry ───────────────────────────────────────────
 * Nobody waited for these decodes. Press Export while a clip's sound was still
 * being read and the mix simply did not include it: a file with no audio
 * stream and no warning. Everything pending is listed here, so the export
 * dialog can say "Preparing sound… 2 of 3" and wait, rather than guess.
 */

const jobs = new Map();            // assetId -> job
const listeners = new Set();
const waiting = [];                // jobs not yet started, in the order they run
const running = new Set();         // started and not finished (one live at most)

const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* listener's problem */ } } };

/**
 * Queue `work(job)` to prepare an asset's sound.
 *
 * The asset is marked `audioState: 'pending'` straight away — synchronously —
 * so anything that looks at it from this moment on knows to wait. `work`
 * receives `{ progress(f), alive() }`: report 0..1 through the first, and stop
 * early when the second turns false (the asset was removed, or another project
 * was opened and the store cleared).
 *
 * Returns a promise that settles when this asset's turn is over.
 */
export function queueAudio(asset, work) {
  const id = asset.id;
  const prev = jobs.get(id);
  if (prev?.alive()) return prev.promise;   // already queued: one decode per asset
  if (prev) {
    // Left over from before the store was cleared (a project reopened). It is
    // not this asset's job any more and must not stand in for it — that
    // left a reopened clip with no sound job at all, and Export waiting on it
    // for ever.
    const i = waiting.indexOf(prev);
    if (i >= 0) { waiting.splice(i, 1); prev.resolve(); }
    jobs.delete(id);
  }

  const job = {
    id, name: asset.name, progress: 0, started: false,
    alive: () => assets.get(id) === asset,
  };
  const setProgress = (f) => { job.progress = Math.max(0, Math.min(1, f || 0)); notify(); };

  assets.update(id, { audioState: 'pending' });

  job.run = async () => {
    if (!job.alive()) { if (jobs.get(id) === job) jobs.delete(id); notify(); return; }
    job.started = true;
    notify();
    try {
      await work({ progress: setProgress, alive: job.alive });
    } catch (err) {
      console.warn('preparing sound failed for', asset.name, err);
      if (job.alive() && asset.audioState === 'pending') {
        assets.update(id, { audioState: 'unreadable', audioReason: String(err?.message || err) });
      }
    } finally {
      // Whatever happened, it is no longer pending. A job that bailed out
      // because its asset left the store leaves nothing behind.
      if (job.alive() && asset.audioState === 'pending') {
        assets.update(id, { audioState: 'unreadable' });
      }
      if (jobs.get(id) === job) jobs.delete(id);
      notify();
    }
  };
  job.promise = new Promise((resolve) => { job.resolve = resolve; });
  waiting.push(job);
  jobs.set(id, job);
  notify();
  pump();
  return job.promise;
}

/** Start the next waiting job when nothing is running. One at a time. */
function pump() {
  // A job whose asset has left the store (another project was opened) is
  // finishing up on its own; it must not hold up the new project's sound.
  for (const j of running) if (j.alive()) return;
  const job = waiting.shift();
  if (!job) return;
  running.add(job);
  Promise.resolve().then(job.run).catch(() => {}).finally(() => {
    running.delete(job);
    job.resolve();
    pump();
  });
}

/** Every job, including ones whose asset is gone. Tests only. */
export function __audioJobsForTest() {
  return [...jobs.values(), ...[...running].filter(j => !jobs.has(j.id) || jobs.get(j.id) !== j)]
    .map(j => ({ id: j.id, name: j.name, started: j.started, alive: j.alive(), running: running.has(j) }));
}

/**
 * Move these assets' sound to the front of the queue (still one at a time).
 *
 * Reopening a project queues every file in it, in import order — including
 * long recordings that are not on the timeline at all. An export waits only
 * for the clips it uses, but used to wait behind all of those too: minutes of
 * "Preparing sound…" for files that were never going to be in the video. The
 * export dialog and project opening put what the timeline uses first.
 */
export function prioritizeAudio(ids) {
  const want = new Set(ids);
  const first = waiting.filter(j => want.has(j.id));
  if (!first.length) return;
  const rest = waiting.filter(j => !want.has(j.id));
  waiting.length = 0;
  waiting.push(...first, ...rest);
  notify();
}

/** Sound still being prepared, optionally only for these asset ids. */
export function pendingAudio(ids) {
  const want = ids ? new Set(ids) : null;
  return [...jobs.values()]
    .filter(j => j.alive() && (!want || want.has(j.id)))
    .map(j => ({ id: j.id, name: j.name, progress: j.progress, started: j.started }));
}

/** Told whenever a job starts, moves or finishes. Returns an unsubscribe. */
export function onAudioJobs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Resolves once none of these assets has sound pending.
 *
 * `onProgress({ done, total, current })` is called as files finish, for a
 * "Preparing sound… 2 of 3" line. The returned promise has a `cancel()` that
 * stops waiting (it does not stop the decodes — the sound is still wanted).
 */
export function whenAudioReady(ids, onProgress) {
  const total = pendingAudio(ids).length;
  let off = null;
  let cancel = () => {};
  const p = new Promise((resolve) => {
    const check = () => {
      const left = pendingAudio(ids);
      onProgress?.({ done: total - left.length, total, current: left.find(j => j.started) || left[0] || null });
      if (!left.length) { off?.(); resolve(true); }
    };
    cancel = () => { off?.(); resolve(false); };
    off = onAudioJobs(check);
    check();
  });
  p.cancel = () => cancel();
  return p;
}
