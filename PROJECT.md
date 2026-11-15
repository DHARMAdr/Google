# ClipCutter - Project File (history to latest change)

> Give this file to Claude together with the files in the repo whenever you want to improve the project.
> Add a new entry to the CHANGE LOG at the bottom after every round.

---

## 1. What this project is

A website that takes long videos (especially **game footage**), **analyses every sound and frame**, finds the **kills, streaks and big moments**, and exports **ready-to-upload vertical clips** for YouTube Shorts and Instagram Reels.

Everything runs **inside the browser**. No server, no upload, no cost. Hosted free on GitHub Pages.

- Repo: https://github.com/DHARMAdr/Google
- Live site: https://dharmadr.github.io/Google/

## 2. Technology and why

| Choice | Reason |
|---|---|
| **Plain JavaScript (no framework)** | Runs in the browser, so videos stay private. No backend. |
| **Web Audio API + own FFT** | Decodes every audio sample and finds gunfire-like bursts, booms and loudness. |
| **Canvas** | Reads pixels from frames (motion, flashes, kill-feed activity) and draws the timeline / Analysis Lab. |
| **ffmpeg.wasm (single-thread core 0.12.10)** | Real H.264 encoding in the browser: sharp, original frame rate, exact cuts. Loaded from `vendor/ffmpeg` (own copy), with CDN back-up. |
| **MediaRecorder** | Kept only as the "Fast recorder" (quick previews). |
| **Service worker + manifest** | Offline use and "Install app". |

Python (OpenCV, librosa, Whisper, YOLO) could analyse deeper but needs a server or local install, so it is listed under future upgrades.

## 3. File list

| File | Purpose |
|---|---|
| `index.html` | Page layout only (boxes, buttons, inputs). |
| `css/style.css` | All looks. Dark and light theme through CSS variables. |
| `js/util.js` | Small helpers: formatting, saved settings, toasts, video wait helpers. |
| `js/profiles.js` | Game profiles (kill-feed boxes + clue weights) and platform length limits. |
| `js/engine.js` | **Highlight Engine**: audio scan, frame scan, channels, kill detection, streaks, clip building, Classic mode. |
| `js/exporter.js` | Export: ffmpeg high quality, lossless cut, fast recorder, title image, ZIP maker. |
| `js/app.js` | Connects buttons to everything: library, studio, analysis, lab, clips, export, calibrate. |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Offline mode and installable app. |
| `vendor/ffmpeg/` | Own copy of ffmpeg.wasm (about 31 MB, mostly one .wasm file). |
| `PROJECT.md` | This file. |

## 4. How the Highlight Engine works

1. **Audio scan** - the whole soundtrack is decoded (16 kHz) and cut into 20 ms slices. Each slice goes through an FFT. Measured: loudness, deep "boom" energy, and **onsets** in the 1.5-7.5 kHz band (sharp gunshot-like sounds = new energy appearing).
2. **Frame scan** - the video is stepped through at 2 / 5 / 10 / 30 frames per second. Per sample: movement, full-screen flashes, red damage, scene cuts. Three screen boxes are read from the **full-size frame** at higher detail: **kill feed**, **centre banner**, **hit marker**. A new text line = a sudden rise in sharp edges compared with the previous sample.
3. **Channels** - every clue becomes a 0-1 line with one value per 0.1 s. Values are scaled by a "floor" so quiet noise is not blown up.
4. **Kill detection** - a kill needs a screen clue (feed / hit / banner, clues within half a second reinforce each other) **and** gunfire sound close by. Feed movement without gunfire is kept as "feed only" and never builds a clip. Whole-screen changes (cut, camera whip, flash) are ignored for the box clues.
5. **Streaks** - kills closer than the "group" time (default 7 s) form one streak (Double, Triple, Quad, Multi-kill). Intense non-kill moments are separate "peaks" (never glued onto a streak).
6. **Clips** - lead-in (default 5 s) + action + after-action (3.5 s), fitted to the platform limit (59 s default), merged when windows overlap, snapped to quiet moments, ranked, overlaps removed. A strong lone kill is kept even when a streak outranks it.

Settings changed after the first scan (length, count, lead-in, grouping, sensitivity, platform) re-pick clips instantly. Changing frame detail or the kill-feed box needs a new scan.

**Honest limits**
- It cannot read names or know WHO made the kill (no text reading yet), so it finds kill-feed activity plus gunfire. Use **Calibrate kill feed** to draw the box exactly for your game.
- Kill-feed positions in `profiles.js` are generic. They are not verified per game.
- Tested on a synthetic video with known kill times, not yet on real BGMI / Valorant footage. Real footage may need Sensitivity or Calibration tuning.

## 5. Export quality (why the first versions looked degraded)

The first two versions re-recorded the video in real time with the browser's MediaRecorder. In a test it produced **VP9 at only 0.75 Mbps** (and sometimes VP9 + Opus inside an `.mp4`, which Instagram can reject).

Version 3 adds three engines:

| Engine | What it does | Measured (13 s clip, 1280x720 30 fps source -> 1080x1920) |
|---|---|---|
| **Best quality (ffmpeg)** | Decodes every real frame, scales/crops, encodes H.264 CRF 16-20, keeps the frame rate, AAC audio | PSNR **53 dB**, SSIM **0.996** (near lossless). Took ~70 s for a 13 s clip at the *Quick* preset (about 5x slower than the clip). |
| **Original quality, instant** | Cuts without re-encoding (stream copy) | Bit-identical quality, ~1 s. Keeps original shape; start may be ~1-2 s early (keyframe). |
| **Fast recorder** | Old real-time recorder | PSNR **27 dB** (visibly softer). Now asks for H.264 + AAC MP4 only, else WebM. |

Tips: "Whole video + blurred bars" keeps the full original picture (no zoom, no upscaling blur). "Crop to fill" zooms in, so it is softer by nature. Presets: Maximum = veryfast CRF 16, High = superfast CRF 18, Quick = ultrafast CRF 20.

## 6. Feature list (v3)

**Library** - add many videos with thumbnails, select, delete one or all, memory cleanup, friendly errors.
**Studio** - player, timeline with excitement curve and event dots, draggable In/Out handles, typed In/Out, nudges, keyboard shortcuts (I, O, arrows), play selection, add clip, split at playhead.
**Auto highlights** - Smart engine or Classic (sound + motion), 6 profiles, 4 detail levels (2 / 5 / 10 / 30 fps), platform targets, auto or fixed length (15 s to 10 min, custom), count, lead-in, after-action, grouping, sensitivity, quiet-moment snapping, Calibrate kill feed (drag boxes on a real frame), Cancel.
**Analysis Lab** - 9 clue lanes over time, event markers, event table with Jump and Make clip.
**Clips** - ranked cards with confidence, kills, platform-fit badges; rename, edit times, nudge, preview, split, duplicate, delete; sort best-first or by time.
**Export** - shapes (9:16, 4:5, 1:1, 16:9, original), fit (blur bars, crop, black bars) with crop sliders, resolution, frame rate, speed, fade, mute, loudness normalising, title overlay, Export all, Cancel, delete exported files, **Download all as ZIP**.
**Upload pack** - title, YouTube description and Instagram caption with hashtags per clip, copy buttons, copy-all.
**Digital extras** - live stats strip, light/dark theme, saved settings, installable and offline (service worker), toast messages.
**One click** - "Auto-make Shorts (everything)": analyse, pick clips, export all.

## 7. Putting it online (GitHub Pages)

1. Repo `DHARMAdr/Google`, branch `main`, folder `/ (root)`. Settings > Pages > Deploy from a branch > main > / (root).
2. Open https://dharmadr.github.io/Google/
3. After an update, refresh once (the service worker fetches new files first when online).

## 8. Testing notes

Headless Chrome, synthetic 70 s clip with planted events (kills at 12, 14.5, 17, 32, 50, 52 s; gunfire-only decoy at 42 s; full-screen flash decoy at 24 s; feed-only decoy at 60 s):
- Detected kills at 11.8, 14.3, 16.8, 31.8, 49.8, 51.8 s (within 0.2 s), decoys rejected, at 2, 5 and 10 fps.
- Clips: Triple kill (6-19 s), Double kill (44-57 s), single Kill.
- Scan time for a 70 s clip: 2 fps ~14 s, 5 fps ~35 s, 10 fps ~60 s.
- Also passed: upload, re-pick, manual trim, Classic mode, all three export engines, ZIP (valid), calibrate, service worker, delete clip / file / video. No console errors.
- Not yet tested: Safari, Firefox, phones, real game footage, videos over 10 minutes.

## 9. Known limitations

- ffmpeg export is slower than the clip (single-thread WebAssembly). A 45 s Full HD Short can take several minutes.
- Audio decoding of files over ~1.5 GB is skipped (picture clues only).
- Scan speed depends on seeking: long videos at high detail are slow (about 1x real time at 10 fps on the test machine).
- Tab should stay open and visible during scanning and exporting.
- No speech/OCR yet, so the player's name is not recognised.

## 10. Future upgrades (ideas, biggest value first)

1. **OCR of the kill feed** (tesseract.js) to keep only the player's own kills by name.
2. **Hardware encoding** with WebCodecs (much faster than ffmpeg.wasm) and WebCodecs decoding for faster frame scans.
3. **Multi-thread ffmpeg** (needs cross-origin isolation headers; possible with a service-worker trick).
4. **Captions** with Whisper in the browser, cuts at sentence ends.
5. **Face / crosshair aware crop** for "Crop to fill".
6. **Merge several clips** into one compilation with transitions.
7. **Per-game presets** verified on real footage (BGMI, Free Fire, Valorant, CS2, Fortnite...).
8. **Trained model** on labelled kill moments to replace the hand-made rules.

## 11. Prompt to continue with Claude

> I am attaching the ClipCutter files (`index.html`, `css/`, `js/`, `PROJECT.md`). Read `PROJECT.md` first.
> Keep every code file commented in basic English for beginners (why each part exists, how it works, how to improve it).
> Make this change: ____________
> Test it in a browser, update `PROJECT.md` with a new CHANGE LOG entry, and upload everything to the GitHub repo DHARMAdr/Google.

---

## CHANGE LOG

### Round 1 - Initial build (2026-11-15)
- Single `index.html`: upload, sound + motion analysis, best-clip finder with quiet-point snapping, timeline map, editable clips, preview, real-time 9:16 export with three fit modes. Created `PROJECT.md`. Pushed to `DHARMAdr/Google`.
- GitHub Pages could not be switched on automatically; the user enabled it in repo settings and confirmed it works.

### Round 2 - Library, trimmer and export options (2026-11-15)
- Video library (add, select, delete one or all), manual trimmer (draggable In/Out, nudges, shortcuts, split), clip actions (rename, duplicate, delete, delete exported file), custom lengths, up to 20 clips, export options (shapes, fit, quality, speed, fade, mute, title), Export all, Cancel, clearer errors. Tested in headless Chrome. Pushed.

### Round 3 - Highlight Engine, true-quality export, redesign (2026-11-15)
- User asked for: frame-by-frame and bit-by-bit analysis that automatically makes Shorts of important scenes (such as a player killing opponents), upload-ready without editing; fix degraded export quality; keep old options; digitalise the site further.
- Split the single file into `index.html`, `css/`, `js/` (util, profiles, engine, exporter, app), plus service worker, manifest and icon.
- **New Highlight Engine** (`engine.js`): per-sample audio FFT, frame scan at 2 to 30 fps, kill-feed / banner / hit-marker box reading at higher detail, whole-screen-change filtering, kill + gunfire fusion, streak grouping, clip windows, merge, quiet-point snapping, ranking.
- Tuning found by testing against a synthetic video with known truth: moved from a slow baseline to sharp onsets (stopped ghost events), read boxes from the full-size frame (text vanished at 108p), separated kills from peaks, weak "feed only" events never join streaks.
- **New export engine** (`exporter.js`): ffmpeg.wasm real H.264 encode, lossless instant cut, title as PNG overlay, fades, speed, loudness normalising; Fast recorder kept and fixed to avoid VP9-in-MP4. ZIP download.
- Measured quality vs original: new engine PSNR 53 dB / SSIM 0.996; old recorder PSNR 27 dB.
- **Site redesign**: hero + live stats, step cards, Analysis Lab, Calibrate dialog, upload pack text, one-click Auto-make Shorts, light/dark theme, saved settings, installable + offline.
- All earlier options kept (Classic method, custom lengths, trimmer, shapes, fit modes, crop sliders, speed, fade, mute, title, library, delete).
- Honest limits: no OCR (cannot tell whose kill it is), profiles unverified on real games, ffmpeg export is slower than the clip.
