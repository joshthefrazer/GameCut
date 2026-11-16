/**
 * "Click to outline anything", off the main thread.
 *
 * SlimSAM-77 (an object-outlining model, 13.8 MB, Apache-2.0) through
 * Transformers.js and ONNX Runtime. Like the speech model, it is read from
 * gcmodels:// (Strike's own folder, downloaded once and checksum-checked by
 * the main process) and nothing here can reach the network.
 *
 * The model works in two halves:
 *   1. the picture is "looked at" once (the slow half, ~0.3–2 s), and
 *   2. every click is turned into an outline from that look (fast, ~20–80 ms),
 * so clicking again to add or take away a bit costs almost nothing.
 *
 * Messages in:  { type: 'load', model }
 *               { type: 'image', id, width, height, data: Uint8ClampedArray (RGBA) }
 *               { type: 'points', id, points: [{ x, y, add }] }   x, y are 0..1 of the picture
 * Messages out: { type: 'ready', device }
 *               { type: 'looked', id, ms }
 *               { type: 'outline', id, width, height, count, mask: Uint8Array (count planes, 0/255),
 *                 scores: [count], best, score, ms }
 *               { type: 'error', id?, message }
 */
import { SamModel, AutoProcessor, RawImage, Tensor, env } from '../../../vendor/transformers/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'gcmodels://m/';
env.useBrowserCache = false;
env.useFSCache = false;
const ort = env.backends.onnx;
ort.wasm.wasmPaths = new URL('../../../vendor/transformers/', import.meta.url).href;
ort.wasm.numThreads = Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 4) - 1));
ort.wasm.proxy = false;

let model = null, processor = null, device = null;
/** The picture currently looked at: its id, its processed inputs and the model's look at it. */
let current = null;

async function load(id) {
  if (model) return;
  processor = await AutoProcessor.from_pretrained(id);
  // The CPU (WebAssembly, several threads). Measured 2026-11-16 on an Iris Xe laptop
  // (qa/outline.mjs): this 8-bit model was no faster on the GPU (looking ~the same,
  // each click ~2x slower), because WebGPU has no fast 8-bit maths. The GPU path is
  // kept for testing: localStorage 'strike.outlineDevice' = 'webgpu' (passed in by the page).
  const order = self.__forceDevice ? [self.__forceDevice] : ['wasm'];
  let lastErr = null;
  for (const d of order) {
    try {
      model = await SamModel.from_pretrained(id, { dtype: 'q8', device: d });
      device = d;
      return;
    } catch (e) { lastErr = e; model = null; }
  }
  throw lastErr || new Error('the outline model could not start');
}

async function look(msg) {
  const t0 = performance.now();
  const image = new RawImage(msg.data, msg.width, msg.height, 4).rgb();
  const inputs = await processor(image);
  const embeddings = await model.get_image_embeddings(inputs);
  current = { id: msg.id, width: msg.width, height: msg.height, inputs, embeddings };
  return performance.now() - t0;
}

async function outline(msg) {
  if (!current || current.id !== msg.id) throw new Error('that picture has not been looked at yet');
  const t0 = performance.now();
  const pts = (msg.points || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) throw new Error('no click to outline from');
  // Points go in the resized picture's pixels (longest side 1024); [h, w] order.
  const [rh, rw] = current.inputs.reshaped_input_sizes[0];
  const input_points = new Tensor('float32', Float32Array.from(pts.flatMap(p => [p.x * rw, p.y * rh])), [1, 1, pts.length, 2]);
  const input_labels = new Tensor('int64', BigInt64Array.from(pts.map(p => (p.add === false ? 0n : 1n))), [1, 1, pts.length]);
  const out = await model({ ...current.embeddings, input_points, input_labels });
  const masks = await processor.post_process_masks(out.pred_masks, current.inputs.original_sizes, current.inputs.reshaped_input_sizes);
  // The model offers up to three outlines for one click: a part, a bigger part, the whole
  // thing (a click on a body could mean the shirt or the person). All are sent back;
  // the page starts on the one the model is surest of and lets you step through the rest.
  const scores = Array.from(out.iou_scores.data, Number);
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const m = masks[0]; // [1, n, H, W], booleans
  const [, n, H, W] = m.dims;
  const plane = W * H;
  const mask = new Uint8Array(plane * n);   // n planes, one after another, 0 or 255
  const src = m.data;
  for (let i = 0; i < plane * n; i++) mask[i] = src[i] ? 255 : 0;
  return { width: W, height: H, count: n, mask, scores, best, score: scores[best], ms: performance.now() - t0 };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      if (data.device) self.__forceDevice = data.device;
      await load(data.model);
      self.postMessage({ type: 'ready', device });
    } else if (data.type === 'image') {
      if (!model) throw new Error('the outline model is not loaded');
      const ms = await look(data);
      self.postMessage({ type: 'looked', id: data.id, ms });
    } else if (data.type === 'points') {
      const r = await outline(data);
      self.postMessage({ type: 'outline', id: data.id, ...r }, [r.mask.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data?.id, message: String(err?.message || err) });
  }
};
