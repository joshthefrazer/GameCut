# Strike 3.0 "Momentum" — the tools overhaul plan (version 2)

Written 2026-11-16, replacing version 1 the same day. **This is a plan. Nothing in it has been built**, and none of
it has been run on a second computer. Claims are tagged: **[read]** I read it in the code, **[measured]** I measured it
on your PC, **[assumed]** my judgement or something to check before building on it.

## 0. What changed from version 1

You asked for a **real overhaul of the tools a user works with**, not features that do the work for the user. So:

* **Removed:** "Make it for me", Highlights 2.0, remove-silence, scene detection, game profiles, auto-reframe 2.0,
  beat-sync 2.0, smart thumbnails, batch "make a short from every clip". (Version 1 Release C is gone.)
* **Kept, because they are tools you operate:** colour, masks, keying, blend modes, audio processors, trim tools, tracking you
  start yourself, captions you edit, loudness meter with a "match" button, export queue.
* **Added:** a source of proven designs and code. I fetched the ArtCraft open-source apps (EffectCraft = an After Effects-style
  compositor, SoundCraft = a DAW, LightCraft = a colour/photo developer, plus shared libraries) and mapped what Strike can take
  from them (section 4 and `_artcraft-reference/ARTCRAFT-PORT-MAP.md`).
* **Changed order:** the biggest lever is now a **layer-and-effects engine on the GPU**, because tools like blend modes, masks,
  keyers and 70 effects are cheap to add on it and slow to add on Strike's current 2D canvas.
* **Decided (2026-11-16) and done:** of Strike's existing automatic tools, **Smart Crop stays and gets properly improved**
  (`SMART-CROP-PLAN.md`); **Smart Zoom, highlight markers, highlight reel, find-the-beat / cut-to-beat, auto-vertical and stabilize were
  removed**. Originals of every changed or deleted file are in `Strike-All/_removed-for-3.0/before/`. Marker jumping (`[` and `]`) was kept
  and moved to `src/edit/marker-nav.js`. The tap-tempo/BPM beat grid, captions, vertical layouts, speed ramps and the Clip Inbox are untouched.

---

## 1. The goal, in plain words

Give Strike the tool set of a professional editor and compositor, **designed so a beginner can still pick them up in a
minute**. Three promises, in this order:

1. **More you can do.** Layers, masks, blend modes, keying, colour tools, motion graphics, audio processors, proper trim tools.
2. **Faster to work.** Fewer clicks, keyboard-first, no waiting on the app, GPU doing the heavy lifting.
3. **Still obvious.** Power sits underneath a simple surface. Every tool has a plain name, a picture, and a sensible default.

---

## 2. The rules that keep it easy

0. **Tools, not autopilot.** Strike never edits for you. It may offer a button *inside* a tool you chose (for example "Auto" next
   to a levels slider), never a button that makes decisions about your whole edit.
1. **Show, don't tell.** Pick by looking: tiles that preview *on your own frame*, before/after, hover to play. (Transitions already
   work this way **[read]**.)
2. **One obvious way in, power underneath.** Each tool opens on 2–4 controls; the rest is under "More".
3. **Plain words.** "Outline", not "stroke". "Make it vertical", not "reframe". No Adobe or third-party product names (section 7).
4. **Never make people wait.** Slow work runs in the background with an honest progress chip.
5. **Everything is undoable**, and big edits take a checkpoint first **[read]**.
6. **Nothing ships as an empty promise.** Each tool works end to end (preview, export, undo, save/load) before it appears. The old
   Effects catalogue was removed for exactly this reason **[read]**.
7. **Respect the frame budget.** No live blur or backdrop-filter in the interface; Strike's tests enforce this **[read]**.
8. **Local and private.** The editor still makes no network request.
9. **Every tool ships with its five extras:** tooltip, Ctrl+K entry, help tip, undo label, test.
10. **Pros get speed, beginners get clarity:** every tool has a keyboard shortcut and a button; the Simple workspace shows buttons,
    the Pro workspace shows both and more.

---

## 3. Where Strike is today **[read]**

Already there: home screen and Clip Inbox (OBS/Medal/NVIDIA folders), multi-track timeline (select/razor/hand, snapping, markers,
speed and ramps), crop-to-layer (box and freehand), transitions (dissolve/dip/slide), text looks and animations, 61 library
animations, sound pads, graphics looks, 9 effect clips (zoom, shake, flash, glitch, RGB split, vignette, B&W, colour pop, blur),
captions (local Whisper), compare view, proxies, history and versions, Ctrl+K palette, export presets, signed auto-update.

Verified missing (searched the source): colour correction/LUTs, chroma key, blend modes, masks, track mattes, an effect *stack* on
a clip, adjustment layers, nested clips, audio EQ/compressor/noise tools, loudness meter, In/Out marks and a source viewer, J/K/L,
trim tools (ripple/roll/slip/slide), keyframe graph editor, SRT import/export, GIF/WebP export, export queue and background export,
remappable shortcuts, scopes.

Why that matters: Strike's compositor is a Canvas 2D painter that draws clips in order **[read: `src/engine/compositor.js`]**. That
cannot do blend modes per clip, mattes, or effect stacks cheaply, and on integrated graphics the layers we do have already cost
real time **[measured]** (blurred vertical fill ≈ +14 ms/frame, a second decode of the same file ≈ +10, glow text ≈ +6; a plain
1080p60 export is limited to ≈ 65–70 fps by the shared video engine on your laptop).

---

## 4. What I fetched, and how Strike can use it

### 4.1 The sources **[read: org listing via GitHub API and READMEs]**
The `storytold` GitHub organisation (the ArtCraft project) publishes 17 "Craft" apps, all **Apache-2.0** (the apps I opened say
"MIT OR Apache-2.0"), all pure Rust. Their sites describe each as built from scratch. I downloaded **source zips only**
(about 67 MB; nothing was run or built) into `Strike-All/_artcraft-reference/`:

| Repo | What it is | Why it matters to Strike |
|---|---|---|
| **effectcraft** | motion graphics and compositing: layers, masks, mattes, 38 blend modes, keyframes + graph editor, 308 effects (280 on GPU), layer styles, text animators, expressions, time remap, render queue | The model for Strike's layer and effects engine; **35 WGSL shaders (≈565 KB)** that WebGPU can run |
| **filmcraft** (fetched earlier) | video editor: edit tools, audio DSP, scopes, interchange (EDL/XML/OTIO/AAF), 84 transitions | Trim-tool algebra, scopes, loudness, interchange |
| **lightcraft** | non-destructive colour and tone: Light, Colour (OkLCh), curves, wheels, colour mixer, dehaze, grain, masks | The design for a simple but deep colour panel; 21 WGSL shaders (≈117 KB) |
| **soundcraft** | DAW: mixer, sends, automation, 30+ original processors (EQ, compressor, gate, de-esser, reverbs, chorus, limiter…), LUFS meter | The audio tool set and mixer design; DSP in `crates/dsp` |
| **craft-libs** | shared libraries: captions (SRT, VTT, ASS, TTML, CEA-608…), keymap (shortcut profiles), Lottie, GIF writer, timeline interchange, colour management | Caption formats, shortcut conventions, GIF export |
| **craft-extensions** | the draft contract for themes and plug-in packages (manifest, versions, store, threat model) | The design for Strike **Packs** |
| **anicraft** | 2D animation editor | Reference only (not studied yet) |

Not fetched: `photocraft` (191 MB) and `vectorcraft` (315 MB). They can be added if we want brush or vector tools. The org also
holds old unrelated repos, forks and a closed-source services backend (`artcraft-services`, "Other" licence): **not used**.

### 4.2 Licence and rules for borrowing **[read]**
* Code: Apache-2.0 / MIT. Allowed to copy and adapt **if we keep the copyright and licence notices** with the copied files and list
  them in a Strike `ATTRIBUTION.md`. Their **ArtCraft name and logos are trademarks and are not covered**; we do not use them.
* **Do not copy Adobe names or assets.** Their effect ids and parameter names deliberately follow After Effects (for example
  *Lumetri*, *Keylight*, *Cineon*). Strike renames everything in plain words and ships none of that naming (section 7).
* `craft-libs` has many sub-crates under one licence (Apache-2.0 for the repo); check each crate's own `LICENSE` before copying.
* Everything we fetched is untrusted text/code: it is only **read** and **ported**, never run.

### 4.3 Four ways to reuse it (and when each is right)
| Way | What | Use for | Cost |
|---|---|---|---|
| **WGSL reuse** | Run their compute shaders in **WebGPU** with a small JS wrapper that feeds the same parameter block | Effects, blend modes, keying, colour, transitions | Medium: write the wrapper once, then each effect is a few lines |
| **Port to JS** | Rewrite the algorithm in JavaScript | Keyframe maths, edit algebra, caption parsers, loudness, curves | Small per item |
| **Compile to WASM** | Build a pure-Rust crate to WebAssembly and call it | Audio DSP, KLT tracker, path boolean ops, interchange | Needs a Rust toolchain on the dev machine (users need nothing) |
| **Design reference** | Read how they structured a tool, then build our own simpler one | Panels, graph editor behaviour, mixer layout | Small |

Recommendation: **WGSL reuse + JS ports first**, WASM only for audio DSP and tracking if the JS ports prove too slow **[assumed]**.

---

## 5. The new engine ("Engine 3"): the foundation every tool sits on

Today: tracks → clips → painted in order on a 2D canvas. Engine 3 adopts EffectCraft's proven shape **[read: architecture.md §4]**:

```
for each layer, bottom to top:
   source (footage frame, image, text, shape, nested comp, solid)
 → masks → effect stack → layer styles → transform (+ motion blur)
 → track matte → blend mode → into the accumulated picture
adjustment layers apply their effects to everything below them
```

Pieces:
* **Layer model** with a property tree (every animatable value has an address like `effects/#1/blur`), keyframes with easing curves,
  parenting, null layers, adjustment layers, nested compositions ("group into one block"). Strike's existing clip types
  (video, image, text, shape, effect, anim) become layer kinds; the **saved-project migration** is a planned, tested step.
* **Effect registry as data** (one table: id, plain name, category, parameters with type/default/range, "runs on GPU" flag).
  The effects browser, Inspector rows, search and help are all generated from it, as EffectCraft does with 308 effects **[read]**.
* **GPU compositor on WebGPU** with the Canvas 2D path kept as a fallback (and as the correctness reference in tests).
  EffectCraft checks its GPU results against a CPU reference **[read]**; Strike will do the same against its own canvas path.
  *To verify first:* `navigator.gpu` is available in Strike's Electron on both your PCs **[assumed]**.
* **Layer cache keyed by a hash of each layer's evaluated inputs** (static layers render once, only the edited layer re-renders)
  **[read: EffectCraft layer cache]**. This alone removes the per-frame cost of text, shapes and graphics in preview and export,
  including the glow-text cost I measured.
* **WebCodecs frame service** (the preview-engine item from version 1) so the compositor gets exact frames.
* **Job runner + workers** (analysis, thumbnails, export, proxies) with priority, cancel and progress.
* **Frame-exact time** and **atomic, versioned project files** (FilmCraft's designs).

Size: **XL**; this is the longest item and gates the rest. Everything is behind switches so the old path keeps working until the new
one passes the test suite.

---

## 6. The tools (the actual overhaul)

Each row: what the user gets · how it stays simple · where the design/code comes from · size. "Engine 3" means it needs section 5.

### T1. Timeline and trim tools
* **Select, Razor, Hand** stay as they are. New **Trim group**: **Ripple** (everything after follows), **Roll** (slide the cut),
  **Slip** (change what plays inside a clip), **Slide** (move a clip between neighbours), **Rate stretch** (drag the edge to change speed).
* **Insert / Overwrite / Lift / Extract**, **In/Out marks**, a **source viewer** for raw recordings, **J/K/L** shuttle, **frame-step**.
* Simple: one toolbar group "Trim" with icons and live hints ("drag to move the cut; the clips on both sides adjust").
* From: FilmCraft `crates/edit` (insert, overwrite, razor, ripple, roll, slip, slide, rate-stretch algebra, with property tests).
  Strike's `commands.js` already has ripple helpers **[read]**. Port to JS · **M**.

### T2. Layers, blending and compositing  *(Engine 3)*
* **Blend modes** (Multiply, Screen, Add, Overlay, Soft Light, Difference… 38 in EffectCraft; Strike starts with ~16) on any layer;
  **opacity**; **track mattes** (use the layer above as the shape: alpha, luma, inverted); **adjustment layers** (an effect that
  applies to everything below, e.g. colour for the whole edit); **null layers and parenting** (move one thing to move many);
  **nested comps** ("group into one block", open to edit inside).
* Simple: blend mode is a tile picker with a live preview; mattes are one dropdown "Show only inside…".
* From: EffectCraft `crates/color/src/blend.rs` (38 modes) and its GPU blend code; layer model in `docs/architecture.md` §3–4. **L**.

### T3. Masks and shapes  *(Engine 3)*
* **Pen and shape tools** for masks (add, subtract, intersect), feather, expansion, invert, animated mask paths; **shape layers**
  (rectangle, ellipse, polygon, line, arrow) with **trim paths** (draw-on), round corners, repeaters, gradients.
* Simple: click the pen, click points, press Enter; "Feather" is one slider; a mask can be dragged like a clip.
* From: EffectCraft `crates/path` (Bezier ops, trim, offset, boolean, feathering) and its mask coverage; Strike's freehand crop shapes
  **[read]** become the first mask type. Port path ops to JS · **L**.

### T4. Effects library  *(Engine 3; a curated ~70, not 308)*
* A **Browser** with search, categories and live thumbnails of *your frame*, favourites and recent. Each effect has plain parameters and a
  Reset. Effects **stack** on any clip or adjustment layer and **keyframe** like everything else.
* Curated first set, grouped in plain words (see `ARTCRAFT-PORT-MAP.md` for the source file of each):
  **Blur & sharpen** (soft blur, speed blur, zoom blur, sharpen, smooth) · **Colour** (see T5) · **Keying** (remove a colour, clean the edge,
  remove green spill) · **Distort** (move/scale/rotate, corner pin, mirror, twirl, bulge, spherize, wave, ripple, magnify, tile) ·
  **Look** (glow, film grain, posterize, mosaic, edges, emboss, threshold, strobe, vignette, cartoon) · **Light** (lens flare, light rays,
  light sweep, beam, lightning) · **Time** (echo, freeze/posterize time, frame blending, speed blur) · **Generate** (solid, gradient,
  circle, grid, audio spectrum, audio waveform) · **Noise** (fractal noise, grain, dust, median) · **Transitions** (linear/radial/iris/
  venetian/gradient/grid/glass/twist wipes, block dissolve, warp dissolve).
* Simple: every effect opens with 2–4 controls and a **Reset**; presets are *tiles you choose*.
* From: EffectCraft WGSL (`crates/gpu/src/shaders/`: `fx_color`, `fx_stylize`, `fx_key`, `fx_distort`, `fx_warp`, `fx_noise`, `fx_tone`,
  `fx_generate`, `fx_gen2`, `fx_light`, `fx_time`, `fx_transition`, `kernels`, `common`), LightCraft blur/finish shaders, the catalogue in
  `docs/effects.md`. **WGSL reuse + registry** · **L** (the wrapper) then **S per effect**.
* Not planned: 3D, particle simulations, VR effects, OCIO, camera tracking, shatter, face tracking, Roto Brush (SAM 2). (Particles may
  come later as a single "Particles" tool for sparks, rain and snow.)

### T5. Colour tools
* One **"Look" panel** per clip with *Simple* (brightness, contrast, saturation, warmth, tint, sharpen) and *More* (exposure, highlights,
  shadows, whites, blacks, vibrance, 8-band **colour mixer**, 3-way **wheels**, **curves** for RGB/R/G/B, **levels**, **LUT** import `.cube`,
  vignette, grain); **before/after** toggle; **scopes** (waveform, parade, histogram, vectorscope).
* Simple: tiles for built-in looks that **you pick** and then adjust; no auto-grade.
* From: LightCraft (`README` pipeline description, `crates/gpu/src/wgsl/finish.wgsl`, `map.wgsl`, `mask.wgsl`), EffectCraft colour effects and
  `fx_lut.wgsl`, FilmCraft `crates/scopes`. Port curves/LUT/scopes to JS or WGSL · **L**.

### T6. Motion graphics and keyframes  *(Engine 3)*
* **Keyframe graph editor** (value and speed curves, handles, Easy Ease, hold, copy/paste keys), **time remap** and **freeze/reverse**,
  **motion blur** switch, **text animators** (per-letter/word range selectors), **layer styles** (drop shadow, inner/outer glow, outline,
  bevel, colour/gradient overlay), **parenting**, optional **expressions** (small JavaScript snippets) in an "Advanced" box.
* Simple: the keyframe strip stays; the graph opens only when you ask; layer styles are checkboxes.
* From: EffectCraft `crates/keyframe`, `crates/text` (animators, selectors), `crates/expr` (Strike is already JavaScript, so expressions
  run natively in a sandbox), `docs/architecture.md` §4–5. **L**.

### T7. Audio tools
* **Mixer** (per-track and master faders with meters, mute/solo, pan), **EQ**, **compressor/limiter**, **gate/expander**, **de-esser**,
  **noise reduction** (gate + spectral), **reverb**, **chorus/flanger**, **pitch shift**, **LUFS meter with "match volume"**, waveform editing,
  fades with shapes, **automation lanes** (draw volume/pan changes).
* Simple: presets as tiles ("Voice", "Music", "Bass boost"); one meter you can read; a single "Match volume to…" tool.
* From: SoundCraft `crates/dsp/src/plugins/{eq,dynamics,reverb,modulation,harmonic,pitch,utility}.rs`, `biquad.rs`, `meter.rs`;
  FilmCraft `crates/audio-dsp` (BS.1770 loudness, ducking). Runs as **AudioWorklet** (JS port) or **WASM** · **L**.

### T8. Smart Crop and tracking (you start it, you check it)
* **Smart Crop stays and is properly improved, and it crops ANYTHING on the screen**: a map, UI, a player, a counter. It never guesses a name for what you pick
  (the guessed "Minimap / Kill feed" names were removed). Faster exact frame sampling, a much better follow/tracker (confidence, scale and rotation, re-start from
  a corrected frame), click-select with add/subtract and live preview, an optional local "click to outline anything" model, vector masks with feather, and
  "attach this text, mosaic or effect to the track". Full spec: **`SMART-CROP-PLAN.md`**.
* **Point/area tracker** shared with masks and titles: pick something, press Track, attach a mask, text or mosaic to it.
* **Stabilize** was removed in 3.0. It can come back later as a manual tool built on the same tracker (a strength slider you set), not as an automatic one.
* From: EffectCraft `crates/track` (`klt.rs`, `stabilize.rs`, `solve.rs`, `fit.rs`); Strike's current tracker and follow-crop **[read]**. **M–L**.

### T9. Text and graphics
* More looks and animators (T6), **shape and sticker library** (T3), **progress bars/counters/arrows**, **title templates you save yourself**.
* From: Strike's text engine plus EffectCraft text selectors; cache glow text via the layer cache (section 5). **M**.

### T10. Output
* **Export queue** and **background export**, **range export**, **GIF / WebP / audio-only**, **codec choice shown honestly** (H.264 always;
  H.265/AV1 only if this PC can encode them), **render settings you can save**, **burn-in or sidecar captions**.
* From: EffectCraft render queue design, craft-libs `gif`, FilmCraft export pipeline notes (batching, overlap, ETA). **L**.

### T11. Project, interchange and captions
* **Import/export** timelines (EDL, FCP XML, OTIO) so projects move to and from other editors; **SRT/VTT/ASS** caption import and export and a
  caption editor; **Lottie** export of simple animations (optional); **project packs** (a project plus its media list).
* From: craft-libs `timeline` (ALE/EDL/FCP7/FCPXML/OTIO), `captions` (SRT, VTT, ASS, TTML), `lottie`; FilmCraft `crates/interchange`. **M–L**.

### T12. Workspaces, shortcuts and Packs
* **Simple and Pro workspaces** (same app, different amount of panel); **panel layouts you can save**; **remappable shortcuts with a keyboard picture**
  and import of common profiles; **Packs**: droppable folders of looks, titles, sounds, presets and effects with a manifest (data only; effects
  as sandboxed WebAssembly later).
* From: craft-libs `keymap` (chord/profile model), craft-extensions (manifest, versions, store, threat model), EffectCraft `docs/plugins.md`. **L**.

---

## 7. Plain-words naming (and the trademark rule)

Strike labels things for a beginner and **never uses another product's brand names**. Examples (full table in the port map):

| ArtCraft/EffectCraft name | Strike says |
|---|---|
| Lumetri / Color Grading | **Look** |
| Keylight / Screen Key | **Remove a colour** |
| CC Light Rays / Radial Light Burst | **Light rays** / **Light burst** |
| Gaussian Blur / Directional Blur / Radial Blur | **Soft blur** / **Speed blur** / **Zoom blur** |
| Track Matte | **Show only inside…** |
| Adjustment Layer | **Effect for everything below** |
| Pre-compose | **Group into one block** |
| Time Remap | **Change speed over time** |
| Stroke / Trim Paths | **Outline** / **Draw-on** |

---

## 8. Release slices (each one ships and is useful alone)

| Release | Name | Contents | Exit criteria |
|---|---|---|---|
| **A · 2.1** | Solid & Fast | Prove and finish the export fixes (branch `perf/faster-export`), honest export ETA, export queue + background export (T10 start), crash-safe versioned saves, frame-exact time, **WebCodecs frame service** | Scrub a 1-hour recording with no stale frame; plain export within 10% of the hardware limit; no data loss on crash |
| **B · 2.2** | Edit tools | T1 (source viewer, In/Out, J/K/L, trim group, insert/overwrite), remappable shortcuts (T12 start), keyframe graph editor first version (T6), timeline thumbnails and waveforms | Timed edit tasks (section 9) pass |
| **C · 2.3** | Engine 3 | Section 5 end to end behind a switch: layer model, effect registry, **WebGPU compositor + canvas fallback**, layer cache, **blend modes + opacity (T2)** as the first user-visible tools | GPU and canvas results agree on test scenes; layered exports ≥ 2× faster than today **[to measure]**; saved projects migrate |
| **D · 2.4** | Look & Effects | T3 masks and shapes, T4 effects (first ~40), T5 colour (Simple + More + scopes + LUT), mattes and adjustment layers (T2) | Effects browser with live thumbnails; each tool has preview, export, undo, save/load tests |
| **E · 2.5** | Motion & Audio | T6 (layer styles, text animators, time remap, motion blur), T7 (mixer + processors + LUFS), T8 tracking, rest of T4 | Audio processors null-test against the reference DSP; tracker follows test footage |
| **F · 3.0** | Momentum | T9, T10 finish (GIF/WebP/range), T11 interchange and captions, T12 workspaces + Packs, new home screen, polish, rename of the GitHub repo and update URL (with a redirect) | Ease tests pass; full QA suite green on both PCs |

**Critical path:** C (Engine 3). A and B can start now, in parallel with the long build of C. D–F depend on C.

---

## 9. How we'll know it is faster and still easy

**Speed** (measured by an automatic suite on both your PCs): plain 1080p60 export ≥ 90% of the hardware limit; vertical short with blur, facecam
and titles ≥ 50 fps on Iris Xe **[today ≈ 20 fps, measured]**; first exact frame after a scrub < 150 ms; dropped preview frames < 1%.

**Ease tests** (a person who has never used Strike, with a stopwatch): (1) put a green-screen clip over a game clip → < 3 min; (2) add a glow
and a drop shadow to a title → < 1 min; (3) make a colour look and save it → < 3 min; (4) cut 10 moments out of a long recording → < 5 min;
(5) find "match volume" via Ctrl+K → < 20 s. If a tool fails its test it is redesigned before it ships.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WebGPU not available or unstable on some PCs | med | high | Check `navigator.gpu` on both PCs first; keep the canvas path as fallback and as the test reference |
| Porting compute shaders takes longer than hoped (parameter packing, storage-texture formats, memory on integrated GPUs) | med | med | Start with 5 shaders end to end (blend, soft blur, levels, remove-colour, wipe); use half-float textures; measure memory |
| Engine 3 delays every later release | high | high | Releases A and B ship first and don't depend on it; Engine 3 behind a switch |
| Too many tools hurt "easy" | high | high | Rules 0–2, Simple/Pro, curated 70 effects, ease tests with veto power |
| Licence/trademark slip-ups | low | high | Attribution file from day one; rename policy; no Adobe names or assets; only Apache/MIT sources |
| Existing projects break | low | high | Versioned migrations + golden project files |
| Scope | high | high | A, B, C are the core; D–F can be trimmed by tool, not by quality |

---

## 11. Decisions I need from you (my recommendation first)

1. **Order A → B → C → D → E → F** (engine first, tools on top)? *(Recommended.)*
2. ~~Existing automatic tools~~ **Decided:** Smart Crop stays and is improved; everything else automatic was removed (section 0).
3. **GPU-first engine** (WebGPU with canvas fallback)? *(Recommended.)*
4. **Rust toolchain for WASM** (dev-time only; installs via winget): allow later if JS ports prove too slow for audio or tracking? *(Recommended: decide at Release E.)*
5. **Shortcut change:** `I`/`O` mark In/Out, **Import moves to `Ctrl+I`**? *(Recommended.)*
6. **Repo hygiene:** your working tree is far ahead of the last commit ("Release 1.6.0") **[read]**. OK to make one baseline commit of the current 2.0.5 state on a new
   branch before any work? Nothing pushed. *(Recommended.)*
7. **First effects to port** from the curated list: any you want first or want dropped? (I'd start with blend modes, soft blur, levels/curves, remove-a-colour, glow, mosaic, linear wipe.)
8. **Fetch more repos?** `photocraft` (brushes, filters) and `vectorcraft` (vector paths) are large; only if you want paint or vector tools. *(Recommended: not now.)*
9. **GitHub repo rename** (`GameCut` → `Strike`) and the update URL: do it with the 3.0 release, with a redirect, not before. *(Recommended.)*
10. **People for the ease tests:** two friends available at the end of Releases B and D?

---

## Appendix — shortcut proposal (checked against today's keys **[read: `src/shortcuts.js`]**)

`Space` play · `J K L` shuttle · `, .` frame step (arrows stay) · `I O` In/Out · `Enter` add range · `Ctrl+I` import · `S` split · `B` razor · `V` select ·
`R` trim group *(Pro)* · `T` new text · `P` pen/mask · `M` marker · `Q` quick look · `Z` zoom effect · `Shift+Z` fit · `Ctrl+K` palette · `?` help ·
property keys like After Effects' `A P S R T` only in the Pro workspace.
