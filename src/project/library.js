import { assets } from '../media/asset-store.js';
import { extractPeaks } from '../audio/waveform.js';
import { canDecodeAudio } from '../media/importer.js';
import { projectDuration } from '../core/schema.js';
import { bus } from '../core/events.js';

/**
 * Saving and reopening projects.
 *
 * A project file holds the document and a note of where each piece of footage
 * lives — never the footage itself. These are hour-long gaming recordings; a
 * project that copied them would cost gigabytes per save and take minutes to
 * write. So a project is a few hundred kilobytes of JSON that points at files
 * already on the disk, which is what Premiere and Resolve do, and it carries
 * the same consequence: move a file and the project says so rather than
 * pretending.
 *
 * The media itself comes back over `gcmedia://`, an id the main process hands
 * out for a path it has been told about. Nothing else on the disk is reachable.
 */

const uid = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** The fields of an asset worth keeping. The File and the blob URL are not. */
function assetRecord(a) {
  return {
    id: a.id, kind: a.kind, name: a.name, path: a.path || null,
    duration: a.duration || 0,
    width: a.width || 0, height: a.height || 0,
    thumb: a.thumb || null,
    streamAudio: !!a.streamAudio,
    family: a.family || null,
  };
}

/** A small picture of the project for the home screen. */
function snapshot(comp) {
  try {
    const src = comp?.canvas;
    if (!src || !src.width) return null;
    const w = 320, h = Math.max(1, Math.round((src.height / src.width) * w));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

export function createLibrary({ store, comp, history }) {
  const api = window.gamecut;
  /** The project currently open. Null means nothing has been opened yet. */
  let current = null;
  let lastSavedAt = 0;

  const hasBridge = () => !!(api && api.saveProject);

  /* ── Dirty tracking ────────────────────────────────────────────
     Cheap and honest: any document change marks the project dirty, and a
     successful save clears it. That is what decides whether closing needs to
     say anything at all. */
  let dirty = false;
  store.on('doc', () => { dirty = true; });
  store.on('history', () => { dirty = true; });

  const state = () => ({ id: current, dirty, lastSavedAt });

  function newProject(name = 'Untitled Project') {
    current = uid();
    store.doc.name = name;
    dirty = true;
    lastSavedAt = 0;
    return current;
  }

  function adopt(id) { current = id; dirty = false; }

  async function save({ silent = false } = {}) {
    if (!hasBridge()) return { ok: false, reason: 'No desktop bridge.' };
    if (!current) current = uid();

    const payload = {
      id: current,
      name: store.doc.name || 'Untitled Project',
      doc: store.doc,
      assets: assets.all().map(assetRecord),
      duration: projectDuration(store.doc),
      clips: store.doc.tracks.reduce((n, t) => n + t.clips.length, 0),
      thumb: snapshot(comp),
    };

    const r = await api.saveProject(payload);
    if (r?.ok) {
      dirty = false;
      lastSavedAt = r.savedAt;
      if (!silent) bus.emit('toast', { msg: 'Project saved', kind: 'ok' });
    } else if (!silent) {
      bus.emit('toast', { msg: r?.reason || 'Could not save the project.', kind: 'err' });
    }
    return r;
  }

  /**
   * Reopen a saved project.
   *
   * Assets are rebuilt from their recorded paths. Anything the main process
   * could not find comes back flagged `missing` rather than silently absent —
   * the timeline still shows the clip, so you can see what is gone and point it
   * at the file again instead of guessing what the project used to contain.
   */
  async function open(id) {
    if (!hasBridge()) return { ok: false, reason: 'No desktop bridge.' };
    const r = await api.loadProject(id);
    if (!r?.ok) return r || { ok: false, reason: 'Could not open that project.' };

    const { project } = r;
    assets.clear();

    let missing = 0;
    for (const rec of project.assets || []) {
      const a = {
        ...rec,
        file: null,
        url: rec.mediaId ? `gcmedia://${rec.mediaId}` : null,
        peaks: null,
      };
      if (rec.missing || !a.url) { a.missing = true; missing++; }
      assets.add(a);
    }

    store.replaceDoc(project.doc);
    current = project.id;
    dirty = false;
    lastSavedAt = project.savedAt || 0;
    history.reset?.();

    // Waveforms are derived, not stored: recomputing costs a read and keeps the
    // project file small. Short clips only — long recordings deliberately never
    // hold a decoded buffer (see media/importer.js).
    rebuildAudio(project.assets || []);

    return { ok: true, missing, name: project.name };
  }

  async function rebuildAudio(records) {
    for (const rec of records) {
      if (rec.missing || !rec.mediaId) continue;
      if (rec.kind !== 'audio' && rec.kind !== 'video') continue;
      if (!canDecodeAudio(rec.duration || 0, 0)) {
        assets.update(rec.id, { streamAudio: true });
        continue;
      }
      try {
        const buf = await (await fetch(`gcmedia://${rec.mediaId}`)).arrayBuffer();
        const peaks = await extractPeaks(buf);
        if (peaks) assets.update(rec.id, { peaks });
        else assets.update(rec.id, { streamAudio: true });
      } catch {
        assets.update(rec.id, { streamAudio: true });
      }
    }
    bus.emit('assets');
  }

  /** Point a moved file at the project again. */
  async function relink(assetId) {
    const a = assets.get(assetId);
    if (!a || !api?.relinkMedia) return false;
    const picked = await api.relinkMedia(a.name);
    if (!picked) return false;
    assets.update(assetId, { path: picked.path, url: `gcmedia://${picked.id}`, missing: false });
    bus.emit('assets');
    dirty = true;
    return true;
  }

  const list = () => (hasBridge() ? api.listProjects() : Promise.resolve([]));
  const remove = (id) => (hasBridge() ? api.deleteProject(id) : Promise.resolve({ ok: false }));

  return { newProject, adopt, save, open, list, remove, relink, state,
           get id() { return current; },
           get dirty() { return dirty; },
           get lastSavedAt() { return lastSavedAt; } };
}
