/**
 * Encoder probe — what can THIS machine's H.264 encoder actually do?
 *
 *   node_modules\.bin\electron qa\encoder-probe.cjs
 *
 * Writes encoder-probe.json next to package.json, then quits. Nothing is sent
 * anywhere; it only asks the local encoder questions and times its answers.
 *
 * Exists because the export bitrate bug turned out to depend on the machine:
 * the same request is accepted on Linux (OpenH264, software) and refused on
 * Windows (Media Foundation, the GPU's encoder), and guessing which limit was
 * firing from a different computer is how the first fix missed. This asks the
 * real encoder, through the same API GameCut uses, and writes down:
 *
 *   1. which configurations isConfigSupported() accepts — by size, frame
 *      rate, bitrate, and hardware vs software
 *   2. what bitrate the encoder ACTUALLY produces when asked for a high one,
 *      on picture noise that is hard enough to absorb it — "accepted" and
 *      "delivered" are different claims and only the second one matters
 *   3. what the GPU process says the hardware encoder supports
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// One file per Electron major, so runs on two versions sit side by side.
const OUT = path.join(__dirname, '..',
  `encoder-probe-e${String(process.versions.electron).split('.')[0]}.json`);

// The probe itself runs inside a page, because WebCodecs only exists there.
const PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title><body><script>
${probeSource.toString()}
probeSource();
</script></body>`;

function probeSource() {
  // ITU-T H.264 Table A-1, same as src/export/render-export.js.
  const LEVELS = [
    ['3.0','1e',40500,1620,10000],['3.1','1f',108000,3600,14000],['3.2','20',216000,5120,20000],
    ['4.0','28',245760,8192,20000],['4.1','29',245760,8192,50000],['4.2','2a',522240,8704,50000],
    ['5.0','32',589824,22080,135000],['5.1','33',983040,36864,240000],['5.2','34',2073600,36864,240000],
    ['6.0','3c',4177920,139264,240000],['6.1','3d',8355840,139264,480000],['6.2','3e',16711680,139264,800000],
  ];
  function level(w, h, fps, bits) {
    const fs = Math.ceil(w / 16) * Math.ceil(h / 16);
    return LEVELS.find(l => l[3] >= fs && l[2] >= fs * fps && l[4] * 1.25 >= bits / 1000) || LEVELS[LEVELS.length - 1];
  }

  window.runProbe = async function () {
    const out = { support: [], encodes: [] };
    const sizes = [[1920, 1080], [2560, 1440], [3840, 2160]];
    const rates = [30, 60];
    const mbps = [8, 16, 40, 60, 80, 120, 200, 300];
    const modes = ['no-preference', 'prefer-hardware', 'prefer-software'];

    for (const [w, h] of sizes) for (const fps of rates) for (const m of mbps) for (const hw of modes) {
      const bits = m * 1e6;
      const lv = level(w, h, fps, bits);
      const cfg = { codec: 'avc1.6400' + lv[1], width: w, height: h, framerate: fps,
                    bitrate: bits, latencyMode: 'quality', hardwareAcceleration: hw };
      let ok = false, err = null;
      try { ok = (await VideoEncoder.isConfigSupported(cfg)).supported; } catch (e) { err = String(e); }
      out.support.push({ w, h, fps, mbps: m, hw, level: lv[0], ok, err });
    }

    // Real encodes. Random noise every frame, because a flat test pattern can
    // be compressed to almost nothing and would "produce" a tiny file at any
    // requested bitrate — which is exactly the trap the first fix fell into.
    async function encode(w, h, fps, m, hw, frames, mode = 'variable') {
      const bits = m * 1e6;
      const lv = level(w, h, fps, bits);
      const cfg = { codec: 'avc1.6400' + lv[1], width: w, height: h, framerate: fps,
                    bitrate: bits, bitrateMode: mode, latencyMode: 'quality', hardwareAcceleration: hw };
      const rec = { w, h, fps, mbps: m, hw, mode, level: lv[0], frames };
      try {
        const sup = await VideoEncoder.isConfigSupported(cfg);
        rec.supported = sup.supported;
        if (!sup.supported) return rec;
      } catch (e) { rec.supported = false; rec.err = String(e); return rec; }

      let bytes = 0, chunks = 0, error = null;
      const enc = new VideoEncoder({
        output: (c) => { bytes += c.byteLength; chunks++; },
        error: (e) => { error = String(e); },
      });
      try { enc.configure(cfg); } catch (e) { rec.err = 'configure: ' + e; return rec; }

      const cv = new OffscreenCanvas(w, h);
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(w, h);
      const u32 = new Uint32Array(img.data.buffer);
      let seed = 12345;
      const t0 = performance.now();
      for (let i = 0; i < frames && !error; i++) {
        for (let p = 0; p < u32.length; p++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          u32[p] = seed | 0xff000000;
        }
        ctx.putImageData(img, 0, 0);
        const f = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        enc.encode(f, { keyFrame: i % (fps * 2) === 0 });
        f.close();
        while (enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 2));
      }
      try { await enc.flush(); } catch (e) { error = error || String(e); }
      enc.close();
      rec.ms = Math.round(performance.now() - t0);
      rec.chunks = chunks;
      rec.bytes = bytes;
      rec.deliveredMbps = +((bytes * 8) / (frames / fps) / 1e6).toFixed(1);
      if (error) rec.err = error;
      return rec;
    }

    // The question each row answers is "if GameCut asks for N Mbps here, does
    // N Mbps come out?" — so the same size is asked at a low and a high rate:
    // an encoder that is really controlling bitrate gives two very different
    // answers, one that ignores it gives the same answer twice.
    const plan = [
      [1920, 1080, 60, 16,  'prefer-hardware', 120, 'variable'],
      [1920, 1080, 60, 80,  'prefer-hardware', 120, 'variable'],
      [1920, 1080, 60, 80,  'prefer-hardware', 120, 'constant'],
      [1920, 1080, 60, 200, 'prefer-hardware', 120, 'variable'],
      [1920, 1080, 60, 16,  'prefer-software', 120, 'variable'],
      [1920, 1080, 60, 80,  'prefer-software', 120, 'variable'],
      [1920, 1080, 60, 80,  'no-preference',   120, 'variable'],
      [1920, 1080, 120, 80, 'prefer-hardware', 120, 'variable'],
      [2560, 1440, 60, 80,  'prefer-hardware', 90,  'variable'],
      [3840, 2160, 60, 45,  'prefer-hardware', 60,  'variable'],
      [3840, 2160, 60, 150, 'prefer-hardware', 60,  'variable'],
    ];
    for (const p of plan) out.encodes.push(await encode(...p));
    return out;
  };
}


app.whenReady().then(async () => {
  const report = {
    when: new Date().toISOString(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch },
  };
  try { report.gpu = await app.getGPUInfo('complete'); } catch (e) { report.gpuError = String(e); }
  try { report.gpuFeatures = app.getGPUFeatureStatus(); } catch { /* older electron */ }

  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  // A file rather than a data: URL — WebCodecs needs a secure context, and
  // file:// is one where an opaque data: origin may not be.
  const pageFile = path.join(app.getPath('temp'), 'gamecut-encoder-probe.html');
  fs.writeFileSync(pageFile, PAGE);
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('page:', msg); });
  await win.loadFile(pageFile);
  try {
    const r = await win.webContents.executeJavaScript('window.runProbe()');
    Object.assign(report, r);
  } catch (e) { report.probeError = String(e && e.stack || e); }

  // The GPU info blob is huge; keep only what bears on video encoding.
  if (report.gpu) {
    const g = report.gpu;
    report.gpu = {
      devices: (g.gpuDevice || []).map(d => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active, driver: d.driverVersion, vendor: d.vendorString, device: d.deviceString })),
      encodeProfiles: g.videoEncodeAcceleratorSupportedProfile || g.videoEncodeAcceleratorSupportedProfiles || null,
      auxAttributes: g.auxAttributes ? { glRenderer: g.auxAttributes.glRenderer, glVendor: g.auxAttributes.glVendor } : null,
    };
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('wrote', OUT);
  app.quit();
});
