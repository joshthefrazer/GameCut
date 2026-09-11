import { bus } from '../core/events.js';

/** Families available to the text engine — stock stack plus user uploads. */
export const STOCK_FONTS = [
  'Inter', 'Impact', 'Arial Black', 'Georgia', 'Trebuchet MS',
  'Courier New', 'Verdana', 'Times New Roman',
];

const custom = new Map();   // family -> FontFace

export function fontList() { return [...STOCK_FONTS, ...custom.keys()]; }

/** Load a user font file and register it with the document + workers. */
export async function registerFontFile(file) {
  const buf = await file.arrayBuffer();
  const family = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Custom Font';
  const face = new FontFace(family, buf);
  await face.load();
  document.fonts.add(face);
  custom.set(family, face);
  bus.emit('fonts', fontList());
  return family;
}

/** CSS font shorthand for a resolved text style at a given pixel size. */
export function fontShorthand(style, px) {
  const italic = style.italic ? 'italic ' : '';
  return `${italic}${style.weight || 700} ${px}px "${style.font}", "Inter", sans-serif`;
}
