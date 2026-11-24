/**
 * The installer's pictures, drawn from Strike's own mark and fonts.
 *   node_modules/.bin/electron tools/make-installer-art.cjs
 * Writes build/installer-*.bmp and build/*Sidebar.bmp (24-bit BMP, what NSIS reads).
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const mark = fs.readFileSync(path.join(ROOT, 'assets', 'strike-mark-volt.svg'), 'utf8').trim();

/** A few rows of timeline clips, slanted like the mark. */
function lanes(w, h, rows, seed, dim = 1) {
  let r = seed;
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const cols = ['#C6FF3D', '#5B4BFF', '#23C6B8', '#8F84FF', '#2A3553', '#1C2540', '#2A3553'];
  let s = '';
  const rh = h / rows;
  for (let i = 0; i < rows; i++) {
    let x = -40 - rnd() * 60;
    while (x < w + 40) {
      const cw = 26 + rnd() * 92;
      const c = cols[Math.floor(rnd() * cols.length)];
      const o = (c === '#C6FF3D' ? 0.95 : 0.8) * dim;
      s += `<rect x="${x.toFixed(1)}" y="${(i * rh + 2).toFixed(1)}" width="${cw.toFixed(1)}" height="${(rh - 5).toFixed(1)}" rx="4" fill="${c}" opacity="${o.toFixed(2)}"/>`;
      if (cw > 50 && c !== '#C6FF3D') {
        for (let k = x + 7; k < x + cw - 6; k += 4) {
          const b = (0.15 + rnd() * 0.6) * (rh - 11);
          s += `<rect x="${k.toFixed(1)}" y="${(i * rh + rh / 2 - b / 2).toFixed(1)}" width="1.6" height="${b.toFixed(1)}" fill="#fff" opacity="${(0.28 * dim).toFixed(2)}"/>`;
        }
      }
      x += cw + 4;
    }
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g transform="translate(${h * 0.1} 0) skewX(-12)">${s}</g></svg>`;
}

const css = `
@font-face{font-family:U;src:url(${url('assets/fonts/unbounded-latin-900-normal.woff2')});font-weight:900}
@font-face{font-family:I;src:url(${url('assets/fonts/inter-latin-wght-normal.woff2')});font-weight:100 900}
*{margin:0;box-sizing:border-box}html,body{overflow:hidden;background:#0A0E19}
body{position:relative;font-family:I}
.abs{position:absolute}.w{font-family:U;font-weight:900;color:#fff;letter-spacing:.01em;line-height:1}
.m svg{display:block;width:100%;height:100%}`;

const PICS = {
  // Welcome and Ready: the strip across the top, fading into the page colour.
  'installer-hero': [497, 150, (w, h) => `
    <div class="abs" style="inset:0;background:radial-gradient(420px 220px at 78% 30%,#1a2350,transparent 70%),#06080F"></div>
    <div class="abs" style="left:196px;top:14px;transform:rotate(-4deg)">${lanes(340, 112, 5, 4711)}</div>
    <div class="abs" style="inset:0;background:linear-gradient(90deg,#06080F 30%,rgba(6,8,15,.82) 46%,rgba(6,8,15,0) 72%)"></div>
    <div class="abs" style="inset:0;background:linear-gradient(180deg,rgba(10,14,25,0) 62%,#0A0E19 100%)"></div>
    <div class="abs m" style="left:24px;top:36px;width:70px;height:70px">${mark}</div>
    <div class="abs w" style="left:104px;top:47px;font-size:33px">STRIKE</div>
    <div class="abs" style="left:106px;top:88px;font-size:11.5px;font-weight:600;color:#9FB0D0">The gaming clip editor</div>`],
  // While it installs: a timeline with the playhead on it.
  'installer-work': [450, 118, (w, h) => `
    <div class="abs" style="inset:0;background:#0A0E19"></div>
    <div class="abs" style="left:-10px;top:6px">${lanes(470, 106, 5, 90210, 0.62)}</div>
    <div class="abs" style="inset:0;background:linear-gradient(90deg,#0A0E19 0,rgba(10,14,25,0) 14%,rgba(10,14,25,0) 86%,#0A0E19 100%)"></div>
    <div class="abs" style="left:298px;top:0;width:2px;height:118px;background:#C6FF3D;box-shadow:0 0 14px 2px rgba(198,255,61,.55)"></div>
    <div class="abs" style="left:293px;top:0;width:12px;height:9px;background:#C6FF3D;clip-path:polygon(0 0,100% 0,50% 100%)"></div>`],
  // The uninstaller's side panel.
  'uninstallerSidebar': [164, 314, (w, h) => `
    <div class="abs" style="inset:0;background:radial-gradient(220px 220px at 50% 22%,#18204a,transparent 75%),#06080F"></div>
    <div class="abs" style="left:-30px;top:196px;transform:rotate(-6deg)">${lanes(230, 130, 6, 31337, 0.8)}</div>
    <div class="abs" style="inset:0;background:linear-gradient(180deg,rgba(6,8,15,0) 50%,rgba(6,8,15,.25) 75%,#06080F 100%)"></div>
    <div class="abs m" style="left:47px;top:48px;width:70px;height:70px">${mark}</div>
    <div class="abs w" style="left:0;right:0;text-align:center;top:130px;font-size:22px">STRIKE</div>`],
};

function bmp24(img, w, h) {
  const src = img.toBitmap();                        // BGRA, top row first
  const row = (w * 3 + 3) & ~3;
  const out = Buffer.alloc(54 + row * h);
  out.write('BM', 0); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = 54 + (h - 1 - y) * row + x * 3;
    out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
  }
  return out;
}

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'strike-art-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => { /* the next picture opens another */ });
app.whenReady().then(async () => {
  for (const [name, [w, h, draw]] of Object.entries(PICS)) {
    const win = new BrowserWindow({ width: w, height: h, useContentSize: true, show: false, frame: false, webPreferences: { offscreen: true, sandbox: true } });
    const page = path.join(app.getPath('userData'), name + '.html');
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${css}body{width:${w}px;height:${h}px}</style>${draw(w, h)}`);
    await win.loadFile(page);
    await win.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,250)))');
    const img = (await win.webContents.capturePage()).resize({ width: w, height: h });
    fs.writeFileSync(path.join(ROOT, 'build', name + '.bmp'), bmp24(img, w, h));
    if (process.env.ART_PNG) fs.writeFileSync(path.join(process.env.ART_PNG, name + '.png'), img.toPNG());
    console.log(name, `${w}x${h}`);
    win.destroy();
  }
  app.quit();
});
