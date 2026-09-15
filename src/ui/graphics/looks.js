/**
 * Ready-made looks for a graphic.
 *
 * Each one is a complete `fx` block, not a diff — pick a look and you know
 * exactly what you have, with no leftovers from the last one quietly still
 * applied. Every number underneath stays editable, so a look is a starting
 * point rather than a mode.
 *
 * The names describe the result, not the mechanism: "Sticker", not "16-pass
 * silhouette dilation". Someone choosing one of these is choosing a picture in
 * their head.
 */

const base = {
  radius: 0, glow: 0, glowColor: '#38bdf8', glowStrength: 1,
  shadow: 0, shadowColor: '#000000', shadowX: 0, shadowY: 0.03,
  outline: 0, outlineColor: '#ffffff',
  tint: '#22d3ee', tintAmount: 0,
  tiltX: 0, tiltY: 0, depth: 0,
};

/** Tiny diagrams. A square standing in for the graphic, showing what happens to it. */
const art = {
  flat: `<svg viewBox="0 0 44 32"><rect x="12" y="7" width="20" height="18" rx="2" fill="#60a5fa"/></svg>`,
  shadow: `<svg viewBox="0 0 44 32">
    <rect x="15" y="11" width="20" height="18" rx="2" fill="#030712" opacity=".65"/>
    <rect x="12" y="7" width="20" height="18" rx="2" fill="#60a5fa"/></svg>`,
  glow: `<svg viewBox="0 0 44 32">
    <defs><filter id="gfxg" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="3"/></filter></defs>
    <rect x="12" y="7" width="20" height="18" rx="2" fill="#22d3ee" filter="url(#gfxg)"/>
    <rect x="12" y="7" width="20" height="18" rx="2" fill="#e0f2fe"/></svg>`,
  sticker: `<svg viewBox="0 0 44 32">
    <rect x="9" y="4" width="26" height="24" rx="5" fill="#ffffff"/>
    <rect x="12" y="7" width="20" height="18" rx="3" fill="#60a5fa"/></svg>`,
  card: `<svg viewBox="0 0 44 32">
    <rect x="14" y="10" width="20" height="18" rx="5" fill="#030712" opacity=".5"/>
    <rect x="11" y="6" width="20" height="18" rx="5" fill="#60a5fa"/>
    <rect x="11" y="6" width="20" height="18" rx="5" fill="none" stroke="#e0f2fe" stroke-width="1.4"/></svg>`,
  tilt: `<svg viewBox="0 0 44 32">
    <path d="M13 6 33 10v14L13 27Z" fill="#1e40af"/>
    <path d="M13 6 33 10v14L13 27Z" fill="none" stroke="#93c5fd" stroke-width="1.2"/></svg>`,
  neon: `<svg viewBox="0 0 44 32">
    <defs><filter id="gfxn" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="2.6"/></filter></defs>
    <rect x="12" y="7" width="20" height="18" rx="9" fill="#f472b6" filter="url(#gfxn)"/>
    <rect x="12" y="7" width="20" height="18" rx="9" fill="none" stroke="#fce7f3" stroke-width="2"/></svg>`,
};

export const GFX_LOOKS = [
  {
    id: 'flat', name: 'Flat', note: 'Straight onto the picture, nothing added',
    art: art.flat, fx: null,
  },
  {
    id: 'shadow', name: 'Shadow', note: 'Lifted off the footage. The safe one.',
    art: art.shadow,
    fx: { ...base, radius: 0.04, shadow: 0.09, shadowColor: '#02040a', shadowY: 0.045 },
  },
  {
    id: 'glow', name: 'Glow', note: 'Coloured light behind it — good on dark gameplay',
    art: art.glow,
    fx: { ...base, glow: 0.16, glowColor: '#38bdf8', glowStrength: 1.2, shadow: 0.03 },
  },
  {
    id: 'sticker', name: 'Sticker', note: 'A white edge that follows the shape, like a cut-out',
    art: art.sticker,
    fx: { ...base, outline: 0.035, outlineColor: '#ffffff', shadow: 0.05, shadowY: 0.02 },
  },
  {
    id: 'card', name: 'Card', note: 'Rounded, outlined and lifted — for screenshots and panels',
    art: art.card,
    fx: { ...base, radius: 0.09, outline: 0.008, outlineColor: '#cfe3ff',
          shadow: 0.11, shadowColor: '#01030a', shadowY: 0.05 },
  },
  {
    id: 'tilt', name: '3D tilt', note: 'Turned in space, with thickness under it',
    art: art.tilt,
    fx: { ...base, radius: 0.03, tiltY: 16, depth: 0.09,
          shadow: 0.09, shadowColor: '#01030a', shadowY: 0.05 },
  },
  {
    id: 'neon', name: 'Neon', note: 'Hot outline and a matching haze',
    art: art.neon,
    fx: { ...base, radius: 0.3, outline: 0.012, outlineColor: '#fce7f3',
          glow: 0.2, glowColor: '#f472b6', glowStrength: 1.5 },
  },
];

export const lookById = (id) => GFX_LOOKS.find(l => l.id === id) || null;
