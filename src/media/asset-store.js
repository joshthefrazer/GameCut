import { Emitter } from '../core/events.js';
import { uid } from '../core/schema.js';

/**
 * Registry of imported media. Blobs stay as object URLs for the session;
 * the persistence layer (Phase 3) swaps these for OPFS handles without the
 * rest of the app noticing, because everything downstream only ever holds
 * an `assetId`.
 */
export class AssetStore extends Emitter {
  #map = new Map();

  add(asset) {
    asset.id ||= uid('as');
    this.#map.set(asset.id, asset);
    this.emit('add', asset);
    this.emit('change');
    return asset;
  }

  update(id, patch) {
    const a = this.#map.get(id);
    if (!a) return null;
    Object.assign(a, patch);
    this.emit('change');
    return a;
  }

  get(id) { return this.#map.get(id) || null; }
  all() { return [...this.#map.values()]; }
  /**
   * Assets matching a filter id, which is simply an asset `kind`
   * ('video' | 'audio'), or 'all'. Nothing is stored per asset to make this
   * work, so a file can never be filed under the wrong heading.
   */
  byBin(bin) {
    if (!bin || bin === 'all') return this.all();
    return this.all().filter(a => a.kind === bin);
  }
  count(bin) { return bin && bin !== 'all' ? this.byBin(bin).length : this.#map.size; }

  /** Drop everything — opening another project starts from nothing. */
  clear() {
    for (const a of this.#map.values()) {
      // Only blob URLs are ours to revoke; gcmedia: ids belong to the main
      // process and outlive the page.
      if (a?.url?.startsWith('blob:')) URL.revokeObjectURL(a.url);
    }
    this.#map.clear();
    this.emit('change');
  }

  remove(id) {
    const a = this.#map.get(id);
    if (a?.url) URL.revokeObjectURL(a.url);
    this.#map.delete(id);
    this.emit('change');
  }

}

export const assets = new AssetStore();
