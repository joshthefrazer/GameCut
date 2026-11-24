/**
 * Run the test suites while you use the computer.
 *
 *   node qa/run-quiet.mjs              the light suites (a few minutes each, little CPU)
 *   node qa/run-quiet.mjs --all        also the heavy ones (exports, the outline model)
 *   node qa/run-quiet.mjs tools-a qol  just these
 *
 * Quiet means: every Strike window opens off-screen and never takes focus, all
 * sound is muted (STRIKE_QA_QUIET=1, see electron-main.cjs), and everything runs
 * at below-normal priority, so a video you are watching gets the processor first.
 * Results: printed, and saved to qa/out/quiet-results.txt.
 */
import { spawn } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIGHT = ['tools-a', 'features', 'features2', 'timeline', 'timeline-next', 'qol', 'ui-next', 'strike', 'smart-crop', 'crop-box', 'text-motion', 'engine'];
const HEAVY = ['export-sink', 'outline'];

const args = process.argv.slice(2);
const named = args.filter(a => !a.startsWith('--'));
const suites = named.length ? named : args.includes('--all') ? [...LIGHT, ...HEAVY] : LIGHT;

// Below normal: Windows hands the same priority to the Electron windows the tests start.
try { setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: carry on */ }

mkdirSync(path.join(ROOT, 'qa', 'out'), { recursive: true });
const env = { ...process.env, STRIKE_QA_QUIET: '1' };
const summary = [];

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'qa', `${name}.mjs`), path.join(ROOT, 'qa', 'out')], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', (code) => {
      const lines = out.split('\n').filter(l => /FAIL|PASSED|FAILED|!!|all good/.test(l)).map(l => l.trim().slice(0, 240));
      const secs = Math.round((Date.now() - started) / 1000);
      const line = `${code === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${secs}s  ${code === 0 ? '' : lines.filter(l => /FAIL|!!/.test(l)).join(' | ')}`;
      console.log(line);
      summary.push(line);
      resolve(code);
    });
  });
}

console.log(`Quiet test run: ${suites.length} suite(s), muted, off-screen, low priority.\n`);
let failed = 0;
for (const s of suites) if (await run(s)) failed++;
const text = `${new Date().toISOString()}\n${summary.join('\n')}\n\n${failed ? `${failed} suite(s) failed` : 'all passed'}\n`;
writeFileSync(path.join(ROOT, 'qa', 'out', 'quiet-results.txt'), text);
console.log(`\n${failed ? `${failed} suite(s) failed` : 'all passed'} — saved to qa/out/quiet-results.txt`);
process.exit(failed ? 1 : 0);
