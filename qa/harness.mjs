/**
 * Shared driver for the front-door tests: launch the real app, then do things
 * the way a person does — file picker, mouse, keyboard — reading the
 * timeline's own layout only to know where to aim.
 */
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { waitFor } from './wait.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const FIX = (n) => `${ROOT}/qa/fixtures/${n}`;
export { sleep, waitFor };

export async function launch({ name = 'test', size = [1600, 960], env = null } = {}) {
  const PROFILE = `/tmp/gc-${name}-${process.pid}`;
  await rm(PROFILE, { recursive: true, force: true });
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${PROFILE}`],
    cwd: ROOT, timeout: 60000,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, s) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(s[0], s[1]); w.center(); }, size);
  const problems = [];
  const IGNORE = /deprecat|Autoplay|AudioContext|willReadFrequently/i;
  win.on('pageerror', e => problems.push('pageerror: ' + e.message));
  win.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) problems.push('console.error: ' + m.text()); });
  await win.waitForLoadState('domcontentloaded'); await sleep(1800);

  const ev = (fn, arg) => win.evaluate(fn, arg);
  const frame = () => sleep(140);
  let failed = 0;
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
  const step = async (title, fn) => {
    if (only && !only.test(title)) return;
    const before = problems.length;
    try { await fn(); } catch (e) { problems.push(`${title}: ${e.message}`); console.log('  !! ' + e.message); }
    const ok = problems.length === before;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}`);
  };

  async function fresh() {
    const home = await ev(() => document.getElementById('app').classList.contains('is-home'));
    if (!home) {
      await ev(() => window.gc.library && document.getElementById('btnHome').click());
      await waitFor(win, () => document.getElementById('app').classList.contains('is-home'), null, { timeout: 15000 });
    }
    await win.click('#homeNew');
    await waitFor(win, () => !document.getElementById('app').classList.contains('is-home'), null, { timeout: 15000 });
    await sleep(400);
    await ev(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  }
  async function importFiles(paths) {
    const n0 = await ev(() => window.gc.assets.all().length);
    await win.setInputFiles('#filePicker', paths);
    await waitFor(win, (n) => window.gc.assets.all().length >= n, n0 + paths.length, { timeout: 30000 });
    await sleep(600);
  }
  const clips = () => ev(() => window.gc.store.doc.tracks.flatMap((t, ti) => t.clips.map(c => ({
    id: c.id, name: c.name, type: c.type, start: c.start, duration: c.duration, inPoint: c.inPoint,
    speed: c.speed, linkTo: c.linkTo ?? null, crop: c.crop ?? null, track: t.name, trackId: t.id,
    trackKind: t.kind, trackIndex: ti, transform: c.transform, motion: c.motion ?? null,
  }))));
  const byStart = async (type = null) => (await clips()).filter(c => !type || c.type === type).sort((a, b) => a.start - b.start);
  const box = (id) => ev((id) => {
    const { L } = window.gc.timeline;
    const v = document.getElementById('timelineView').getBoundingClientRect();
    for (const row of L.rows) {
      const c = row.track.clips.find(c => c.id === id);
      if (c) return { x0: v.left + L.t2x(c.start), x1: v.left + L.t2x(c.start + c.duration),
                      y: v.top + row.y + row.h / 2, top: v.top + row.y, h: row.h };
    }
    return null;
  }, id);
  const xOf = (t) => ev((t) => document.getElementById('timelineView').getBoundingClientRect().left + window.gc.timeline.L.t2x(t), t);
  async function drag(x0, y0, x1, y1, steps = 12, { alt = false, shift = false } = {}) {
    await win.mouse.move(x0, y0);
    if (alt) await win.keyboard.down('Alt');
    if (shift) await win.keyboard.down('Shift');
    await win.mouse.down();
    for (let i = 1; i <= steps; i++) { await win.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await sleep(14); }
    await win.mouse.up();
    if (shift) await win.keyboard.up('Shift');
    if (alt) await win.keyboard.up('Alt');
    await frame();
  }
  const playheadTo = async (t) => { await ev((t) => window.gc.playback.seek(t), t); await frame(); };
  async function clickClip(id, { shift = false } = {}) {
    const b = await box(id);
    if (shift) await win.keyboard.down('Shift');
    await win.mouse.click((b.x0 + b.x1) / 2, b.top + 8);
    if (shift) await win.keyboard.up('Shift');
    await frame();
  }
  async function setRipple(on) {
    const is = await ev(() => document.getElementById('btnRipple').classList.contains('is-active'));
    if (is !== on) await win.click('#btnRipple');
    await sleep(80);
  }
  async function setSnap(on) {
    const is = await ev(() => window.gc.store.ui.snap);
    if (is !== on) await win.click('#btnMagnet');
  }
  const toastTexts = () => ev(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent));
  async function finish(label) {
    await app.close();
    console.log(failed ? `\n${label} FAILED — ${failed} step(s)\n${problems.map(p => ' • ' + p).join('\n')}` : `\n${label} PASSED`);
    process.exit(failed ? 1 : 0);
  }

  return { app, win, ev, frame, step, fresh, importFiles, clips, byStart, box, xOf, drag, playheadTo,
    clickClip, setRipple, setSnap, toastTexts, finish, problems, sleep };
}
