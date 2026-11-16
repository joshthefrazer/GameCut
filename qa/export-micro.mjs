/**
 * Micro-benchmarks for the export pipeline, one stage at a time.
 *
 *   node qa/export-micro.mjs --file <video> [--frames 600] [--fps 60] [--w 1920] [--h 1080] [--mbps 20]
 *
 * E1  decode only        Mp4FrameReader walks the clip in output-frame steps.
 * E2  encode only        real decoded pictures are re-encoded (no decoder running).
 * E3  decode + encode    the two together, as the exporter runs them, no compositor.
 *
 * E2 and E3 are run with several encoder settings so the cost of each choice is
 * visible. Footage is only read. Nothing is written to disk.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };
const FILE = arg('file');
if (!FILE || FILE === true) { console.error('usage: node qa/export-micro.mjs --file <video>'); process.exit(2); }
const N = Number(arg('frames', 600)), FPS = Number(arg('fps', 60));
const W = Number(arg('w', 1920)), H = Number(arg('h', 1080)), MBPS = Number(arg('mbps', 20));
const ONLY = arg('only', '');

const ROOT = path.resolve(import.meta.dirname, '..');
const PROFILE = await mkdtemp(path.join(tmpdir(), 'strike-micro-'));
const app = await electron.launch({ args: ['.', `--user-data-dir=${PROFILE}`], cwd: ROOT, timeout: 90_000 });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await win.waitForLoadState('domcontentloaded');
await sleep(2500);
await win.waitForSelector('#homeNew', { timeout: 30_000 });
await win.click('#homeNew');
await win.waitForFunction(() => !document.getElementById('app').classList.contains('is-home'), null, { timeout: 30_000 });
await sleep(800);
await win.setInputFiles('#filePicker', [FILE]);
let id = null;
for (let i = 0; i < 240 && !id; i++) {
  id = await win.evaluate(async () => {
    const m = await import('app://gamecut/src/media/asset-store.js');
    const a = m.assets.all().find(x => x.kind === 'video' && x.width);
    return a ? a.id : null;
  });
  if (!id) await sleep(500);
}
await sleep(1500);
console.log(`\n${path.basename(FILE)}  ·  ${N} frames @ ${FPS}fps → ${W}x${H} ${MBPS} Mbps\n`);

const run = (code, args) => win.evaluate(code, args);

const common = `
  const { Mp4FrameReader, forgetProbes } = await import('app://gamecut/src/export/frame-reader.js');
  const { planVideoEncoder } = await import('app://gamecut/src/export/render-export.js');
  const { assets } = await import('app://gamecut/src/media/asset-store.js');
`;

if (!ONLY || ONLY === 'e1') {
  const r = await run(async ({ id, N, FPS }) => {
    const { Mp4FrameReader } = await import('app://gamecut/src/export/frame-reader.js');
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    const rd = await Mp4FrameReader.open(assets.get(id));
    if (!rd) return { err: 'reader unavailable' };
    const t0 = performance.now();
    let got = 0;
    for (let i = 0; i < N; i++) { const f = await rd.frameAt(i / FPS); if (f) got++; }
    const ms = performance.now() - t0;
    rd.close();
    return { ms, got };
  }, { id, N, FPS });
  console.log(`E1 decode only            ${r.err || `${(N / (r.ms / 1000)).toFixed(1)} frames/s   (${(r.ms / N).toFixed(2)} ms/frame, ${r.got} frames)`}`);
}

const variants = [
  { name: 'now   (quality, constant, queue 8)', cfg: {}, q: 8 },
  { name: 'queue 24', cfg: {}, q: 24 },
  { name: 'realtime latency', cfg: { latencyMode: 'realtime' }, q: 8 },
  { name: 'realtime + queue 24', cfg: { latencyMode: 'realtime' }, q: 24 },
  { name: 'variable bitrate', cfg: { bitrateMode: 'variable' }, q: 8 },
  { name: 'software (OpenH264)', cfg: { hardwareAcceleration: 'prefer-software' }, q: 8 },
];

if (!ONLY || ONLY === 'e2') {
  for (const v of variants) {
    const r = await run(async ({ id, N, FPS, W, H, MBPS, v }) => {
      const { Mp4FrameReader } = await import('app://gamecut/src/export/frame-reader.js');
      const { planVideoEncoder } = await import('app://gamecut/src/export/render-export.js');
      const { assets } = await import('app://gamecut/src/media/asset-store.js');
      const plan = await planVideoEncoder({ width: W, height: H, fps: FPS, bitrate: MBPS * 1e6 });
      if (!plan) return { err: 'no encoder' };
      // 90 real pictures, kept as VideoFrames so the decoder is idle while we encode.
      const rd = await Mp4FrameReader.open(assets.get(id));
      const keep = [];
      for (let i = 0; i < 90; i++) { const f = await rd.frameAt(i / FPS); if (f) keep.push(new VideoFrame(f)); }
      rd.close();
      let err = null, outBytes = 0, outs = 0;
      const enc = new VideoEncoder({ output: (c) => { outBytes += c.byteLength; outs++; }, error: (e) => { err = e; } });
      const cfg = { ...plan.config, codec: plan.codec, ...v.cfg };
      try { enc.configure(cfg); } catch (e) { return { err: 'configure: ' + e.message }; }
      const sup = await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
      if (!sup.supported) return { err: 'not supported' };
      const frameDur = 1e6 / FPS;
      const t0 = performance.now();
      for (let i = 0; i < N && !err; i++) {
        const src = keep[i % keep.length];
        const f = new VideoFrame(src, { timestamp: Math.round(i * frameDur), duration: Math.round(frameDur) });
        enc.encode(f, { keyFrame: i % (FPS * 2) === 0 });
        f.close();
        while (enc.encodeQueueSize > v.q) await new Promise(r => { const d = () => { enc.removeEventListener('dequeue', d); r(); }; enc.addEventListener('dequeue', d); setTimeout(d, 100); });
      }
      if (!err) await enc.flush();
      const ms = performance.now() - t0;
      keep.forEach(f => f.close());
      try { enc.close(); } catch {}
      return { ms, err: err && String(err.message || err), mbps: outBytes * 8 / (N / FPS) / 1e6 };
    }, { id, N, FPS, W, H, MBPS, v });
    console.log(`E2 encode only  ${v.name.padEnd(36)} ${r.err ? 'ERR ' + r.err : `${(N / (r.ms / 1000)).toFixed(1).padStart(6)} frames/s   ${(r.ms / N).toFixed(2)} ms/frame   out ${r.mbps.toFixed(1)} Mbps`}`);
  }
}

if (!ONLY || ONLY === 'e3') {
  for (const v of variants.slice(0, 4)) {
    const r = await run(async ({ id, N, FPS, W, H, MBPS, v }) => {
      const { Mp4FrameReader } = await import('app://gamecut/src/export/frame-reader.js');
      const { planVideoEncoder } = await import('app://gamecut/src/export/render-export.js');
      const { assets } = await import('app://gamecut/src/media/asset-store.js');
      const plan = await planVideoEncoder({ width: W, height: H, fps: FPS, bitrate: MBPS * 1e6 });
      const rd = await Mp4FrameReader.open(assets.get(id));
      let err = null, outBytes = 0;
      const enc = new VideoEncoder({ output: (c) => { outBytes += c.byteLength; }, error: (e) => { err = e; } });
      enc.configure({ ...plan.config, codec: plan.codec, ...v.cfg });
      const frameDur = 1e6 / FPS;
      let dec = 0, wait = 0;
      const t0 = performance.now();
      for (let i = 0; i < N && !err; i++) {
        const a = performance.now();
        const src = await rd.frameAt(i / FPS);
        dec += performance.now() - a;
        const f = new VideoFrame(src, { timestamp: Math.round(i * frameDur), duration: Math.round(frameDur) });
        enc.encode(f, { keyFrame: i % (FPS * 2) === 0 });
        f.close();
        const b = performance.now();
        while (enc.encodeQueueSize > v.q) await new Promise(r => { const d = () => { enc.removeEventListener('dequeue', d); r(); }; enc.addEventListener('dequeue', d); setTimeout(d, 100); });
        wait += performance.now() - b;
      }
      if (!err) await enc.flush();
      const ms = performance.now() - t0;
      rd.close(); try { enc.close(); } catch {}
      return { ms, dec, wait, err: err && String(err.message || err) };
    }, { id, N, FPS, W, H, MBPS, v });
    console.log(`E3 decode+encode ${v.name.padEnd(35)} ${r.err ? 'ERR ' + r.err : `${(N / (r.ms / 1000)).toFixed(1).padStart(6)} frames/s   (decode wait ${(r.dec / N).toFixed(2)} + encode wait ${(r.wait / N).toFixed(2)} ms/frame)`}`);
  }
}

/* E4: is one hardware encoder the limit, or is it waiting on round trips? Several at once. */
if (!ONLY || ONLY === 'e4') {
  for (const k of [1, 2, 3, 4]) {
    const r = await run(async ({ id, N, FPS, W, H, MBPS, k }) => {
      const { Mp4FrameReader } = await import('app://gamecut/src/export/frame-reader.js');
      const { planVideoEncoder } = await import('app://gamecut/src/export/render-export.js');
      const { assets } = await import('app://gamecut/src/media/asset-store.js');
      const plan = await planVideoEncoder({ width: W, height: H, fps: FPS, bitrate: MBPS * 1e6 });
      const rd = await Mp4FrameReader.open(assets.get(id));
      const keep = [];
      for (let i = 0; i < 90; i++) { const f = await rd.frameAt(i / FPS); if (f) keep.push(new VideoFrame(f)); }
      rd.close();
      const frameDur = 1e6 / FPS;
      const one = async (n) => {
        let err = null;
        const enc = new VideoEncoder({ output: () => {}, error: (e) => { err = e; } });
        enc.configure({ ...plan.config, codec: plan.codec });
        for (let i = 0; i < n && !err; i++) {
          const f = new VideoFrame(keep[i % keep.length], { timestamp: Math.round(i * frameDur), duration: Math.round(frameDur) });
          enc.encode(f, { keyFrame: i % 60 === 0 });
          f.close();
          while (enc.encodeQueueSize > 8) await new Promise(r => { const d = () => { enc.removeEventListener('dequeue', d); r(); }; enc.addEventListener('dequeue', d); setTimeout(d, 100); });
        }
        if (!err) await enc.flush();
        try { enc.close(); } catch {}
        return err && String(err.message || err);
      };
      const t0 = performance.now();
      const errs = await Promise.all(Array.from({ length: k }, () => one(Math.ceil(N / k))));
      const ms = performance.now() - t0;
      keep.forEach(f => f.close());
      return { ms, err: errs.find(Boolean) };
    }, { id, N, FPS, W, H, MBPS, k });
    console.log(`E4 ${k} encoder(s) in parallel          ${r.err ? 'ERR ' + r.err : `${(N / (r.ms / 1000)).toFixed(1).padStart(6)} frames/s total`}`);
  }
}

/* E5: other H.264 profiles, and decoder options. */
if (!ONLY || ONLY === 'e5') {
  for (const prof of ['avc1.42002a', 'avc1.4d002a', 'avc1.64002a']) {
    const r = await run(async ({ id, N, FPS, W, H, MBPS, prof }) => {
      const { Mp4FrameReader } = await import('app://gamecut/src/export/frame-reader.js');
      const { planVideoEncoder } = await import('app://gamecut/src/export/render-export.js');
      const { assets } = await import('app://gamecut/src/media/asset-store.js');
      const plan = await planVideoEncoder({ width: W, height: H, fps: FPS, bitrate: MBPS * 1e6 });
      const rd = await Mp4FrameReader.open(assets.get(id));
      const keep = [];
      for (let i = 0; i < 90; i++) { const f = await rd.frameAt(i / FPS); if (f) keep.push(new VideoFrame(f)); }
      rd.close();
      const cfg = { ...plan.config, codec: prof };
      const sup = await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
      if (!sup.supported) return { err: 'not supported' };
      let err = null;
      const enc = new VideoEncoder({ output: () => {}, error: (e) => { err = e; } });
      enc.configure(cfg);
      const frameDur = 1e6 / FPS;
      const t0 = performance.now();
      for (let i = 0; i < N && !err; i++) {
        const f = new VideoFrame(keep[i % keep.length], { timestamp: Math.round(i * frameDur), duration: Math.round(frameDur) });
        enc.encode(f, { keyFrame: i % 120 === 0 });
        f.close();
        while (enc.encodeQueueSize > 8) await new Promise(r => { const d = () => { enc.removeEventListener('dequeue', d); r(); }; enc.addEventListener('dequeue', d); setTimeout(d, 100); });
      }
      if (!err) await enc.flush();
      const ms = performance.now() - t0;
      keep.forEach(f => f.close()); try { enc.close(); } catch {}
      return { ms, err: err && String(err.message || err) };
    }, { id, N, FPS, W, H, MBPS, prof });
    console.log(`E5 encode profile ${prof}              ${r.err ? 'ERR ' + r.err : `${(N / (r.ms / 1000)).toFixed(1).padStart(6)} frames/s`}`);
  }
  const d = await run(async ({ id, N, FPS }) => {
    const { Mp4FrameReader } = await import('app://gamecut/src/export/frame-reader.js');
    const { assets } = await import('app://gamecut/src/media/asset-store.js');
    const out = {};
    const a = assets.get(id);
    // Is there a software HEVC decoder at all?
    const hev = 'hev1.1.6.L120.B0', hvc = 'hvc1.1.6.L120.B0';
    for (const c of [hvc, hev]) {
      for (const h of ['prefer-hardware', 'prefer-software', 'no-preference']) {
        out[`${c} ${h}`] = (await VideoDecoder.isConfigSupported({ codec: c, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: h }).catch(() => ({ supported: false }))).supported;
      }
    }
    return out;
  }, { id, N, FPS });
  console.log('E5 decoder support:', JSON.stringify(d));
}

await app.close();
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
