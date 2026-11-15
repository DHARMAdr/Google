# ClipCutter - Project File (history to latest change)

> Give this file to Claude together with `index.html` whenever you want to improve the project.
> Add a new entry to the CHANGE LOG at the bottom after every round.

---

## 1. What this project is

A website that takes long videos, **analyses them**, and suggests the **best moments** to turn into:

- **Shorts / Reels** (15 to 90 seconds, or any custom length)
- **Longer highlights** (2, 3, 5, 10 minutes)

You can also **trim by hand**, and **export** each clip in the shape you want for YouTube Shorts, Instagram Reels, TikTok, Instagram feed or YouTube.

Everything runs **inside the browser**. No server, no upload, no cost. Hosted free on GitHub Pages.

- Repo: https://github.com/DHARMAdr/Google
- Live site (after Pages is switched on): https://dharmadr.github.io/Google/

## 2. Why this language / technology?

| Choice | Reason |
|---|---|
| **JavaScript (plain, no framework)** | Runs in the browser, so videos stay private on the user's device. No backend needed. |
| **Web Audio API** | Decodes audio so we can measure loudness. |
| **Canvas** | Reads pixels from video frames (motion) and draws cropped/faded/titled frames (export). |
| **MediaRecorder** | Records canvas + audio into a downloadable video file. |
| **One single `index.html`** | Easiest to host on GitHub Pages. HTML + CSS + JS in one file. |

Python (OpenCV, librosa, Whisper) could analyse deeper, but needs a server or local install. See "Future upgrades".

## 3. How the analysis works

1. **Sound score** - audio decoded, loudness (RMS) measured per quarter-second. Loud, lively parts often mean excitement, laughter, key statements or music hits.
2. **Motion score** - the page jumps through the video (about 300 sample points max), shrinks frames to 64x36 and compares with the previous sample. Big differences = movement or scene change.
3. **Combine** - `score = weight * sound + (1 - weight) * motion`. The weight comes from the "What counts as best" dropdown. If audio cannot be decoded (or the file is over 1.5 GB), motion alone is used.
4. **Smooth** - a moving average stops one-second spikes from winning.
5. **Find clips** - slide a window of the chosen length over the video, rank by average score, take the best windows that do **not overlap**.
6. **Snap to quiet** - start and end move (up to 2 or 4 seconds, or off) to the quietest spot so words are not cut in half.
7. **Explain** - each clip gets a reason ("Loud / lively audio", "Lots of visual action", "Strong overall energy").

Analysis results are cached per video, so re-suggesting clips (different length, count or focus) is instant.

## 4. Features list (current, v2)

**Library**
- Add several videos (drag-drop or browse), switch between them
- Delete one video or all videos (frees memory; original files on disk are never touched)
- Friendly errors for unsupported files (for example HEVC .mov that Chrome cannot play)

**Manual trimmer**
- Timeline with interest graph, clip bands, playhead
- Draggable green In/Out handles, typed In/Out, "In/Out = playhead"
- Playhead nudge buttons (5 s, 1 s, 0.1 s), arrow keys, `I` and `O` shortcuts
- Play selection, Add as clip, Split clip at playhead

**Auto suggestions**
- Length presets, custom length, 1 to 20 clips
- Focus: balanced / mostly sound / mostly action
- Quiet-point snapping on/off
- New suggestions replace old automatic ones; clips you made or edited are kept

**Clips**
- Rename, edit start/end by typing, nudge +/-0.5 s, set from playhead
- Preview, Split, Duplicate, Delete
- Platform-fit badges (Shorts <= 60 s, Reels <= 90 s)

**Export**
- Shape: 9:16, 4:5, 1:1, 16:9, original
- Fit: crop to fill (with left/right and top/bottom sliders), blurred bars, black bars
- Quality 540p / 720p / 1080p, speed 0.75x to 2x, fade in/out, mute, clip name as title
- Export one clip or all clips, Cancel button, delete exported files

## 5. How export works

1. A hidden `<video>` jumps to the clip start.
2. Each animation frame is drawn onto a canvas (crop / fit, fade overlay, title text).
3. Canvas stream + audio stream (through a volume node for fades) are recorded with `MediaRecorder`.
4. Format: MP4 if the browser supports it (Chrome, Safari), else WebM.

Limits:
- Real time: a 30 s clip at 1x takes about 30 s to export.
- The tab must stay open and visible.
- WebM may need converting to MP4 for Instagram.
- Blurred bars use `ctx.filter` (Safari may skip the blur).
- Phone videos in HEVC/H.265 may not play in some browsers.

## 6. File list

| File | Purpose |
|---|---|
| `index.html` | The whole site (layout + style + logic), commented for beginners |
| `PROJECT.md` | This file: history, design and how to continue |

## 7. How to put it online (GitHub Pages)

1. Repo `DHARMAdr/Google` already holds both files on branch `main`.
2. Open https://github.com/DHARMAdr/Google/settings/pages
3. Source: **Deploy from a branch**, branch **main**, folder **/ (root)**, press **Save**.
4. After about a minute the site is live at https://dharmadr.github.io/Google/

If the page shows 404, Pages is not switched on yet (step 2 and 3), or the first build is still running (check the Actions tab).

## 8. Testing notes

Tested in headless Chrome with a generated 24 s test video: upload two videos, analyse, manual clip, split, delete clip, export with fade + title + speed, delete exported file, delete video. All passed, no console errors. Not yet tested on Safari, Firefox, phones, or long real-world videos.

## 9. Known limitations

- Very large files (over about 1.5 GB) skip audio listening, motion only.
- Analysis of long videos takes time because frames are sampled by seeking.
- No speech understanding yet, so cuts follow loudness and motion, not sentences.
- No merge of several clips into one video yet.
- Export is real time, not instant.

## 10. Future upgrades (ideas, easiest first)

1. **Captions** - Whisper in the browser (transformers.js) for subtitles, and cutting at sentence ends.
2. **Faster, better export** - `ffmpeg.wasm` for real MP4 trimming without real-time recording.
3. **Merge clips** - join selected clips into one video.
4. **Face-aware crop** - a face detector so the 9:16 crop follows the speaker.
5. **Hook finder** - score the first 3 seconds of each clip higher.
6. **Batch ZIP download** of all exports.
7. **Titles and hashtags** suggested from the transcript.
8. **Python power version** - local tool with `ffmpeg`, `librosa`, `PySceneDetect`, Whisper, using this page as the front end.

## 11. Prompt to continue with Claude

> I am attaching `index.html` and `PROJECT.md` for my ClipCutter project. Read both first.
> Keep every code file commented in basic English for beginners (why each part exists, how it works, how to improve it).
> Make this change: ____________
> Afterwards, return the updated `index.html` and an updated `PROJECT.md` with a new CHANGE LOG entry, and upload both to the GitHub repo DHARMAdr/Google.

---

## CHANGE LOG

### Round 1 - Initial build (2026-11-15)
- Created `index.html`: upload, analysis (sound + motion), best-clip finder with quiet-point snapping, timeline map, editable clip cards, preview, and 9:16 export with three fit modes.
- Created this `PROJECT.md`.
- Pushed both files to `DHARMAdr/Google` (branch `main`).
- Pages could not be switched on automatically (settings API blocked in the session), so the user must enable it in repo settings.

### Round 2 - Library, trimmer and export options (2026-11-15)
- Reported: "it's not working". Diagnosis: in headless Chrome the v1 analysis worked, so the likely cause was GitHub Pages not being switched on (404). Added clearer errors anyway (unplayable files, load timeouts, unexpected errors shown in the status line, missing browser features).
- Added a video library: add many videos, select, delete one or all, memory cleanup.
- Added the manual trimmer: draggable In/Out handles on the timeline, In/Out inputs, playhead nudges, keyboard shortcuts, Play selection, Add as clip, Split at playhead.
- Added clip actions: rename, nudge, duplicate, delete, delete exported file.
- Added suggestion options: custom length up to 1 hour, up to 20 clips, 10 minute preset, snap range choice, results cached so re-suggesting is instant.
- Added export options: shapes (9:16, 4:5, 1:1, 16:9, original), fit modes, quality, speed, fade, mute, clip name as title, vertical crop slider, Export all, Cancel.
- Tested end to end in headless Chrome (see section 8). Pushed to `DHARMAdr/Google`.
