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
  return addFace(family, buf);
}

/**
 * Register a font again from where it lives — for a project reopened from disk.
 *
 * A reopened project has no File objects, only the gcmedia:// url the main
 * process handed back for the font's saved path. The bytes are fetched rather
 * than handed to FontFace as `url(...)`, because the page's font-src policy
 * (rightly) does not include gcmedia:, while connect-src does.
 *
 * `family` is the name the project's text clips already use, so they pick the
 * face up the moment it loads. Resolves with the family, or null if the file
 * could not be read or is not a font.
 */
export async function registerFontUrl(url, family) {
  if (!url || !family) return null;
  if (custom.has(family)) return family;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await addFace(family, await res.arrayBuffer());
  } catch (err) {
    console.warn('font could not be restored:', family, err);
    return null;
  }
}

async function addFace(family, buf) {
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
