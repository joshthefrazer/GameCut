/** Project + export presets tuned for gaming clips and vertical shorts. */

export const ASPECTS = {
  '16:9': { aspect: '16:9', width: 1920, height: 1080, fps: 60, label: 'Landscape · YouTube' },
  '9:16': { aspect: '9:16', width: 1080, height: 1920, fps: 60, label: 'Vertical · Shorts / TikTok / Reels' },
  '1:1':  { aspect: '1:1',  width: 1080, height: 1080, fps: 30, label: 'Square · Feed' },
  '4:5':  { aspect: '4:5',  width: 1080, height: 1350, fps: 30, label: 'Portrait · Feed' },
};

export const EXPORT_PRESETS = [
  { id: 'yt4k',    name: '4K · YouTube',       scale: 2,    fps: 60, vBitrate: 45_000_000, aBitrate: 320_000 },
  { id: 'yt1080',  name: '1080p · YouTube',    scale: 1,    fps: 60, vBitrate: 16_000_000, aBitrate: 256_000 },
  { id: 'short4k', name: '4K · Shorts',        scale: 2,    fps: 60, vBitrate: 40_000_000, aBitrate: 256_000 },
  { id: 'short',   name: '1080p · Shorts',     scale: 1,    fps: 60, vBitrate: 14_000_000, aBitrate: 192_000 },
  { id: 'draft',   name: 'Draft · 720p30',     scale: 0.667, fps: 30, vBitrate: 5_000_000, aBitrate: 128_000 },
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
