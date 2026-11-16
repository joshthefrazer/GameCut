/**
 * Keep the installer under GitHub's 100 MB file limit.
 *
 * dxcompiler.dll and dxil.dll are Chromium's shader compiler for WebGPU on
 * Direct3D 12. Strike never uses WebGPU (captions run on wasm, export on
 * WebCodecs), and the two files are ~27 MB of the download.
 */
const fs = require('node:fs');
const path = require('node:path');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  for (const f of ['dxcompiler.dll', 'dxil.dll']) {
    fs.rmSync(path.join(ctx.appOutDir, f), { force: true });
  }
};
