/**
 * Encoder probe: what will THIS machine's H.264 encoder actually do?
 *
 * Runs with GameCut's own Electron (and so GameCut's own Chromium), opens a
 * hidden window, asks the WebCodecs encoder about a matrix of sizes, frame
 * rates, bitrates and settings, then really encodes a few seconds of
 * high-detail footage at several of them and measures what came out. Writes
 * everything to probe-result.json beside the project and quits.
 *
 * It exists because "the encoder refused the bitrate" is a symptom with
 * several possible causes inside Chromium, and guessing between them from a
 * different machine is how the first fix missed.
 *
 *   node_modules\.bin\electron qa\probe\main.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'probe-result.json');
const started = Date.now();
let result = { started: new Date().toISOString(), versions: process.versions, platform: process.platform };

function save(extra = {}) {
  result = { ...result, ...extra, seconds: (Date.now() - started) / 1000 };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
}

// Never hang a .bat forever: whatever has been gathered is written out.
setTimeout(() => { save({ timedOut: true }); app.exit(0); }, 6 * 60 * 1000);

app.whenReady().then(async () => {
  try {
    const gpu = await app.getGPUInfo('complete').catch(() => null);
    result.gpu = gpu ? {
      devices: gpu.gpuDevice, driver: gpu.auxAttributes?.driverVersion,
      vendor: gpu.auxAttributes?.glVendor, renderer: gpu.auxAttributes?.glRenderer,
      videoEncodeAcceleratorSupportedProfile: gpu.videoEncodeAcceleratorSupportedProfile,
    } : null;
    result.featureStatus = app.getGPUFeatureStatus();
  } catch (e) { result.gpuError = String(e); }
  save();

  ipcMain.on('probe:part', (_e, part) => { Object.assign(result, part); save(); });
  ipcMain.on('probe:done', (_e, part) => { Object.assign(result, part); save({ done: true }); app.exit(0); });

  const win = new BrowserWindow({
    show: false, width: 400, height: 300,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    (result.console ||= []).push(`[${level}] ${msg}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => { save({ rendererGone: d }); app.exit(0); });
  win.loadFile(path.join(__dirname, 'probe.html'));
});
