import { Store } from './core/store.js';
import { History } from './core/history.js';
import { createCommands } from './core/commands.js';
import { makeProject } from './core/schema.js';
import { ASPECTS } from './project/presets.js';

import { Compositor } from './engine/compositor.js';
import { Playback } from './engine/playback.js';
import { AudioGraph } from './audio/graph.js';

import { initShell } from './ui/shell.js';
import { initPreview } from './ui/preview/preview-panel.js';
import { initTransport } from './ui/preview/transport.js';
import { initTimeline } from './ui/timeline/timeline-panel.js';
import { initMediaPool } from './ui/media-pool/pool-panel.js';
import { initInspector } from './ui/inspector/inspector-panel.js';
import { initTransitions } from './ui/transitions/transitions-panel.js';
import { initGraphics } from './ui/graphics/graphics-panel.js';
import { initShortcuts } from './shortcuts.js';
import { initExport } from './export/export-dialog.js';
import { initDesktop } from './desktop.js';
import { createLibrary } from './project/library.js';
import { initHome } from './ui/home/home-screen.js';
import { initTips } from './ui/help/tips.js';
import { initUpdates } from './ui/updates/updates-panel.js';
import { initHelp } from './ui/help/help-overlay.js';
import { bus } from './core/events.js';
import { assets } from './media/asset-store.js';

/* ── Boot ─────────────────────────────────────────────────────── */
const doc     = makeProject(ASPECTS['16:9']);
const store   = new Store(doc);
const history = new History(store);
const cmds    = createCommands(store, history);

const canvas  = document.getElementById('previewCanvas');
const comp    = new Compositor(store, canvas);
const audio   = new AudioGraph(store);
const playback = new Playback(store, comp, audio);

// Long clips keep no decoded audio buffer, so their sound plays off the very
// element that decodes their picture. The graph needs the pool to reach it.
audio.pool = comp.pool;

// A seek finishing while parked delivers its frame asynchronously, after the
// render that asked for it. Repaint when the decoder actually hands one over so
// scrubbing shows the frame you landed on; during playback the transport's rAF
// loop is already driving, so leave it alone.
comp.onFrame = () => {
  if (!store.rt.playing) comp.render(store.rt.playhead, false);
};

initShell(store);
const preview  = initPreview({ store, comp, playback, cmds, history });
const transport = initTransport({ store, playback, audio });
const timeline = initTimeline({ store, cmds, history, playback, comp });
initMediaPool({ store, cmds });
initInspector({ store, cmds, comp, playback });
const transitions = initTransitions({ store, cmds, comp, playback });
const graphics = initGraphics({ store, cmds, comp });
initTips();
const help = initHelp();
initShortcuts({ store, cmds, history, playback, timeline, preview, help });
const desktop = initDesktop({ history });
const updates = initUpdates({ store });

/* ── Top bar wiring ───────────────────────────────────────────── */
const projName = document.getElementById('projName');
projName.value = store.doc.name;
projName.addEventListener('change', () => { store.doc.name = projName.value || 'Untitled Project'; });
projName.addEventListener('keydown', (e) => { if (e.key === 'Enter') projName.blur(); e.stopPropagation(); });

const undoBtn = document.getElementById('btnUndo');
const redoBtn = document.getElementById('btnRedo');
const syncHistory = () => {
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
  undoBtn.title = history.canUndo ? `Undo ${history.info.undoLabel} (Ctrl+Z)` : 'Undo';
  redoBtn.title = history.canRedo ? `Redo ${history.info.redoLabel} (Ctrl+Shift+Z)` : 'Redo';
};
undoBtn.addEventListener('click', () => history.undo());
redoBtn.addEventListener('click', () => history.redo());
store.on('history', syncHistory);
store.on('doc', syncHistory);
syncHistory();

initExport({ store, playback });

/* ── Projects: the home screen, saving, and autosave ──────────── */
const library = createLibrary({ store, comp, history });

/** Everything that has to be told the document was swapped out. */
function refreshAll() {
  comp.resize();
  comp.render();
  timeline.repaint();
  transport.paint();
  preview.fit();
  projName.value = store.doc.name || 'Untitled Project';
  syncHistory();
  paintSaveChip();
  bus.emit('assets');
}

const home = initHome({
  library,
  onNew: () => {
    const doc = makeProject(ASPECTS['16:9']);
    store.replaceDoc(doc);
    assetsClear();
    library.newProject();
    history.reset();
    refreshAll();
    home.hide();
    bus.emit('toast', { msg: 'New project — drop some footage in to start' });
  },
  onOpen: async (id) => {
    const r = await library.open(id);
    if (!r.ok) { bus.emit('toast', { msg: r.reason, kind: 'err' }); return; }
    refreshAll();
    home.hide();
    if (r.missing) {
      bus.emit('toast', {
        msg: `${r.missing} file${r.missing === 1 ? '' : 's'} could not be found — they were moved or deleted. The clips are still on the timeline.`,
        kind: 'err', ms: 10000,
      });
    } else {
      bus.emit('toast', { msg: `Opened "${r.name}"`, kind: 'ok' });
    }
  },
});

/**
 * "Is my work safe?" answered without being asked.
 *
 * Autosave already runs, but silently, and silent autosave is only reassuring
 * once you have learned to trust it. The chip says which of three states the
 * project is in, updates itself as time passes, and is a save button when you
 * want one. Ctrl+S does the same thing, because everyone tries it.
 */
const saveChip = document.getElementById('saveChip');
const saveChipText = document.getElementById('saveChipText');

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} hr ago`;
}

function paintSaveChip() {
  if (!saveChip) return;
  if (library.dirty) {
    saveChip.dataset.state = 'dirty';
    saveChipText.textContent = 'Unsaved changes';
    saveChip.setAttribute('aria-label', 'Unsaved changes — click to save now (Ctrl+S)');
  } else {
    saveChip.dataset.state = 'saved';
    saveChipText.textContent = library.lastSavedAt ? `Saved ${ago(library.lastSavedAt)}` : 'Saved';
    saveChip.setAttribute('aria-label', 'Everything is saved. Click to save again (Ctrl+S)');
  }
}

async function saveNow() {
  if (!library.id) return;
  saveChip.dataset.state = 'busy';
  saveChipText.textContent = 'Saving…';
  const r = await library.save({ silent: true });
  paintSaveChip();
  bus.emit('toast', r?.ok
    ? { msg: 'Saved', kind: 'ok', ms: 1500 }
    : { msg: r?.reason || 'Could not save the project.', kind: 'err' });
}

saveChip?.addEventListener('click', saveNow);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
});
store.on('doc', paintSaveChip);
store.on('history', paintSaveChip);
setInterval(paintSaveChip, 20_000);

async function assetsClear() {
  const { assets } = await import('./media/asset-store.js');
  assets.clear();
}

/**
 * Going back to the list saves first.
 *
 * Leaving the editor is exactly the moment work gets lost, so it is also the
 * moment to write it down. Silently, because you did not ask to save — you
 * asked to go somewhere else.
 */
bus.on('home:request', async () => {
  if (library.id) await library.save({ silent: true });
  await home.show();
});

/**
 * Autosave.
 *
 * Every thirty seconds, and only when something actually changed. A video
 * project's document is small — the footage is referenced, not copied — so a
 * save is a few hundred kilobytes and costs nothing worth noticing.
 */
setInterval(async () => {
  if (library.id && library.dirty && !store.rt.playing) {
    await library.save({ silent: true });
    paintSaveChip();
  }
}, 30_000);

/**
 * Closing saves, and says so.
 *
 * The main process asks before it lets the window go. If nothing changed there
 * is nothing to say; if something did, it saves and reports what happened, so
 * "did that get kept?" is never a question you have to carry to the next
 * session.
 */
window.gamecut?.onCloseRequest?.(async () => {
  const name = store.doc.name || 'Untitled Project';
  if (!library.id || !library.dirty) return { saved: false };

  const r = await library.save({ silent: true });
  if (!r?.ok) return { saved: false, failed: true, name, reason: r?.reason };

  // Shown in the window on the way out rather than as a dialog: a message you
  // see, not one you have to answer. The pause is just long enough to read it.
  bus.emit('toast', { msg: `Saved "${name}" — it will be on the projects screen`, kind: 'ok' });
  await new Promise(res => setTimeout(res, 1100));
  return { saved: true, name };
});

/* Open on the project list, the way an editor should. */
library.newProject();
home.show();

bus.emit('toast', {
  msg: 'Space to play · S split · T text · C crop · ? for what everything does',
  ms: 5200,
});

/* Expose for console poking during development. */
Object.assign(window, { gc: { store, history, cmds, comp, playback, timeline, preview, transport, desktop, library, home, help, transitions, updates, assets, graphics } });
