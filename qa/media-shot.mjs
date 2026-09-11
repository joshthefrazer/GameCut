import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

const ROOT = '/home/claude/gamecut';
const OUT = process.argv[2] || '.';

// Throwaway profile — a stale Chromium SingletonLock from an unclean exit
// makes the next launch quit before opening a window.
const PROFILE = `/tmp/gamecut-qa-shot-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=/tmp/gamecut-qa-media-${process.pid}`], cwd: ROOT, timeout: 60000 });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await sleep(2200);

// Clear the seeded demo so the shot shows only the imported footage.
await win.evaluate(() => {
  const { store, cmds } = window.gc;
  const ids = store.doc.tracks.flatMap(t => t.clips.map(c => c.id));
  store.select(ids);
  cmds.removeSelected();
});
await sleep(400);

await win.setInputFiles('#filePicker', [`${ROOT}/qa/fixtures/test-clip.mp4`,
                                        `${ROOT}/qa/fixtures/test-tone.mp3`]);
await sleep(4500);

// Add both the way a user now would.
await win.evaluate(async () => {
  const { assets } = await import('/src/media/asset-store.js');
  const { placeAsset } = await import('/src/ui/timeline/place-asset.js');
  const { store, cmds } = window.gc;
  window.gc.playback.seek(0);
  for (const a of assets.all()) placeAsset(store, cmds, a.id, { start: 0, allowShift: false });
});
await sleep(600);

await win.click('#btnZoomFit');
await win.evaluate(() => window.gc.playback.seek(2.0));
await sleep(2500);
await win.evaluate(() => window.gc.comp.render(2.0, false));
await sleep(400);
await win.screenshot({ path: `${OUT}/media-working.png` });

// Playing state: red transport button, live "Playing" pill, fps readout.
// Small crops first: a full-page capture takes seconds on a software-rendered
// box, and playback would run to the end before the crop was taken.
await win.evaluate(() => { window.gc.playback.seek(0); window.gc.playback.play(); });
await sleep(300);
await win.locator('.transport').screenshot({ path: `${OUT}/transport-playing.png` });
await win.screenshot({ path: `${OUT}/media-playing.png` });
await win.evaluate(() => window.gc.playback.pause());
await sleep(400);
await win.locator('.transport').screenshot({ path: `${OUT}/transport-paused.png` });
await app.close();
console.log('shot written');
await rm(PROFILE, { recursive: true, force: true });
