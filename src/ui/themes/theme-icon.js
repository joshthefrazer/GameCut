/**
 * Strike's mark in a theme's colours: the one in the top bar, and the app's own icon.
 */
import { contrast, mix, isLight } from './theme-core.js';

export const STOCK = { tile: '#c6ff3d', mark: '#06080f' };
/** The two colours of the mark in this theme. */
export function markColours(t) {
  if (t.id === 'strike' || t.id === 'black') return STOCK;
  const tile = t.accent;
  const dark = mix(t.bg, '#000000', 0.35), own = isLight(t) ? t.panel : dark;
  const mark = [own, '#06080f', '#ffffff'].find(c => contrast(c, tile) >= 4) || (contrast('#06080f', tile) > contrast('#ffffff', tile) ? '#06080f' : '#ffffff');
  return { tile, mark };
}
/** The mark as SVG text. Same drawing as assets/strike-icon.svg. */
export function markSvg({ tile, mark }, round = 1) {
  const piece = `<path d="M22 16 L63 40 L22 64 Z" fill="${mark}" stroke="${mark}" stroke-width="6" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="256" height="256"><defs><clipPath id="l"><path d="M-60 -60 L49 -60 L49 6 L35 37 L49 42 L30 74 L30 140 L-60 140 Z"/></clipPath><clipPath id="r"><path d="M49 -60 L140 -60 L140 140 L30 140 L30 74 L49 42 L35 37 L49 6 Z"/></clipPath></defs><rect width="80" height="80" rx="${Math.round(22 * Math.min(1.4, Math.max(0.2, round)))}" fill="${tile}"/><g transform="translate(38.6434 40.042) scale(0.84) skewX(-12) translate(-42 -40)"><g clip-path="url(#l)">${piece}</g><g clip-path="url(#r)" transform="translate(7 -3)">${piece}</g></g></svg>`;
}
export const markUrl = (t) => `url("data:image/svg+xml,${encodeURIComponent(markSvg(markColours(t), t.radius)).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')}")`;

let last = '', timer = 0;
/** Window, taskbar and shortcut icons, and the strip behind the window's own buttons. */
export function dressApp(t, wantIcon = true, css = getComputedStyle(document.documentElement)) {
  clearTimeout(timer);
  const use = wantIcon ? t : { id: 'strike', radius: 1, accent: STOCK.tile };
  const bar = css.getPropertyValue('--bg-1').trim(), barText = css.getPropertyValue('--txt-1').trim();
  const key = JSON.stringify([markColours(use), use.radius, bar, barText]);
  if (key === last || !window.gamecut?.setAppIcon) return;
  timer = setTimeout(async () => {
    try {
      const img = new Image();
      img.src = 'data:image/svg+xml,' + encodeURIComponent(markSvg(markColours(use), use.radius));
      await img.decode();
      const png = {};
      for (const s of [16, 24, 32, 48, 256]) {
        const c = document.createElement('canvas'); c.width = c.height = s;
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, s, s);
        png[s] = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
      }
      await window.gamecut.setAppIcon({ png, stock: use.id === 'strike', bar: /^#[0-9a-f]{6}$/i.test(bar) ? bar : undefined, barText: /^#[0-9a-f]{6}$/i.test(barText) ? barText : undefined });
      last = key;
    } catch (e) { console.warn('app icon', e); }
  }, 500);
}
