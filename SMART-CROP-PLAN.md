# Smart Crop: crop ANYTHING on the screen (version 2)

Written 2026-11-16, replacing the first version the same day. **Plan only for the new parts; nothing below "Done already" is built.**
Tags: **[read]** read in the code, **[measured]**, **[assumed]** judgement to verify.

## 0. What you told me, and what it changes

> "The thing I want to crop is literally anything on the screen: UI parts, the map, anything. It doesn't need to be a part of the screen and
> named. That's the problem I had with it."

So Smart Crop is **not a HUD tool**. It has no idea what a thing is and must never pretend to. Rules from now on:

1. **Anything.** A map, a counter, a player, a sign, a menu, an emote, part of the interface, part of the game world.
2. **Never named by the tool.** No "Minimap", "Kill feed", "Scoreboard". Pieces are numbered; you name them only if you want to.
3. **Never limited to "stays still".** Things that move, rotate or change are as croppable as things that don't.
4. **You pick, Strike helps.** Every automatic suggestion is optional, shown before it is applied, and undoable.

### Done already (2026-11-16, not yet run or tested) **[read: the edits]**
* The guesser `nameFor` is **deleted**. Suggestions are now **"Piece 1, Piece 2…"** and a multi-piece cut is **"Crop pieces"**.
* "Find the HUD" is now **"Find what stays still"**; all HUD / minimap / kill-feed wording was removed from the tool, its hints and its tests.
  `findHud` was renamed `findStill`; the test now fails if any piece is given a guessed name.
* Originals are in `Strike-All/_removed-for-3.0/before/` (`smart-crop.js`, `crop-studio.js`, `qa/smart-crop.mjs`, `qa/timeline-next.mjs`).

## 1. What it does today **[read]**
Crop window (`src/ui/preview/crop-studio.js`), finders (`src/ui/preview/smart-crop.js`), follower (`src/edit/tracker.js`, `follow.js`):
* **Box**, **Brush** (paint the exact shape, Keep/Remove), **Smart** (click a thing, or find what stays still).
* **Click to cut out** (`magicSelect`): flood-fill of similar colour around the click, stopping at strong edges; the result is a soft-edged mask PNG.
* **Follow it as it moves** (`trackCrop`): template matching on greyscale, forward and backward, stored as `crop.path`.
* The crop is stored as fractions of the frame; a cropped layer shares the original's decoder.

## 2. Why it falls short of "anything"

| # | Problem | Evidence |
|---|---|---|
| 1 | **Click-select only works on flat colour regions.** A circular map with a textured picture, a player, a gradient bar, anything photographic fails or leaks | `magicSelect` stops on colour distance `tol*3` and edge `> 60` |
| 2 | **No control**: no tolerance, no add/subtract, no live preview, no feather | `magicSelect(img, u, v, tol = 22)` is always called with the default |
| 3 | **Suggestions assume things stay still** | `findStill` keeps pixels with temporal deviation `< 7` **[read]** |
| 4 | **Sampling is slow and imprecise** (hidden `<video>` seeks, 1.5 s timeout each) | `sampleFrames` |
| 5 | **Follow samples as coarsely as every 0.5 s**, so a fast thing is lost | `step` in `trackCrop` |
| 6 | **Follow never says when it is guessing**, and can't be corrected from one bad frame | `follow()` returns no confidence |
| 7 | **Follow handles only sideways/up-down movement**, not growing, shrinking or turning things | translation search only |
| 8 | **Greyscale only**, so things of the same brightness but different colour are confused | `patch/cost` use grey |
| 9 | **The cut-out is a PNG**: can't be feathered, grown, shrunk, inverted or animated as a shape | `maskPng` |
| 10 | **A crop can't drive anything else** (a title, a blur, a sticker can't stick to it) | follow writes only `crop.path` |
| 11 | **Runs on the main thread** with toast progress | `followCrop` |

## 3. The improved tool, in plain words
> Press **C**. Pick the thing by **drawing a box or shape**, **painting it**, or just **clicking it**. Click once and Strike outlines it; click again on a
> missed bit to add it, or **Alt-click** to take a bit away. You see the outline live *before* you accept. Press **Follow** if it moves: a bar under the
> timeline shows where Strike is sure and where it is guessing; fix one frame by dragging the box and press **Continue from here**.

### 3.1 Ways to pick (all unnamed, all optional)
1. **Box / ellipse / shape** (exists): exact and instant. A round map is simply an ellipse; a fixed corner of the screen is a box with Follow off.
2. **Brush** (exists): paint what you want.
3. **Click-select 2.0**: live hover preview, a **tolerance** slider under "More", **Shift = add, Alt = subtract**, **feather / grow / shrink**, "select similar in the
   whole frame". Better than today on flat regions; still colour-based.
4. **Click to outline anything** *(new, the real answer to "anything")*: click an object and Strike draws its exact outline with a **small object-segmentation
   model that runs on your computer**, so photographic things (a player, a textured map, an item) work, not just flat colour. Add/subtract clicks refine it.
   * Loads like the speech model does today: **downloaded once by the main process from a fixed list, checked by checksum, then offline** **[read: how captions get their model]**.
   * Strike already ships the ONNX runtime it needs for captions (`vendor/transformers/ort-wasm-simd-threaded.*`) **[read]**.
   * Reference designs: EffectCraft `crates/segment` (swappable open-licensed models with author, licence, URL, size and SHA-256; MobileSAM) and `crates/sam2`
     **[read: architecture.md]**. Speed on your Iris Xe and outline quality on game footage are **[assumed — to verify in a spike before promising anything]**.
   * **Chosen model (2026-11-16, you approved an optional download):** SlimSAM-77, quantized (`Xenova/slimsam-77-uniform`), **13.8 MB in two files**, Apache-2.0
     **[read: Hugging Face model page and API]**. Much smaller than the 40–100 MB first guessed. Upgrade tiers if quality is not enough: SlimSAM-50 (~35 MB), SAM ViT-B (~106 MB).
   * **Done in code (unrun):** `electron-main.cjs` has an `'outline-small'` entry in `MODELS`, pinned to an exact commit, with expected file sizes and SHA-256 for both
     big files. Downloads are verified: a wrong or damaged file is deleted and the user sees "The download was damaged, so it was thrown away. Please try again."
     Same `models:status / download / progress` calls as the speech model. Original saved in `_removed-for-3.0/before/electron-main.cjs`.
   * **Built and tested overnight 2026-11-16** **[measured]** (commit "Smart crop: Click to outline anything"):
     `src/ui/preview/outline-worker.js` (the model, off the main thread), `src/ui/preview/outline.js` (page side), crop window Smart tool:
     a "Get Click to outline (14 MB, once)" button; then **click = outline**, **`]` / `[` = bigger / smaller outline** (the model offers part / whole),
     **Ctrl+click = add a missed bit**, **Alt+click = take a bit away**, −/+ buttons on each piece. Without the model, click still selects by colour.
   * **Spike results on your laptop** (`qa/outline.mjs`, synthetic pictures with a known answer, other tests running at the same time):

     | Picture | First outline (IoU) | Best with `[`/`]` | Each click |
     |---|---|---|---|
     | textured round map | 0.97 | 0.97 | ~0.3 s |
     | figure on a busy background (click on the body) | 0.54 (just the body) | **0.96** | ~0.25 s |
     | interface bar with text | 0.92 | 0.92 | ~0.27 s |

     "Looking at the picture" (once per crop-window opening) took **5–7 s** while other tests were running, so a quiet-machine measurement is still needed.
     The **GPU was no faster** (similar look time, clicks ~2× slower: no fast 8-bit maths on WebGPU), so it runs on the CPU. Download 13.8 MB in 4–14 s;
     a damaged file is caught and re-downloaded (tested).
   * **Next for it:** measure "looking" on a quiet machine; if it stays above ~2 s, try the fp16 model on the GPU (bigger download) or look at the
     picture in the background as soon as the crop window opens; test on ~30 real game screenshots you choose.
5. **Find what stays still** (done, optional): numbered suggestions of things that don't move. Kept only as a convenience; it can be removed if you never use it.

### 3.2 Follow (the tracker) 2.0
Port the proven algorithms from EffectCraft `crates/track` (`klt.rs` pyramid Lucas–Kanade with sub-pixel refinement, `fit.rs`/`solve.rs` similarity and affine solves):
per-frame tracking at the clip's frame rate, **colour** matching, **scale + rotation**, a **confidence bar**, **auto-hold** (stop and warn instead of drifting),
**Continue from here** after you fix a frame, **track backwards**, a smoothing slider, results cached per clip. Runs in a worker on exact frames from the
WebCodecs frame service, never on the page's main thread.

### 3.3 Output and "Stick to it"
* The cut-out becomes a **vector mask** from the masks tool (T3): feather, grow/shrink, invert, animated by the track.
* **Stick to it**: after tracking, add a title, a mosaic/blur, a sticker or any effect that moves with it (parent the layer to the track).
* **Saved pieces** *(replaces "layout memory per game")*: any selection can be saved and re-applied to another clip at the same screen position, with a name **you** give it.

### 3.4 Keep it easy
* Same entry points as today (**C**, the Crop button, the Inspector "Smart crop" group); same words where they still make sense.
* New controls sit under **More**. No new panel. The confidence bar shows only while the layer is selected.
* The first click always does something sensible; nothing needs a setting first.

## 4. Slices and where they land
| Slice | What | Needs | Release |
|---|---|---|---|
| **SC-0** Done | no guessed names, "anything" wording | — | now |
| **SC-1** | exact fast frames in a worker; per-frame, colour-aware tracking with confidence, auto-hold, Continue from here, cache | WebCodecs frame service | A/B |
| **SC-2** | ~~segmentation spike~~ and **"Click to outline anything" — done 2026-11-16**; still to do: Click-select 2.0 (preview, tolerance, feather) | frame service | B/D |
| **SC-3** | vector masks, scale/rotation tracking, Stick to it, saved pieces | Engine 3 layer model, masks (T3), tracker port (T8) | D/E |

## 5. How we'll test it
* **Synthetic clips with known truth**: moving, growing, rotating, partly hidden and colour-changing targets, so tracker error in pixels is measured, not eyeballed.
  `qa/smart-crop.mjs` and `qa/crop-box.mjs` **[read: exist]** are the base.
* **Targets** **[assumed]**: mean tracking error < 2 px at 1080p; confidence falls below 0.4 within 3 frames of the target leaving or being covered; one-click outline
  overlaps the true object ≥ 90% (IoU) on a set of 30 game screenshots chosen by you; a 60-second 1080p60 clip tracks in < 60 s on the laptop.
* **Your clips**: 5 clips, rated good / needs a fix / wrong.

## 6. Questions for you
1. ~~**Optional model download** for "Click to outline anything"~~ **Answered: yes, optional is fine.** Real size is about 14 MB, once, then offline.
2. Should **"Find what stays still"** stay as an optional suggestion, or be removed so the tool is purely "you pick"? *(Recommended: keep, optional.)*
3. Is **"Stick this to it"** (tracked text, blur, sticker) worth building early, or tracker quality first? *(Recommended: tracker quality first.)*
