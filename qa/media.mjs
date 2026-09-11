/**
 * Real-media diagnostic: import an actual H.264+AAC clip and an mp3, put them
 * on the timeline, and trace what each stage produces. The earlier suites only
 * ever imported a 4x4 PNG, so nothing here was covered.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = '/home/claude/gamecut';
const PORT = 5196;
const server = spawn('node', ['server.js', String(PORT)], { cwd: ROOT, stdio: 'pipe' });
await sleep(700);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
         '--use-fake-ui-for-media-stream', '--mute-audio=false'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('   [console.error]', m.text()); });
page.on('pageerror', (e) => console.log('   [pageerror]', e.message));

await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
await sleep(900);

const show = (label, v) => console.log(`  ${label}:`, JSON.stringify(v, null, 2).slice(0, 900));

console.log('\n── 1. import a real mp4 + mp3 ───────────');
await page.setInputFiles('#filePicker', [
  `${ROOT}/qa/fixtures/test-clip.mp4`,
  `${ROOT}/qa/fixtures/test-tone.mp3`,
]);
await sleep(4000);

const imported = await page.evaluate(async () => {
  const { assets } = await import('/src/media/asset-store.js');
  return assets.all().map(a => ({
    name: a.name, kind: a.kind, duration: +(a.duration || 0).toFixed(2),
    w: a.width, h: a.height,
    hasURL: !!a.url, hasThumb: !!a.thumb,
    hasPeaks: !!a.peaks,
    hasDecodedBuffer: !!a.peaks?.buffer,
    bufDur: a.peaks?.buffer ? +a.peaks.buffer.duration.toFixed(2) : null,
  }));
});
show('assets', imported);

console.log('\n── 2. place them on the timeline ────────');
const placed = await page.evaluate(async () => {
  const { assets } = await import('/src/media/asset-store.js');
  const { makeClip } = await import('/src/core/schema.js');
  const { store, cmds } = window.gc;

  const vidAsset = assets.all().find(a => a.kind === 'video');
  const audAsset = assets.all().find(a => a.kind === 'audio');
  const vTrack = store.doc.tracks.find(t => t.kind === 'video');
  let aTrack = store.doc.tracks.find(t => t.kind === 'audio');
  if (!aTrack) { cmds.addTrack('audio'); aTrack = store.doc.tracks.find(t => t.kind === 'audio'); }

  const out = { videoTrack: !!vTrack, audioTrack: !!aTrack, tracks: store.doc.tracks.map(t => t.kind) };

  if (vidAsset && vTrack) {
    const c = makeClip('video', {
      name: vidAsset.name, assetId: vidAsset.id,
      start: 0, duration: vidAsset.duration || 5, inPoint: 0,
    });
    cmds.addClip(vTrack.id, c, { select: false });
    out.videoClipId = c.id;
  }
  if (audAsset && aTrack) {
    const c = makeClip('audio', {
      name: audAsset.name, assetId: audAsset.id,
      start: 0, duration: audAsset.duration || 4, inPoint: 0,
    });
    cmds.addClip(aTrack.id, c, { select: false });
    out.audioClipId = c.id;
  }
  return out;
});
show('placed', placed);

console.log('\n── 3. does the decoder yield a frame? ───');
const decode = await page.evaluate(async (clipId) => {
  const { store, comp, playback } = window.gc;
  const clip = store.doc.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
  if (!clip) return { error: 'clip not found' };

  playback.seek(1.5);
  await new Promise(r => setTimeout(r, 1800));   // let the element seek + decode

  const src = comp.pool.frameFor(clip, 1.5, false);
  const active = comp.activeClips(1.5).map(x => x.clip.type);

  // Reach into the pool's element to see what the browser actually did.
  let el = null;
  for (const v of document.querySelectorAll('video')) el = v;
  return {
    activeClipTypes: active,
    frameForReturned: src ? (src.tagName || 'IMG') : null,
    videoElementsInDom: document.querySelectorAll('video').length,
    el: el ? {
      readyState: el.readyState,          // 0..4  (>=2 required by frameFor)
      networkState: el.networkState,      // 3 = NO_SOURCE
      currentTime: +el.currentTime.toFixed(2),
      duration: Number.isFinite(el.duration) ? +el.duration.toFixed(2) : String(el.duration),
      videoWidth: el.videoWidth, videoHeight: el.videoHeight,
      paused: el.paused, muted: el.muted, crossOrigin: el.crossOrigin,
      srcScheme: (el.currentSrc || el.src || '').split(':')[0],
      error: el.error ? { code: el.error.code, message: el.error.message } : null,
    } : null,
  };
}, placed.videoClipId);
show('decode', decode);

console.log('\n── 4. does the frame reach the canvas? ──');
const painted = await page.evaluate(() => {
  const { comp, store } = window.gc;
  comp.render(1.5, false);
  const c = comp.canvas;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0, sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 89) {
    const v = d[i] + d[i + 1] + d[i + 2];
    sum += v; n++;
    if (v > 40) lit++;
  }
  return { samples: n, litSamples: lit, avgBrightness: +(sum / n / 3).toFixed(1),
           canvas: `${c.width}x${c.height}` };
});
show('canvas', painted);

console.log('\n── 5. audio scheduling on play ──────────');
const audio = await page.evaluate(async () => {
  const { playback, store, audio } = window.gc;
  const graph = window.gc.playback?.audio || null;
  playback.seek(0);
  await new Promise(r => setTimeout(r, 100));
  playback.play();
  await new Promise(r => setTimeout(r, 900));

  const g = window.gc.playback.audio || window.__gcAudio;
  const res = {
    playing: store.rt.playing,
    playhead: +store.rt.playhead.toFixed(2),
    scheduledNodes: g ? g.nodes.length : 'no graph handle',
    trackKinds: store.doc.tracks.map(t => ({ kind: t.kind, clips: t.clips.length })),
  };
  playback.pause();
  return res;
});
show('audio', audio);

console.log('\n── 6. would video audio ever play? ──────');
const videoAudio = await page.evaluate(() => {
  const { store } = window.gc;
  // Mirror AudioGraph.start()'s own filter to see what it would schedule.
  const wouldSchedule = [];
  for (const track of store.doc.tracks) {
    if (track.kind !== 'audio' || track.muted) continue;
    for (const clip of track.clips) wouldSchedule.push({ track: track.kind, clip: clip.name });
  }
  const videoClipsWithSound = [];
  for (const track of store.doc.tracks) {
    if (track.kind === 'audio') continue;
    for (const clip of track.clips) {
      if (clip.type === 'video') videoClipsWithSound.push(clip.name);
    }
  }
  const els = [...document.querySelectorAll('video')].map(v => ({ muted: v.muted }));
  return { wouldSchedule, videoClipsOnNonAudioTracks: videoClipsWithSound, videoElements: els };
});
show('videoAudio', videoAudio);

await page.screenshot({ path: process.argv[2] + '/media-diag.png' });
await browser.close();
server.kill();
console.log('\ndone.');
