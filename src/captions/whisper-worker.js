/**
 * Speech to text, off the main thread.
 *
 * Whisper (base, English) through Transformers.js and ONNX Runtime in
 * WebAssembly. The model is read from gcmodels:// — Strike's own folder —
 * and nothing here can reach the network: the page's lockdown refuses it.
 *
 * Messages in:  { type: 'load', model }
 *               { type: 'run', id, audio: Float32Array (16 kHz mono) }
 * Messages out: { type: 'loading', file, progress }
 *               { type: 'ready' }
 *               { type: 'result', id, words: [{ text, s, e }] }
 *               { type: 'error', id?, message }
 */
import { pipeline, env } from '../../vendor/transformers/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'gcmodels://m/';
env.useBrowserCache = false;
env.useFSCache = false;
const ort = env.backends.onnx;
ort.wasm.wasmPaths = new URL('../../vendor/transformers/', import.meta.url).href;
ort.wasm.numThreads = Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 4) - 1));
ort.wasm.proxy = false;

let asr = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      if (!asr) {
        asr = await pipeline('automatic-speech-recognition', data.model, {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: (p) => {
            if (p.status === 'progress') self.postMessage({ type: 'loading', file: p.file, progress: p.progress });
          },
        });
      }
      self.postMessage({ type: 'ready' });
      return;
    }
    if (data.type === 'run') {
      if (!asr) throw new Error('the speech model is not loaded');
      const out = await asr(data.audio, {
        return_timestamps: 'word',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const words = [];
      for (const c of out?.chunks || []) {
        const text = String(c.text || '').trim();
        const [s, e] = c.timestamp || [];
        if (!text || !Number.isFinite(s)) continue;
        words.push({ text, s, e: Number.isFinite(e) ? e : s + 0.3 });
      }
      self.postMessage({ type: 'result', id: data.id, words });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data?.id, message: String(err?.message || err) });
  }
};
