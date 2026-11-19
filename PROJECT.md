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

## 6. Feature list (v3.1)

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

## 9b. Self-healing and error reports (added in Round 4)

- **Frame reader chain** (`engine.js`): `browser` (video + canvas) -> `memory` (copy file into RAM, play that) -> `ffmpeg` (decode ourselves, plain numbers cannot be tainted). On failure the scan RESUMES at the same sample with the next reader; a reader that failed is remembered per video (`v.deadSources`).
- **Audio chain**: `decodeAudioData` -> ffmpeg PCM decode. **Last resort**: if no pictures can be read, finish with sound only and flag the result as partial.
- **Export recipes** (`app.js exportClip`): your settings -> simple options -> 540p/30fps quick -> lossless cut. The engine is reset between tries.
- **Error report** (`diagnostics.js` + `#errDlg`): pop-up with Copy / Download / Re-run tests. Contains summary, error + stack, stage trail, clicks, recovery attempts, auto-diagnosis, video + settings (name/size only), device, codec support, live canvas tests, console log, ffmpeg log. Opened automatically on failure; a toast for auto-fixed issues; "Report" button in the header.
- Root cause of the user's "canvas tainted" error could not be reproduced in normal Chrome (http, file, sandboxed iframe all fine); likely an in-app browser / privacy feature / cloud-file source. The chain handles it regardless.

## 9c. Compatibility layer (Round 5)

- `js/compat.js`: **stable copy** of every picked file into private browser storage (OPFS, memory fallback) right at upload, because Android can revoke permission to a picked file later (real report: `NotReadableError ... permission problems after a reference to a file was acquired` broke every reader). Screen wake lock during analysis/export. Old copies cleaned at start.
- **Any format**: if the browser cannot play the file (AVI, MKV, HEVC, video-track-less metadata...), `Exporter.probeInfo` reads length/size with ffmpeg, `v.noPlay=true`, analysis goes straight to the ffmpeg frame reader and audio via ffmpeg, export uses ffmpeg (Fast recorder auto-switches to Best quality), thumbnail via ffmpeg, and an optional "Make preview copy" (480p H.264) lets you watch it.
- `errText()` turns any thrown thing into readable text (fixes `[object Object]` and `undefined` in reports).

## 9d. Speed layer (Round 6)

- **Stream reader** (`engine.js makeVideoSource mode "stream"`): the hidden video is PLAYED muted at up to 8x and a picture is grabbed with `requestVideoFrameCallback` when the time reaches each sample (no seeking, hardware decoder). Speed controller slows down if samples arrive late. 12 s watchdog (ignores hidden tab) -> falls to the next reader.
- **Parallel parts**: video is split into N parts, N from `navigator.hardwareConcurrency` / `deviceMemory` (max 3, 1 for short clips or <=2 GB). Each part has its own `makeProcessor` and a "priming" sample so no gap at the joins. Unfinished parts continue through the chain seek -> memory -> ffmpeg, resuming at the same sample.
- Header-only wait (`whenMeta`) replaces "wait for first picture" (it hung 30 s on Android Chrome).
- **Parallel export**: `Exporter` is now a factory (`make`, `Exporter.spawn()`); `exportAll` runs up to 3 ffmpeg engines at once (by cores/RAM). Output size never upscales small sources (min of chosen size and max(720, source)).
- Fixed report-dialog bug (`e.currentTarget` null after await). Version 3.3.0, SW cache v6.

## 9e. Turbo export, keep-alive, memory (Round 7)

- **Turbo engine** (`exporter.js exportTurbo`): hidden <video> plays the clip once; each picture is painted on a canvas (blur/fill/fit, title, fades) -> `VideoFrame` -> hardware `VideoEncoder` (H.264 High 4.2, bitrate = pixels x fps x 0.09/0.14/0.2 by preset) -> `vendor/mp4-muxer` (MIT, v5.2.2) -> MP4. Sound: ffmpeg cuts + AAC-encodes the clip's audio only, then a stream-copy join. Takes about the clip's own length. Two clips at once on strong devices (>=6 cores, >=4 GB). Falls back: turbo simple 720p -> ffmpeg quick 540p -> lossless cut.
- Why: the ffmpeg.wasm x264 encode ran at 0.6 fps on the user's Pixel (0.019x speed): one 33 s clip took ~30 min.
- **Keep-alive** (`compat.js keepAwake`): screen wake lock + Web Lock + near-silent looping audio + Media Session card, so work continues when the tab/app is switched or the screen is off. A website cannot run after the browser is closed.
- **Memory between visits** (`persist.js`): IndexedDB records + private copies/exports in OPFS; the library, clips and finished files come back after a reload. Analysis Lab data is not saved (analyse again).
- Engine default migrated once to Turbo. Version 4.0.0, SW cache v7.

## 9f. Optional cloud server (Round 8)

- **Server** (`server/server.js`, no libraries, Node 18+ + native ffmpeg; Dockerfile + README included): token-protected API. Chunked resumable upload (8 MB pieces, any order), render queue (one clip at a time, native x264, same filter graph as the browser: blur/fill/fit, fades, title via drawtext, loudnorm, speed), Range downloads, `DELETE /api/videos/:id` removes source + clips, `POST /api/purge`, 48 h safety-net expiry (`TTL_HOURS`), size/disk limits, CORS allow-list. Jobs survive a server restart.
- **Client** (`js/cloud.js`): off by default; main + backup/proxy address (fastest answers, other is fallback); 3 parallel chunk uploads with retries and resume; job polling; resumable download; **delete on server when the video is deleted on the site**, and if the server is unreachable the delete is remembered (localStorage `cloudDeletes`) and retried every minute and at start-up.
- **App wiring**: header "Cloud" dialog (address, backup, token, auto-upload, Test, Purge); engine option "Cloud server" appears only when configured; clips picked up automatically when the page is reopened (library memory keeps `remote.id` + pending clip ids; clip ids are no longer renumbered on restore); if the server fails, clips are rendered on the device instead.
- **Fix from the user's report (v3.3.0, NotFoundError after ~40 min)**: opening the installed app in a second window ran the start-up clean-up and deleted the OPFS copy the first window was exporting from. Clean-up now keeps files that are saved in the library, never deletes files younger than 10 minutes, and `ensureFile()` re-opens or clearly reports a missing copy before analysis / export (no pointless retries). Errors in attempts use `errText` (no more "Error: undefined").
- Version 4.1.0, SW cache v8.

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

### Round 4 - Self-healing + error report (2026-11-16)
- User reported: "Analysis failed: getImageData ... canvas has been tainted by cross-origin data". Asked for a fix, an automatic self-repair algorithm, and a copyable full error report pop-up.
- New `js/diagnostics.js` (error report system, global error nets, live probes, auto-diagnosis), error dialog in `index.html`, styles in `style.css`, header "Report" button.
- `engine.js`: frame-source chain with resume, ffmpeg audio fallback, sound-only last resort, thumbnail tolerates taint. `exporter.js`: `extractFrames`, `decodeAudioPCM`, ffmpeg log buffer. `app.js`: report wiring, `diagContext`, export retry recipes.
- Tested by simulating the exact SecurityError: (a) original blob tainted -> memory reader recovered, 6/6 kills found; (b) all video tainted -> ffmpeg reader recovered; (c) ffmpeg blocked too -> sound-only partial + report. Older e2e suite still passes. `sw.js` cache v4.
- Known: ffmpeg reader is slower (~10 s for the 70 s test clip at 2 fps) and adds one extra decoy event; real cause of the user's error still unconfirmed - the report will tell us.

### Round 5 - Android file-permission fix + all formats (2026-11-16)
- From the user's first real error report (Pixel, Android Chrome, 230 MB 36-minute MP4): picked file became unreadable -> all readers failed -> sound-only result; also message showed `[object Object]`.
- Added `compat.js` (stable copy, wake lock), ffmpeg probe / preview copy / thumbnail for unplayable formats, probe rejects files with sound but no decodable picture, better media-error text, readable attempt errors, report shows copy method and codec. SW cache v5.
- Tested: MP4 (browser reader), AVI (mpeg4+mp3) and HEVC mp4 (ffmpeg reader, export, preview copy), simulated taint cases (all still recover). Not testable here: real Android permission revocation (the stable copy is the fix by design).
- Note: 36-minute video at 5 fps = ~10,800 samples; on a phone use 2 fps (Fast) first.

### Round 6 - Speed (2026-11-16)
- User report: analysis "still loading" on Pixel (36 min, 768x480): browser reader timed out at 30 s, memory copy stalled; Copy button crashed.
- Added stream reader + parallel parts + device-based worker count, parallel export, no-upscale size cap, fixes above.
- Measured here (desktop Chrome): 280 s clip analysis 53 s with seek vs 17.6 s with 3 parallel stream parts (same kills). Export of 3 clips (quick preset): 145 s with 1 engine, 97 s with 3 (sandbox has few cores). Taint/AVI/HEVC recovery tests still pass.
- Not verified on the real phone. Biggest remaining cost: x264 in WebAssembly (single thread per engine). Next idea: WebCodecs hardware encoder.

### Round 7 - Turbo export + background + memory (2026-11-16)
- User report (Pixel): analysis worked (stream x3) but ffmpeg export ran at 0.019x for ~1 hour. Asked for much faster use of device hardware, background running, push + files.
- Added Turbo (hardware) export, keep-alive, persistent library. Measured here (desktop Chrome, software encoder): 12.9 s clip -> 13.4 s, 1080x1920 H.264 + AAC; 3 clips 25 s (ffmpeg engine: 97-145 s). Library restored after reload. Earlier recovery/format tests pass.
- Not verifiable here: real phone speed (hardware encoder should be faster than this test), Android background behaviour.
- Needs a server to truly run with the app closed (options in chat: cloud worker, or always-on PC).

### Round 8 - Cloud server + stored-file fix (2026-11-17)
- User has a Cloudflare setup and a proxy; asked for a per-video temporary server option with automatic removal on clear.
- Added server + client as in 9f. Tested locally (Node server + real ffmpeg + browser): upload, 3-clip server render (1080x1920 H.264+AAC), page closed mid-render and clips collected after reopening, delete on site empties the server, delete while server is down is retried later, wrong token falls back to local rendering, test dialog shows ffmpeg/cores/storage. Earlier regression tests pass.
- Not tested: a real Cloudflare deployment (a plain Worker cannot run ffmpeg: use Tunnel + this server, Docker, or Containers).

### Round 9 - Main-player Hunter, two-stage speed-up, Montage (2026-11-17, v5.0.0)
- User report: only 1 of their kills was found as "main player"; other clips were ~30 s from the start of a section with no kill; analysis still slow; wanted a SEPARATE tool to join finished clips with per-clip trimming.
- Cause of filler clips (old `detect`): it added "peak" (loud/busy) events and turned them into clips even without kills; kill-feed-only events (teammates) also counted.
- New `js/hunter.js` (method "Main-player kills only", now default): a kill is accepted only with (a) own gunfire just before and (b) two of three clues: hit marker, centre banner, kill-feed line (banner may stand alone with 3+ shots). Feed-only = teammate, hit-only = no kill, red flash without hit = own death. No peak events, so no-kill clips can no longer be made. Rejected candidates stay in the event table with the reason. Old methods (Smart, Classic) unchanged.
- Two-stage speed-up in `engine.js`: `audioWindows()` finds gunfire stretches from sound (fast), `visualScan` then reads pictures ONLY in those windows (work queue over parallel stream readers, `mask` marks read samples, `buildChannels` skips the rest). Falls back to a full scan if the sound is useless or >75% of the video is gunfire, or video < 90 s.
- New separate program `montage.html` + `js/montage.js` (link "Montage" in header): loads finished clips saved by the main page (Persist) or device files, per-clip trim (sliders, numbers, "use current time"), reorder, remove, 3 shapes, dip-to-black, export one MP4 (canvas + VideoEncoder + mp4-muxer; sound by AudioEncoder, or WAV + ffmpeg AAC join when the browser has no AAC encoder). It only reads data; the main page is not touched.
- Tests (desktop Chrome, synthetic 120 s game-like video, 6 real kills + decoys): Hunter found all 6 (within 0.3 s), rejected teammate-feed, hit-only and extra-gunfire decoys, made 3 clips all containing kills; analysis 15 s (46 s of 120 s watched) vs 31 s for the old Smart method (which also accepted a decoy). Montage: 3 trimmed/reordered clips -> 1080x1920 H.264 + AAC, 19.07 s as expected.
- NOT verified: real BGMI/PUBG/Free Fire footage and a real phone. Thresholds (hit/banner/feed 0.34/0.30, shots needed) are guesses; "Sensitivity" tunes them. No OCR yet, so it cannot read the player NAME. Next: OCR on kill-feed crops of candidate moments + name match; learn thresholds from kept/deleted clips; faster-than-real-time export/montage via WebCodecs VideoDecoder.

### Round 9b - Cloud address check + Hunter diagnostics (2026-11-17)
- User report CC-MWK3YRLA: Cloud URL pointed at their MangaFlow accounts Worker (not a ClipCutter server): test gave 404/405. A Worker cannot run ffmpeg. Fix: Test now asks /api/health first and says "NOT a ClipCutter server"; 404/405 errors carry the same hint.
- User: Hunter still gave no kill clips on real footage (36 min, 768x480, Pixel). Now: if zero kills pass, it retries with easier settings (x1.5, x2.3) and says so; if still none, the status lists how many moments were checked and why each was rejected. Real footage still unverified; needs a kill-feed screenshot to tune.

### Round 9c - Stream stall retry + tighter windows (2026-11-17)
- Report CC-MWKAJBVK (Pixel 9a, 36 min): all 3 stream readers stalled together after ~2 min ("no pictures for 12 s"), analysis dropped to the slow seek reader; two-stage mode was not used (gunfire >75% of the video).
- Fix: after a stall, unfinished parts are retried one at a time at half, then quarter speed before falling to seek. Gunfire windows now tighten progressively (strongest shots only, narrower) until <=55% of the video is watched. Retry path not reproducible here (needs a real phone); synthetic test unchanged (46 s of 120 s watched, 6/6 kills).

### Round 10 - Cloudflare storage server (2026-11-17)
- User asked for a new Cloudflare storage server. Added `cloudflare-storage/` (Worker + R2): same /api as server/ for upload (8 MB pieces, resumable), info, delete, purge, hourly TTL sweep; `canRender:false`, jobs -> 501. Tested with a fake R2 bucket in Node (upload, resume checks, complete, delete). NOT deployed (needs the user's Cloudflare login) and not tested from the real site.
- Client: Cloud.test stores `canRender`; the "Cloud server" export choice is hidden for storage-only servers (`Cloud.canRender()`).

### Round 11 - Profiles, admin view, Cloudflare storage v2, Hunter layout fix (2026-11-17, v5.1)
- User wanted: a NEW Cloudflare storage (not the old one) with a setup guide; add the server manually each time; profiles (username + 6-digit code) with content separated per profile; an admin "parent" profile that sees all profiles; log out resets the server on the site while server data stays; better kill finding without lobby/section-start clips.
- `cloudflare-storage/worker.js` v2: /api/register, /api/login (PBKDF2 hashed code, 5 tries -> 10 min lock, 30-day sessions), /api/logout, /api/me, per-owner videos, admin endpoints (users, a user's videos, reset code, delete profile), clips store (PUT/GET/DELETE), source download. Owner key (TOKEN) creates the admin. Tested with a fake R2 bucket (23 checks) and from the site through a local bridge (register, auto-upload, logout wipes local, admin sees child, child loads video back, wrong code rejected).
- Site: `js/profile.js` + dialog (Profile button). Cloud module gained login/register/logout/list/admin/putClip/fetchBlob. Logging out clears server address, session and the local library (without deleting server copies). Finished Shorts are uploaded to the profile's server after export. Cloud engine option stays hidden for storage-only servers.
- Detection: new profile `shooter_top` (kill feed searched along the whole top; banner and hit-marker boxes wider); Hunter uses it when the layout is unknown. Clip stretching now adds time mostly AFTER the kill (25% before / 75% after), so lobby time is never pulled in. Status line names the method and, when nothing is found, why moments were rejected.
- Research note: online sources found did not state Free Fire/BGMI HUD positions, so layout is NOT assumed; a screenshot is still needed to tune per game.

### Round 12 - Export crash fix, "Teach it my name" (Valorant-style kill feeds), no auto-relax (2026-11-18, v5.2.0)
- Report CC-MWKJAE61 (Pixel 9a): Turbo export failed with "addVideoChunkRaw's fourth argument (duration) must be a non-negative real number" (the phone's encoder returned chunks without a duration). Fix: VideoFrames now carry a duration; if a chunk still has none, exporter.js and montage.js add it themselves (addVideoChunkRaw). Verified: export of 3 clips + montage still work in desktop Chrome (the bug itself only shows on the phone).
- Game identified from the user's words: Valorant (13 rounds, 30 s buy phase + 1:40 round - confirmed online at oneesports.gg; kill-feed layout and own-kill highlighting were NOT found online). Valorant shows no hit markers or kill banners, so the Hunter's clue test had nothing to latch onto; the earlier "auto-relax" retry then accepted junk (round-start / round-end moments). Auto-relax REMOVED; Hunter sensitivity can no longer go below 1.
- New "Teach it my name" (js/teach.js): the user boxes their own name in one kill-feed line; engine.js `matchTemplate` (normalised cross-correlation on every 2nd pixel/position, kill-feed area sampled at 480 px) finds that picture in every frame, counts matching lines (`ch.mine`, `ch.mineN`), and hunter.js `detectByName` makes a kill for each NEW matching line. A scene cut within 2.5 s after it = own death (rejected). Gunfire only raises confidence.
- Tests (synthetic 768x480 Valorant-like video, 4 own kills + teammate kills + own death + "ROUND WON" banner): without teaching: 0 clips and a clear reason (honest); after teaching: 3 clips with the 4 own kills (a double kill is one clip), teammate rows and the death rejected, 10 s analysis for 120 s. NOT verified on the user's real footage (768x480 screen recording on Pixel, 36 min).
- Next ideas: also teach the top-centre alive-icons bar, auto-skip buy phase via round-timer text, OCR.

### Round 13 - Automatic name finding, Server pop-up, offload + restore from server (2026-11-18, v5.3.0)
- User asked: no manual kill picking (36-min videos cannot be scrubbed frame by frame); a separate Server pop-up with test + reasons + copyable report; faster "Find everything"; upload copy to the server and free the device; delete on site also deletes on server; data survives reloads; if the browser data is cleared the server gives it back; works on phone and computer.
- AUTO NAME (js/autoname.js, engine.js `collect`): while scanning, engine keeps a small gray picture of every NEW kill-feed row (per-row edge counts, handles list scrolling by one row). AutoName cuts pieces out of the rows that came right after own gunfire, counts which piece recurs (NCC>=0.78, coarse+fine search), checks the best 6 against ALL rows (must be tied to gunfire, must not be on nearly every row = frame decoration), then every row with that piece = one own kill; a view switch right after = own death (dropped). The piece is remembered (localStorage "autoname") for the next video. "Teach it my name" still wins if the user taught one. If nothing is found the old clue method runs and the status line says why. Name/auto modes sample at most 4 fps (faster); up to 4 readers on strong devices.
- SERVER POP-UP (Profile > "Server: check / set up", js/profile.js + Cloud.diagnose): steps address -> reachable (no-cors probe) -> CORS/allowed origin -> is ClipCutter -> R2 bucket bound -> TOKEN secret set -> optional login test; each failure has a "How to fix"; "Copy server report", "Copy the server code", step-by-step guide. worker.js /api/health now returns bucketBound/tokenSet/openSignup/originAllowed (yes/no only). Failed login/create also points to this pop-up.
- OFFLOAD / SYNC / RESTORE (app.js): "Free space" button + automatic sweep (checkbox in Profile) remove the local OPFS copy once the server confirms the video is complete (selected video waits for 2 min idle); `bringBack(v)` downloads it again when opened/analysed/exported (`ensureFile`). Placeholder records (key "off-<id>") survive reloads. Editing state (clips, trim, thumbnail) is PUT to /api/videos/:id/project (worker storage-2.1, kept in meta.project) every 5 s when changed. After login (or start-up) `pullFromServer()` rebuilds the library from the server, so cleared browser data does not lose work (the user must log in again: the token lives in the same browser data). Deleting a video already deleted it on the server (Cloud.remove, retried if offline).
- Tests (synthetic): auto name found all 4 own kills on truth2.mp4 without teaching (3 clips); truth.mp4 (hit-marker style) still 3 clips; offload -> reload -> wipe all site data -> login -> restored with clips/trim -> open downloads it back -> delete leaves 0 on server; server pop-up OK/PROBLEM lines; phone width 390 px no horizontal overflow.
- NOT verified on the user's real footage (no access): auto name on real Valorant kill feed; real Cloudflare deployment. If it fails the status line prints the reason; send that line + a screenshot of the kill feed.
- Next ideas: learn the highlighted "my row" colour, OCR, background sync of finished Shorts, resumable downloads.

### Round 14 - Analysis speed: hardware decoder reader (2026-11-18, v5.4.0)
- Report CC-MWLMWRDH (Pixel 9a, 36-min 768x480 video): frame scan crawled. Log showed "Stream reader failed: AbortError: The play() request was interrupted because video-only background media was paused to save power" and a 5890 s gap with no progress (phone/tab asleep) - hidden-video playback is paused by Chrome when the screen turns off, and `setTimeout`-based yields are throttled in the background.
- FIX 1 (engine.js `makeDecoderSource`, `loadMp4Info`, stage 0 of `visualScan`): read the MP4 index with the vendored mp4box.js (vendor/mp4box, BSD-3), feed compressed pictures to WebCodecs `VideoDecoder` (hardware, no playback), grab a picture at each sample time, close other frames at once. Works with the screen off. Falls back to the stream/seek/memory/ffmpeg chain if the file is not an MP4, the codec is unsupported or the decoder stalls (20 s).
- FIX 2 (util.js `tick`): MessageChannel yield instead of setTimeout(0), so progress is not throttled in the background.
- Tests (desktop Chrome, synthetic): 30-min 768x480 H.264 with B-frames and index at the end of the file -> frame scan 80 s, whole analysis 87 s (stream reader on the same machine took ~2.5x longer on short clips); truth2.mp4 3 s vs 7 s; WebM falls back to the stream reader; results identical. NOT tested on the real phone (hardware decoder, background behaviour).
- Tip for users: keep the tab open; with the decoder reader a locked screen no longer freezes the scan, but some phones still freeze a whole tab after many minutes.

### Round 14b - Fix: "Cannot read properties of null (reading 'addEventListener')" (v5.4.1)
- Report CC-MWLSZ9CP: profile.js:178 ran against an OLD cached index.html (no #pfServer yet) because the browser's HTTP cache served index.html and the scripts from different versions.
- Fix: profile.js uses a null-safe `on(id, event, fn)` helper (a missing element is skipped with a console hint, never crashes the script); sw.js now fetches every page/script with `cache: "no-cache"` (revalidate, quick 304) so versions cannot be mixed; cache name clipcutter-v14.

### Round 15 - Referee: no more lobby / buy-phase clips (2026-11-19, v5.5.0)
- User report: clips of ~10 s were cut from the lobby / buy phase of every round and no real kill was found. Reproduced with a new synthetic Valorant-like video (320 s, 3 buy phases with loud periodic music + a blinking name list, 3 live rounds, 8 own kills with highlighted rows, teammate rows, one own death): the old pipeline made 3 clips ALL in lobby/buy phases and missed every real kill.
- Cause: lobby music beats look like gunshots (gunfire test passed everywhere) and the blinking name list looked like "my name in the kill feed", so AutoName even learned the wrong thing.
- FIX (new js/referee.js): (1) `cleanOnsets` removes music-like beat trains (>=12 beats, >=8 s, regular gaps) inside `pickOnsets`, so they never count as gunfire or create scan windows; (2) `fight(an,t)` = real shots in the 8 s before t, a live round has >=3; (3) `judge` rejects every kill with no firefight ("no firefight around (lobby / buy phase / menu)") and logs EVERY decision in `an.decisions` (also printed in the report, section 4b); AutoName ignores rows outside live fights for learning and events; the clue mode now also goes through Hunter.finish (so it is judged too); the sound-only "Maybe" picks come only from live fights.
- Result on the synthetic video: 0 lobby clips, all 8 own kills found (two doubles), teammate rows and own death rejected. truth2.mp4 unchanged (4 kills, 3 clips).
- NOT done yet / honest limits: still verified only on synthetic footage; no extra dense frame re-check pass; no Troubleshoot/Doctor module or KeepAlive for minimised use yet; `Persist.cacheTidy` not yet called at start-up. Needed from the user: a screenshot of the kill feed at one of their kills + a short clip around a kill from the real video.

### Round 15b - Export "Codec reclaimed due to inactivity" (v5.5.1)
- Report CC-MWN1A95V (Windows, 44-min 576x360 video): the first export attempt failed after 917 s with QuotaExceededError "Codec reclaimed due to inactivity" / "closed codec" / "playback stalled"; the simpler recipe then worked. Cause: turbo ran TWO hardware encoders and two hidden playing videos at once; Chrome reclaims an idle/starved hardware encoder. (The report also showed version 5.4.1: the user had not yet received 5.5.0 - reload the page twice.)
- Fix: turbo export is sequential; an encoder-interrupted error retries the SAME settings once (fresh encoder, 1.5 s pause) before falling back to simpler recipes.
