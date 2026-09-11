import { Emitter } from './events.js';
import { projectDuration } from './schema.js';

/**
 * Single application state container.
 *
 *   state.doc  — the project document. Undoable. Serializable. Saved to disk.
 *   state.ui   — view state (zoom, scroll, panel sizes). Not undoable.
 *   state.rt   — runtime/transient (playhead, playing, selection, drag ghosts).
 *
 * Views subscribe to channels rather than the whole store so a playhead tick
 * doesn't force the media pool to re-render.
 */
export class Store extends Emitter {
  constructor(doc, ui = {}) {
    super();
    this.doc = doc;
    this.ui = Object.assign({
      zoom: 1,               // px-per-second multiplier
      basePxPerSec: 60,
      scrollX: 0,            // seconds at the left edge of the viewport
      scrollY: 0,
      snap: true,
      ripple: false,
      beatGrid: false,
      guides: true,
      grid: false,
      // Preview render scale. Half is the default because the preview pane is
      // rarely wider than ~800px, so a half-size canvas is close to 1:1 on
      // screen while costing a quarter of the pixels — which is what makes
      // long or high-resolution footage play smoothly.
      previewScale: 0.5,
      activeBin: 'all',
      leftW: 268,
      rightW: 296,
      timelineH: 306,
    }, ui);
    this.rt = {
      playhead: 0,
      playing: false,
      loop: false,
      muted: false,
      volume: 0.85,
      selection: [],         // clip ids
      activeTrack: null,
      duration: 0,
      snapLine: null,        // seconds — live snap indicator
      dragging: null,
      /**
       * The cut you have selected, as the id of the clip on the RIGHT of it.
       *
       * A transition belongs to a junction between two clips, which is a thing
       * you point at but not a thing the document contains — the transition
       * itself is stored on the incoming clip. Naming the junction by that clip
       * keeps one identity for both, so a cut cannot be selected after the clip
       * that defines it has been deleted.
       */
      junction: null,
      /** True while a render is running: nothing may reload the editor. */
      exporting: false,
    };
    this.recompute();
  }

  get pxPerSec() { return this.ui.basePxPerSec * this.ui.zoom; }

  recompute() { this.rt.duration = projectDuration(this.doc); }

  /** Mutate ui and notify. */
  setUI(patch) { Object.assign(this.ui, patch); this.emit('ui', patch); }

  /** Mutate runtime and notify. */
  setRT(patch) { Object.assign(this.rt, patch); this.emit('rt', patch); }

  select(ids, additive = false) {
    const next = additive
      ? [...new Set([...this.rt.selection, ...ids])]
      : [...ids];
    this.rt.selection = next;
    this.emit('selection', next);
    this.emit('rt', { selection: next });
  }

  toggleSelect(id) {
    const s = new Set(this.rt.selection);
    s.has(id) ? s.delete(id) : s.add(id);
    this.select([...s]);
  }

  get selectedClips() {
    const out = [];
    for (const t of this.doc.tracks)
      for (const c of t.clips)
        if (this.rt.selection.includes(c.id)) out.push({ clip: c, track: t });
    return out;
  }

  /**
   * Swap in a whole document — opening a project, or starting a new one.
   *
   * Everything downstream reads `store.doc`, so replacing the reference and
   * announcing it is the entire operation. Selection and playhead are cleared
   * because they point at clips that no longer exist.
   */
  replaceDoc(doc) {
    this.doc = doc;
    this.rt.selection = [];
    this.rt.playhead = 0;
    this.rt.playing = false;
    this.ui.scrollX = 0;
    this.ui.scrollY = 0;
    this.recompute();
    this.emit('selection', []);
    this.emit('playhead', 0);
    this.emit('doc', 'replace');
    this.emit('ui', {});
  }

  /** Fired after any undoable document change. */
  docChanged(reason = 'edit') {
    this.recompute();
    this.emit('doc', reason);
  }
}
