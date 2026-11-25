/**
 * Keep the installer under GitHub's 100 MB file limit.
 *
 * dxcompiler.dll and dxil.dll are Chromium's shader compiler for WebGPU on
 * Direct3D 12. Strike never uses WebGPU (captions run on wasm, export on
 * WebCodecs), and the two files are ~27 MB of the download.
 */
const fs = require('node:fs');
const path = require('node:path');
/**
 * Refuse to make an app that cannot update itself or cannot start.
 *
 * Installers up to 2.0.5 went out without update-config.json, so those copies
 * never checked for an update and nothing said so.
 */
function checkContents(ctx) {
  const asar = require('@electron/asar');
  const mac = ctx.electronPlatformName === 'darwin';
  const res = mac
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(ctx.appOutDir, 'resources');
  const file = path.join(res, 'app.asar');
  const read = (n) => { try { return asar.extractFile(file, n); } catch { throw new Error(`The packaged app is missing ${n}. Not building a broken installer.`); } };
  for (const n of ['electron-main.cjs', 'file-body.cjs', 'preload.cjs', 'updater.cjs', 'inbox.cjs', 'app-icon.cjs', 'index.html']) read(n);
  const cfg = JSON.parse(read('update-config.json').toString('utf8'));
  if (!cfg.publicKey || !/^https:/.test(cfg.manifestUrl || '') || /CHANGE-ME/.test(cfg.manifestUrl)) {
    throw new Error('update-config.json has no public key or no address: this build could never update.');
  }
}

exports.default = async function afterPack(ctx) {
  checkContents(ctx);
  if (ctx.electronPlatformName !== 'win32') return;
  for (const f of ['dxcompiler.dll', 'dxil.dll']) {
    fs.rmSync(path.join(ctx.appOutDir, f), { force: true });
  }
};
