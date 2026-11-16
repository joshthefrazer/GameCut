/**
 * Makes the test media the qa/ suites import (qa/fixtures is not committed).
 * Needs ffmpeg on PATH. Safe to run again: existing files are kept.
 *   node qa/make-fixtures.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, 'fixtures');
mkdirSync(DIR, { recursive: true });
const fx = (n) => path.join(DIR, n);
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const make = (name, args) => {
  if (existsSync(fx(name))) return console.log(`  have ${name}`);
  ff([...args, fx(name)]); console.log(`  made ${name}`);
};
const sine = (f, sr = 48000) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=${sr}`];

// 5 s, 640×360, 30 fps, with sound: the clip almost every suite uses.
make('test-clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', ...sine(440), '-t', '5',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest']);
make('test-clip.webm', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', ...sine(440), '-t', '5',
  '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-b:v', '1M', '-c:a', 'libopus', '-shortest']);
make('test-tone.mp3', [...sine(660, 44100), '-t', '8', '-c:a', 'libmp3lame', '-b:a', '128k']);
make('test-logo.png', ['-f', 'lavfi', '-i', 'color=c=0xff5a1f@1:size=256x256,format=rgba,drawbox=x=64:y=64:w=128:h=128:color=white@1:t=fill', '-frames:v', '1']);
// 10 s of 1080p60 with sound: the heavy case for playback and export cost.
make('hd1080p60.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', ...sine(440), '-t', '10',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest']);
// 12 minutes, tiny picture: past what can be decoded whole.
make('long-clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5', ...sine(440), '-t', '720',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-shortest']);
// 10 s, quiet except for loud hits at 1.5, 3.3 and 6 s.
make('hits-clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i',
  "aevalsrc='0.02*sin(2*PI*220*t)+if(between(t,1.5,1.8)+between(t,3.3,3.6)+between(t,6,6.3),0.9*sin(2*PI*330*t),0)':s=48000",
  '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest']);
// A font file to import.
if (!existsSync(fx('GCTestFont.ttf'))) {
  const f = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'].find(existsSync);
  if (f) { copyFileSync(f, fx('GCTestFont.ttf')); console.log('  made GCTestFont.ttf'); } else console.log('  no system font found for GCTestFont.ttf');
}
console.log('fixtures ready in', DIR);
