/**
 * Brand kit: your logo, colours and font, saved once for every project.
 *
 * New text starts in your font and first colour; "Add my logo" puts the logo
 * in the corner for the whole video. Kept in this profile (like saved looks),
 * the logo as a small PNG data URL so it needs no file to stay where it was.
 */
const KEY = 'gamecut.brand';

export const defaultBrand = () => ({ font: '', colors: ['#ffffff', '#38bdf8', '#fbbf24'], logo: null, logoName: '', corner: 'tr' });

export function getBrand() {
  try { return { ...defaultBrand(), ...(JSON.parse(localStorage.getItem(KEY) || 'null') || {}) }; }
  catch { return defaultBrand(); }
}

export function setBrand(patch) {
  const next = { ...getBrand(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window */ }
  return next;
}

/** Style fields a new text clip gets from the brand, if any were set. */
export function brandTextStyle() {
  const b = getBrand();
  const out = {};
  if (b.font) out.font = b.font;
  if (b.colors?.[0] && b.colors[0].toLowerCase() !== '#ffffff') out.color = b.colors[0];
  if (b.colors?.[1]) out.color2 = b.colors[1];
  if (b.colors?.[1]) out.glowColor = b.colors[1];
  return out;
}

/** Shrink a picture to at most 512 px and return it as a PNG data URL. */
export async function logoFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

export async function logoFile() {
  const b = getBrand();
  if (!b.logo) return null;
  const blob = await (await fetch(b.logo)).blob();
  return new File([blob], b.logoName || 'logo.png', { type: 'image/png' });
}
