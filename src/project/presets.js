/** Project + export presets tuned for gaming clips and vertical shorts. */

export const ASPECTS = {
  '16:9': { aspect: '16:9', width: 1920, height: 1080, fps: 60, label: 'Landscape · YouTube' },
  '9:16': { aspect: '9:16', width: 1080, height: 1920, fps: 60, label: 'Vertical · Shorts / TikTok / Reels' },
  '1:1':  { aspect: '1:1',  width: 1080, height: 1080, fps: 30, label: 'Square · Feed' },
  '4:5':  { aspect: '4:5',  width: 1080, height: 1350, fps: 30, label: 'Portrait · Feed' },
};

/**
 * `tracksSource` marks the tier that refuses to be worse than the footage it
 * was given. See export/quality.js — the fixed numbers below are floors, not
 * ceilings, for those two, because a recorder set to 90 Mbps was set that way
 * on purpose and an export that quietly ignores it is a bug, not a default.
 */
export const EXPORT_PRESETS = [
  { id: 'yt4k',    name: '4K · YouTube',       scale: 2,    fps: 60, vBitrate: 45_000_000, aBitrate: 320_000, tracksSource: true },
  { id: 'yt1080',  name: '1080p · YouTube',    scale: 1,    fps: 60, vBitrate: 16_000_000, aBitrate: 256_000 },
  { id: 'short4k', name: '4K · Shorts',        scale: 2,    fps: 60, vBitrate: 40_000_000, aBitrate: 256_000, tracksSource: true },
  { id: 'short',   name: '1080p · Shorts',     scale: 1,    fps: 60, vBitrate: 14_000_000, aBitrate: 192_000 },
  { id: 'draft',   name: 'Draft · 720p30',     scale: 0.667, fps: 30, vBitrate: 5_000_000, aBitrate: 128_000 },
  // Whatever you say it is. `scale` and `fps` are placeholders the dialog
  // replaces from the controls; nothing reads them from here.
  { id: 'custom',  name: 'Custom',             scale: 1,    fps: 60, vBitrate: 30_000_000, aBitrate: 320_000, custom: true },
];

/** Frame rates offered on the custom tile. */
export const EXPORT_FPS = [24, 30, 50, 60, 120, 144, 240];

/** Sizes offered on the custom tile, as multipliers of the project's own. */
export const EXPORT_SCALES = [
  { scale: 0.5,   label: 'Half' },
  { scale: 0.667, label: '720p-ish' },
  { scale: 1,     label: 'Project size' },
  { scale: 1.5,   label: '1.5×' },
  { scale: 2,     label: '2× · 4K from 1080p' },
];

/**
 * Asset filters.
 *
 * These are not folders you sort things into — they are just a view of what is
 * already there, derived from what each file actually is. The previous set
 * (Roblox Captures, Minecraft Raw, Anime Overlays and five more) guessed from
 * filenames, which meant a clip landed in the wrong place whenever a recording
 * was named something ordinary, and seven of the eight sat empty. `id` matches
 * the asset's own `kind`, so there is nothing to keep in sync.
 *
 * Images and fonts have no filter of their own and appear under All uploads.
 */
export const DEFAULT_BINS = [
  { id: 'all',   name: 'All uploads', color: '#8595ab' },
  { id: 'video', name: 'Video files', color: '#2563eb' },
  { id: 'audio', name: 'Audio files', color: '#059669' },
];
