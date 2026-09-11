import { DEFAULT_BINS } from '../../project/presets.js';
import { assets } from '../../media/asset-store.js';

/**
 * The media filters.
 *
 * These used to be drop targets you dragged files between. They are now a view
 * of what each file already is, so there is nothing to drag — you cannot move a
 * recording into "Audio files" any more than you can rename it into being one.
 */
export function renderBins(root, store, onPick) {
  root.innerHTML = `<div class="bins__title"><span>Show</span></div>`;
  for (const bin of DEFAULT_BINS) {
    const el = document.createElement('button');
    el.className = 'bin' + (store.ui.activeBin === bin.id ? ' is-active' : '');
    el.style.setProperty('--bin-color', bin.color);
    el.dataset.bin = bin.id;
    el.innerHTML = `<i class="bin__dot"></i><span class="bin__name">${bin.name}</span>
                    <span class="bin__count">${assets.count(bin.id)}</span>`;
    el.addEventListener('click', () => onPick(bin.id));
    root.appendChild(el);
  }
}
