# ClipCutter - Project File (history to latest change)

> Give this file to Claude together with `index.html` whenever you want to improve the project.
> Keep adding a new entry to the CHANGE LOG at the bottom after every round.

---

## 1. What this project is

A website that takes a long video, **analyses it**, and suggests the **best moments** to turn into:

- **Shorts / Reels** (15, 30, 45, 60, 90 seconds)
- **Longer highlights** (2, 3, 5 minutes)

It can also **export** each clip as a vertical 9:16 video, ready for YouTube Shorts and Instagram Reels.

Everything runs **inside the browser**. No server, no upload, no cost. It can be hosted free on GitHub Pages.

## 2. Why this language / technology?

| Choice | Reason |
|---|---|
| **JavaScript (plain, no framework)** | Runs in the browser, so videos stay private on the user's device. No backend needed. |
| **Web Audio API** | Decodes the audio and lets us measure loudness. |
| **Canvas** | Lets us read pixels from video frames (for motion) and draw cropped 9:16 frames (for export). |
| **MediaRecorder** | Records the canvas + audio into a downloadable video file. |
| **One single `index.html`** | Easiest to upload to GitHub Pages. HTML + CSS + JS in one file. |

Why not Python? Python (with OpenCV, librosa, Whisper) would give deeper analysis, but it needs a server or the user installing things. The browser version works for anyone with a link. See "Future upgrades" for a Python option.

## 3. How the analysis works

1. **Sound score** - audio is decoded and split into quarter-second slices. Loudness (RMS) is measured for each. Loud, lively parts usually mean excitement, laughter, key statements or music hits.
2. **Motion score** - the page jumps through the video (about 300 sample points max), shrinks each frame to 64x36 pixels and compares it with the previous sample. Big differences mean movement or scene changes.
3. **Combine** - `score = weight * sound + (1 - weight) * motion`. The user picks the weight (balanced / mostly sound / mostly action). If audio cannot be decoded, motion alone is used.
4. **Smooth** - a small moving average stops one-second spikes from winning.
5. **Find clips** - slide a window of the chosen length over the video, average the score inside, sort best first, and take the best windows that do **not overlap**.
6. **Snap to quiet** - each start and end is moved (up to 2 seconds) to the quietest spot so words are not cut in half.
7. **Explain** - each clip gets a reason: "Loud / lively audio", "Lots of visual action" or "Strong overall energy".

## 4. How export works

1. A hidden `<video>` jumps to the clip start.
2. Each animation frame is drawn onto a canvas:
   - **Crop 9:16**: zoom to fill; a slider moves the crop left/right.
   - **Blur bars 9:16**: whole video in the middle, blurred copy behind.
   - **Original shape**: no crop.
3. The canvas stream + audio stream are recorded with `MediaRecorder`.
4. Format: MP4 if the browser supports it (Chrome, Safari), else WebM.
5. A download link appears.

Limits:
- Export runs in **real time** (30 s clip = about 30 s wait).
- The tab must stay open and visible.
- WebM may need converting to MP4 for Instagram.
- Blur background uses `ctx.filter`, which Safari may not support.

## 5. Features list (current)

- Drag-and-drop or browse for a video
- Preview player
- Clip length presets (Shorts/Reels and longer)
- Number of clips (1-10)
- "What counts as best" selector (sound vs action)
- Interest map (timeline graph with clip markers; click to jump)
- Suggested clips with reason, score and platform-fit badges
- Edit start/end by typing or by "use player time" buttons
- Preview each clip
- Export each clip (3 shape modes) with progress bar and download link

## 6. File list

| File | Purpose |
|---|---|
| `index.html` | The whole site (layout + style + logic), commented for beginners |
| `PROJECT.md` | This file: history, design and how to continue |

## 7. How to put it online (GitHub Pages)

1. Create a repository (for example `clipcutter`) on GitHub.
2. Upload `index.html` and `PROJECT.md`.
3. Go to **Settings > Pages**, choose branch `main`, folder `/ (root)`, and Save.
4. Open the link GitHub shows after a minute.

## 8. Known limitations

- Very large files (more than about 2 GB) may fail to decode audio. The app then falls back to motion only.
- Analysis of long videos takes time because frames are sampled by seeking.
- No speech understanding yet, so cuts are placed by loudness, not by sentences or topics.
- No captions, titles or face tracking yet.

## 9. Future upgrades (ideas, easiest first)

1. **Captions** - run Whisper in the browser (transformers.js) for subtitles, and cut at sentence ends.
2. **Faster, better export** - use `ffmpeg.wasm` for real MP4 trimming without real-time recording.
3. **Face-aware crop** - use a face detector so the 9:16 crop follows the speaker.
4. **Hook finder** - score the first 3 seconds of each clip higher (strong hook = better retention).
5. **Batch ZIP download** - export all clips and zip them.
6. **Titles and hashtags** - suggest them from the transcript.
7. **Python power version** - a local tool using `ffmpeg`, `librosa`, `PySceneDetect` and Whisper for deeper analysis, with this website as the front end.

## 10. Prompt to continue with Claude

> I am attaching `index.html` and `PROJECT.md` for my ClipCutter project. Read both first.
> Keep every code file commented in basic English for beginners (why each part exists, how it works, how to improve it).
> Make this change: ____________
> Afterwards, return the updated `index.html` and an updated `PROJECT.md` with a new CHANGE LOG entry.

---

## CHANGE LOG

### Round 1 - Initial build (2026-11-15)
- Created `index.html`: upload, analysis (sound + motion), best-clip finder with quiet-point snapping, timeline map, editable clip cards, preview, and 9:16 export with three shape modes.
- Created this `PROJECT.md`.
- Status: first version, not yet tested on real videos by the user. Please report what works and what breaks (browser, video length, format).
