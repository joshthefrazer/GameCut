# Changelog

What goes in here is what your friends read inside the app. `npm run release`
pulls the bullet points from the section matching the version in `package.json`
and puts them in the manifest, so there is one copy of the text and it is this
one.

Write them for the person using GameCut, not for yourself: "you can drag the
ends of a clip to trim it" rather than "added trim handles to clip-renderer".

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
