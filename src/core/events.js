/** Minimal typed-ish event emitter shared by every module. */
export class Emitter {
  #map = new Map();

  on(type, fn) {
    if (!this.#map.has(type)) this.#map.set(type, new Set());
    this.#map.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...a) => { off(); fn(...a); });
    return off;
  }

  off(type, fn) { this.#map.get(type)?.delete(fn); }

  emit(type, payload) {
    const set = this.#map.get(type);
    if (set) for (const fn of [...set]) fn(payload);
    const all = this.#map.get('*');
    if (all) for (const fn of [...all]) fn(type, payload);
  }
}

export const bus = new Emitter();

/** rAF-coalesced callback — many calls per frame collapse into one. */
export function raf(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...args); });
  };
}

/** Trailing-edge debounce. */
export function debounce(fn, ms = 120) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
