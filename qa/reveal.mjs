/**
 * The inspector shows one tab at a time and folds its advanced groups away.
 * A person clicks the tab (or opens the group) before reaching inside; this
 * makes a page's click() do the same, so older suites keep driving the real UI.
 */
export function patchClick(page) {
  const click = page.click.bind(page);
  const reveal = (sel) => page.evaluate((s) => {
    let el = null;
    try { el = document.querySelector(s); } catch { return; }
    if (!el) return;
    const pane = el.closest('.ipane');
    if (pane && !pane.classList.contains('is-active')) document.querySelector(`#inspectorRoot [data-itab="${pane.dataset.ipane}"]`)?.click();
    const g = el.closest('.group.is-closed');
    if (g) g.querySelector('.group__h')?.click();
    const drawer = el.closest('#leftPanel .tabpane');
    if (drawer && !drawer.classList.contains('is-active')) document.querySelector(`#leftTabs [data-tab="${drawer.dataset.pane}"]`)?.click();
  }, sel).catch(() => {});
  page.click = async (sel, opts) => { await reveal(sel); return click(sel, opts); };
  return reveal;
}

/** The same, for a Playwright locator: open the tab / group that holds it. */
export async function revealLocator(loc) {
  await loc.evaluate((el) => {
    const pane = el.closest('.ipane');
    if (pane && !pane.classList.contains('is-active')) document.querySelector(`#inspectorRoot [data-itab="${pane.dataset.ipane}"]`)?.click();
    const g = el.closest('.group.is-closed');
    if (g) g.querySelector('.group__h')?.click();
  }, null, { timeout: 5000 }).catch(() => {});
}
