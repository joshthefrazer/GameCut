/**
 * Serving files to the player: right bytes, and cancelling never throws.
 *   node qa/file-body.mjs          (no app, no window)
 *   node qa/file-body.mjs --old    the previous way, to show the error it had
 */
import { createRequire } from 'node:module';
import { createReadStream, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { fileBody } = createRequire(import.meta.url)('../file-body.cjs');
const OLD = process.argv.includes('--old');
const body = OLD ? (f, o) => createReadStream(f, o) : fileBody;
let thrown = 0, sample = '';
process.on('uncaughtException', (e) => { thrown++; sample ||= e.message; });
process.on('unhandledRejection', (e) => { thrown++; sample ||= String(e?.message || e); });

const dir = mkdtempSync(path.join(tmpdir(), 'strike-fb-'));
const file = path.join(dir, 'f.bin');
const data = randomBytes(1_500_001);
writeFileSync(file, data);
const sha = (b) => createHash('sha256').update(b).digest('hex');
let failed = 0;
const check = (ok, name) => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); };

const whole = Buffer.from(await new Response(body(file)).arrayBuffer());
check(sha(whole) === sha(data), 'the whole file arrives intact');
for (const [s, e] of [[0, 0], [100, 99_999], [262_143, 262_144], [1_500_000, 1_500_000], [700_000, 1_500_000]]) {
  const part = Buffer.from(await new Response(body(file, { start: s, end: e })).arrayBuffer());
  check(part.equals(data.subarray(s, e + 1)), `bytes ${s}-${e}`);
}
// Cancel at every sort of moment, above all just as the file ends.
for (let i = 0; i < 1500; i++) {
  const len = [1, 900, 65_536, 262_144, 300_000][i % 5];
  const r = new Response(body(file, { start: 0, end: len - 1 })).body.getReader();
  const reads = i % 4;
  for (let k = 0; k < reads; k++) r.read().catch(() => {});
  if (i % 3 === 0) await r.read().catch(() => {});
  if (i % 7 === 0) await new Promise(setImmediate);
  r.cancel().catch(() => {});
}
// The exact moment: every byte has arrived, the end has not been noticed yet.
for (let i = 0; i < 1000; i++) {
  const len = [1, 900, 65_536, 70_000][i % 4];
  const r = new Response(body(file, { start: 0, end: len - 1 })).body.getReader();
  let got = 0;
  while (got < len) { const { value, done } = await r.read(); if (done) break; got += value.byteLength; }
  r.read().catch(() => {});
  for (let k = 0; k < i % 12; k++) await null;
  if (i % 3 === 1) await new Promise(process.nextTick);
  if (i % 3 === 2) await new Promise(setImmediate);
  r.cancel().catch(() => {});
}
await new Promise(r => setTimeout(r, 500));
check(thrown === 0, `2500 cancelled reads throw nothing${thrown ? ` — ${thrown} errors: ${sample}` : ''}`);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold it a moment */ }
console.log(failed ? '\nFILE-BODY FAILED' : '\nFILE-BODY PASSED');
process.exit(failed ? 1 : 0);
