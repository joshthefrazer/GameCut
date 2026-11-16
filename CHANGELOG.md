# Changelog

What goes in here is what your friends read inside the app. `npm run release`
pulls the bullet points from the section matching the version in `package.json`
and puts them in the manifest, so there is one copy of the text and it is this
one.

Write them for the person using GameCut, not for yourself: "you can drag the
ends of a clip to trim it" rather than "added trim handles to clip-renderer".

## 2.0.5

Faster exports.

- Export waits on your graphics card's encoder and decoder the moment they
  are ready, instead of on short timers that Windows stretches to ~15 ms each.
- Your recordings are decoded on the graphics card when it can.
- Graphics cards that refuse "constant bitrate" now encode in variable mode
  instead of the whole export falling back to the processor.
- The progress line says what is doing the work: "graphics card encoding" or
  "processor (slower) encoding", and the same for decoding.

## 2.0.4

Bug-fix pass.

- Smaller windows: the top bar no longer pushes the app wider than the
  window, so Export, the inspector and the media panel stay on screen on a
  laptop or a window that is not maximised. The tools on the picture wrap
  instead of overlapping.
- Keys like S, Space and T sometimes did nothing at first: the project name
  box was quietly taking the focus. It now only takes it when you click it.
- Exports of MKV recordings now use the same fast, frame-exact decoding as
  MP4s.
- Two clips of the same recording on screen at once export quickly.

## 2.0.3

- Find the HUD: a piece that was joined from several (three bars stacked in
  a corner) has a Split button, and Shift+click on the picture keeps just the
  part under the pointer.
- Recordings with several sound tracks (Medal, OBS): Strike listens to a few
  moments of every track. Silent tracks are left out, a track already inside
  the first one (OBS's mic track) is left out, and the rest are mixed — so a
  Medal clip whose first track is empty still has sound.
- Fixed: no sound from Medal clips (and other recordings with several sound
  tracks). 2.0.1 started using only the first track, which is the full mix in
  OBS but can be empty, or just the game, in Medal. Strike now listens to a few
  moments of every track: silent tracks are left out, a track already inside
  the first one (OBS's mic track) is left out, and the rest are mixed.
- Adding a clip from Media when the playhead is over another clip: it goes in
  after it, as before, but the timeline now scrolls to show where it went and
  says so. With a long recording on the timeline it used to land off screen,
  so it looked like nothing happened.

## 2.0.2

More sound and export fixes.

- MKV recordings (OBS's default) now keep their sound however long they are:
  it is read straight out of the file, plays in step with the picture, and
  goes into the export. Long MKVs used to export silent.
- Exports decode your MP4 footage frame by frame instead of jumping around in
  it: several times faster on OBS recordings, and every frame is the right
  one — no more frozen or repeated frames.

## 2.0.1

Sound and export fixes.

- No more crackle when game sound, voice, music and effects play together:
  the mix is kept from clipping, in the preview and in exports.
- Sound that is still being prepared when you press Play now comes in by
  itself once it is ready, instead of staying silent until you press Play again.
- The picture is held back by your headphones' or speakers' delay, so sound
  and picture line up (most noticeable on Bluetooth).
- OBS recordings with more than one sound track use track 1 (the full mix)
  instead of adding every track together, which doubled the mic.
- Exports of OBS recordings are faster and smoother: Strike no longer goes
  back to the last keyframe for a difference of less than a frame.

## 2.0.0

GameCut is now **Strike** — the biggest update yet. Your projects come with you.

- A new name and a new look: a new logo, new fonts, and four themes in
  Settings (Strike, Pitch black, Neon night, Daylight).
- Edit · Library · Export along the top. Library shows every animation big
  and moving.
- 61 animations, each with its own sound: kill counters that count by
  themselves, headshots, ACE, multi-kills, rank ups, scoreboards, speedrun
  timers, versus screens, cinematic bars, polls, alerts, comments, subscribe
  and like buttons, and more. Click one to drop it at the playhead, or drag
  it onto a lane.
- Customize: select an animation to change its words, colours, speed and
  sound. Swap it for another and it keeps its place and timing.
- Smart Zoom (Effects, or Alt+Z) finds the loud hits and the kills and
  punches in on each one — Smooth, Snap, Bounce or Impact shake, with a
  whoosh if you want it. The zooms sit on their own Zoom lane.
- Quick look: press Q to see the frame under the playhead at full export
  quality.
- S flashes the cut on the timeline so you see it happen.
- Make vertical (on the preview): one click turns a gameplay recording into
  a 9:16 short — Game + cam, Cam on top, a cam bubble, the whole picture over
  a blurred fill, or a centre crop. Tell it which corner your facecam is in.
- Sound pads: twelve sounds on twelve keys. Press Play and record and hit the
  keys while it plays; the whole take is one undo. New sounds: crowd cheer,
  air horn, rewind and camera click.
- Captions 2.0: Highlight box and One word at a time looks, keywords
  coloured, "um" and "uh" left out, and captions kept clear of the phone
  apps' buttons. Vertical projects show those safe zones on the preview.
- Clip Inbox on the home screen: new recordings from the folders OBS, Medal
  and NVIDIA save to show up by themselves. Open one, or make a quick short.
- Thumbnail maker: pick a frame, add big words and an arrow, save a
  1280×720 PNG.
- Export has a "Small for Discord" choice that stays under 10 MB.
- Fixed: the extra tall and square versions in Export now sit on a blurred
  copy of the picture instead of black bars.
- A new home screen: pick what you are making (a short, a YouTube video, a
  montage) and start.
- Fixed: closing Strike without doing anything no longer saves an empty
  "edited video". Old empty projects can be cleared from the home screen.
- A short tour the first time you open the editor (Ctrl+K "tour" to see it
  again).

## 1.9.0

Easier to find your way around, and a lot of small things that add up.

- Lanes made for the job: the Lane button (and the + on each group) adds a
  Video, Facecam, Text, Voice, Music or SFX lane. A Voice lane cleans up
  speech by itself; a Music lane dips whenever someone talks.
- Drag a lane by its dot to move it up or down. Right-click a lane to give it
  a colour, rename it, duplicate it, or switch voice clean-up and dipping on
  and off.
- Fade by dragging: hover a clip and drag the dots on its top corners inwards
  to fade the picture and sound in or out.
- History (Ctrl+H): every change you made, in a list. Click any step to go
  back to it; later steps stay there to redo.
- Jump anywhere: click the timecode under the preview and type 1:23, or type
  a time into Ctrl+K. Up and Down arrows jump to the previous and next cut.
- Colour labels and names for clips (right-click), rename by double-clicking
  the name in the Inspector, and hover any clip to see its length, speed and
  fades.
- Shift+Delete deletes and closes the gap, whatever the Ripple switch says.
  "Select this and everything after it" is in the right-click menu.
- Save the frame under the playhead as a full-size PNG (camera button on the
  preview, or Ctrl+Shift+S) — thumbnails in one click.
- Settings (Ctrl+,): choose an accent colour, a compact layout, and whether
  buttons show hover hints. A short "What's new" tour opens once after an
  update.

## 1.8.0

A redesign. Everything below is new or rebuilt.

- A cleaner layout: a slim rail on the left opens Media, Text, Graphics, Cuts
  and Effects in a drawer you can close. The right side is one inspector with
  tabs (Picture, Motion, Timing, Sound). Messages pop up over the preview,
  where you are looking.
- Ctrl+K searches everything: actions, clips, media, effects. Type what you
  want to do and press Enter.
- Motion for every clip: pick how a clip arrives, leaves and moves while it is
  on screen, and see a preview by hovering a tile. One-click combos too.
- A new timeline: tracks are grouped (Text & Graphics, Video, Audio) and can
  be folded, lanes fit the window, and there are Select, Razor (B) and Hand (H)
  tools. Dropping a clip on another one either slides things over or puts it
  on a new layer, and the timeline shows you which before you let go. Linked
  crop layers stay in sync with their footage, so the video no longer goes out
  of step when you edit.
- Effects you drop on the timeline: punch-in zoom (Z), shake, flash and more,
  applied to everything under them.
- Speed ramps in one click (hit, smooth, rush), and Copy look / Paste look
  (Ctrl+Alt+C / Ctrl+Alt+V) between clips.
- Smart edits: find the highlights in a long recording, build a highlight
  reel, cut to the beat of a song.
- Auto-captions: GameCut listens to your clip and writes what you say on
  screen, each word lighting up as it is said. It runs on your PC; the speech
  model (about 80 MB) is downloaded once, the first time.
- Smart crop: "Find the HUD" boxes the minimap, kill feed and scoreboard for
  you; click anything on the picture to cut it out; and "Follow it as it
  moves" keeps a crop on a player or a car for the whole clip.
- Auto-vertical turns a 16:9 clip into 9:16 that follows the action, and
  Stabilize takes the shake out of handheld footage.
- Voice clean-up and auto-duck (music dips when you talk).
- Brand kit: set your font, colours and logo once and new text uses them.
- Version history: go back to any earlier state of a project (clock button,
  top bar).
- Export TikTok, square and YouTube versions in one go, saved beside your
  main file.
- Compare view: drag a divider over the preview to see before and after.
- Smooth 4K preview: 1440p and 4K clips can get a light copy for editing, so
  playback stays smooth. Your export still uses the original.

## 1.7.0

- Exports finally keep the quality you pick. At 60 fps GameCut was quietly
  falling back to a slow encoder that ignored the bitrate setting (and refused
  high ones with a "bitrate limit" error). It now uses your graphics card at
  60 and 120 fps, up to 4K, and the file comes out at the bitrate you chose.
- Long, high-bitrate exports no longer run out of memory at the end. You pick
  where to save first, and the video is written to disk as it renders. If you
  cancel, or something goes wrong, no half-finished file is left behind.
- Big Medal and OBS recordings export with their sound. Files of several GB
  used to come out silent; their audio is now read in small pieces instead of
  loading the whole recording. This also works when you reopen a project.
- Transitions between clips no longer make an export crawl, and a clip whose
  file has moved is skipped (and named) instead of freezing the render.
- Glow and other effects on a large graphic now survive a 4K export.
- Graphics work again: an added image or sticker used to be invisible and
  could not be moved. It now lands on top of your footage and can be dragged,
  animated and styled. Graphics with the Shadow look no longer vanish.
- Custom fonts come back when you reopen a project.
- What you hear in the preview matches the export, including volume under
  fades.
- One drag is one undo step, and every undo shows a message with a Redo
  button. Locked tracks stay locked, and Ripple delete really closes the gap.
- Lots of timeline fixes: clips drop where your mouse is, splitting and
  trimming behave, and keyboard shortcuts no longer fire on the Home screen or
  while a dialog is open.
- Freeze frame: press Shift+F (or right-click a clip, or use the button in
  the crop screen) and the video pauses on that exact frame for a couple of
  seconds, then plays on. The pause keeps the clip's crop and look, its sound
  stops with it, and you can drag the end of the still to make it longer.
- Fixed sound that stuttered on imported videos, in the preview and in exports.
- After exporting a vertical video, an "Upload to TikTok" button opens the
  upload page with your file ready to drag in.
- Your footage keeps its resolution. The first recording you add now sets the
  project to match it (1440p, 4K, or a vertical phone clip), so nothing is
  shrunk to 1080p before it reaches the export. Undo puts the old size back.
- The preview is as sharp as the space it is shown in. A new Auto quality (the
  default) matches your screen, including laptops with display scaling, and
  still drops a step by itself if playback gets heavy.
- The Box crop tool works: the button switches, the box can be moved and
  resized from any edge, and double-click applies it.
- Text has real animations: typewriter, per-letter and per-word entrances,
  exits, glitch, shake and more, with a live preview, plus saved looks and
  saved texts you can reuse.

## 1.6.0

- Video clips can be mixed. The Audio tab used to work only on music and SFX
  clips, so the sound on your gameplay footage could not be turned down at all.
  Now every clip that makes a noise gets a proper fader, a mute button and its
  own fades — and you can hear the fader move while the timeline is playing.
- Double-click any fader to put it back to 100%, or hold Shift while dragging
  for fine control.
- The crop tool is a proper room now. Press C and the frame fills the screen,
  where you can zoom right into the pixels, drag a box, or paint the exact
  shape you want with a brush — Keep paints what stays, Remove paints what
  goes. Soften the edge, undo a stroke, then Apply. Nothing changes until you
  do.
- Transitions show themselves. Pick a cut and the panel plays the transition on
  your own two shots, on a loop — hover any tile to see that one instead, before
  you commit to it.
- You can type straight onto the picture. Double-click a title in the preview,
  or select it and press Enter, and a cursor appears in the words themselves.
  Escape puts back what was there; one undo takes out the whole edit rather
  than one letter at a time.
- Sped-up clips can wear a badge. Set a clip to 4× and the Inspector offers to
  put a "4×" on the picture — it is an ordinary text layer, so drag it
  anywhere, restyle it, or fade it. Change the speed again and the badge
  rewrites itself.
- The timeline keeps up with the playhead now. During playback it slides along
  so you never lose where you are, and it gets out of the way the moment you
  take hold of it yourself.
- Zooming the timeline glides instead of jumping, panels ease in, groups open
  and close smoothly, and every button gives under the press. If your machine
  is set to reduce motion, all of it turns off.
- Graphics. There is a Graphics tab now, next to Media and Transitions. Drop
  in a PNG of your logo, an emote, a cut-out or a screenshot and it lands on the
  picture already looking like something — pick how it arrives first: Shadow,
  Glow, Sticker, Card, 3D tilt or Neon.
- Every one of those looks is adjustable afterwards, and so is everything
  underneath it: rounded corners, a coloured glow that follows the shape of a
  cut-out rather than sitting in a box around it, a drop shadow, a sticker edge,
  a colour wash, and a real 3D turn with thickness behind it.
- Movement. Eleven ready-made moves — Pop in, slide in from any side, Float,
  Pulse, Spin, Sway, Slow push, and more. Every one of them writes ordinary
  keyframes, and the keyframe strip underneath shows you those exact keyframes:
  drag a diamond to retime it, double-click to remove it, click the empty track
  to add one, right-click for how it eases. Nothing is hidden behind a preset,
  so the first time one is nearly right you can just fix it.
- A new logo: a controller with a timeline cut straight through the middle of
  it — clips, a gap and a playhead running in one side and out the other. The
  same drawing is the app icon, the mark in the top bar, the website and the
  installer, and it is drawn separately at every size, so the sticks and the
  d-pad drop away as it gets smaller instead of turning to mush.
- The installer has proper pages now. It opens by telling you what GameCut is
  and who made it, and when it finishes it offers to open it and to pin it to
  your taskbar. It is listed as being from Frazer's Softwares.
- Export quality is yours to set. There is a Custom tile next to the three
  presets now: type the exact bitrate you want — 82 Mbps if that is what your
  recorder is set to — or drag the slider, and pick the frame rate and the
  output size while you are there. It tells you what your footage was recorded
  at and offers to match it in one click.
- Fixed, and this is the one that mattered: exports could come out softer than
  the footage that went in. GameCut was choosing the H.264 "level" from the
  picture size alone, but a level caps bitrate too — 1080p was being handed one
  that tops out at 25 Mbps, so anything above that was quietly thrown away. If
  you record in Medal or OBS at 50, 70 or 100 Mbps, every export was being
  squeezed through a 25 Mbps pipe. It now picks a level that can carry what you
  asked for, and "Best quality" will no longer go below the footage it was
  given.
- Fixes, mostly to things added in this release before anyone saw them:
  dragging a keyframe now follows your pointer all the way instead of stopping
  after a few pixels; the transitions panel no longer freezes playback while it
  fetches its preview, and stops animating when you are not looking at it; the
  timeline no longer fights you for the scrollbar while it is playing; Zoom Fit
  slides instead of half-sliding and half-jumping; effect and length sliders can
  be undone; adding a graphic is one undo rather than four; movement presets
  work on very short clips instead of never finishing; the crop room keeps your
  zoom when the window resizes, brings back your box if you press Undo after
  Clear, and refuses to open on a frame that has not decoded yet.

## 1.5.0

- GameCut can now update itself. When you publish a new version it arrives
  quietly in the background and a card asks whether to install it — nothing
  changes until you say yes.
- The version number in the top bar opens an Updates panel: what you are
  running, what is waiting, and the full log of everything that has changed.
- Every update is signed. An install refuses anything that is not signed by the
  key it was built with, so nothing can push code to your machine but you.

## 1.4.0

- Transitions work the way they do in CapCut. A small button appears on every
  cut where two clips meet — click it and pick Dissolve, Dip to black or a
  Slide from the new Transitions panel.
- A transition now sits across its cut rather than starting at it, so the shot
  changes exactly where you cut it.
- Right-click a video clip to take its audio out onto its own track, lined up
  exactly, so you can fade it or cut it on its own.
- Fixed: the fullscreen button had never worked in any build.

## 1.3.0

- Dissolve, Dip to black and Slide transitions.
- The Crop tool can trace any shape freehand, not just a rectangle.
- Hover any control for a sentence saying what it does, and press ? for a
  searchable sheet covering every tool and shortcut.
- Right-click the timeline for everything you can do to a clip, a cut, the
  ruler or empty space.
- A save-state chip in the top bar, and Ctrl+S.
- Markers can be removed — right-click the ruler.
- Fixed: a clip added while three others were decoding never showed a picture.
- Fixed: an exported transition could be missing its outgoing shot.

## 1.2.0

- The app opens on your projects instead of an empty timeline, and saves your
  work every half minute and when you close the window.
- Fixed: an old installed update could shadow the editor forever, which is what
  was hiding the projects screen.
