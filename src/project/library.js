import { assets } from '../media/asset-store.js';
import { restoreAssetAudio } from '../media/importer.js';
import { buildBundled } from '../anim/sfx.js';
import { registerFontUrl } from '../media/fonts.js';
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
    bytes: a.bytes || 0,
    width: a.width || 0, height: a.height || 0,
    thumb: a.thumb || null,
    streamAudio: !!a.streamAudio,
    family: a.family || null,
    bundled: a.bundled || null,
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
  /**
   * Version history: snapshots of the document kept inside the project file.
   * A new one is taken on a save when the last is more than five minutes old,
   * and on demand (checkpoint) before something drastic. A project file holds
   * the newest 30; a document is a few kilobytes, so that costs nothing.
   */
  let versions = [];
  const VERSION_EVERY = 5 * 60 * 1000;
  const MAX_VERSIONS = 30;
  const describe = (doc) => {
    const clips = doc.tracks.reduce((n, t) => n + t.clips.length, 0);
    return { clips, duration: projectDuration(doc) };
  };
  function takeVersion(label = '', force = false) {
    const last = versions.at(-1);
    const now = Date.now();
    if (!force && last && now - last.at < VERSION_EVERY) return false;
    const json = JSON.stringify(store.doc);
    if (last && last.json === json) return false;
    versions.push({ at: now, label, json, ...describe(store.doc) });
    while (versions.length > MAX_VERSIONS) versions.shift();
    return true;
  }

  const hasBridge = () => !!(api && api.saveProject);

  /* ── Dirty tracking ────────────────────────────────────────────
     Cheap and honest: any document change marks the project dirty, and a
     successful save clears it. That is what decides whether closing needs to
     say anything at all. */
  let dirty = false;
  /*
   * Only a real edit makes a project worth saving. Swapping a document in
   * (new project, opening one) fires the same 'doc' event as an edit does, and
   * counting those is what made closing Strike on the home screen save an
   * empty "Untitled Project" every single time. The undo history is the honest
   * record: it only grows when you changed something.
   */
  store.on('history', (h) => { if (h?.canUndo || h?.canRedo) dirty = true; });
  // Media brought into the pool is work too, even before it is on the timeline.
  let knownAssets = 0;
  bus.on('assets', () => {
    const n = assets.all().length;
    if (n > knownAssets) dirty = true;
    knownAssets = n;
  });
  // Big automatic edits ask for a snapshot first, so they can be walked back
  // even after the undo history is gone.
  bus.on('checkpoint', (label) => takeVersion(label || '', true));

  const state = () => ({ id: current, dirty, lastSavedAt });

  function newProject(name = 'Untitled Project') {
    current = uid();
    versions = [];
    store.doc.name = name;
    dirty = false;
    knownAssets = assets.all().length;
    lastSavedAt = 0;
    return current;
  }

  function adopt(id) { current = id; dirty = false; }

  async function save({ silent = false } = {}) {
    if (!hasBridge()) return { ok: false, reason: 'No desktop bridge.' };
    if (!current) current = uid();

    takeVersion();
    const payload = {
      versions: versions.map(v => ({ at: v.at, label: v.label, clips: v.clips, duration: v.duration, doc: JSON.parse(v.json) })),
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
      if (rec.bundled) { a.missing = false; a.url = null; }
      else if (rec.missing || !a.url) { a.missing = true; missing++; }
      assets.add(a);
    }

    store.replaceDoc(project.doc);
    versions = (project.versions || []).map(v => ({ at: v.at, label: v.label || '', clips: v.clips, duration: v.duration, json: JSON.stringify(v.doc) }));
    current = project.id;
    dirty = false;
    lastSavedAt = project.savedAt || 0;
    history.reset?.();

    /*
     * Sound and fonts are derived, not stored, so they are rebuilt here.
     *
     * Sound goes through the same streamed reader an import uses: only the
     * audio track is read, a few MB even for a multi-GB recording. This used
     * to fetch each whole file into memory to decode it — which on a long
     * Medal or OBS recording is gigabytes, and enough to take the editor down
     * just by opening the project. restoreAssetAudio queues one file at a
     * time and marks each pending at once, so an export started straight away
     * waits for the sound instead of coming out silent.
     *
     * Custom fonts have to be registered again before any title can use them;
     * one that can no longer be read is shown as missing rather than silently
     * falling back to the default face.
     */
    // What the timeline uses first, so an export straight after opening does
    // not wait on files that are only sitting in the media panel.
    const used = new Set();
    for (const t of store.doc.tracks) for (const c of t.clips) if (c.assetId) used.add(c.assetId);
    const ordered = assets.all().slice().sort((x, y) => used.has(y.id) - used.has(x.id));
    for (const a of ordered) {
      if (a.missing) continue;
      if (a.kind === 'font') {
        if (a.url && a.family) {
          registerFontUrl(a.url, a.family).then((ok) => {
            if (!ok) { assets.update(a.id, { missing: true }); bus.emit('assets'); }
          });
        }
      } else if (a.bundled) {
        buildBundled(a);
      } else {
        restoreAssetAudio(a);
      }
    }
    knownAssets = assets.all().length;
    bus.emit('assets');
    dirty = false;

    return { ok: true, missing, name: project.name };
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

  /** Put an earlier version back — as one step you can undo. */
  function restoreVersion(at) {
    const v = versions.find(x => x.at === at);
    if (!v) return false;
    takeVersion('Before going back', true);
    const doc = JSON.parse(v.json);
    history.run('Go back to an earlier version', (d) => {
      for (const k of Object.keys(d)) if (!(k in doc)) delete d[k];
      Object.assign(d, doc);
    });
    dirty = true;
    return true;
  }

  /** Is there anything in this project worth a place on the projects screen? */
  const worthKeeping = () => assets.all().length > 0
    || store.doc.tracks.some(t => t.clips.length > 0);

  return { newProject, adopt, save, open, list, remove, relink, state, worthKeeping,
    markDirty: () => { dirty = true; },
    versions: () => versions.map(({ json, ...v }) => v), takeVersion, restoreVersion,
           get id() { return current; },
           get dirty() { return dirty; },
           get lastSavedAt() { return lastSavedAt; } };
}
