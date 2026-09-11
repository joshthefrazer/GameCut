# GameCut

A desktop video editor for gaming clip workflows: Roblox cinematics, Minecraft
gameplay, Suno instrumental beat-syncing, anime overlays, vertical reposts.

Runs on your machine. No account, no upload, no telemetry. **The editor — where
your footage, your projects and everything you type live — is blocked at the
process level from making any network request at all**, and that has not
changed. Since 1.5.0 the outer shell may fetch exactly one thing: a small file,
from one address compiled into the build, to find out whether there is a newer
version. It sends nothing and it downloads nothing else.
[What that means exactly](#what-goes-over-the-network-and-what-never-does).

---

## New in 1.5.0

- **GameCut updates itself.** You publish, and every install finds out. The
  update arrives quietly in the background and waits — a card in the corner
  says what is new and offers to install it. Nothing changes until it is
  clicked, and it never appears over a running export.
- **The version number in the top bar is now a button**: what you are running,
  what is waiting, Check now, and the full log of everything that has ever
  changed, taken from the same CHANGELOG.md you write.
- **Every release is signed.** An install refuses anything not signed by the key
  it was built with, so control of your web host is not control of your
  friends' machines.
- **You decide when.** One command builds the folder you upload; the version
  everyone sees is whatever that folder says. `--rollout 0.25` gives it to a
  quarter of installs first, `--hold` puts the files in place without telling
  anyone yet.

[How to publish one](#publishing-an-update) ·
[What goes over the network](#what-goes-over-the-network-and-what-never-does)

---

## New in 1.4.0

- **Transitions work the way they do in CapCut.** A small ⋈ button appears on
  every cut where two clips meet. Click it and the Transitions panel — a new tab
  next to Media — opens on that cut, showing six tiles that each draw what they
  do. Dissolve first.
- **A transition now sits ACROSS its cut**, half either side, instead of
  starting at the cut and running forwards. That is what every editor does, and
  it matters: the shot changes at the moment you chose rather than half a second
  later.
- **Take a clip's audio out onto its own track** — right-click any video clip.
  Same file, same in-point, lined up exactly, and the video clip goes silent so
  nothing doubles.
- **Fixed: the fullscreen button had never worked, in any build.** The main
  process refused every permission, and Chromium routes `requestFullscreen()`
  through the same gate as the camera. See
  [why](#why-fullscreen-never-worked).
- Right-clicking a cut gives you the transition list straight away, and the
  badge hides itself when the clips are too narrow for it to sit on without
  covering them.

---

## New in 1.3.0

- **Transitions.** Dissolve, Dip to black and Slide, set per clip and drawn on
  the timeline. The outgoing shot keeps playing through the cut rather than
  freezing.
- **Draw your crop.** The Crop tool now has a Draw mode that traces any shape
  freehand and keeps only what is inside it.
- **Hover help on every control**, and a searchable help sheet on `?` — what
  each tool does, in plain words, plus every shortcut.
- **Right-click the timeline** for everything you can do to a clip, the ruler or
  an empty lane.
- **A save-state chip in the top bar**, and `Ctrl+S`.
- **Markers can be removed** — right-click the ruler. They could only be added
  before.
- **Fixed: a clip added while the decoder pool was full never showed a picture.**
  The pool was evicting the decoder it had just built. See
  [why](#why-a-full-decoder-pool-used-to-break-the-next-clip).
- **Fixed: an exported transition could be missing its outgoing shot** — the
  render loop was not told to decode it.
- Deleting a project no longer opens a modal that freezes the window.

**This one needs a real rebuild**, not a `.gcupdate`. 1.2.0 changed
`electron-main.cjs` — that is where the fix lives for an old update overlay
shadowing the editor forever, which is what was hiding the projects screen — and
a `.gcupdate` is not allowed to touch that file, by design. Run
`BUILD-WINDOWS.bat` once and everything after this can go back to being a
one-click update.

---

## Run it

**Double-click `BUILD-WINDOWS.bat`**, then run `dist\win-unpacked\GameCut.exe`.
That copy needs no installing — double-click and it opens. There is an installer
in `dist` as well if you want Start-menu shortcuts. See [BUILD.md](BUILD.md),
which also covers the "Error opening file for writing" message Windows shows
when it is asked to install over a copy that is still running.

From a terminal:

```bash
npm install
npm start          # run the app
npm run dist       # build the .exe
```

## What goes over the network, and what never does

One address, one direction, one kind of file.

**Never, under any circumstances**

- Your footage, your projects, your project names, your file paths, your fonts,
  your keystrokes, or anything derived from them.
- Usage counts, crash reports, timings, install counts, "anonymous" anything.
- Any request at all from the editor. The renderer — the part that holds all of
  the above — is still restricted at the session layer to `app:` and
  `gcmedia:`, both of which are this process handing the page a local file.
  `https:` is not on that list, so there is no code path from your project to a
  socket. `npm run test:electron` asserts it.

**Once every few hours, and when you press Check now**

- A plain GET of one static file, from the address compiled into
  `update-config.json`, made by the main process using Node's own `https` —
  outside Chromium's network stack entirely.
- No query string, no cookie, no identifier. The one header is a user agent
  saying `GameCut`. A static web host writes an IP address and a timestamp into
  its log for that request, the same as for any file; there is nothing else to
  collect, and nothing is sent back.

**Only after that file says there is something newer, and only then**

- A GET of the update bundle, at an address built from the manifest URL rather
  than read out of the manifest — so a manifest cannot send the app anywhere
  else. The test suite checks this by publishing a manifest that tries.

**The rules around all of it**

- HTTPS, unless the address is loopback. The exception exists so the whole path
  can be tested against a real server rather than by reading the code.
- Redirects are followed only within the same origin.
- 512 KB cap on the manifest, 64 MB on a bundle, 15-second timeout.
- The manifest must carry a valid Ed25519 signature from the key this build was
  compiled with, and the bundle must match the SHA-256 inside that signed
  payload. Either check failing throws the download away.
- With no key compiled in — which is the default in the source — none of this
  runs at all. It fails closed.
- The address and the key live in `update-config.json`, which ships inside the
  package next to the main process. An update may only write the files `app://`
  serves, so **an update can never change where the next update comes from.**

`npm run test:update` stands up a real server on loopback, points a real
GameCut at it, and asserts all of it: a signed release installs; one signed by
a different key is refused; an edited manifest is refused; a bundle swapped
after signing is refused; a downgrade is ignored; a manifest pointing at another
host is refused; a build with no key installs nothing; and a dead or lying
server is survived.

---

## The website

`npm run release` builds the page as well as the update files, from the same
numbers, into the same folder. There is no separate step and no second copy of
the version to keep in step — a download page advertising something the updater
does not offer is a thing you only find out about when a friend asks.

**Setting it up on GitHub Pages**

[PUBLISHING.md](PUBLISHING.md) is the step-by-step version, written for GitHub
Desktop and no prior git. The short version:

```bash
npm run keygen                                             # once, ever
npm run site:init https://joshthefrazer.github.io/GameCut/ # once, or when it moves
npm run dist                                               # build the .exe
npm run release                                            # build the site
git add -A && git commit -m "Release 1.5.0" && git push
```

Then once, on GitHub: **Settings → Pages → Deploy from a branch → your default
branch → `/docs`**.

`FIRST-TIME-SETUP.bat` and `PUBLISH.bat` do the same thing by double-click, for
a machine where opening a terminal is friction rather than convenience.
`PUBLISH.bat` runs the release, and if the answer comes back as "this version
needs a Windows build that does not exist yet" — signalled by exit code 3, which
`npm run release -- --require-installer` produces — it builds one and publishes
again. So an editor-only release takes seconds and never touches the 90 MB
installer, while a shell change quietly gets one.

`site:init` is the only place the address is typed. It writes it into
`update-config.json` (where the app looks for updates), `site/site-config.json`
(what the page says about itself) and `site/CNAME` (only for a real domain —
a `github.io` address deliberately deletes it, because a stale CNAME makes
Pages fight itself). It refuses plain `http`, anything with a query string, and
the placeholder, because getting this wrong is silent: the app checks an address
that does not exist and simply never finds an update, which looks exactly like
there not being one.

**Why `docs/` and not the repository root.** The root already has an
`index.html` — and it is the *editor's*. A Pages site served from `/` would hand
visitors the app's markup without any of the files it needs, which renders as a
blank dark page. Publishing from a subfolder avoids that entirely, and makes
releasing a `git push` rather than dragging files into a web host.
`npm run test:site` asserts the built page is not the editor.

**What you get**

`docs/` then contains:

| | |
|---|---|
| `index.html`, `site.css`, `shots/` | the page |
| `update.json` | the signed manifest the app reads |
| `GameCut-x.y.z.gcupdate` | the editor files |
| `GameCut-x.y.z-x64.exe` | the installer the Download button points at |
| `update.txt` | the manifest in plain text, for you |
| `.nojekyll` | stops Pages running the folder through Jekyll |

```bash
npm run site:preview     # look at it on localhost:8080 before pushing
```

**What to edit.** `site/site-config.json` holds the name, the tagline and the
paragraph under the headline. `site/index.template.html` is the page itself —
the six feature cards and the "your footage" section are plain HTML, and the
version, the download link and the whole changelog are filled in at build time
from `package.json` and `CHANGELOG.md`. `site/shots/` are the screenshots;
**replace `editor.png` with a shot of your own footage** when you have one, and
the page will look like yours rather than like a test pattern.

**The 100 MB wall.** GitHub refuses any single file over 100 MB and the push
fails outright. The installer is around 90 MB, so `npm run release` warns when
it passes 90 — if it ever grows past that, put the `.exe` in a GitHub Release
instead and set `"installer"` in `site/site-config.json` to that download link.
Everything else keeps working unchanged.

**The folder is not wiped between releases**, deliberately. An editor-only
release does not rebuild the `.exe`, and deleting the folder would leave the
Download button pointing at nothing — so the last installer stays, the page says
"installer v1.5.0, updates to 1.6.0 by itself on first run", and old `.gcupdate`
bundles are pruned to the newest three, which is the only thing that actually
accumulates.

`npm run test:site` builds the whole thing in a throwaway copy of the project
with a throwaway key and checks it: the page and the manifest agree about the
version, nothing is left as a placeholder, every file the page links to is in
the folder, a wrapped bullet in CHANGELOG.md arrives whole rather than cut off
at the line break, the download still works on a release that did not rebuild
the `.exe`, and the page does not scroll sideways on a 360px phone.

---

## Publishing an update

Once, ever:

```bash
npm run keygen          # makes your signing key
```

That writes the public half into `update-config.json` and the private half to
`~/.gamecut/signing-key.pem`. Set `manifestUrl` in `update-config.json` to where
the file will live — e.g. `https://yourname.github.io/gamecut/update.json` —
then build the `.exe` once so every copy you hand out carries both.

**Guard the private key.** If you lose it, nothing breaks: make another and give
everyone one more installer. If somebody else gets it, they can push code to
every machine you have ever given GameCut to. It is a password, not a build
artifact — never in the project folder, never in a zip, never in git.

Then, for each release:

```bash
# 1. write what changed, for the people using it, in CHANGELOG.md
# 2. bump "version" in package.json
npm test && npm run test:electron && npm run test:media   # the usual sweep
npm run release
```

`docs/` is then the folder GitHub Pages serves. Its contents:

| | |
|---|---|
| `update.json` | the manifest, signed |
| `GameCut-x.y.z.gcupdate` | the editor files |
| `GameCut-x.y.z-x64.exe` | the installer, if one was built |
| `update.txt` | the same manifest in plain text, for you to read |

Commit it and push; Pages serves it from `docs/`. Nothing runs on the server —
it is a handful of static files, and it works the same on Netlify or your own
domain later.

**Deciding when.** The version everyone sees is whatever is in that folder, so
uploading *is* releasing. Two flags change that:

```bash
npm run release -- --rollout 0.25   # a quarter of installs get it first
npm run release -- --hold           # upload the files, announce nothing yet
```

`--rollout` is decided on each machine from a random local id, so an install
that is early for one release is not systematically early for the next, and it
never flickers between yes and no. Re-run without the flag to give it to
everyone. `--hold` puts a build in place so you can switch it on later by
re-running plain.

**When a release needs the installer.** Changing `electron-main.cjs`,
`preload.cjs`, `package.json`, `updater.cjs` or `update-config.json` means a
file swap is not enough — those run as Node with the full privileges of the
process, and an update is never allowed to touch them. `npm run release`
notices, marks the manifest, and installs then ask for the new `.exe` instead
of half-updating. Build it with `BUILD-WINDOWS.bat` and re-run `npm run release`
so the installer is copied in beside the manifest.

**The release notes are CHANGELOG.md.** `npm run release` reads the bullet
points under the heading for the version in `package.json`. There is one copy of
that text and your friends read the same one. A release with no section for its
own version stops rather than shipping an empty "what's new".

---

## Updating without rebuilding

Rebuilding the `.exe` for every change is three minutes of `npm install` and
electron-builder, and almost always pointless: the interface is plain ES
modules, CSS and one HTML file loaded over `app://` with no bundler and no build
step, so **nothing inside the executable changes when the editor changes** —
only the files it reads.

So there are two kinds of update:

| | What to do |
|---|---|
| **The editor changed** (anything in `src/`, `styles/`, `index.html`) | `npm run release` and upload — every install picks it up on its own. Or, with no server involved, hand someone the `.gcupdate` file: version chip → Install from a file. |
| **The app shell changed** (`electron-main.cjs`, `preload.cjs`, `package.json`, `updater.cjs`, `update-config.json`) | A real rebuild — `BUILD-WINDOWS.bat` again. The manifest says so and installs ask for the new `.exe` rather than half-updating. |

The second is rare, and `npm run update` says which kind you are looking at: it
hashes the shell files and warns when they have moved since the last packed
update, so "just install this" and "you need to rebuild" is never a guess.

```bash
npm run update 1.2.0 "What changed"   # → dist/GameCut-1.2.0.gcupdate
```

The bundle is a single JSON file rather than a zip, because Node has no zip
reader built in and adding a dependency would reintroduce the `npm install` this
whole thing exists to avoid.

**What an update is not allowed to do.** Only paths `app://` already serves get
written — `index.html` and the `src` / `styles` / `vendor` / `assets` folders.
A bundle naming `electron-main.cjs`, `preload.cjs`, or anything outside those
folders has that entry refused and reported. Those run as Node with the full
privileges of the process, and a file swap is not a safe way to change them.
`npm run test:electron` asserts the refusal, including an attempt to escape the
folder with `../`.

**If an update breaks the editor**, the menu bar has **Update → Go back to the
built-in version**. It lives in the native menu rather than the page precisely
because a page that will not start cannot offer you a way out of it. The built-in
version inside the `.exe` is never modified, so that is always a working
fallback. Failing that, deleting the `app-update` folder in the app's data
directory does the same thing by hand.

GameCut is a desktop application only. There is no server, no localhost, no
browser mode and nothing to open in a tab. The window loads its own files over
a private `app://` protocol handled inside the process, so no TCP port is ever
bound: no Windows Firewall prompt, no clash with anything else you have running,
and nothing on your network can reach the editor. The COOP/COEP headers a server
would normally send are attached there instead, which is what keeps
`SharedArrayBuffer` available for the WebCodecs export path.

### On "it's HTML, so isn't it a website?"

The interface is built with HTML, CSS and JavaScript, rendered by the Chromium
engine bundled inside the executable — the same way VS Code, Discord, Slack and
Figma's desktop app are built. That engine is the UI toolkit, not a browser you
open. Nothing is hosted and nothing is served: the page is read off your own
disk over a private `app://` scheme, and the renderer is still refused every
other protocol — including `https:` — at the session layer.

---

## The interface costs nothing per frame

This is the single most important thing in the project, and it was wrong for a
long time. The tell was that **making the window smaller made playback smooth** —
which rules out the decoder and the compositor immediately, because the preview
canvas is sized from the project and the quality setting and never from the
window. If the expense were in producing the picture, resizing the window would
change nothing at all.

Two decorative CSS features were costing the entire editor:

- Three circles the width of half the screen, each with `filter: blur(120px)`,
  drifting forever on a 30-second animation. A blurred layer that moves can
  never be cached; it is re-rasterized continuously, and the bill scales with
  its area.
- `backdrop-filter: blur(18px)` on all five panels. It is the most expensive
  property a live editor can use: the compositor reads back everything painted
  behind the element, blurs it, and re-composites — every time anything behind
  it changes. Something behind them was always changing, because of the circles.

Measured with `npm run diag:chrome`, at 1600×1000, with no video involved at
all — this is the frame rate of an empty `requestAnimationFrame` loop:

| | |
|---|---|
| with both | **5 fps** |
| without them | **60 fps** |

The wash is now baked into the background as plain radial gradients: same look,
rasterized once, never touched again. The panels are opaque instead of frosted,
which at 96% opacity was almost invisible anyway. `npm test` asserts that no
element in the running app has a `backdrop-filter` or an animated blur, because
this is exactly the sort of thing that gets added back for the look of it.

The lesson generalizes: anything ambient and decorative has to earn its place
against the preview's frame budget, and almost nothing does.

### Hardware acceleration

Chromium keeps a blocklist of graphics drivers it refuses to accelerate, and
laptops with older integrated chips often land on it — at which point the whole
window is drawn by the processor and no setting inside the app can make up for
it. GameCut asks for the GPU anyway (`ignore-gpu-blocklist`,
`enable-gpu-rasterization`), and if it still doesn't get it, **it says so** in
plain words and tells you that updating your graphics driver usually fixes it,
rather than leaving you to conclude your machine is too slow.

---

## Look

Black and blue, with glows. `styles/tokens.css` is the only place colors are
defined — the DOM reads the custom properties directly and `src/ui/theme.js`
mirrors the canvas-facing ones into plain strings at boot, because a canvas
can't read CSS variables. Change a token and the panels, the timeline and the
clip bodies all follow. Going from the old white theme to this one was a single
file plus a sweep of controls that had hardcoded a light surface instead of
reading a token; those now read `--surface`, `--surface-hi` and `--field`, so
the next retheme really is one file.

**Every glow is a `box-shadow` or a `text-shadow`.** Never `filter: blur()`,
never `backdrop-filter`. Those are re-rasterized whenever anything behind them
moves and the cost grows with the window — this interface already lost 55fps
that way once. A static shadow is rasterized once and cached, so the glow is
free, and `npm test` fails if a live blur ever reappears.

A retheme breaks legibility in exactly one way: a surface keeps its old colour
while the text on it flips. That is how the track names ended up white on a
leftover near-white strip, at a contrast ratio of 1.06 — invisible, and nothing
else would have caught it. `npm test` now measures the contrast of every piece
of text against what is actually behind it and fails below 2.5:1.

The area immediately around the video frame stays darker still. Judging exposure
and colour against a bright surround lies to your eye, so every NLE keeps the
viewer dark.

---

## What works today (Phase 1 + 2)

**Projects** — the app opens on your projects, not an empty timeline. A gradient
card starts a new one; every saved project shows a still from its own preview,
its length and when you last touched it.

Work is kept automatically: every thirty seconds when something has changed,
when you go back to the project list, and when you close the window — which
says so on the way out rather than leaving you to wonder.

**Your footage is never copied.** A project records *where* each file lives and
streams it from there over a private `gcmedia://` scheme. These are hour-long
recordings; a project that copied them would cost gigabytes per save. So a
project file is a few hundred kilobytes of JSON, and the trade is the same one
Premiere and Resolve make: move a file and the project tells you it is missing
instead of pretending. The clips stay on the timeline so you can see what is
gone.

Two things about that were only found by building it:

- **Byte ranges are not optional.** Without them a video element cannot seek —
  it asks for the bytes around a timestamp, gets the file from the start
  instead, and lands back at zero. Measured exactly that: a 40-second clip asked
  to seek to 30s reported "seeked" and sat at 0. Scrubbing an hour-long
  recording is entirely this code path.
- **Cross-origin isolation blocks it silently.** The page is isolated so
  WebCodecs has `SharedArrayBuffer`, and under `require-corp` every subresource
  from another origin must opt in — and `gcmedia://` is another origin from
  `app://`. Serving it with the editor's usual `same-origin` header made every
  video import produce no asset at all, with no error naming the cause.

**Timeline** — multi-track (video / text / audio), canvas-rendered at 60fps.
**Click anywhere and the playhead goes there** — the ruler, an empty lane, or a
clip, and it keeps playing rather than stopping. Dragging still does what it
always did: a drag on a clip moves it, a drag in empty space marquee-selects.
Drag clips within and across tracks, trim either edge, razor-split at the playhead,
marquee-select, duplicate, nudge by frame. Pixel-space magnetic snapping to clip
edges, the playhead, markers and the beat grid, with a live snap indicator.
Ctrl+scroll zooms around the cursor; zoom-to-fit; horizontal and vertical scrollbars.

**Preview** — real compositing, not a mockup. A green PLAYING pill and a red
transport button say what the transport is doing at a glance; `F` or the button
in the preview's top-right goes fullscreen, and the picture refits immediately
rather than a frame later. Video frames, stills, text and shape
layers composited per frame against the AudioContext clock. Aspect presets
(16:9 / 9:16 / 1:1 / 4:5) reframe the whole project live. Title-safe and action-safe
guides, rule-of-thirds grid, and a 9:16 crop window drawn inside 16:9 projects so
you can frame the landscape cut and the Short at the same time.

**Crop a region out of the picture** — press **C** (or the Crop button above the
preview) and drag a box around anything on screen: a coin counter in the corner,
a timer, a killfeed. That region becomes its own layer on top, still playing
live, which you then drag and scale anywhere you like — the magnified-counter
shot, without leaving the editor.

The original keeps playing underneath, untouched. The new layer lands exactly
over the box you drew, so nothing appears to jump at the moment you crop; every
move after that is one you made on purpose. Crop a cropped layer again to refine
it, nudge the edges numerically in the inspector, or remove the crop to get the
whole frame back.

Two things make it cheap rather than expensive. The crop is stored as a fraction
of the source frame, so it survives a change of project resolution or preview
quality like every other measurement here. And a cropped layer **shares the
decoder of the clip it came from** — same footage, same offset, same speed, same
moment, so one `<video>` serves both. Giving it its own would decode every frame
twice and, with the pool capped at three, evict the original to make room: the
preview would freeze the instant you cropped anything. Move or retime either
layer and they separate into their own decoders, which by then is correct.

**Draw the crop instead of boxing it.** The Crop tool has two modes, Box and
Draw. Draw traces any shape freehand and keeps only what you drew round — round
a head, round a minimap, round a killfeed that is not a rectangle. The shape is
stored *beside* the box rather than instead of it, so the gizmo, the inspector
numbers and the layer's on-screen size all keep working untouched; the shape
only decides which pixels inside that box get painted. The edge is crisp rather
than feathered on purpose: softening it means blurring a mask every frame, and a
per-frame blur is the exact cost this editor spent a day removing.

**Transitions** — Dissolve, Dip to black and Slide, reached the way CapCut does
it. Put two clips next to each other on a track and a small **⋈ button appears
on the seam**. Click it: the playhead parks on the cut, the Transitions tab
comes forward, and six tiles show you what each one does rather than telling
you. Pick one and it is on, with a length slider, a Remove, and a "use this on
every cut" for when you want the whole edit to match. Right-clicking the badge
gives the same list without leaving the timeline.

Everything about that is deliberate. The old version stored the same three
transitions on the clip and offered them as four words in the Inspector, and
nobody found it — which is a verdict on the design, not on the person. You
choose a transition by looking at it.

**A transition sits across its cut**, half before and half after. It used to
start at the cut and run forwards, which is simpler and is wrong: the cut is the
moment you chose, and a transition that only begins there delays the shot change
by its whole length. Centred, the shot changes where you cut it and the blend
happens around that point — which is also what the badge sitting *on* the seam
says is happening.

They work the way an NLE works rather than the way a crossfade of two stills
does: **both sides keep playing through the cut**, the outgoing shot past its
out point and the incoming one before its in point, spending the spare footage
each has. Freezing a frame would be far simpler and would look wrong the moment
anything in the shot is moving, which in gameplay is always. If a clip has no
footage left it holds its last frame — a soft floor rather than a hole in the
picture. Slide is a push: the new shot comes in from one edge and shoves the old
one out of the other, so the two move together as if they were on one strip.

Because a transition is no longer inside either clip's own span, the compositor
composes it at the TRACK level: the track is the thing that is continuously
visible, so the track paints the blend and the two clips involved sit out that
frame. Export asks the same question — `clipsNeededAt` — so it decodes both
sides too.

The transition is still stored on the *incoming* clip rather than "in the gap",
because the clip is the thing you select, move, split and delete; a transition
living between two clips would need its own lifetime rules and would go stale
the first time either side was dragged.

**Take a clip's audio out onto its own track.** Right-click a video clip and its
sound becomes a real audio clip on a real audio lane — same file, same in-point,
same speed, lined up exactly — and the video clip is silenced so the two do not
play a fraction out of phase, which sounds like a broken file rather than a
doubled one. Nothing is copied or re-encoded; both clips point at the same
imported asset. It is one undo, like everything else. That is what you need to
duck music under commentary, or to keep the sound of a moment while cutting away
from it.

**Speed** — 0.1x to 64x, and changing it resizes the clip. Eight times faster,
one eighth as long: the clip holds a fixed stretch of footage, so playing that
stretch quicker has to take less of the timeline. It did not used to, and the
result was a clip that kept its original slot, ran out of footage a fraction of
the way in and looped on its own tail for the rest. Keyframes shrink with the
clip, and the length is floored to a frame that genuinely fits rather than
rounded up into footage that is not there. Past 16x the picture is stepped frame
by frame, because a media element refuses to play faster than that — which is
exactly what a timelapse of a long recording needs.

**Text** — built so the first thing you meet is a row of finished looks, not a
column of numbers.

**Looks** — Clean, Impact, Neon, Gradient, Subtitle, Pill, Typed, Ghost. Each
button is that look rendered in miniature, so it shows what it does rather than
describing it. Click one and you have it; your words, size and position are
kept. Change anything and **Save this look** puts your version in the row
alongside the built-in ones, for every project. Saved looks live in this install
rather than in the project file, because a look is yours and belongs to all of
your work, not to one video.

**What the text can do**

- **Gradient fill** — two colours through the letters at any angle, spanning the
  text's own box so it reads the same whether the word is long or short.
- **Glow, separate from shadow.** A shadow is offset and dark and lifts type off
  the picture; a glow is centred, coloured and usually the point. Editors that
  offer one "shadow blur" slider make you choose and you end up with neither.
- **Background plate** — none, box or pill, with its own colour, padding and
  corner rounding.
- **One-click entrances** — Fade, Pop, Rise, Slam and a real typewriter that
  slices the string rather than fading letters, because a half-faded letter
  reads as a rendering fault and a missing one reads as typing. These are stored
  as a name, not as keyframes, so changing or removing one is a click instead of
  unpicking five keyframes — and the keyframe system still layers on top if you
  want to hand-animate.
- **Outline**, letter gap, line spacing, alignment, per-line wrap.
- **Any font on your computer** (`.ttf` / `.otf` / `.woff2`), loaded through the
  FontFace API and listed as "(yours)".

Everything is named for what it does to the picture — "Outline", not "stroke
width" — and shown 0-100 rather than as fractions of the frame's short edge,
even though the fraction is what gets stored, because the fraction is what keeps
type the same optical size at 4K and after a switch to 9:16. Advanced sections
start collapsed.

### Text behind a character

Text sits on top of whatever is on the tracks below it, and **Send down** /
**Bring up** in the text panel move it a track at a time.

To get text behind a *character*: park the playhead on the shot, press **C** and
draw a box round the character. That becomes its own live layer on top — put the
text below it and the character covers the words. It is a rectangle, so it works
best where the background behind the character is fairly plain.

Being straight about this: that is the manual version. Automatic cutout — the
app finding the person and masking them for you — needs a segmentation model
bundled into the build and a mask pipeline in the compositor, which is its own
project rather than a setting. It is not in here, and pretending otherwise with
something that half-works on Roblox footage would be worse than saying so.

**Nothing is an unlabelled icon.** Hovering any control gives its name, a
sentence saying what it actually does, and the key that does the same thing —
one table, `src/ui/help/tips.js`, which also builds the help sheet, so the two
can never disagree. `?` or `F1` opens that sheet: a six-step walkthrough in plain
words, every tool grouped by where it lives, and every shortcut, with a search
box because a list that long is only useful if you can reach your line of it in
two seconds. The native `title` tooltip is taken off each of those controls —
a browser will happily show its own on top of ours — and moved to `aria-label`,
so the control is still named for a screen reader.

**Right-click anything on the timeline.** A clip offers split, duplicate, delete,
play from here, transition, speed, crop, layer order and lock. The ruler offers
markers — including removing one, which used to be impossible: markers could be
added and never taken off again, so a mistyped `M` was permanent. Empty space
offers text, a marker, import and select-all. Every entry calls the same command
the rest of the app does; the menu is only the route you can find without
knowing where anything is.

**You can see whether your work is saved.** The top bar carries a chip that says
"Saved 2 min ago" or "Unsaved changes", updates itself as time passes, and is a
save button — as is `Ctrl+S`, because everyone tries it. Autosave was already
running; a silent autosave is only reassuring once you have learned to trust it.

**Keyframes** — stopwatch toggle on position, scale, rotation, opacity, text size and
shape dimensions. Linear / ease / in / out / in-out / hold / back interpolation.
The same evaluator drives preview and export, so what you see is what renders.

**Audio** — sample-accurate scheduling through WebAudio. Min/max + RMS waveforms
rendered from 480 buckets per second, normalized so quiet Suno stems still read.
Tap tempo, BPM beat grid overlaid on the timeline, snap-clip-to-beat, "set beat 1
at playhead".

**Media pool** — import with the Import button or by dropping files anywhere on
the pool. To get something onto the timeline: drag it, **double-click it**, or hit
the **+** on the tile — the last two drop it at the playhead and slide it past
anything already there rather than burying it.

Three filters down the side — **All uploads**, **Video files**, **Audio files** —
and they are filters, not folders: each one is derived from what a file actually
is, so nothing can be filed in the wrong place and there is nothing to drag
between. The eight named bins that used to be here (Roblox Captures, Minecraft
Raw, Anime Overlays and five more) guessed from the filename, which put a clip
in the wrong place whenever a recording was named something ordinary, and seven
of the eight sat permanently empty. Images and fonts have no filter of their own
and live under All uploads.

**Video sound** — a clip's own audio plays through the same sample-accurate
graph as a music track, and draws its waveform inside the clip. Every video
track has an **M** button to silence it.

**Long recordings** — an hour-long capture is a different problem from a
five-second clip, and the app is built for it:

- Audio is only pulled into memory for clips under 10 minutes. Decoded audio
  costs `seconds × 48000 × 2 × 4` bytes regardless of how well the file was
  compressed — 1.6 GB for 76 minutes — which starves the video decoder and
  shows up as a black preview. Longer clips play their sound straight off the
  decoder that is already drawing their picture, and go without a waveform.
- **Preview quality** (Full / Half / Quarter, default Half) in the preview
  header. It lowers itself when paints overrun the frame budget and climbs back
  on its own once they are cheap again — without waiting for you to stop, so one
  heavy second at the head of a clip no longer leaves the rest of a twenty-minute
  pass looking soft. Recovery is deliberately harder to trigger than a drop, so
  the two cannot ping-pong. Measured on 1080p footage: compositing into a
  full-size preview canvas costs ~32ms a frame — a 31fps ceiling on any machine —
  while half size is effectively free. Export is never affected.
- **The fps chip counts pictures, not attempts.** The transport ticks at display
  rate whether or not a decoder produced anything, so counting ticks reported a
  confident 60 while the picture visibly stuttered. It now counts frames actually
  painted, and hovering it splits the number in two: pictures on screen versus
  frames the decoder delivered. When those disagree the bottleneck is decode, and
  lowering preview quality will not help.
- **The decoder is left alone during steady playback.** Both available drift
  corrections cost decode — a seek flushes the pipeline, and a `playbackRate`
  change reconfigures it (these elements carry the audio for long clips, so it
  lands on the decode path there too). Correcting little and often produced
  exactly what it sounds like: smooth playback punctuated by a crawl every couple
  of seconds. There is now a wide dead zone, hysteresis so a correction runs
  until it has settled rather than switching on and off at the threshold, and a
  six-second cooldown on the seek of last resort. Measured over four seconds of
  playback: zero rate changes, which the test suite asserts.
- **Frames are painted only when the decoder produces one.** The transport ticks
  at display rate, but a 1080p60 source may decode fewer; repainting regardless
  redraws an identical picture and competes for the GPU the decoder is waiting
  on. Note that `frameFor()` is transport control as well as a frame request, so
  the decoders are still driven every tick via `Compositor.sync()` — skipping
  that deadlocks playback, which is a mistake worth not repeating.
- At most three decoders run at once, so walking a long timeline does not
  accumulate one per clip.
- Speeds above 16× are stepped frame by frame — `playbackRate` throws above 16,
  which would otherwise break a timelapse outright.
- A frame that is not ready holds the previous picture instead of painting
  black. A stutter reads as a stutter; black reads as broken.

The open limitation: a clip too long to decode cannot have its audio mixed into
an **export** yet. The export dialog says so before you start rather than
leaving you to discover it on upload.

**Export** — renders to a real MP4 (H.264) you can upload straight to YouTube,
TikTok or Shorts. Three choices — Best quality, Recommended, Quick draft — sized
from your project, so a vertical project exports vertical. Each frame is
composited at full resolution one at a time rather than screen-recorded, so
nothing is ever dropped however busy the machine gets. Progress shows the frame
count and time remaining, and Cancel stops it cleanly.

**Export speed — the source is played, not seeked.** Almost all of an export
used to be one thing: 99% of it, measured. Rendering parked the source video on
every output frame with a seek, and a seek is the most expensive request you can
make of a video decoder — it discards the decode pipeline, jumps back to the
last keyframe and decodes forward again, up to two seconds of footage to produce
one frame. On 1080p60 that measured **187ms per frame, against 0.14ms to encode
it**.

Export walks time strictly forward in equal steps, which is exactly what a
decoder is built for. Playing the footage and taking frames as they arrive
measures **3x faster end to end** (`npm run diag:export`), which turns a render
that took longer than the video into one that takes less.

The honest cost: a playing decoder does not stop precisely where it is told, so
the frame used can sit up to about one source frame from the requested moment —
16ms on 60fps footage, measured at a median of 3ms. Invisible, but it means the
file is not bit-identical between machines. **Frame-exact render** in the export
dialog seeks to every frame instead, which is slower and always produces the
same bytes.

**Getting it to YouTube.** When a render finishes, **Upload to YouTube** opens
YouTube's upload page in your normal browser and highlights the file in
Explorer, ready to drag onto the page.

It is deliberately not an account login inside the editor. Uploading through
YouTube's own API from an app Google has not audited forces every video to
private and locks it there — "All videos uploaded via the `videos.insert`
endpoint from unverified API projects created after 28 July 2020 will be
restricted to private viewing mode" — so signing in here would cost the network
lockdown and a whole OAuth flow and *still* leave you opening YouTube Studio to
make anything unlisted or public. Handing the browser the file is one click,
keeps the app offline, and leaves the privacy setting, the title and the
thumbnail where they are meant to be chosen.

The renderer cannot name what gets opened, only ask for a destination by key;
the main process owns the list. A page that could hand its own string to
`shell.openExternal` could launch anything on the machine, and `npm run
test:electron` asserts the refusal.

Whether playing forward helps at all depends on the footage — a clip whose frame
rate is near the output's keeps landing between frames, and each of those has to
be corrected with a seek, which is worse than seeking in the first place. So the
renderer does not guess from the file; it watches what actually happens on a
rolling window of recent frames, and a bad window suspends the fast path for a
few hundred frames before it tries again.

The rolling part matters, and it was wrong at first. The original version judged
once, on the opening two dozen frames, and that verdict stood for the whole
render — but those are the coldest frames there are, with the decoder still
warming up and the first `play()` still settling. On a 45,000-frame export it
meant one bad second at the start cost an hour. Suspending rather than stopping,
and never counting the warm-up as evidence, is what fixes it. The progress line
shows the live frame rate and says `(seeking)` when the fast path is suspended,
so this is visible rather than something to deduce from the clock.

Audio is mixed offline and encoded as AAC where the machine can do it (Windows
normally can) and Opus where it can't — negotiated at runtime, because a machine
that *plays* AAC cannot always *make* it.

**Undo/redo** — snapshot history with drag coalescing, so a 300px clip drag is one
undo step. Ctrl+Z / Ctrl+Shift+Z.

---

## Keyboard

| | |
|---|---|
| `Space` | play / pause |
| `←` `→` | nudge selection (or playhead) 1 frame · `Shift` = 1 second |
| `Home` `End` | jump to start / end |
| `S` | split at playhead |
| `C` | crop a region onto its own layer |
| `T` | new text layer |
| `M` | marker (right-click the ruler to remove one) |
| click the `⋈` on a cut | pick a transition for that cut |
| `N` | toggle snapping |
| `B` | toggle beat grid |
| `L` | loop |
| `I` | import |
| `F` | fullscreen preview |
| `Del` | delete selection |
| `Ctrl+D` | duplicate |
| `Ctrl+A` | select all |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+S` | save now (it also saves itself every 30s) |
| `?` or `F1` | what every tool does, and this table, in the app |
| `+` `-` / `Shift+Z` | zoom in, out, fit |
| `Ctrl+scroll` | zoom at cursor |
| `Shift+scroll` | scroll tracks vertically |
| middle-drag | pan |
| right-click | everything you can do to whatever is under the pointer — a clip, a cut, the ruler, or empty space |

---

## Architecture

```
Document  ─┬─  store.js      state container, three channels: doc / ui / rt
           ├─  commands.js   the ONLY place doc is mutated
           └─  history.js    snapshot undo with merge keys

Engine    ─┬─  compositor.js per-frame paint, painter's order, hit testing
           ├─  decoder-pool  one <video> per active clip; frameFor() drives the
           │                 transport, peek() is the read-only query
           ├─  keyframes.js  evalProp(clip, path, t) — one evaluator, everywhere
           └─  playback.js   AudioContext clock, never rAF deltas

UI        ─┬─  timeline/     canvas draw + DOM hit layer, pixel-space snapping
           ├─  preview/      viewport fit, guides, transform gizmo
           ├─  media-pool/   assets, bins, drag sources
           └─  inspector/    property rows bound to commands + keyframes
```

Three rules hold the thing together:

1. **UI never touches `doc`.** Every mutation goes through `commands.js`, which
   wraps it in a history transaction. Undo, autosave and dirty-tracking come free.
2. **Transforms are normalized (0–1).** Nothing stores pixels, so reframing a
   project or exporting at 4K is a multiply, not a migration.
3. **Preview and export share the evaluator.** `evalProp` is the single source of
   truth for any animated value.

### Why fullscreen never worked

`lockDownNetwork()` in the main process ended with one line that refused every
permission the renderer could ask for — written for the camera, the microphone
and geolocation, none of which this app wants. Chromium routes
`element.requestFullscreen()` through that same gate, so the button had been
denied since the first build. The promise rejected, the toast that would have
said so was easy to miss, and under a bare X server (which is what the test box
has) the request does not even get that far — it simply never settles, so a test
that called it could not tell "refused" from "no window manager here".

The fix is an allowlist of exactly one thing. The test is on the decision rather
than the outcome: the main process exposes what it would permit, and
`qa/electron.mjs` asserts fullscreen is allowed and the camera, microphone,
location and notifications are not. Reverting the fix makes that test fail,
which was checked rather than assumed.

### Why a full decoder pool used to break the next clip

The pool keeps a handful of `<video>` elements and evicts the least recently
used one when it needs room. The record for a brand-new decoder was created with
`lastUsed: 0` and the eviction pass ran before that field was stamped — so by
the pool's own measure the newest decoder was the oldest thing it owned, and
once the pool was full it destroyed each new decoder a microsecond after
building it. The next request built another and killed that one too.

From outside it looked exactly like footage that would not decode: `readyState`
stuck at 0, `networkState` at NO_SOURCE, an empty `currentSrc`, and no error
object to explain any of it — because the element had had its `src` taken away
rather than having failed to load one. Fetching the same URL by hand returned
206 with the bytes in it, which is what made it clear the problem was on this
side. A decoder is now stamped as used at the moment it is made, and the
eviction pass will not consider the decoder the caller is currently asking for
whatever the clock says. `qa/media-electron.mjs` fills the pool past its ceiling
and asserts the newest decoder still has a source and still becomes ready.

### Why the decoder is never seeked to correct small drift

Seeking an HTMLVideoElement tears down its decode pipeline. Correcting a few
tens of milliseconds of drift by seeking causes the stall it was meant to fix:
the element re-buffers, falls further behind, and gets seeked again — playback
pins at a couple of frames a second. Small drift is absorbed by bending
`playbackRate` a few percent instead; only a real discontinuity earns a seek.

For the same reason `frameFor()` and `peek()` are separate. `frameFor()` plays,
pauses and seeks as a side effect of asking for a frame, so any read-only
query — measuring a clip's on-screen box, hit-testing a click — has to use
`peek()`, or it will stop the video it is only trying to measure.

### Why FFmpeg.wasm is not in the playback path

Decoding through wasm for preview would stall on every scrub. Playback uses real
`<video>` elements (upgradeable to `VideoDecoder` behind the same `frameFor()`
signature) and only the final render touches an encoder.

---

## Roadmap

**Effects — removed, not pending**
There used to be Effects, Transitions and Graphics tabs here. They were catalogs:
clicking one stored a choice on the clip and changed nothing on screen, because
the renderer that would apply it was never written. Three tabs that looked
finished and did nothing are worse than three tabs that are not there, so they
went, along with `clip.effects`. Transitions have since come back the other way
round — three of them, written first and then given an interface — which is the
rule the rest follows: one at a time, working, rather than a menu of promises.

**Phase 3 — waveforms**
Peak extraction moves to a worker with an IndexedDB LOD cache, so a long
recording draws its waveform without blocking the interface.

**Phase 4 — export** ✅ done
`src/export/` pumps frames from the compositor at project resolution into
`VideoEncoder` and muxes with `mp4-muxer`; audio bounces through
`OfflineAudioContext` into `AudioEncoder`. Still to come: rendering in a worker
so the window stays responsive, and hardware encoding where available.

**Phase 5 — persistence**
Media blobs to OPFS, project JSON to IndexedDB, `.gcproj` save/load, autosave,
crash recovery.

---

## Tests

```bash
npm test                  # core application suite: 110 checks
npm run test:electron     # shell, isolation and security boundaries
npm run test:media        # real H.264 / VP8 / mp3 files, end to end
npm run test:export       # renders an MP4 and inspects it with ffprobe
npm run test:long         # 12-minute clip: memory, timelapse speeds, decoder cap
npm run test:packaged     # the packaged build, running from its asar
npm run test:update       # updates, against a real server on loopback
npm run test:site         # the website, built and inspected

npm run diag:chrome       # what does the window itself cost, with no video?
npm run diag:fps          # pictures per second, real 1080p60, each quality
npm run diag:export       # export: playing the source forward vs seeking
```

The two `diag:` scripts are measurements, not pass/fail tests. Reach for
`diag:chrome` first whenever the editor feels slow: if the number there is low,
nothing about the video path is the problem.

All eight are run before a release. They used to drive a Chromium page
against a dev server, which was a mistake twice over: Playwright's Chromium has
no H.264, so real footage "failed" there while working perfectly in the app —
and a suite that green-lights a configuration nobody ships proves very little.

They fail on any console error, page error or failed request. Between them they
cover boot, playback, every aspect preset, split/trim/drag/marquee, undo/redo
coherence, keyframes, import, all keyboard shortcuts, empty-project and
extreme-zoom edge cases, the three transitions each drawing something different
from a hard cut, a drawn crop masking to its shape, a decoder still working when
the pool is already full, every icon-only control having a name, and the help
sheet and right-click menus opening and doing what they say — plus, on the
desktop side, cross-origin isolation, the preload boundary (no `require`, no
`process` in the renderer), path-traversal refusal, the outbound-network block,
and the whole update path against a server that tries to lie to it.

---

### Why the update system looks the way it does

Three decisions, and they are all the same decision: an update is code arriving
from somewhere else and running with your privileges, so every part of it is
built to fail closed.

**The check lives in the main process, not the renderer.** The renderer is where
the footage, the projects and every keystroke are, and it is still refused
`https:` outright at the session layer. Moving the check there would have been
two lines shorter and would have put a socket in the same process as everything
worth protecting. Node's own `https` in the main process shares nothing with the
page.

**The address is not in the manifest.** Only the manifest URL is trusted; the
bundle address and the installer address are both built from it with `new URL`,
and everything is checked against that one origin before a request is made. A
manifest that names another host is therefore not a vulnerability to mitigate —
it is a string that never gets used. The suite publishes one and asserts it.

**The signature covers bytes, not an object.** `update.json` is
`{ kind, payload, sig }` where `payload` is base64 of the manifest JSON. Signing
the encoded bytes avoids the trap every signed-JSON scheme falls into: two
encoders disagreeing about key order or whitespace, which either breaks valid
signatures or invites a canonicalisation step with its own bugs. There is one
byte string, it is quoted verbatim in the file, and it is what is signed.
`update.txt` sits beside it with the same content in plain text, because *you*
still need to be able to read what you published.

And the whole thing is off unless a public key was compiled in. The default in
the source has none, so a build made without running `npm run keygen` cannot
install anything from the network at all — which is the right way round for a
default to be wrong.

---

## Layout of the source

Everything under `src/` is plain ES modules, loaded directly by the renderer
over `app://` — there is no bundler and no build step for the app code itself.
`styles/tokens.css` holds the design tokens — change the accent there and the whole
interface follows.
