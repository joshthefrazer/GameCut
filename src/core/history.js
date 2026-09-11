/**
 * Snapshot undo stack.
 *
 * The document is small and fully serializable, so a structured clone per
 * transaction is cheaper (in code and in bugs) than hand-written inverse
 * commands — and it makes every mutation automatically undoable.
 *
 * Coalescing: transactions sharing a `mergeKey` within `mergeMs` collapse into
 * one entry, so dragging a clip 300 px produces one undo step, not 300.
 */
const clone = (o) => (typeof structuredClone === 'function'
  ? structuredClone(o)
  : JSON.parse(JSON.stringify(o)));

export class History {
  constructor(store, limit = 200) {
    this.store = store;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this._open = null;
    this._lastKey = null;
    this._lastAt = 0;
  }

  /** Forget everything — a freshly opened project has no past to undo into. */
  reset() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.store.emit('history', {});
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** Begin an explicit transaction (for multi-step drags). */
  begin(label, mergeKey = null) {
    if (this._open) return;
    this._open = { label, mergeKey, before: clone(this.store.doc) };
  }

  /** Commit the open transaction. No-op if nothing changed. */
  commit(mergeMs = 600) {
    const tx = this._open;
    this._open = null;
    if (!tx) return;
    const after = this.store.doc;
    const now = performance.now();
    const merge = tx.mergeKey && tx.mergeKey === this._lastKey && (now - this._lastAt) < mergeMs;

    if (merge && this.undoStack.length) {
      this.undoStack.at(-1).label = tx.label;   // keep earliest `before`
    } else {
      this.undoStack.push({ label: tx.label, before: tx.before });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this._lastKey = tx.mergeKey;
    this._lastAt = now;
    this.redoStack.length = 0;
    this.store.docChanged(tx.label);
    this.store.emit('history', this.info);
    void after;
  }

  abort() { if (this._open) { this.store.doc = this._open.before; this._open = null; this.store.docChanged('abort'); } }

  /** One-shot transaction: run(doc) mutates the document in place. */
  run(label, mutator, mergeKey = null) {
    this.begin(label, mergeKey);
    const r = mutator(this.store.doc);
    this.commit();
    return r;
  }

  undo() {
    if (!this.undoStack.length) return false;
    const entry = this.undoStack.pop();
    this.redoStack.push({ label: entry.label, before: clone(this.store.doc) });
    this.store.doc = entry.before;
    this._lastKey = null;
    this.store.docChanged('undo:' + entry.label);
    this.store.emit('history', this.info);
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    const entry = this.redoStack.pop();
    this.undoStack.push({ label: entry.label, before: clone(this.store.doc) });
    this.store.doc = entry.before;
    this._lastKey = null;
    this.store.docChanged('redo:' + entry.label);
    this.store.emit('history', this.info);
    return true;
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
