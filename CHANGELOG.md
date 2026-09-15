# Changelog

What goes in here is what your friends read inside the app. `npm run release`
pulls the bullet points from the section matching the version in `package.json`
and puts them in the manifest, so there is one copy of the text and it is this
one.

Write them for the person using GameCut, not for yourself: "you can drag the
ends of a clip to trim it" rather than "added trim handles to clip-renderer".

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
