/**
 * Pictures of the update panel, the "new version" card and the What's-new card
 * with the real 2.1.0 notes, in every theme. Off-screen; no network.
 *   node qa/updates-look.mjs
 */
process.env.STRIKE_QA_QUIET = '1';
const { launch, ROOT } = await import('./harness.mjs');
const T = await launch({ name: 'uplook', size: [1366, 768] });
const { win, ev, fresh, sleep } = T;
await fresh();
await ev(() => window.gc.updates.open());
await sleep(500);
for (const theme of (process.argv[2] || 'strike,day').split(',')) {
  await ev((t) => { if (t === 'strike') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }, theme);
  await sleep(200);
  await win.screenshot({ path: `${ROOT}/qa/out/updates-panel-${theme}.png` });
}
await ev(() => { delete document.documentElement.dataset.theme; window.gc.updates.close(); window.gc.whatsNew.open(); });
await sleep(400);
await win.screenshot({ path: `${ROOT}/qa/out/whatsnew.png` });
await ev(() => { document.getElementById('whatsNewOk').click(); document.documentElement.dataset.theme = 'day'; window.gc.whatsNew.open(); }); await sleep(300);
await win.screenshot({ path: `${ROOT}/qa/out/whatsnew-day.png` });
await ev(() => { document.getElementById('whatsNewOk').click(); delete document.documentElement.dataset.theme; return window.gc.captionFiles.importText('1\n00:00:00,300 --> 00:00:02,000\nthat was insane bro\n\n2\n00:00:02,200 --> 00:00:04,400\nno way he hit that\n', { name: 't' }); });
await ev(() => { window.gc.captionEditor.open(); document.querySelector('#captionEditor [data-word$=\":2\"]').click(); }); await sleep(400);
await win.screenshot({ path: `${ROOT}/qa/out/cape.png` });
// Every panel must be solid: nothing showing through.
for (const s of ['.upd__card', '.mini__box', '#captionEditor']) {
  const bg = await ev((s) => getComputedStyle(document.querySelector(s)).backgroundColor, s);
  const a = /rgba\(.*,\s*([\d.]+)\)/.exec(bg);
  if (a && +a[1] < 1) T.problems.push(s + ' is see-through: ' + bg);
}
console.log('api', await ev(() => Object.keys(window.gc.updates || {})), 'problems', T.problems);
await T.app.close(); process.exit(T.problems.length ? 1 : 0);
