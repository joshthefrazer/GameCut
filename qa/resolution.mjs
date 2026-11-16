/**
 * Importing footage must not quietly lower its resolution.
 *
 * Drives the real app: imports real files through the picker and reads what
 * the project canvas, the preview and the export dialog end up at.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(process.argv[3] || path.join(import.meta.dirname, '..'));
const OUT = path.resolve(process.argv[2] || '/tmp');
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  ' + extra}`); };

const make = (size) => {
  const f = path.join(OUT, `res-${size}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
  return f;
};

async function session(fn) {
  const P = '/tmp/gc-res-' + process.pid + '-' + Math.random().toString(36).slice(2, 7);
  await rm(P, { recursive: true, force: true });
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + P], cwd: ROOT, timeout: 60000 });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1900, 1050); w.center(); });
    await win.waitForLoadState('domcontentloaded'); await sleep(1800);
    await win.click('#homeNew'); await sleep(800);
    await fn(win);
  } finally { await app.close(); }
}
const hasVideo = (win) => win.evaluate(() => window.gc.store.doc.tracks.some(t => t.clips.some(c => c.type === 'video')));
async function importFile(win, file) {
  const before = await win.evaluate(() => window.gc.assets.all().length);
  await win.setInputFiles('#filePicker', [file]);
  for (let i = 0; i < 80; i++) { if (await win.evaluate((n) => window.gc.assets.all().length > n, before)) break; await sleep(250); }
  await sleep(1500);
}
const doc = (win) => win.evaluate(() => { const d = window.gc.store.doc; return [d.width, d.height, d.aspect]; });

const cases = [
  ['2560x1440', [2560, 1440, '16:9']],
  ['3840x2160', [3840, 2160, '16:9']],
  ['1920x1080', [1920, 1080, '16:9']],
  ['1280x720',  [1920, 1080, '16:9']],     // never shrinks the canvas
  ['1080x1920', [1080, 1920, '9:16']],     // phone clip in a fresh project
  ['1440x2560', [1440, 2560, '9:16']],
  ['3440x1440', [1920, 1080, '16:9']],     // ultrawide: standard canvas, letterboxed
];
for (const [size, want] of cases) {
  await session(async (win) => {
    await importFile(win, make(size));
    check(`${size} → project ${want[0]}×${want[1]}`, await hasVideo(win) && JSON.stringify(await doc(win)) === JSON.stringify(want), JSON.stringify(await doc(win)));
    const sharp = await win.evaluate(() => {
      const { comp, store } = window.gc;
      const shown = Math.round(comp.canvas.clientWidth * (window.devicePixelRatio || 1));
      return { canvas: comp.canvas.width, shown, project: store.doc.width, scale: store.ui.previewScale };
    });
    check(`${size} preview is as sharp as the panel (canvas ${sharp.canvas}px for ${sharp.shown}px shown)`,
      sharp.canvas >= Math.min(sharp.shown, sharp.project) * 0.97, JSON.stringify(sharp));
  });
}

// Undo is one step and gives back both the clip and the old size.
await session(async (win) => {
  await importFile(win, make('2560x1440'));
  await win.evaluate(() => window.gc.history.undo()); await sleep(300);
  const r = await win.evaluate(() => ({ d: [window.gc.store.doc.width, window.gc.store.doc.height], clips: window.gc.store.doc.tracks.reduce((n, t) => n + t.clips.length, 0) }));
  check('undo restores 1920×1080 and removes the clip together', r.d[0] === 1920 && r.d[1] === 1080 && r.clips === 0, JSON.stringify(r));
});

// A project that already has footage never changes size under you.
await session(async (win) => {
  await importFile(win, make('1920x1080'));
  await importFile(win, make('3840x2160'));
  await win.evaluate(() => { const g = window.gc; g.cmds.addClip && 0; });
  const id = await win.evaluate(() => window.gc.assets.all().find(a => a.width === 3840).id);
  await win.evaluate((id) => { const { store, cmds } = window.gc; cmds.fitProjectToFootage(window.gc.assets.get(id)); }, id);
  check('second recording does not resize the project', JSON.stringify(await doc(win)) === JSON.stringify([1920, 1080, '16:9']), JSON.stringify(await doc(win)));
});

// A shape the person already chose is respected.
await session(async (win) => {
  await win.click('#aspectSeg [data-ar="9:16"]'); await sleep(400);
  await importFile(win, make('2560x1440'));
  const d = await doc(win);
  check('a 9:16 project stays 9:16 when landscape footage arrives', d[2] === '9:16' && d[0] === 1080 && d[1] === 1920, JSON.stringify(d));
});

// The export dialog offers the footage's own size.
await session(async (win) => {
  await importFile(win, make('2560x1440'));
  await win.click('#btnExport'); await sleep(900);
  const txt = await win.evaluate(() => document.querySelector('#exportModal')?.textContent || '');
  check('export dialog offers 2560×1440', /2560\s*[×x]\s*1440/.test(txt), txt.slice(0, 200));
});

console.log(fails ? `\n${fails} FAILED` : '\nall resolution checks passed');
process.exit(fails ? 1 : 0);
