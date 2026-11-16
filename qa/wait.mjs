/**
 * Polling stand-in for page.waitForFunction.
 *
 * Playwright's own waitForFunction compiles its predicate inside the page,
 * which the app's Content-Security-Policy (no 'unsafe-eval') refuses, so every
 * test that used it failed before it could check anything. `evaluate` goes
 * through the debugger protocol instead and is allowed.
 */
export async function waitFor(page, fn, arg = null, { timeout = 30000, polling = 100 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await page.evaluate(fn, arg); } catch (e) { last = undefined; if (Date.now() > until) throw e; }
    if (last) return last;
    if (Date.now() > until) throw new Error(`waitFor timed out after ${timeout}ms: ${String(fn).slice(0, 120)}`);
    await new Promise(r => setTimeout(r, typeof polling === 'number' ? polling : 100));
  }
}
