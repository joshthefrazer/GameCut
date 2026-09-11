/**
 * Make the signing key pair, once.
 *
 *   npm run keygen
 *
 * Writes the PUBLIC half straight into update-config.json, where it is compiled
 * into every .exe you build from then on, and the PRIVATE half to a file outside
 * the project — because the two must never travel together, and the project
 * folder is the thing you will zip up and send to people.
 *
 * What the private key is for: every release you publish is signed with it, and
 * an install refuses anything that is not signed by the matching public half.
 * That is what stands between your friends and somebody who gets control of
 * your web host — without it, whoever can change the file at that address can
 * run code on every machine that has GameCut installed.
 *
 * If you lose it, nothing breaks; you generate a new pair and everyone installs
 * one more .exe. If somebody else GETS it, they can push an update to every
 * install you have ever handed out. Keep it like a password.
 */
import { writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG = path.join(ROOT, 'update-config.json');
const KEY_DIR = process.env.GAMECUT_KEY_DIR || path.join(homedir(), '.gamecut');
const KEY_FILE = path.join(KEY_DIR, 'signing-key.pem');

const force = process.argv.includes('--force');

const exists = await access(KEY_FILE).then(() => true, () => false);
if (exists && !force) {
  console.log(`\n  You already have a signing key:\n    ${KEY_FILE}`);
  console.log('\n  Keep using it. Making a new one would mean every existing install');
  console.log('  stops trusting your updates until it is reinstalled.');
  console.log('  If that is genuinely what you want: npm run keygen -- --force\n');
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

await mkdir(KEY_DIR, { recursive: true });
await writeFile(KEY_FILE, privPem, { mode: 0o600 });

const cfg = JSON.parse(await readFile(CONFIG, 'utf8'));
cfg.publicKey = pubDer;
await writeFile(CONFIG, JSON.stringify(cfg, null, 2) + '\n');

console.log('\n  ── GameCut signing key ───────────────────────────────');
console.log(`\n  Private key  ${KEY_FILE}`);
console.log('               Never put this in the project folder, a zip, or a');
console.log('               git repository. Back it up somewhere only you can reach.');
console.log(`\n  Public key   written into update-config.json`);
console.log('               This one is meant to ship. It is what lets an install');
console.log('               tell your updates from anybody else’s.');
console.log('\n  Next: set "manifestUrl" in update-config.json to where you will');
console.log('  host update.json, then rebuild once so every copy carries the key.\n');
