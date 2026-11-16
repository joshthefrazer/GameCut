import { bus } from '../core/events.js';

/**
 * [ and ]: move the playhead to the previous / next marker.
 *
 * Markers are yours (M adds one, right-click the ruler removes one), so jumping
 * between them is a plain navigation tool. It used to live inside the automatic
 * "smart edit" module; that module is gone, this part stays.
 */
export function initMarkerNav({ store, playback }) {
  function jumpMarker(dir) {
    const t = store.rt.playhead;
    const ms = store.doc.markers.map(m => m.t).sort((a, b) => a - b);
    const next = dir > 0 ? ms.find(m => m > t + 1e-3) : [...ms].reverse().find(m => m < t - 1e-3);
    if (next == null) return false;
    playback.pause(); playback.seek(next);
    return true;
  }

  bus.emit('palette:add', [
    { id: 'mknext', name: 'Next marker', key: ']', sec: 'Playback', run: () => jumpMarker(1) },
    { id: 'mkprev', name: 'Previous marker', key: '[', sec: 'Playback', run: () => jumpMarker(-1) },
  ]);

  return { jumpMarker };
}
