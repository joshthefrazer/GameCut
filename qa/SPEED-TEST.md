# Strike export speed test (for a second computer)

Tests the export speed-ups against the old behaviour on whatever computer you run it on, and checks
that nothing broke. It does not change your footage or your projects.

## What to bring

1. **The Strike folder** (without `node_modules` and `dist`, which are big and get rebuilt). Copy it by
   USB stick or cloud drive.
2. **One test video**: a 1080p60 recording of at least 12 seconds, ideally the kind you really edit.
   A good one is `MedalTVRoblox20261023165210939.mp4` (153 MB) from `Videos\Medal\Clips\Roblox`.
   Any 1080p60 clip works, but results from different clips can't be compared.

## On the college computer

1. Install **Node.js LTS** from https://nodejs.org if it isn't there (default options). If you can't install
   software there, get the portable zip from the same site, unzip it, and add its folder to PATH for that session.
2. If it's a **laptop with an NVIDIA card** (it usually also has an Intel one): make sure Strike's engine uses the
   NVIDIA card, otherwise the test measures the wrong chip. Windows Settings → System → Display → Graphics →
   Browse → pick `Strike\node_modules\electron\dist\electron.exe` (it appears after the first run; run the test once,
   set this, then run it again) → Options → **High performance**. The test prints which graphics chip it used.
3. Close other heavy programs (games, video calls, browsers with many tabs) and plug the laptop in.
4. **Drag the test video onto `qa\RUN-SPEED-TEST.bat`.** The first run installs the app's tools (about 300 MB).
5. Leave it alone until it says *Done* (5–15 minutes). It opens its own Strike windows.
6. Send back the newest file in `qa\out\` named `speed-test-<computer>-<time>.txt`.
   If an exported test file looks wrong, also keep `qa\out\speed-test-encoder-restart.mp4`.

## Reading the result

The table lists frames per second for each kind of edit, old behaviour against new (higher is better):

| Scene | What it is | What should change |
|---|---|---|
| `plain` | one clip, no extras | little or nothing: this is limited by the video hardware |
| `vblur` | vertical 9:16 short with the blurred background | should speed up if the blur fix was the right diagnosis |
| `cam` | gameplay plus a facecam cut out of the same recording | should speed up (one decode instead of two) |
| `second` | two shots with a dissolve between them | should speed up (decoder no longer dropped mid-transition) |
| `heavy` | all of the above plus titles | should speed up the most |

Then three extra checks:

* **Blurred background look check**: the new background should look the same as the old one ("looks the same").
* **Encoder failure**: the test pretends the video encoder failed half-way. A new one should take over and
  the finished file should decode cleanly with the right number of frames.
* **Decoder failures**: one failure should recover quietly; three in a row should fall back to the slow player
  *and* say so.

If a number gets worse or a check says FAILED / DIFFERENT, that's the useful part: send the file anyway.

## Options

`RUN-SPEED-TEST.bat "clip.mp4" --secs 10 --rounds 3 --scenes plain,vblur,heavy --no-failures`
(`--fps`, `--w`, `--h`, `--mbps` and `--noaudio` also exist; see the top of `qa\speed-test.mjs`.)
