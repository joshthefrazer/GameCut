import { bus } from './events.js';

/**
 * Snapshot undo stack.
 *
 * The document is small and fully serializable, so a structured clone per
 * transaction is cheaper (in code and in bugs) than hand-written inverse
 * commands — and it makes every mutation automatically undoable.
 *
 * Two ways a stream of small changes becomes ONE undo step:
 *
 *   - Gestures (`gesture(label)`). A drag, a trim, a gizmo move: anything with
 *     a pointerdown and a pointerup. The document is snapshotted once when the
 *     hand goes down and one entry is written when it comes up, however many
 *     commands ran in between. This is the right tool for anything the mouse
 *     does, because the boundary is the person's own action rather than a
 *     guess about time.
 *
 *   - Merge keys (`begin(label, mergeKey)`). Transactions sharing a key within
 *     `mergeMs` collapse into one entry. Kept for things with no clear end —
 *     a slider being nudged with the keyboard, a held arrow key. It is the
 *     wrong tool for drags: it used to turn one slow drag into several undo
 *     steps (a pause longer than the window split it) and two quick separate
 *     drags into one (the second merged into the first).
 */
const clone = (o) => (typeof structuredClone === 'function'
  ? structuredClone(o)
  : JSON.parse(JSON.stringify(o)));

/**
 * Deep structural equality for plain JSON-ish data.
 *
 * Used to tell whether a transaction actually changed anything. A command
 * that changes nothing (Delete with only locked clips selected, a split with
 * the playhead off every clip, setting a value to what it already was) used to
 * push an undo entry anyway — and pushing one wipes Redo, so a stray key press
 * could throw away the thing you had just undone.
 */
export function same(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!same(a[k], b[k])) return false;
  }
  return true;
}

export class History {
  constructor(store, limit = 200) {
    this.store = store;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this._open = null;
    this._gesture = null;
    this._lastKey = null;
    this._lastAt = 0;
  }

  /** Forget everything — a freshly opened project has no past to undo into. */
  reset() {
    this._gesture = null;
    this._open = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.store.emit('history', {});
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** True while a pointer gesture is holding the history open. */
  get inGesture() { return !!this._gesture; }

  /**
   * Open a gesture: everything until `end()` is one undo step.
   *
   *   const g = history.gesture('Move clip');   // on pointerdown
   *   ...cmds.moveClip(...) as often as you like  // on pointermove
   *   g.end();                                    // on pointerup
   *
   * While it is open, `begin`/`commit`/`run` still mutate the document and
   * still announce each change (so the timeline and preview repaint live), but
   * they write nothing to the undo stack. `end()` writes a single entry — or
   * none, if the document finished where it started (a click that never
   * became a drag, a trim dragged out and back).
   *
   *   g.restore()  puts the document back to the snapshot without closing the
   *                gesture. For commands that take an absolute target but
   *                apply a relative change (a ripple trim moves the clips after
   *                it by however far the edge moved), calling this before each
   *                pointermove makes every step start from the same place
   *                instead of compounding.
   *   g.cancel()   puts the document back and closes with no entry (Escape).
   *   g.label = '…' renames the entry before it is written.
   *
   * Only one gesture can be open; asking for a second while one is running
   * returns a handle whose methods do nothing, so a nested caller cannot close
   * the outer gesture early.
   */
  gesture(label) {
    if (this._gesture) return { label, end() { return false; }, cancel() {}, restore() {}, nested: true };
    // A half-open transaction would otherwise be folded into this one.
    if (this._open) this.commit();
    const g = { label, before: clone(this.store.doc) };
    this._gesture = g;
    const self = this;
    return {
      get label() { return g.label; },
      set label(v) { g.label = v; },
      end() {
        if (self._gesture !== g) return false;
        self._gesture = null;
        self._lastKey = null;
        self.onBeforeCommit?.(self.store.doc);
        if (same(g.before, self.store.doc)) return false;
        self._push(g.label, g.before);
        self.store.docChanged(g.label);
        self.store.emit('history', self.info);
        return true;
      },
      cancel() {
        if (self._gesture !== g) return;
        self._gesture = null;
        self.store.doc = clone(g.before);
        self.store.docChanged('cancel');
      },
      restore() {
        if (self._gesture !== g) return;
        self.store.doc = clone(g.before);
      },
    };
  }

  /** Begin an explicit transaction. Prefer `gesture()` for pointer drags. */
  begin(label, mergeKey = null) {
    if (this._open) return;
    // Inside a gesture the snapshot was already taken at pointerdown; another
    // full clone per pointermove would be pure cost.
    this._open = { label, mergeKey, before: this._gesture ? null : clone(this.store.doc) };
  }

  /** Commit the open transaction. No entry is written if nothing changed. */
  commit(mergeMs = 600) {
    const tx = this._open;
    this._open = null;
    if (!tx) return;
    // Rules that hold after every edit (linked clips follow their parent) are
    // applied here, inside the same step, so one undo takes both back.
    this.onBeforeCommit?.(this.store.doc);

    // Part of a gesture: show the change now, write the entry at the end.
    if (this._gesture) { this.store.docChanged(tx.label); return; }

    if (same(tx.before, this.store.doc)) return;

    const now = performance.now();
    const merge = tx.mergeKey && tx.mergeKey === this._lastKey && (now - this._lastAt) < mergeMs;

    if (merge && this.undoStack.length) {
      this.undoStack.at(-1).label = tx.label;   // keep earliest `before`
      this.redoStack.length = 0;
    } else {
      this._push(tx.label, tx.before);
    }
    this._lastKey = tx.mergeKey;
    this._lastAt = now;
    this.store.docChanged(tx.label);
    this.store.emit('history', this.info);
  }

  _push(label, before) {
    this.undoStack.push({ label, before, at: Date.now() });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  abort() {
    const tx = this._open;
    if (!tx) return;
    this._open = null;
    // Inside a gesture there is no per-transaction snapshot to go back to; every
    // abort in the commands happens before anything was touched, so there is
    // nothing to put back either.
    if (tx.before) { this.store.doc = tx.before; this.store.docChanged('abort'); }
  }

  /** One-shot transaction: run(doc) mutates the document in place. */
  run(label, mutator, mergeKey = null) {
    this.begin(label, mergeKey);
    const r = mutator(this.store.doc);
    this.commit();
    return r;
  }

  /**
   * Step back. `opts.quiet` skips the "Undid …" toast, for callers that say
   * something themselves.
   */
  undo(opts = {}) {
    if (this._gesture) return false;            // never mid-drag
    if (!this.undoStack.length) return false;
    const entry = this.undoStack.pop();
    this.redoStack.push({ label: entry.label, before: clone(this.store.doc), at: entry.at });
    this.store.doc = entry.before;
    this._lastKey = null;
    this._afterJump();
    this.store.docChanged('undo:' + entry.label);
    this.store.emit('history', this.info);
    if (!opts.quiet) this._say(`Undid ${entry.label}`, 'Redo', () => this.redo());
    return true;
  }

  /**
   * The steps, oldest first, for the History list: what each was, when, and
   * whether it is currently undone.
   */
  steps() {
    return [
      ...this.undoStack.map((e, i) => ({ label: e.label, at: e.at || 0, done: true, n: i - this.undoStack.length + 1 })),
      ...this.redoStack.slice().reverse().map((e, i) => ({ label: e.label, at: e.at || 0, done: false, n: i + 1 })),
    ];
  }

  /**
   * Go to a step in one move: n < 0 undoes that many, n > 0 redoes. The list
   * says "after <step>", so clicking a done step with n = 0 means "here".
   */
  jump(n) {
    let moved = 0;
    if (n < 0) for (let i = 0; i < -n && this.undo({ quiet: true }); i++) moved--;
    if (n > 0) for (let i = 0; i < n && this.redo({ quiet: true }); i++) moved++;
    return moved;
  }

  redo(opts = {}) {
    if (this._gesture) return false;
    if (!this.redoStack.length) return false;
    const entry = this.redoStack.pop();
    this.undoStack.push({ label: entry.label, before: clone(this.store.doc), at: entry.at });
    this.store.doc = entry.before;
    this._lastKey = null;
    this._afterJump();
    this.store.docChanged('redo:' + entry.label);
    this.store.emit('history', this.info);
    if (!opts.quiet) this._say(`Redid ${entry.label}`, 'Undo', () => this.undo());
    return true;
  }

  /**
   * After the document is swapped, the selection may name clips that no longer
   * exist — undo a split and the right half is gone, but it was what the split
   * had selected. Pressing S then did nothing at all, because "split the
   * selection" found a selection made of one dead id. Keep only what is still
   * there.
   */
  _afterJump() {
    const s = this.store;
    const live = new Set();
    for (const t of s.doc.tracks) for (const c of t.clips) live.add(c.id);
    const sel = s.rt.selection.filter(id => live.has(id));
    if (sel.length !== s.rt.selection.length) s.select(sel);
    if (s.rt.junction && !live.has(s.rt.junction)) s.setRT({ junction: null });
  }

  /**
   * One toast for undo/redo, replacing the previous one rather than stacking
   * ten of them when Ctrl+Z is pressed ten times. It carries the opposite
   * action, so an undo pressed by mistake is one click from being taken back.
   */
  _say(msg, label, run) {
    bus.emit('toast', { msg, key: 'history', ms: 3600, action: { label, run } });
  }

  get info() {
    return {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
    };
  }
}
